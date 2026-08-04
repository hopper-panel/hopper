import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeniedFileError,
  JailedFilesystem,
  NotFoundError,
  PathEscapeError,
  formatMode,
  globToRegExp,
  isInside,
} from './jailed-filesystem.js';

/**
 * Ces tests s'exécutent contre un vrai système de fichiers temporaire, avec de
 * vrais liens symboliques : une évasion par symlink ne se reproduit pas avec un
 * `fs` simulé, et c'est précisément le cas qu'on cherche à empêcher.
 *
 * Windows refuse la création de liens symboliques sans élévation ni mode
 * développeur. Les tests concernés sont donc conditionnés à une sonde, et
 * s'exécutent en intégration continue — qui tourne sous Linux, comme les nodes
 * en production. Un développeur sous Windows les verra marqués « ignorés »,
 * jamais « réussis ».
 */
/**
 * La sonde est **synchrone et au niveau du module**, pas dans un `beforeAll`.
 *
 * `describe.runIf(...)` est évalué au moment où Vitest collecte les tests,
 * c'est-à-dire avant l'exécution du moindre `beforeAll`. Une sonde asynchrone
 * laissait donc le drapeau à `false` sur toutes les plateformes, y compris
 * Linux : les huit tests étaient annoncés « ignorés » partout, et n'ont jamais
 * rien vérifié.
 */
const symlinkSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hopper-symlink-probe-'));

  try {
    mkdirSync(join(probe, 'cible'));
    symlinkSync(join(probe, 'cible'), join(probe, 'lien'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

afterAll(() => {
  if (!symlinkSupported) {
    process.stderr.write(
      '\n⚠ Liens symboliques indisponibles sur cette plateforme : les tests d’évasion par symlink ont été ignorés.\n' +
        '  Ils s’exécutent en intégration continue, sous Linux.\n\n',
    );
  }
});

describe('JailedFilesystem', () => {
  let sandbox: string;
  let volume: string;
  let outside: string;
  let jail: JailedFilesystem;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-jail-'));
    volume = join(sandbox, 'volume');
    outside = join(sandbox, 'secret');

    await mkdir(volume, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'passwd'), 'root:x:0:0:');
    await writeFile(join(volume, 'server.properties'), 'server-port=25565');
    await mkdir(join(volume, 'plugins'), { recursive: true });
    await writeFile(join(volume, 'plugins', 'config.yml'), 'debug: false');

    jail = new JailedFilesystem({ root: volume });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  describe('chemins légitimes', () => {
    it('accepte un fichier à la racine', async () => {
      expect(await jail.resolvePath('server.properties')).toBe(join(volume, 'server.properties'));
    });

    it('accepte un chemin imbriqué', async () => {
      expect(await jail.resolvePath('plugins/config.yml')).toBe(
        join(volume, 'plugins', 'config.yml'),
      );
    });

    it('accepte le préfixe « / » comme racine du volume', async () => {
      expect(await jail.resolvePath('/plugins')).toBe(join(volume, 'plugins'));
    });

    it('accepte les séparateurs Windows', async () => {
      expect(await jail.resolvePath('plugins\\config.yml')).toBe(
        join(volume, 'plugins', 'config.yml'),
      );
    });

    it('accepte un « .. » qui reste dans le volume', async () => {
      expect(await jail.resolvePath('plugins/../server.properties')).toBe(
        join(volume, 'server.properties'),
      );
    });

    it("accepte un fichier qui n'existe pas encore", async () => {
      expect(await jail.resolvePath('nouveau/dossier/fichier.txt')).toBe(
        join(volume, 'nouveau', 'dossier', 'fichier.txt'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Ce bloc est la raison d'être du module.
  // ---------------------------------------------------------------------------

  describe('évasion par traversée', () => {
    it.each([
      '../secret/passwd',
      '../../etc/passwd',
      'plugins/../../secret/passwd',
      '..',
      '../',
      'a/../../secret',
    ])('refuse « %s »', async (attack) => {
      await expect(jail.resolvePath(attack)).rejects.toThrow(PathEscapeError);
    });

    /**
     * L'invariant qui compte n'est pas « ces charges sont refusées », mais
     * « elles ne désignent jamais un fichier de l'hôte ». Selon la charge et la
     * plateforme, le jail les refuse ou les ramène à l'intérieur du volume :
     * les deux issues sont sûres, et l'affirmation les couvre toutes deux.
     *
     * `....//....//` ne piège que les filtres qui suppriment « .. » en boucle :
     * `....` est un nom de dossier ordinaire, que la normalisation de Node
     * traite comme tel. Un chemin absolu est réinterprété relativement au
     * volume — comme le fait `tar` sans `--absolute-names` — sauf sous Windows
     * où `C:/…` est reconnu comme absolu et donc rejeté.
     */
    it.each([
      '....//....//secret/passwd',
      '/etc/passwd',
      '//etc/passwd',
      'C:/Windows/system32',
      '\\\\serveur\\partage\\fichier',
    ])('ne laisse jamais « %s » désigner un fichier de l’hôte', async (payload) => {
      let resolved: string;

      try {
        resolved = await jail.resolvePath(payload);
      } catch (error) {
        expect(error).toBeInstanceOf(PathEscapeError);
        return;
      }

      expect(resolved.startsWith(volume + sep)).toBe(true);
      expect(resolved).not.toContain(outside);
    });

    // Un octet nul tronque le chemin dans les appels système en C : la
    // vérification verrait `a`, le noyau verrait autre chose.
    it('refuse un chemin contenant un octet nul', async () => {
      await expect(jail.resolvePath('a\0/../../secret/passwd')).rejects.toThrow(PathEscapeError);
    });
  });

  // Conditionnés à la sonde : voir le commentaire en tête de fichier.
  describe.runIf(symlinkSupported)('évasion par lien symbolique', () => {
    // L'utilisateur peut créer ces liens lui-même depuis sa console ou en SFTP.
    it('refuse un lien vers un dossier extérieur', async () => {
      await symlink(outside, join(volume, 'evasion'), 'dir');

      await expect(jail.resolvePath('evasion/passwd')).rejects.toThrow(PathEscapeError);
    });

    it('refuse un lien vers un fichier extérieur', async () => {
      await symlink(join(outside, 'passwd'), join(volume, 'lien.txt'));

      await expect(jail.resolvePath('lien.txt')).rejects.toThrow(PathEscapeError);
    });

    it('refuse un lien vers la racine du système', async () => {
      await symlink(sep, join(volume, 'racine'), 'dir');

      await expect(jail.resolvePath('racine/etc/passwd')).rejects.toThrow(PathEscapeError);
    });

    // Le fichier visé n'existe pas encore : c'est le cas d'une écriture, et le
    // contrôle doit porter sur le dossier parent.
    it("refuse l'écriture à travers un lien, même sur un fichier absent", async () => {
      await symlink(outside, join(volume, 'evasion'), 'dir');

      await expect(jail.resolvePath('evasion/nouveau.txt')).rejects.toThrow(PathEscapeError);
    });

    it('accepte un lien qui reste dans le volume', async () => {
      await symlink(join(volume, 'plugins'), join(volume, 'raccourci'), 'dir');

      await expect(jail.resolvePath('raccourci/config.yml')).resolves.toContain('plugins');
    });

    it('refuse un lien imbriqué en deux sauts', async () => {
      await symlink(outside, join(sandbox, 'saut1'), 'dir');
      await symlink(join(sandbox, 'saut1'), join(volume, 'saut2'), 'dir');

      await expect(jail.resolvePath('saut2/passwd')).rejects.toThrow(PathEscapeError);
    });
  });

  describe('liste noire', () => {
    beforeEach(() => {
      jail = new JailedFilesystem({
        root: volume,
        denylist: ['forwarding.secret', 'secrets/**', '*.key'],
      });
    });

    it.each(['forwarding.secret', 'secrets/token.txt', 'secrets/a/b/c.txt', 'serveur.key'])(
      'refuse « %s »',
      async (denied) => {
        await expect(jail.resolvePath(denied)).rejects.toThrow(DeniedFileError);
      },
    );

    it('laisse passer ce qui ne correspond pas', async () => {
      await expect(jail.resolvePath('server.properties')).resolves.toBeTruthy();
      await expect(jail.resolvePath('plugins/config.yml')).resolves.toBeTruthy();
    });

    // Montrer un fichier sans permettre de le lire ne ferait qu'attirer
    // l'attention dessus.
    it("masque les fichiers interdits dans la liste d'un dossier", async () => {
      await writeFile(join(volume, 'forwarding.secret'), 'secret');

      const entries = await jail.list('.');

      expect(entries.map((entry) => entry.name)).not.toContain('forwarding.secret');
      expect(entries.map((entry) => entry.name)).toContain('server.properties');
    });
  });

  describe('extraction d’archive', () => {
    it('accepte une entrée normale', async () => {
      const target = await jail.resolveArchiveEntry('.', 'plugins/nouveau.jar');
      expect(target).toBe(join(volume, 'plugins', 'nouveau.jar'));
    });

    // Le « zip-slip » : beaucoup de bibliothèques d'extraction écrivent cette
    // entrée sans broncher.
    it.each(['../../etc/cron.d/backdoor', '../evasion.txt', 'a/../../../../evasion'])(
      'refuse l’entrée « %s »',
      async (entry) => {
        await expect(jail.resolveArchiveEntry('.', entry)).rejects.toThrow(PathEscapeError);
      },
    );

    // Une entrée absolue est réinterprétée relativement à la destination, comme
    // le fait `tar` : elle n'écrit donc jamais hors du volume.
    it('ramène une entrée absolue dans le volume', async () => {
      const target = await jail.resolveArchiveEntry('.', '/etc/passwd');

      expect(target).toBe(join(volume, 'etc', 'passwd'));
    });

    // Une archive extraite dans `plugins/` ne doit pas écrire ailleurs dans le
    // volume, même si la destination reste légale.
    it('refuse une entrée qui sort de la destination demandée', async () => {
      await expect(jail.resolveArchiveEntry('plugins', '../server.properties')).rejects.toThrow(
        PathEscapeError,
      );
    });

    it('refuse une entrée figurant dans la liste noire', async () => {
      const guarded = new JailedFilesystem({ root: volume, denylist: ['*.key'] });

      await expect(guarded.resolveArchiveEntry('.', 'serveur.key')).rejects.toThrow(
        DeniedFileError,
      );
    });
  });

  describe('opérations', () => {
    it('liste un dossier, dossiers en tête', async () => {
      const entries = await jail.list('.');

      expect(entries[0]!.name).toBe('plugins');
      expect(entries[0]!.directory).toBe(true);
      expect(entries.map((entry) => entry.name)).toContain('server.properties');
    });

    it('renvoie des chemins relatifs, jamais absolus', async () => {
      const entries = await jail.list('plugins');

      expect(entries[0]!.path).toBe('plugins/config.yml');
      // Le chemin sur l'hôte révélerait l'arborescence de la machine.
      expect(entries[0]!.path).not.toContain(sandbox);
    });

    it('signale un dossier introuvable', async () => {
      await expect(jail.list('absent')).rejects.toThrow(NotFoundError);
    });

    it('écrit un fichier et crée son dossier parent', async () => {
      await jail.writeFile('nouveau/dossier/fichier.txt', 'contenu');

      expect((await jail.stat('nouveau/dossier/fichier.txt')).sizeBytes).toBe(7);
    });

    it('renomme un fichier', async () => {
      await jail.rename('server.properties', 'renomme.properties');

      await expect(jail.stat('renomme.properties')).resolves.toBeTruthy();
      await expect(jail.stat('server.properties')).rejects.toThrow(NotFoundError);
    });

    it('refuse un renommage dont la destination sort du volume', async () => {
      await expect(jail.rename('server.properties', '../evade.txt')).rejects.toThrow(
        PathEscapeError,
      );
    });

    it('copie un dossier entier', async () => {
      await jail.copy('plugins', 'plugins-copie');

      expect((await jail.list('plugins-copie')).map((entry) => entry.name)).toEqual(['config.yml']);
    });

    it('supprime plusieurs entrées', async () => {
      await jail.delete(['server.properties', 'plugins']);

      expect(await jail.list('.')).toEqual([]);
    });

    // Supprimer la racine viderait le serveur d'un coup, sans passer par la
    // suppression du serveur elle-même.
    it('refuse de supprimer la racine du volume', async () => {
      await expect(jail.delete(['.'])).rejects.toThrow(PathEscapeError);
      await expect(jail.delete(['/'])).rejects.toThrow(PathEscapeError);
    });

    it.runIf(symlinkSupported)('décrit un lien comme lien, sans suivre sa cible', async () => {
      await symlink(join(outside, 'passwd'), join(volume, 'lien.txt'));

      const entry = (await jail.list('.')).find((candidate) => candidate.name === 'lien.txt');

      expect(entry?.symlink).toBe(true);
      // La taille de la cible révélerait un fichier hors du volume.
      expect(entry?.sizeBytes).not.toBe(12);
    });
  });

  describe('chmod', () => {
    // Le changement de droits passe par la même résolution que tout le reste :
    // sans cela, `../../etc/shadow` deviendrait accessible en écriture à tout
    // le monde depuis un gestionnaire de fichiers de serveur Minecraft.
    it('refuse un chemin hors du volume', async () => {
      await expect(jail.chmod('../../etc/shadow', 0o777)).rejects.toThrow(PathEscapeError);
    });

    it('refuse un fichier de la liste noire', async () => {
      const guarded = new JailedFilesystem({ root: volume, denylist: ['*.key'] });

      await expect(guarded.chmod('secret.key', 0o600)).rejects.toThrow(DeniedFileError);
    });

    // Le schéma du contrat n'accepte que trois chiffres octaux, mais le masque
    // est appliqué ici aussi : un binaire `setuid` déposé dans un volume
    // s'exécuterait avec les droits de son propriétaire et annulerait le
    // cloisonnement du conteneur.
    //
    // Ignoré sous Windows, qui ne retient que le bit d'écriture : le test y
    // passerait sans rien prouver.
    it.runIf(process.platform !== 'win32')('écarte les bits setuid et setgid', async () => {
      await jail.writeFile('script.sh', '#!/bin/sh');
      await jail.chmod('script.sh', 0o6755);

      const absolute = await jail.absolutePathFor('script.sh');
      const { mode } = await stat(absolute);

      expect(mode & 0o7777).toBe(0o755);
    });
  });

  describe('appartenance', () => {
    // Le daemon écrit en root, le serveur tourne en uid non privilégié. Sans
    // reprise de propriété, tout chemin créé par le gestionnaire de fichiers
    // devenait illisible pour le serveur — un plugin qui n'arrive pas à écrire
    // sa configuration, des heures après l'envoi du fichier.
    it('ne casse pas les écritures quand aucune appartenance n’est demandée', async () => {
      await expect(jail.writeFile('sans-proprietaire.txt', 'ok')).resolves.toBeUndefined();
      await expect(jail.createDirectory('dossier')).resolves.toBeUndefined();
    });

    // `chown` échoue sous Windows et pour un utilisateur non privilégié : la
    // reprise de propriété ne doit jamais faire échouer l'écriture elle-même.
    it('n’échoue pas quand chown est impossible', async () => {
      const owned = new JailedFilesystem({
        root: volume,
        ownership: { uid: 4242, gid: 4242 },
      });

      await expect(owned.writeFile('possede.txt', 'ok')).resolves.toBeUndefined();
      await expect(owned.stat('possede.txt')).resolves.toMatchObject({ name: 'possede.txt' });
    });
  });

  describe.runIf(symlinkSupported)('racine elle-même liée', () => {
    it('résout la racine avant toute comparaison', async () => {
      const link = join(sandbox, 'lien-vers-volume');
      await symlink(volume, link, 'dir');

      const linked = new JailedFilesystem({ root: link });

      await expect(linked.resolvePath('server.properties')).resolves.toBeTruthy();
      await expect(linked.resolvePath('../secret/passwd')).rejects.toThrow(PathEscapeError);
    });
  });
});

describe('isInside', () => {
  // Sans le séparateur dans la comparaison, `/var/lib/hopper-evil` passerait
  // pour être sous `/var/lib/hopper`.
  it('refuse un répertoire voisin au nom préfixé', () => {
    expect(isInside(resolve('/var/lib/hopper'), resolve('/var/lib/hopper-evil/x'))).toBe(false);
  });

  it('accepte le répertoire lui-même', () => {
    expect(isInside(resolve('/var/lib/hopper'), resolve('/var/lib/hopper'))).toBe(true);
  });

  it('accepte un descendant', () => {
    expect(isInside(resolve('/var/lib/hopper'), resolve('/var/lib/hopper/a/b'))).toBe(true);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['*.key', 'serveur.key', true],
    ['*.key', 'plugins/serveur.key', false],
    ['**/*.key', 'plugins/serveur.key', true],
    ['secrets/**', 'secrets/a/b.txt', true],
    ['secrets/**', 'autre/a.txt', false],
    ['forwarding.secret', 'forwarding.secret', true],
    ['forwarding.secret', 'forwarding-secret', false],
  ])('« %s » contre « %s » → %s', (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });

  it('échappe les caractères spéciaux des expressions régulières', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });
});

describe('formatMode', () => {
  it.each([
    [0o755, 'rwxr-xr-x'],
    [0o644, 'rw-r--r--'],
    [0o600, 'rw-------'],
    [0o777, 'rwxrwxrwx'],
    [0o000, '---------'],
  ])('formate %s en %s', (mode, expected) => {
    expect(formatMode(mode)).toBe(expected);
  });
});

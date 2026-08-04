import { describe, expect, it } from 'vitest';
import { MAX_VARIABLE_LENGTH, parseRules, validateValue } from './variable-rules.js';

/** Vrai si la valeur passe toutes les règles. */
function accepts(value: string, rules: string): boolean {
  return validateValue(value, rules).length === 0;
}

describe('parseRules', () => {
  it('découpe sur la barre verticale', () => {
    expect(parseRules('required|string|max:20')).toEqual([
      { name: 'required', args: [] },
      { name: 'string', args: [] },
      { name: 'max', args: ['20'] },
    ]);
  });

  it('découpe les listes sur la virgule', () => {
    expect(parseRules('in:paper,purpur,folia')).toEqual([
      { name: 'in', args: ['paper', 'purpur', 'folia'] },
    ]);
  });

  // Une expression régulière contient des virgules, des barres verticales et
  // des deux-points : la découper la rendrait méconnaissable, et la règle
  // n'accepterait plus rien — ou tout.
  it('garde une expression régulière entière', () => {
    const parsed = parseRules('required|regex:/^[a-z]{1,3}(,[a-z]+)?$/i');

    expect(parsed[1]).toEqual({ name: 'regex', args: ['/^[a-z]{1,3}(,[a-z]+)?$/i'] });
  });

  it('ignore les segments vides et les espaces', () => {
    expect(parseRules(' required | | string ')).toEqual([
      { name: 'required', args: [] },
      { name: 'string', args: [] },
    ]);
  });
});

describe('validateValue', () => {
  describe('présence', () => {
    it('exige une valeur avec required', () => {
      expect(accepts('', 'required|string')).toBe(false);
      expect(accepts('   ', 'required|string')).toBe(false);
      expect(accepts('paper', 'required|string')).toBe(true);
    });

    // `nullable` doit court-circuiter les autres règles : les appliquer à une
    // valeur vide autorisée le rendrait sans effet, et le champ deviendrait
    // obligatoire sans que rien ne le dise.
    it('laisse passer le vide avec nullable, sans appliquer le reste', () => {
      expect(accepts('', 'nullable|integer|in:1,2,3')).toBe(true);
    });
  });

  describe('types', () => {
    it('integer', () => {
      expect(accepts('42', 'integer')).toBe(true);
      expect(accepts('-7', 'integer')).toBe(true);
      expect(accepts('4.2', 'integer')).toBe(false);
      expect(accepts('abc', 'integer')).toBe(false);
    });

    it('numeric', () => {
      expect(accepts('4.2', 'numeric')).toBe(true);
      expect(accepts('abc', 'numeric')).toBe(false);
    });

    it('boolean', () => {
      expect(accepts('true', 'boolean')).toBe(true);
      expect(accepts('0', 'boolean')).toBe(true);
      expect(accepts('oui', 'boolean')).toBe(false);
    });

    it('alpha_num et alpha_dash', () => {
      expect(accepts('paper18', 'alpha_num')).toBe(true);
      expect(accepts('paper-1.8', 'alpha_num')).toBe(false);
      expect(accepts('paper_1-8', 'alpha_dash')).toBe(true);
      expect(accepts('paper.1.8', 'alpha_dash')).toBe(false);
    });
  });

  /**
   * Le piège de Laravel, repris tel quel par les eggs : `min`/`max` portent sur
   * la **valeur** d'un nombre et sur la **longueur** d'un texte. Traiter les
   * deux pareil ferait accepter `999` là où l'on attendait trois caractères.
   */
  describe('min et max', () => {
    it('bornent la valeur d’un nombre', () => {
      expect(accepts('5', 'integer|min:1|max:10')).toBe(true);
      expect(accepts('50', 'integer|min:1|max:10')).toBe(false);
      expect(accepts('0', 'integer|min:1|max:10')).toBe(false);
    });

    it('bornent la longueur d’un texte', () => {
      expect(accepts('paper', 'string|max:10')).toBe(true);
      expect(accepts('paper-the-longest', 'string|max:10')).toBe(false);
      expect(accepts('ab', 'string|min:3')).toBe(false);
    });

    it('between combine les deux bornes', () => {
      expect(accepts('5', 'integer|between:1,10')).toBe(true);
      expect(accepts('11', 'integer|between:1,10')).toBe(false);
    });
  });

  describe('in', () => {
    it('n’accepte que les valeurs listées', () => {
      expect(accepts('purpur', 'in:paper,purpur')).toBe(true);
      expect(accepts('spigot', 'in:paper,purpur')).toBe(false);
    });

    // Comparaison exacte : accepter « Paper » pour « paper » ferait passer une
    // valeur que le script d'installation ne reconnaîtra pas.
    it('distingue la casse', () => {
      expect(accepts('Paper', 'in:paper,purpur')).toBe(false);
    });
  });

  describe('regex', () => {
    it('applique une expression délimitée', () => {
      expect(accepts('1.21.4', 'regex:/^\\d+\\.\\d+(\\.\\d+)?$/')).toBe(true);
      expect(accepts('latest', 'regex:/^\\d+\\.\\d+(\\.\\d+)?$/')).toBe(false);
    });

    it('honore les drapeaux', () => {
      expect(accepts('PAPER', 'regex:/^paper$/i')).toBe(true);
    });

    // Une expression illisible est une faute du template, pas de
    // l'utilisateur : le bloquer sur une erreur qu'il ne peut pas corriger
    // rendrait son serveur inconfigurable.
    it('laisse passer quand l’expression est invalide', () => {
      expect(accepts('peu importe', 'regex:/[/')).toBe(true);
    });
  });

  // Une règle qu'on ne sait pas appliquer ne doit pas tout bloquer : les eggs
  // importés en contiennent d'autres, et refuser rendrait le serveur
  // inconfigurable pour une règle décorative.
  it('ignore une règle inconnue', () => {
    expect(accepts('paper', 'required|string|starts_with:pa')).toBe(true);
  });

  /**
   * Borne de longueur appliquée **avant** toute évaluation.
   *
   * Un template est écrit par un administrateur, mais rien ne garantit que son
   * expression régulière soit saine : une expression mal formée peut prendre un
   * temps exponentiel sur une entrée longue. La borne ferme cette porte sans
   * avoir à juger chaque expression.
   */
  it('refuse une valeur démesurée avant d’évaluer les règles', () => {
    const huge = 'a'.repeat(MAX_VARIABLE_LENGTH + 1);

    expect(accepts(huge, 'nullable|string')).toBe(false);
    expect(validateValue(huge, 'nullable')[0]?.rule).toBe('max');
  });

  it('rend toutes les règles enfreintes', () => {
    const violations = validateValue('x', 'integer|min:10');

    expect(violations.map((violation) => violation.rule).sort()).toEqual(['integer', 'min']);
  });
});

/**
 * La règle appliquée à `SERVER_JARFILE` dans les templates livrés.
 *
 * Cette variable a été rendue modifiable, et c'est cette expression qui
 * remplace la protection retirée : elle impose un **nom de fichier**, jamais un
 * chemin. Un `.jar` déposé dans `plugins/` ne peut donc pas être lancé par
 * erreur, et aucune valeur ne peut désigner autre chose dans le volume.
 */
describe('règle du fichier .jar des templates', () => {
  const RULES = String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`;

  it.each(['server.jar', 'proxy.jar', 'paper-1.21.4.jar', 'Mon_Serveur-2.jar'])(
    'accepte « %s »',
    (value) => {
      expect(accepts(value, RULES)).toBe(true);
    },
  );

  it.each([
    'plugins/evil.jar',
    '../evil.jar',
    '/etc/passwd',
    'server.sh',
    'server.jar.txt',
    'serveur bizarre.jar',
    '',
  ])('refuse « %s »', (value) => {
    expect(accepts(value, RULES)).toBe(false);
  });
});

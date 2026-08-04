/**
 * Validation des variables de template.
 *
 * Les règles sont écrites à la façon de Laravel — `required|string|max:20` —
 * parce que c'est ce que contiennent les milliers d'« eggs » Pterodactyl que
 * l'importeur sait déjà lire. Réinventer une syntaxe rendrait ces templates
 * inutilisables, ou pire, silencieusement non validés.
 *
 * **Ce fichier est une barrière de sécurité.** Une variable modifiable par
 * l'utilisateur entre dans la commande de démarrage du conteneur. Le
 * découpage-avant-substitution du daemon empêche déjà qu'une valeur introduise
 * un argument ou une commande, mais rien n'empêche `SERVER_JARFILE` de désigner
 * un fichier que l'utilisateur a déposé lui-même. Les règles sont ce qui
 * restreint le domaine de chaque variable ; les appliquer de travers revient à
 * ne pas les appliquer.
 *
 * Règles reconnues :
 *
 *   required        valeur non vide exigée
 *   nullable        valeur vide acceptée ; les autres règles sont alors ignorées
 *   string          n'importe quel texte
 *   integer         entier
 *   numeric         nombre, entier ou décimal
 *   boolean         0, 1, true, false
 *   alpha_num       lettres et chiffres
 *   alpha_dash      lettres, chiffres, tiret et souligné
 *   min:n / max:n   longueur pour un texte, valeur pour un nombre
 *   between:a,b     les deux à la fois
 *   in:a,b,c        liste fermée de valeurs
 *   regex:/…/       expression régulière, appliquée telle quelle
 */

/**
 * Longueur maximale d'une valeur, quelle que soit la règle.
 *
 * Un template est écrit par un administrateur, mais rien ne garantit que son
 * `regex:` soit sain : une expression mal formée peut prendre un temps
 * exponentiel sur une entrée longue. Borner la longueur **avant** d'évaluer
 * quoi que ce soit ferme cette porte sans avoir à juger chaque expression.
 */
export const MAX_VARIABLE_LENGTH = 2048;

export interface RuleViolation {
  rule: string;
  message: string;
}

interface ParsedRule {
  name: string;
  args: string[];
}

export function parseRules(raw: string): ParsedRule[] {
  return raw
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const separator = part.indexOf(':');

      if (separator === -1) {
        return { name: part.toLowerCase(), args: [] };
      }

      const name = part.slice(0, separator).toLowerCase();
      const rest = part.slice(separator + 1);

      // `regex:` garde son argument entier : il contient des virgules, des
      // barres verticales et des deux-points qu'il ne faut pas découper.
      return { name, args: name === 'regex' ? [rest] : rest.split(',') };
    });
}

/**
 * Confronte une valeur à des règles.
 *
 * @returns la liste des règles enfreintes, vide si la valeur est acceptable.
 */
export function validateValue(value: string, raw: string): RuleViolation[] {
  if (value.length > MAX_VARIABLE_LENGTH) {
    return [
      {
        rule: 'max',
        message: `Valeur trop longue : ${MAX_VARIABLE_LENGTH} caractères au maximum.`,
      },
    ];
  }

  const rules = parseRules(raw);
  const violations: RuleViolation[] = [];
  const empty = value.trim() === '';

  if (empty) {
    if (rules.some((rule) => rule.name === 'required')) {
      return [{ rule: 'required', message: 'Cette valeur est obligatoire.' }];
    }

    // Une valeur vide autorisée n'a pas à satisfaire `integer` ou `in:` : la
    // contrôler quand même rendrait `nullable` sans effet.
    return [];
  }

  for (const rule of rules) {
    const violation = check(rule, value);

    if (violation) {
      violations.push(violation);
    }
  }

  return violations;
}

function check(rule: ParsedRule, value: string): RuleViolation | null {
  const numeric = Number(value);

  switch (rule.name) {
    case 'required':
    case 'nullable':
    case 'string':
      return null;

    case 'integer':
      return Number.isInteger(numeric)
        ? null
        : { rule: 'integer', message: 'Un nombre entier est attendu.' };

    case 'numeric':
      return Number.isFinite(numeric)
        ? null
        : { rule: 'numeric', message: 'Un nombre est attendu.' };

    case 'boolean':
      return ['0', '1', 'true', 'false'].includes(value.toLowerCase())
        ? null
        : { rule: 'boolean', message: 'Valeur attendue : true ou false.' };

    case 'alpha_num':
      return /^[a-zA-Z0-9]+$/.test(value)
        ? null
        : { rule: 'alpha_num', message: 'Lettres et chiffres uniquement.' };

    case 'alpha_dash':
      return /^[a-zA-Z0-9_-]+$/.test(value)
        ? null
        : {
            rule: 'alpha_dash',
            message: 'Lettres, chiffres, tiret et souligné uniquement.',
          };

    case 'min':
      return compare(rule, value, numeric, 'min');

    case 'max':
      return compare(rule, value, numeric, 'max');

    case 'between': {
      const low = compare({ ...rule, args: [rule.args[0] ?? ''] }, value, numeric, 'min');
      const high = compare({ ...rule, args: [rule.args[1] ?? ''] }, value, numeric, 'max');

      return low ?? high;
    }

    case 'in':
      return rule.args.includes(value)
        ? null
        : { rule: 'in', message: `Valeurs acceptées : ${rule.args.join(', ')}.` };

    case 'regex':
      return matchesRegex(rule.args[0] ?? '', value)
        ? null
        : { rule: 'regex', message: "Cette valeur n'a pas le format attendu." };

    default:
      // Une règle inconnue n'est **pas** une erreur de l'utilisateur : c'est le
      // template qui en utilise une que l'on ne sait pas appliquer. La refuser
      // rendrait le serveur inconfigurable ; on l'ignore, et le champ reste
      // couvert par les autres règles.
      return null;
  }
}

/**
 * `min`/`max` portent sur la valeur d'un nombre et sur la longueur d'un texte,
 * comme dans Laravel. Confondre les deux ferait accepter `999` là où l'on
 * attendait trois caractères, ou l'inverse.
 */
function compare(
  rule: ParsedRule,
  value: string,
  numeric: number,
  kind: 'min' | 'max',
): RuleViolation | null {
  const bound = Number(rule.args[0]);

  if (!Number.isFinite(bound)) {
    return null;
  }

  const isNumber = value.trim() !== '' && Number.isFinite(numeric);
  const actual = isNumber ? numeric : value.length;
  const respected = kind === 'min' ? actual >= bound : actual <= bound;

  if (respected) {
    return null;
  }

  const subject = isNumber ? 'La valeur' : 'La longueur';
  const limit = kind === 'min' ? 'au moins' : 'au plus';

  return { rule: kind, message: `${subject} doit être ${limit} de ${bound}.` };
}

function matchesRegex(pattern: string, value: string): boolean {
  // Forme `/motif/drapeaux`, telle qu'elle apparaît dans les eggs.
  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(pattern);

  try {
    const expression = delimited
      ? new RegExp(delimited[1] ?? '', delimited[2])
      : new RegExp(pattern);

    return expression.test(value);
  } catch {
    // Expression illisible : c'est le template qui est fautif, pas la valeur.
    // La refuser bloquerait l'utilisateur sur une erreur qu'il ne peut pas
    // corriger.
    return true;
  }
}

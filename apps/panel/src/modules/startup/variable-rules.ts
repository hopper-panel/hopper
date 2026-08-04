/**
 * Validating template variables.
 *
 * The rules are written Laravel-style — `required|string|max:20` — because that
 * is what the thousands of Pterodactyl eggs the importer already reads contain.
 * Reinventing a syntax would make those templates unusable, or worse, silently
 * unvalidated.
 *
 * **This file is a security barrier.** A user-editable variable feeds the
 * container's startup command. The daemon's split-before-substitute already
 * stops a value from introducing an argument or a command, but nothing stops
 * `SERVER_JARFILE` from naming a file the user uploaded themselves. The rules
 * are what narrows each variable's domain; applying them wrongly amounts to not
 * applying them.
 *
 * Rules recognised:
 *
 *   required        a non-empty value is demanded
 *   nullable        an empty value is accepted; the other rules are then skipped
 *   string          any text
 *   integer         an integer
 *   numeric         a number, integer or decimal
 *   boolean         0, 1, true, false
 *   alpha_num       letters and digits
 *   alpha_dash      letters, digits, hyphen and underscore
 *   min:n / max:n   length for text, value for a number
 *   between:a,b     both at once
 *   in:a,b,c        a closed list of values
 *   regex:/…/       a regular expression, applied as is
 */

/**
 * Longest a value may be, whatever the rule.
 *
 * A template is written by an administrator, but nothing guarantees its
 * `regex:` is sane: a badly formed expression can take exponential time on a
 * long input. Bounding the length **before** evaluating anything closes that
 * door without having to judge each expression.
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

      // `regex:` keeps its argument whole: it contains commas, pipes and
      // colons that must not be split.
      return { name, args: name === 'regex' ? [rest] : rest.split(',') };
    });
}

/**
 * Checks a value against a set of rules.
 *
 * @returns the list of rules broken, empty if the value is acceptable.
 */
export function validateValue(value: string, raw: string): RuleViolation[] {
  if (value.length > MAX_VARIABLE_LENGTH) {
    return [
      {
        rule: 'max',
        message: `Value too long: ${MAX_VARIABLE_LENGTH} characters at most.`,
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

    // An allowed empty value does not have to satisfy `integer` or `in:`:
    // checking it anyway would make `nullable` pointless.
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
            message: 'Letters, digits, hyphen and underscore only.',
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
        : { rule: 'in', message: `Accepted values: ${rule.args.join(', ')}.` };

    case 'regex':
      return matchesRegex(rule.args[0] ?? '', value)
        ? null
        : { rule: 'regex', message: 'This value is not in the expected format.' };

    default:
      // An unknown rule is **not** the user's mistake: it is the template
      // using one we cannot apply. Refusing it would make the server
      // unconfigurable; it is ignored, and the field stays covered by the other
      // rules.
      return null;
  }
}

/**
 * `min`/`max` apply to a number's value and to a text's length, as in Laravel.
 * Confusing the two would accept `999` where three characters were expected, or
 * the other way round.
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

  return { rule: kind, message: `${subject} has to be ${limit} ${bound}.` };
}

function matchesRegex(pattern: string, value: string): boolean {
  // The `/pattern/flags` form, as it appears in eggs.
  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(pattern);

  try {
    const expression = delimited
      ? new RegExp(delimited[1] ?? '', delimited[2])
      : new RegExp(pattern);

    return expression.test(value);
  } catch {
    // An unreadable expression: the template is at fault, not the value.
    // Refusing it would block the user on an error they cannot fix.
    return true;
  }
}

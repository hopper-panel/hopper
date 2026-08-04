import { describe, expect, it } from 'vitest';
import { MAX_VARIABLE_LENGTH, parseRules, validateValue } from './variable-rules.js';

/** True if the value passes every rule. */
function accepts(value: string, rules: string): boolean {
  return validateValue(value, rules).length === 0;
}

describe('parseRules', () => {
  it('splits on the pipe', () => {
    expect(parseRules('required|string|max:20')).toEqual([
      { name: 'required', args: [] },
      { name: 'string', args: [] },
      { name: 'max', args: ['20'] },
    ]);
  });

  it('splits the lists on the comma', () => {
    expect(parseRules('in:paper,purpur,folia')).toEqual([
      { name: 'in', args: ['paper', 'purpur', 'folia'] },
    ]);
  });

  // A regular expression contains commas, pipes and colons: splitting it would
  // make it unrecognisable, and the rule would accept nothing — or
  // everything.
  it('keeps a regular expression whole', () => {
    const parsed = parseRules('required|regex:/^[a-z]{1,3}(,[a-z]+)?$/i');

    expect(parsed[1]).toEqual({ name: 'regex', args: ['/^[a-z]{1,3}(,[a-z]+)?$/i'] });
  });

  it('ignores empty segments and spaces', () => {
    expect(parseRules(' required | | string ')).toEqual([
      { name: 'required', args: [] },
      { name: 'string', args: [] },
    ]);
  });
});

describe('validateValue', () => {
  describe('presence', () => {
    it('demands a value with required', () => {
      expect(accepts('', 'required|string')).toBe(false);
      expect(accepts('   ', 'required|string')).toBe(false);
      expect(accepts('paper', 'required|string')).toBe(true);
    });

    // `nullable` has to short-circuit the other rules: applying them to an
    // allowed empty value would make it pointless, and the field would become
    // required with nothing to say so.
    it('lets emptiness through with nullable, applying nothing else', () => {
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
   * Laravel's trap, inherited as is by the eggs: `min`/`max` apply to a
   * number's **value** and to a text's **length**. Treating the two alike would
   * accept `999` where three characters were expected.
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
    it('accepts only the listed values', () => {
      expect(accepts('purpur', 'in:paper,purpur')).toBe(true);
      expect(accepts('spigot', 'in:paper,purpur')).toBe(false);
    });

    // An exact comparison: accepting "Paper" for "paper" would let through a
    // value the install script will not recognise.
    it('distingue la casse', () => {
      expect(accepts('Paper', 'in:paper,purpur')).toBe(false);
    });
  });

  describe('regex', () => {
    it('applies a delimited expression', () => {
      expect(accepts('1.21.4', 'regex:/^\\d+\\.\\d+(\\.\\d+)?$/')).toBe(true);
      expect(accepts('latest', 'regex:/^\\d+\\.\\d+(\\.\\d+)?$/')).toBe(false);
    });

    it('honore les drapeaux', () => {
      expect(accepts('PAPER', 'regex:/^paper$/i')).toBe(true);
    });

    // An unreadable expression is the template's mistake, not the user's:
    // blocking them on an error they cannot fix would make their server
    // unconfigurable.
    it('lets it through when the expression is invalid', () => {
      expect(accepts('peu importe', 'regex:/[/')).toBe(true);
    });
  });

  // A rule we cannot apply must not block everything: imported eggs contain
  // others, and refusing would make the server unconfigurable over a decorative
  // rule.
  it('ignores an unknown rule', () => {
    expect(accepts('paper', 'required|string|starts_with:pa')).toBe(true);
  });

  /**
   * Length bound applied **before** any evaluation.
   *
   * A template is written by an administrator, but nothing guarantees their
   * regular expression is sane: a badly formed one can take exponential time on
   * a long input. The bound closes that door without having to judge each
   * expression.
   */
  it('refuses an outsized value before evaluating the rules', () => {
    const huge = 'a'.repeat(MAX_VARIABLE_LENGTH + 1);

    expect(accepts(huge, 'nullable|string')).toBe(false);
    expect(validateValue(huge, 'nullable')[0]?.rule).toBe('max');
  });

  it('returns every rule that was broken', () => {
    const violations = validateValue('x', 'integer|min:10');

    expect(violations.map((violation) => violation.rule).sort()).toEqual(['integer', 'min']);
  });
});

/**
 * The rule applied to `SERVER_JARFILE` in the shipped templates.
 *
 * This variable was made editable, and this expression is what replaces the
 * protection that was removed: it imposes a **file name**, never a path. A
 * `.jar` dropped in `plugins/` therefore cannot be launched by mistake, and no
 * value can name anything else in the volume.
 */
describe('the templates .jar file rule', () => {
  const RULES = String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`;

  it.each(['server.jar', 'proxy.jar', 'paper-1.21.4.jar', 'Mon_Serveur-2.jar'])(
    'accepts "%s"',
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
  ])('rejects "%s"', (value) => {
    expect(accepts(value, RULES)).toBe(false);
  });
});

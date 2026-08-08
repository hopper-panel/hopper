import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VARIABLE_LENGTH, parseRules, validateValue } from './variable-rules.js';

/**
 * A malformed rule is reported at error level, which would otherwise paint this
 * suite red for the cases that are deliberately provoking one. Silenced here
 * and asserted on where it is the point of the test.
 *
 * Through a factory so the spy keeps its own type: annotating the variable with
 * `ReturnType<typeof vi.spyOn>` widens it to `any` and the assertions below stop
 * being checked at all.
 */
function silenceLogger() {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

let logged: ReturnType<typeof silenceLogger>;

beforeEach(() => {
  logged = silenceLogger();
});

afterEach(() => {
  logged.mockRestore();
});

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

  /**
   * The pipe, which is what an alternation is made of.
   *
   * Splitting the rule string before looking for `regex:` tore this into
   * `regex:/^(paper` and `purpur|spigot)$/`: the first no longer compiled, the
   * rest was read as rules nobody recognises and dropped. Eggs write
   * alternations constantly, so this shape is not an edge case — it is the
   * common one.
   */
  describe('a delimited regular expression', () => {
    it('survives an alternation', () => {
      expect(parseRules('required|string|regex:/^(paper|purpur|spigot)$/')).toEqual([
        { name: 'required', args: [] },
        { name: 'string', args: [] },
        { name: 'regex', args: ['/^(paper|purpur|spigot)$/'] },
      ]);
    });

    // The rules written after the expression have to come back too: an egg
    // does not always put its regex last, and swallowing the remainder would
    // drop them as silently as the split dropped the fragments.
    it('does not swallow the rules that follow it', () => {
      expect(parseRules('required|regex:/^(a|b)$/|max:10')).toEqual([
        { name: 'required', args: [] },
        { name: 'regex', args: ['/^(a|b)$/'] },
        { name: 'max', args: ['10'] },
      ]);
    });

    /**
     * The flags belong to the rule, so the rule cannot end before them.
     *
     * The alternation earns its place in the input: with no pipe inside the
     * expression, a scan that ended at the delimiter and left `i` behind would
     * fall back to cutting on the pipe and land on the very same boundary, and
     * the test would pass without the flags having been read at all.
     */
    it('ends after its flags', () => {
      expect(parseRules('regex:/^(a|b)$/i|max:5')).toEqual([
        { name: 'regex', args: ['/^(a|b)$/i'] },
        { name: 'max', args: ['5'] },
      ]);
    });

    /**
     * A capital is not a flag JavaScript knows, so the scan stops at the
     * delimiter and the rule falls to the pipe.
     *
     * The forgiving reading is the worse one, which is why this is pinned.
     * Swallowing the `I` would keep the rule whole, and the check would then
     * read `/^(a|b)$/I` as a *bare* pattern — which compiles, matches almost
     * nothing, and refuses every value while blaming the value. Torn instead,
     * the fragment does not compile and the operator is told their template is
     * at fault.
     */
    it('does not mistake a capital for a flag', () => {
      expect(parseRules('regex:/^(a|b)$/I|max:5')).toEqual([
        { name: 'regex', args: ['/^(a'] },
        // Lower-cased like every rule name, which is why it reads `/i` here.
        { name: 'b)$/i', args: [] },
        { name: 'max', args: ['5'] },
      ]);
    });

    // Inside a class a slash is a character, not the closing delimiter — as it
    // is in JavaScript's own regex literals — and a pipe is not an alternation.
    it('reads a character class holding a slash and a pipe', () => {
      expect(parseRules('regex:/^[a-z/|]+$/|max:8')).toEqual([
        { name: 'regex', args: ['/^[a-z/|]+$/'] },
        { name: 'max', args: ['8'] },
      ]);
    });

    /**
     * A `\/` is a slash the pattern matches, not the closing delimiter.
     *
     * The alternation behind it is again what gives the test teeth: an
     * expression holding no pipe is cut in the same place whether or not the
     * escape is understood, so `regex:/^a\/b$/|string` would pass either way.
     */
    it('reads an escaped delimiter', () => {
      expect(parseRules(String.raw`regex:/^a\/|b$/|string`)).toEqual([
        { name: 'regex', args: [String.raw`/^a\/|b$/`] },
        { name: 'string', args: [] },
      ]);
    });

    // An escape swallows exactly one character and no more. Here the escaped
    // slash stands against the real delimiter — the shape any expression
    // matching a URL path ends in — and a scan skipping two would eat the
    // delimiter as well, leaving an expression that never closes.
    it('reads an escaped delimiter standing against the closing one', () => {
      expect(parseRules(String.raw`regex:/^(a|b)\//|string`)).toEqual([
        { name: 'regex', args: [String.raw`/^(a|b)\//`] },
        { name: 'string', args: [] },
      ]);
    });

    // Spacing is the template writer's business, not the scanner's:
    // `required| regex:…` is the same template as `required|regex:…`, and an
    // opening the scan walks past is an alternation torn in half.
    it('recognises an opening standing behind a space', () => {
      expect(parseRules('required| regex:/^(a|b)$/|max:5')).toEqual([
        { name: 'required', args: [] },
        { name: 'regex', args: ['/^(a|b)$/'] },
        { name: 'max', args: ['5'] },
      ]);
    });

    // And on the other side, where a blank must not be mistaken for the
    // leftover that means the scan has misread the rule.
    it('allows a space between the expression and the pipe', () => {
      expect(parseRules('required|regex:/^(a|b)$/ |max:5')).toEqual([
        { name: 'required', args: [] },
        { name: 'regex', args: ['/^(a|b)$/'] },
        { name: 'max', args: ['5'] },
      ]);
    });

    // Rule names are matched case-insensitively everywhere else, and the scan
    // has to agree or a shouted rule stops being a regex halfway through the
    // parse. The expression itself keeps its case: folding that would change
    // what it matches.
    it('recognises an opening in capitals', () => {
      expect(parseRules('REGEX:/^(A|B)$/|max:5')).toEqual([
        { name: 'regex', args: ['/^(A|B)$/'] },
        { name: 'max', args: ['5'] },
      ]);
    });
  });

  /**
   * A `regex:/` whose expression never closes, and the delimiter the scan
   * borrows for it.
   *
   * Nothing in the rule string announces that the expression was left open, so
   * the scan runs on to the first `/` it can find — which may belong to a rule
   * further along, and swallow every rule in between. Two things catch that:
   * anything but a blank standing between the supposed end and the next pipe,
   * and an enclosed expression that will not compile. Both give up on the scan
   * and cut on the pipe instead, which is what an undelimited `regex:` gets and
   * is never wider than what the old split accepted.
   */
  describe('a delimited regular expression that never closes', () => {
    it('does not close on a delimiter with a leftover behind it', () => {
      expect(parseRules('regex:/^(a|b)$|in:x/y,z')).toEqual([
        { name: 'regex', args: ['/^(a'] },
        { name: 'b)$', args: [] },
        { name: 'in', args: ['x/y', 'z'] },
      ]);
    });

    it('does not close on a delimiter that leaves an expression it cannot compile', () => {
      expect(parseRules('regex:/^(a|b$|in:x/|max:5')).toEqual([
        { name: 'regex', args: ['/^(a'] },
        { name: 'b$', args: [] },
        { name: 'in', args: ['x/'] },
        { name: 'max', args: ['5'] },
      ]);
    });

    // Flags are part of what has to compile, because they are part of what
    // `checkRegex` will be handed: the scan judges the very string the check
    // will judge, so the two cannot disagree about what is applicable.
    it('does not close on a delimiter whose flags will not compile', () => {
      expect(parseRules('regex:/^(a|b)$/z|max:5')).toEqual([
        { name: 'regex', args: ['/^(a'] },
        { name: 'b)$/z', args: [] },
        { name: 'max', args: ['5'] },
      ]);
    });

    // And where there is no delimiter to borrow either — here the only `/`
    // left sits inside a character class — the scan simply finds no end, and
    // the pipe has to be what closes the rule.
    it('gives up when there is no closing delimiter to be found', () => {
      expect(parseRules('regex:/^[a/]$|max:5')).toEqual([
        { name: 'regex', args: ['/^[a/]$'] },
        { name: 'max', args: ['5'] },
      ]);
    });
  });

  /**
   * A `regex:` with no delimiters is cut on the pipe like anything else.
   *
   * Pterodactyl always delimits, so a bare one is hand-written and genuinely
   * ambiguous: nothing in `regex:^(a|b)$|max:5` tells the alternation's pipe
   * from the one introducing `max`. Cutting it keeps every rule that was
   * written, and errs the safe way round: what survives is the expression up to
   * its first pipe, either one branch of the alternation — a subset of what the
   * whole would have matched — or a fragment the cut left unbalanced, which
   * does not compile and refuses the value loudly. Neither is wider than
   * intended.
   */
  describe('an undelimited regular expression', () => {
    it('still splits on the pipe', () => {
      expect(parseRules('regex:^[a-z]+$|max:5')).toEqual([
        { name: 'regex', args: ['^[a-z]+$'] },
        { name: 'max', args: ['5'] },
      ]);
    });

    it('keeps the rules written after it, at the cost of the alternation', () => {
      expect(parseRules('regex:^(a|b)$|max:5')).toContainEqual({ name: 'max', args: ['5'] });
    });
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
    it('bound the value of a number', () => {
      expect(accepts('5', 'integer|min:1|max:10')).toBe(true);
      expect(accepts('50', 'integer|min:1|max:10')).toBe(false);
      expect(accepts('0', 'integer|min:1|max:10')).toBe(false);
    });

    it('bound the length of a text', () => {
      expect(accepts('paper', 'string|max:10')).toBe(true);
      expect(accepts('paper-the-longest', 'string|max:10')).toBe(false);
      expect(accepts('ab', 'string|min:3')).toBe(false);
    });

    it('between combines both bounds', () => {
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

    it('honours the flags', () => {
      expect(accepts('PAPER', 'regex:/^paper$/i')).toBe(true);
    });

    /**
     * The shape an imported egg actually contains.
     *
     * This is the check the bug hid: split first and the expression became
     * `/^(paper`, which fails to compile, and a failure to compile used to be
     * read as the template's problem and accept every value. A rule that reads
     * as the strictest line in the template enforced nothing at all.
     */
    describe('an alternation, as the eggs write it', () => {
      const RULES = 'required|string|regex:/^(paper|purpur|spigot)$/';

      it.each(['paper', 'purpur', 'spigot'])('accepts "%s"', (value) => {
        expect(accepts(value, RULES)).toBe(true);
      });

      it.each(['vanilla', 'paper2', '(paper', 'purpur)', ''])('refuses "%s"', (value) => {
        expect(accepts(value, RULES)).toBe(false);
      });
    });

    // The regex in the middle of the list, not at its end: what follows has to
    // be applied, or the scan has merely moved the silence one rule along.
    it('applies the rules written after the expression', () => {
      expect(accepts('paper', 'regex:/^(paper|purpur)$/|max:5')).toBe(true);
      expect(accepts('purpur', 'regex:/^(paper|purpur)$/|max:5')).toBe(false);
    });

    it('applies a class containing a slash', () => {
      expect(accepts('a/b', 'regex:/^[a-z/]+$/')).toBe(true);
      expect(accepts('A/B', 'regex:/^[a-z/]+$/')).toBe(false);
    });

    it('applies a class containing a pipe', () => {
      expect(accepts('a|b', 'regex:/^[a|b]+$/')).toBe(true);
      expect(accepts('c', 'regex:/^[a|b]+$/')).toBe(false);
    });

    it('applies an escaped delimiter', () => {
      expect(accepts('a/b', String.raw`regex:/^a\/b$/`)).toBe(true);
      expect(accepts('ab', String.raw`regex:/^a\/b$/`)).toBe(false);
    });

    it('honours the flags with a rule behind them', () => {
      expect(accepts('PAPER', 'regex:/^paper$/i|max:20')).toBe(true);
      expect(accepts('SPIGOT', 'regex:/^paper$/i|max:20')).toBe(false);
    });

    /**
     * An expression that cannot be compiled refuses the value.
     *
     * It used to accept it, on the grounds that the template is at fault and
     * the user cannot fix it — and that is what turned the splitting bug above
     * into silence, because the split manufactured uncompilable expressions and
     * this branch swallowed every one. A rule that fails open is not a rule.
     * The cost is admitted: the variable cannot be set until an administrator
     * edits the template. It is paid once, visibly, by the first person to
     * touch the variable.
     */
    describe('an expression that will not compile', () => {
      it('refuses the value', () => {
        expect(accepts('whatever', 'regex:/[/')).toBe(false);
        expect(accepts('whatever', 'required|regex:/^(unclosed$/')).toBe(false);
      });

      // Blaming the value would send somebody looking for what is wrong with
      // `server.jar`, which is nothing.
      it('blames the template rather than the value', () => {
        const violation = validateValue('whatever', 'regex:/[/')[0];

        expect(violation?.rule).toBe('regex');
        expect(violation?.message).toMatch(/template/i);
      });

      // Nobody else is going to report this: the user sees a field they cannot
      // fill, and has no idea the template is the reason.
      it('logs the variable and the rule at error level', () => {
        validateValue('whatever', 'required|regex:/[/', 'SERVER_JARFILE');

        expect(logged).toHaveBeenCalledWith(expect.stringContaining('SERVER_JARFILE'));
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('regex:/[/'));
      });

      /**
       * An empty value is the one that gets through, and it is still logged.
       *
       * No rule but `required` is ever applied to an empty value — that is what
       * makes `nullable` mean anything — so a broken expression cannot refuse
       * one. Without the log the operator of a variable normally left empty
       * would hear nothing at all, and would find out the day somebody first
       * needs to fill it in.
       */
      it('reports itself even when there is no value to refuse', () => {
        expect(accepts('', 'nullable|regex:/[/')).toBe(true);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('regex:/[/'));
      });

      it('reports itself before required has its say', () => {
        expect(validateValue('', 'required|regex:/[/')[0]?.rule).toBe('required');
        expect(logged).toHaveBeenCalledWith(expect.stringContaining('regex:/[/'));
      });

      // The ambiguous case, torn on its pipes by design. What matters is that
      // it lands here, loudly, rather than accepting everything in silence.
      it('catches an undelimited alternation', () => {
        expect(accepts('a', 'regex:^(a|b)$')).toBe(false);
        expect(logged).toHaveBeenCalled();
      });

      /**
       * The rules written after it survive, which is the point of giving up on
       * the scan rather than trusting a borrowed delimiter.
       *
       * Read as one expression — `/^(a|b$|in:x/`, closed on the slash belonging
       * to `in:` — the two rules behind it would vanish, and the only complaint
       * would be about the regex. Cut on the pipe, all three are applied.
       */
      it('keeps the rules standing behind a borrowed delimiter', () => {
        const violations = validateValue('123456', 'regex:/^(a|b$|in:x/|max:5');

        expect(violations.map((violation) => violation.rule).sort()).toEqual([
          'in',
          'max',
          'regex',
        ]);
      });
    });

    /**
     * A torn alternation is not always audible, and does not have to be.
     *
     * `regex:^a|b$` cuts to `^a`, which compiles perfectly well: it accepts
     * `apple`, logs nothing, and quietly turns away the `xxxb` its author meant
     * to allow. That is the ambiguity's real cost — not a refusal somebody
     * hears about, but an expression narrower than the one written. Narrower is
     * the direction that can be lived with in a file whose job is to narrow;
     * the way to avoid it altogether is to write the delimiters.
     */
    it('narrows an undelimited alternation to its first branch, in silence', () => {
      expect(accepts('apple', 'regex:^a|b$|max:5')).toBe(true);
      expect(accepts('xxxb', 'regex:^a|b$|max:5')).toBe(false);
      expect(logged).not.toHaveBeenCalled();
    });

    // The report an empty value triggers is for `regex:` rules alone. Reading
    // any rule's first argument as an expression would have `in:*,none`
    // denounced as a broken template, which is an alarm about nothing — and an
    // operator who has been woken by one stops reading the next.
    it('says nothing about a rule that is not an expression at all', () => {
      expect(accepts('', 'nullable|in:*,none')).toBe(true);
      expect(logged).not.toHaveBeenCalled();
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

  it.each(['server.jar', 'proxy.jar', 'paper-1.21.4.jar', 'My_Server-2.jar'])(
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
    'odd server.jar',
    '',
  ])('rejects "%s"', (value) => {
    expect(accepts(value, RULES)).toBe(false);
  });
});

/**
 * The rules the shipped catalogue already carries, unchanged by the scan.
 *
 * None of them holds a pipe inside its expression — the catalogue was written
 * around the bug, in character classes — so every one of them was cut correctly
 * by the old split and has to keep behaving identically. This is what would
 * notice if the scan had moved a boundary by one character.
 */
describe('the shipped catalogue rules', () => {
  const SAVE_NAME = 'required|string|regex:/^[A-Za-z0-9_-]{1,64}$/';
  const FACTORIO_VERSION = 'required|string|regex:/^[0-9a-z][0-9a-z.]{0,19}$/';

  it.each(['gamesave', 'my_world-2', 'a'.repeat(64)])('accepts "%s" as a save name', (value) => {
    expect(accepts(value, SAVE_NAME)).toBe(true);
  });

  it.each(['../../etc/passwd', 'save.zip', 'a b', 'a'.repeat(65), ''])(
    'rejects "%s" as a save name',
    (value) => {
      expect(accepts(value, SAVE_NAME)).toBe(false);
    },
  );

  it.each(['stable', 'experimental', '2.0.28'])('accepts "%s" as a version', (value) => {
    expect(accepts(value, FACTORIO_VERSION)).toBe(true);
  });

  it.each(['../1.1.110', 'stable/../../secrets', '..', 'http://elsewhere.test/x'])(
    'rejects "%s" as a version',
    (value) => {
      expect(accepts(value, FACTORIO_VERSION)).toBe(false);
    },
  );

  /**
   * Not one of them is malformed, so not one of them changes behaviour.
   *
   * Worth asserting rather than assuming: a malformed rule no longer passes
   * everything, it refuses everything, and a catalogue rule that did that would
   * make a shipped template's variable impossible to set. `catalog.spec.ts`
   * holds the same guard over the real catalogue; this one covers the strings
   * as this file reads them.
   */
  it('compiles every one of them without complaint', () => {
    const catalogue = [
      'required|string|max:20',
      'required|string|max:30',
      String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`,
      FACTORIO_VERSION,
      SAVE_NAME,
      'required|in:0,1',
      'nullable|string',
    ];

    for (const rules of catalogue) {
      validateValue('server.jar', rules, 'CATALOGUE');
    }

    expect(logged).not.toHaveBeenCalled();
  });
});

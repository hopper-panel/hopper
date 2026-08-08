import { Logger } from '@nestjs/common';

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
 *   regex:/…/       a regular expression, delimiters included, applied as is
 *
 * A `regex:` is read whole: the rule string is **scanned**, not split, so the
 * `|` of an alternation belongs to the expression and not to the rule list. An
 * expression that cannot be compiled refuses the value rather than accepting
 * it, and is reported in the log even when there is no value to refuse;
 * `checkRegex` below says why that is the only safe direction for a file whose
 * job is to narrow what reaches a startup command.
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

/** A malformed rule is the operator's fault, and nobody else will report it. */
const logger = new Logger('VariableRules');

export interface RuleViolation {
  rule: string;
  message: string;
}

interface ParsedRule {
  name: string;
  args: string[];
}

/** The rule name, and so how far past its start the expression begins. */
const REGEX_RULE = 'regex:';

/** What opens a region the pipe does not divide. Lower case: the scan folds. */
const DELIMITED_REGEX = `${REGEX_RULE}/`;

/**
 * Cuts a rule string into its rules.
 *
 * `|` separates rules, **except** inside a delimited `regex:` — and that
 * exception is the whole reason this scans rather than calling `split('|')`.
 * Eggs write alternations constantly, `regex:/^(paper|purpur)$/`, and splitting
 * first tore that into `regex:/^(paper` and `purpur)$/`: the first no longer
 * compiled, the second was read as a rule nobody recognises and dropped. The
 * strictest-looking line in a template enforced nothing whatever, and said
 * nothing about it either.
 *
 * So a rule opening with `regex:/` is consumed through its closing `/` and its
 * flags, and only then may a `|` end it. Everything else is still cut on the
 * pipe, exactly as before.
 */
export function parseRules(raw: string): ParsedRule[] {
  return splitRules(raw)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const separator = part.indexOf(':');

      if (separator === -1) {
        return { name: part.toLowerCase(), args: [] };
      }

      const name = part.slice(0, separator).toLowerCase();
      const rest = part.slice(separator + 1);

      // `regex:` keeps its argument whole: it contains commas and colons that
      // must not be split. Its pipes survived one step earlier, in the scan.
      return { name, args: name === 'regex' ? [rest] : rest.split(',') };
    });
}

function splitRules(raw: string): string[] {
  const parts: string[] = [];
  let start = 0;

  // A pipe closing the last rule leaves nothing but emptiness behind it, so
  // stopping at the end of the string drops no rule.
  while (start < raw.length) {
    const end = endOfRule(raw, start);

    parts.push(raw.slice(start, end));
    start = end + 1;
  }

  return parts;
}

/**
 * Index of the `|` closing the rule that begins at `start`, or the end of the
 * string.
 *
 * A `regex:` **not** followed by `/` is cut on the pipe like any other rule.
 * Pterodactyl always delimits, so a bare one is hand-written, and it is
 * genuinely ambiguous: in `regex:^(a|b)$|max:5` nothing tells the alternation's
 * pipe from the one introducing `max`. Cutting keeps every rule that was
 * written, and errs the safe way round. What the cut leaves is the expression
 * up to its first pipe: either one branch of the alternation, which matches a
 * subset of what the whole would have matched — `regex:^a|b$` becomes `^a`,
 * which no longer admits the `b` branch — or a fragment the cut left unbalanced
 * or dangling, which does not compile and refuses the value loudly. Neither can
 * accept more than the template's author asked for. The other reading,
 * swallowing the rest of the string, would silently drop every rule written
 * after the regex, which is the same silent under-validation this file has just
 * stopped doing, moved one rule to the right.
 *
 * The narrowing is not always audible: a torn fragment often compiles, and its
 * author then finds their expression stricter than they wrote it with nothing
 * in the log to explain why. That is the cost of the ambiguity; it is the
 * cheaper direction, and delimiting the expression avoids it entirely.
 */
function endOfRule(raw: string, start: number): number {
  const head = skipSpaces(raw, start);

  if (raw.slice(head, head + DELIMITED_REGEX.length).toLowerCase() === DELIMITED_REGEX) {
    const closing = endOfExpression(raw, head + DELIMITED_REGEX.length);

    if (closing !== -1) {
      const next = skipSpaces(raw, closing);

      // Two tests that the `/` the scan stopped on really was the author's
      // closing delimiter, because on an unterminated expression the scan will
      // happily borrow one from a rule further along. Nothing but blanks may
      // stand between the expression and the pipe: any other leftover means we
      // have not understood the rule. And what the scan enclosed has to
      // compile — the borrowed delimiter usually makes nonsense of the
      // expression, and there is no reading under which an expression this
      // file cannot apply is the one worth keeping. It is the very string
      // `checkRegex` will be handed, so the two always agree.
      //
      // Failing either test falls back to the pipe below, which is how the
      // whole rule string was cut before there was a scan at all: never wider
      // than what this file already accepted.
      //
      // One case is left uncaught, knowingly. If a `regex:/` is never closed
      // and a later rule lends it a `/`, and the region between them happens to
      // compile, nothing in the string distinguishes that from a correctly
      // delimited expression — `regex:/^(a|b)$|in:x/|max:5` reads as one valid
      // regex and quietly swallows `in:x`. Catching it would mean refusing an
      // expression that spans a `|` followed by something that looks like a
      // rule name, which breaks the legitimate `regex:/^(a|max:5)$/` to rescue
      // a template that is already malformed. A widening confined to broken
      // templates is the better of the two, so it stays and is written down.
      const enclosed = raw.slice(head + REGEX_RULE.length, closing);

      if ((next === raw.length || raw[next] === '|') && compileExpression(enclosed) !== null) {
        return next;
      }
    }
  }

  const pipe = raw.indexOf('|', start);

  return pipe === -1 ? raw.length : pipe;
}

/**
 * Scans a delimited expression from the first character of its body, and
 * returns the index just past its closing `/` and flags — or -1 if it never
 * closes.
 *
 * Two slashes are not the end of anything: a `\/`, which is a slash the pattern
 * matches, and a `/` inside a `[…]` class, which JavaScript's own regex-literal
 * grammar also reads as ordinary. Stopping at either cuts a working expression
 * in half, and what is left is no longer the expression its author wrote: one
 * that will not compile, if they are lucky and hear about it, and otherwise one
 * that quietly matches something else entirely.
 */
function endOfExpression(raw: string, from: number): number {
  let inClass = false;

  for (let index = from; index < raw.length; index += 1) {
    const character = raw[index];

    if (character === '\\') {
      // The escape swallows whatever follows, delimiter included.
      index += 1;
      continue;
    }

    if (inClass) {
      inClass = character !== ']';
      continue;
    }

    if (character === '[') {
      inClass = true;
      continue;
    }

    if (character === '/') {
      // Lower case only, because every flag JavaScript accepts is lower case.
      //
      // Taking capitals too looks more forgiving and is worse. `/^(a|b)$/I` is
      // a broken expression either way, but swallowing the `I` keeps the rule
      // whole, and `checkRegex` then reads the whole thing as a *bare* pattern
      // — which compiles, matches almost nothing, and refuses every value
      // while blaming the value. Stopping at the `/` instead lets the rule fall
      // to the pipe, where the fragment fails to compile and the operator gets
      // the logged "your template's rule is malformed" they can act on.
      //
      // This only decides where the rule ends; whether a run of lower-case
      // letters is a flag set a regular expression will accept is
      // `checkRegex`'s business.
      let end = index + 1;

      while (end < raw.length && /[a-z]/.test(raw[end] ?? '')) {
        end += 1;
      }

      return end;
    }
  }

  return -1;
}

function skipSpaces(raw: string, from: number): number {
  let index = from;

  while (index < raw.length && /\s/.test(raw[index] ?? '')) {
    index += 1;
  }

  return index;
}

/**
 * Checks a value against a set of rules.
 *
 * @param subject the variable the rules belong to, used only to name it in the
 *   log when one of them turns out to be malformed. Optional because a rule
 *   string is checkable on its own; a log line saying which rule broke without
 *   saying where it lives is still worth having.
 * @returns the list of rules broken, empty if the value is acceptable.
 */
export function validateValue(
  value: string,
  raw: string,
  subject = 'an unnamed variable',
): RuleViolation[] {
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
    // The verdict is deliberately thrown away — what an empty value is worth is
    // decided just below, not by an expression — but the call is kept for the
    // log line inside it. A non-empty value produces that same line *and* a
    // violation the operator sees; an empty one produces neither unless we ask,
    // so a variable normally left empty would keep its broken rule secret until
    // the day somebody finally fills it in.
    for (const rule of rules) {
      if (rule.name === 'regex') {
        checkRegex(rule.args[0] ?? '', value, subject);
      }
    }

    if (rules.some((rule) => rule.name === 'required')) {
      return [{ rule: 'required', message: 'This value is required.' }];
    }

    // An allowed empty value does not have to satisfy `integer` or `in:`:
    // checking it anyway would make `nullable` pointless.
    return [];
  }

  for (const rule of rules) {
    const violation = check(rule, value, subject);

    if (violation) {
      violations.push(violation);
    }
  }

  return violations;
}

function check(rule: ParsedRule, value: string, subject: string): RuleViolation | null {
  const numeric = Number(value);

  switch (rule.name) {
    case 'required':
    case 'nullable':
    case 'string':
      return null;

    case 'integer':
      return Number.isInteger(numeric)
        ? null
        : { rule: 'integer', message: 'A whole number is expected.' };

    case 'numeric':
      return Number.isFinite(numeric)
        ? null
        : { rule: 'numeric', message: 'A number is expected.' };

    case 'boolean':
      return ['0', '1', 'true', 'false'].includes(value.toLowerCase())
        ? null
        : { rule: 'boolean', message: 'Expected value: true or false.' };

    case 'alpha_num':
      return /^[a-zA-Z0-9]+$/.test(value)
        ? null
        : { rule: 'alpha_num', message: 'Letters and digits only.' };

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
      return checkRegex(rule.args[0] ?? '', value, subject);

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

  const subject = isNumber ? 'The value' : 'The length';
  const limit = kind === 'min' ? 'at least' : 'at most';

  return { rule: kind, message: `${subject} has to be ${limit} ${bound}.` };
}

/**
 * Applies a template's expression, refusing the value when the expression
 * cannot be read.
 *
 * This used to accept the value instead, reasoning that an unreadable
 * expression is the template's fault and that blocking a user on a mistake they
 * cannot fix helps nobody. That reasoning is what turned the splitting bug
 * above into silence: the split manufactured uncompilable expressions by the
 * dozen, this branch swallowed every one, and a `regex:` guarding a file name
 * or a download URL accepted anything at all with nothing anywhere saying so. A
 * validation rule that fails open is not a validation rule, and the more a
 * particular rule matters the more expensive its silence is.
 *
 * So the value is refused, and the message blames the template rather than the
 * value: without that, somebody spends an afternoon working out what is wrong
 * with `server.jar`. The log line exists for the same reason as the message —
 * this is an operator-facing fault, and the user hitting it has no way to
 * report anything useful about it.
 *
 * What it trades away is real. Until an administrator edits the template, that
 * variable can hold nothing but an empty value — and not even that where the
 * template says `required` — so a user who only wanted to rename their jar is
 * stuck behind a broken template. That is the right way round: the block is
 * visible, it lands on the first person to touch the variable, and one edit
 * clears it — whereas failing open is a hole nobody is ever told about, on
 * precisely the variables somebody thought worth constraining. Since the scan
 * above, few expressions reach this branch at all: the split was manufacturing
 * most of the failures, so what is left is a genuinely broken template.
 */
function checkRegex(pattern: string, value: string, subject: string): RuleViolation | null {
  const expression = compileExpression(pattern);

  if (!expression) {
    // Precise about the one value that still gets through, because an operator
    // told "no value is accepted" who then watches an empty one save will trust
    // nothing else the line says.
    logger.error(
      `Template variable ${subject} carries a rule that is not a valid regular expression ` +
        `(regex:${pattern}). Every value will be refused for that variable until the template ` +
        `is corrected, bar an empty one where no required rule stands beside it.`,
    );

    return {
      rule: 'regex',
      message:
        "This variable's template rule is malformed and cannot be applied; " +
        'an administrator has to correct the template.',
    };
  }

  return expression.test(value)
    ? null
    : { rule: 'regex', message: 'This value is not in the expected format.' };
}

/**
 * Reads a `regex:` argument, `/pattern/flags` as the eggs write it or a bare
 * pattern, and returns null when it cannot be read.
 *
 * The scan above uses this too, on the region it thinks is an expression, so
 * that what it decides to keep whole and what this file can actually apply are
 * the same judgement made once.
 */
function compileExpression(pattern: string): RegExp | null {
  // The `/pattern/flags` form, as it appears in eggs.
  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(pattern);

  try {
    return delimited ? new RegExp(delimited[1] ?? '', delimited[2]) : new RegExp(pattern);
  } catch {
    return null;
  }
}

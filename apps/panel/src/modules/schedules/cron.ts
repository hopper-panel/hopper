/**
 * Cron expressions: parsing and computing the next occurrence.
 *
 * Written here rather than borrowed from a library, for two reasons.
 *
 * First, the ground to cover is narrow and known: five fields, the syntax
 * everybody writes in a crontab. The libraries in this space add seconds,
 * years, time zones, `L`, `W`, `#`, Quartz dialects — all behaviours that would
 * have to be documented and none of which is asked for.
 *
 * Second and above all, this is code that **decides when a server restarts**. A
 * mistake here is invisible: it shows up as a restart that does not happen, or
 * happens at the wrong moment, weeks later. Keeping it short and fully tested
 * beats trusting a dependency of which a tenth would be exercised.
 *
 * Syntax recognised, per field:
 *
 *   `*`        every value
 *   `5`        one value
 *   `1,3,5`    a list
 *   `1-5`      a range
 *   a star followed by `/15`: a step, from the start of the domain
 *   `10-30/5`  a step, over a range
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
  readonly label: string;
}

const FIELDS = {
  minute: { min: 0, max: 59, label: 'minute' },
  hour: { min: 0, max: 23, label: 'heure' },
  dayOfMonth: { min: 1, max: 31, label: 'jour du mois' },
  month: { min: 1, max: 12, label: 'mois' },
  dayOfWeek: { min: 0, max: 6, label: 'jour de la semaine' },
} as const satisfies Record<keyof CronExpression, FieldRange>;

/**
 * Expands a field into the set of values it designates.
 *
 * @throws {CronError} on any unrecognised syntax: better to refuse at creation
 *   time than accept an expression that will never fire.
 */
export function parseField(raw: string, field: keyof CronExpression): number[] {
  const range = FIELDS[field];
  const trimmed = raw.trim();

  if (trimmed === '') {
    throw new CronError(`Champ « ${range.label} » vide.`);
  }

  const values = new Set<number>();

  for (const part of trimmed.split(',')) {
    for (const value of parsePart(part.trim(), range)) {
      values.add(value);
    }
  }

  // `7` is accepted for Sunday, as in most crontabs, and folded onto `0` —
  // without which it would never match `getDay()`.
  if (field === 'dayOfWeek' && values.delete(7)) {
    values.add(0);
  }

  return [...values].sort((left, right) => left - right);
}

function parsePart(part: string, range: FieldRange): number[] {
  const [spec, stepText, ...extra] = part.split('/');

  if (extra.length > 0 || spec === undefined) {
    throw new CronError(`Expression "${part}" is invalid for field ${range.label}.`);
  }

  let step = 1;

  if (stepText !== undefined) {
    step = Number.parseInt(stepText, 10);

    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`Step "${stepText}" is invalid for field ${range.label}.`);
    }
  }

  const [from, to] = boundsOf(spec, range, part);
  const values: number[] = [];

  for (let value = from; value <= to; value += step) {
    values.push(value);
  }

  return values;
}

function boundsOf(spec: string, range: FieldRange, part: string): [number, number] {
  if (spec === '*') {
    return [range.min, range.max];
  }

  const [fromText, toText, ...extra] = spec.split('-');

  if (extra.length > 0 || fromText === undefined) {
    throw new CronError(`Expression "${part}" is invalid for field ${range.label}.`);
  }

  const from = toNumber(fromText, range, part);

  // `5/15` with no explicit upper bound walks the rest of the domain, as in a
  // crontab — not the single value 5.
  const to =
    toText === undefined ? (part.includes('/') ? range.max : from) : toNumber(toText, range, part);

  if (to < from) {
    throw new CronError(
      `Descending range "${part}" for field ${range.label}: ranges that wrap ` +
        'through zero are not supported, write two of them separated by a comma.',
    );
  }

  return [from, to];
}

function toNumber(text: string, range: FieldRange, part: string): number {
  const value = Number.parseInt(text, 10);

  if (!/^\d+$/.test(text.trim()) || !Number.isInteger(value)) {
    throw new CronError(`« ${text} » n'est pas un nombre (champ ${range.label}).`);
  }

  // The day-of-week domain accepts 7, folded to 0 above.
  const max = range.label === 'jour de la semaine' ? 7 : range.max;

  if (value < range.min || value > max) {
    throw new CronError(
      `"${value}" is outside the ${range.min}–${range.max} bounds of field ${range.label} ` +
        `(expression « ${part} »).`,
    );
  }

  return value;
}

/** Checks a whole expression. Throws on the first faulty field. */
export function validateCron(expression: CronExpression): void {
  for (const field of Object.keys(FIELDS) as (keyof CronExpression)[]) {
    parseField(expression[field], field);
  }
}

/**
 * Largest number of minutes explored when looking for an occurrence.
 *
 * Four years and a day, to cover 29 February of a leap year. Beyond that, the
 * expression matches nothing — `0 0 30 2 *`, 30 February — and it is better to
 * say so than to loop.
 */
const SEARCH_LIMIT_MINUTES = 4 * 366 * 24 * 60;

/**
 * Next occurrence strictly later than `from`.
 *
 * Advances minute by minute rather than computing the date directly. It is
 * slower — at worst a few hundred thousand iterations over integer comparisons,
 * so a few milliseconds — but it avoids the whole combinatorics of months of
 * different lengths, leap years and the day-of-month / day-of-week crossing.
 * The computation happens once per scheduled task run.
 *
 * @throws {CronError} if the expression matches no reachable date.
 */
export function nextOccurrence(expression: CronExpression, from: Date): Date {
  const minutes = parseField(expression.minute, 'minute');
  const hours = parseField(expression.hour, 'hour');
  const daysOfMonth = parseField(expression.dayOfMonth, 'dayOfMonth');
  const months = parseField(expression.month, 'month');
  const daysOfWeek = parseField(expression.dayOfWeek, 'dayOfWeek');

  // A day-of-month and a day-of-week both restricted combine with **or**, not
  // **and**: `0 0 1 * 1` fires on the 1st of the month *and* every Monday. That
  // is cron's behaviour, counter-intuitive but the one every existing crontab
  // assumes.
  const dayOfMonthRestricted = expression.dayOfMonth.trim() !== '*';
  const dayOfWeekRestricted = expression.dayOfWeek.trim() !== '*';

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let step = 0; step < SEARCH_LIMIT_MINUTES; step += 1) {
    const matchesDayOfMonth = daysOfMonth.includes(candidate.getDate());
    const matchesDayOfWeek = daysOfWeek.includes(candidate.getDay());

    const dayMatches =
      dayOfMonthRestricted && dayOfWeekRestricted
        ? matchesDayOfMonth || matchesDayOfWeek
        : matchesDayOfMonth && matchesDayOfWeek;

    if (
      minutes.includes(candidate.getMinutes()) &&
      hours.includes(candidate.getHours()) &&
      months.includes(candidate.getMonth() + 1) &&
      dayMatches
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new CronError('This expression matches no date in the next four years.');
}

/** Returns the expression in its usual form, for display and for logs. */
export function formatCron(expression: CronExpression): string {
  return [
    expression.minute,
    expression.hour,
    expression.dayOfMonth,
    expression.month,
    expression.dayOfWeek,
  ].join(' ');
}

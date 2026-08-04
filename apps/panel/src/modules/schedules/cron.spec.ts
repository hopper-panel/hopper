import { describe, expect, it } from 'vitest';
import { CronError, formatCron, nextOccurrence, parseField, validateCron } from './cron.js';

/**
 * Reading shortcut: `at('2026-08-03 10:00')`.
 *
 * Slicing by position rather than by `split`: the latter returns possibly
 * absent elements, which would then have to be ruled out with assertions for a
 * format entirely under our control.
 */
function at(text: string): Date {
  return new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(5, 7)) - 1,
    Number(text.slice(8, 10)),
    Number(text.slice(11, 13)),
    Number(text.slice(14, 16)),
    0,
    0,
  );
}

function iso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

describe('parseField', () => {
  it('expands the asterisk over the whole domain', () => {
    expect(parseField('*', 'hour')).toHaveLength(24);
    expect(parseField('*', 'minute')).toHaveLength(60);
    expect(parseField('*', 'dayOfMonth')[0]).toBe(1);
  });

  it('accepts a value, a list and a range', () => {
    expect(parseField('5', 'hour')).toEqual([5]);
    expect(parseField('1,3,5', 'hour')).toEqual([1, 3, 5]);
    expect(parseField('1-4', 'hour')).toEqual([1, 2, 3, 4]);
  });

  it('accepts a step', () => {
    expect(parseField('*/15', 'minute')).toEqual([0, 15, 30, 45]);
    expect(parseField('10-30/10', 'minute')).toEqual([10, 20, 30]);
  });

  // `5/15` walks the rest of the domain, as in a crontab: without that it
  // would only name minute 5 and the task would run once an hour instead of
  // four times.
  it('runs to the end of the domain with an unbounded step', () => {
    expect(parseField('5/15', 'minute')).toEqual([5, 20, 35, 50]);
  });

  it('deduplicates and sorts', () => {
    expect(parseField('5,1,5,3', 'hour')).toEqual([1, 3, 5]);
  });

  // Cron's historical behaviour, which every existing crontab assumes.
  it('folds 7 onto 0 for Sunday', () => {
    expect(parseField('7', 'dayOfWeek')).toEqual([0]);
    expect(parseField('0,7', 'dayOfWeek')).toEqual([0]);
  });

  describe('refusals', () => {
    // Refuse at creation rather than accept an expression that would never
    // fire: the user would believe their task was scheduled.
    it.each([
      ['', 'minute'],
      ['abc', 'hour'],
      ['60', 'minute'],
      ['24', 'hour'],
      ['0', 'dayOfMonth'],
      ['32', 'dayOfMonth'],
      ['13', 'month'],
      ['8', 'dayOfWeek'],
      ['*/0', 'minute'],
      ['5-1', 'hour'],
      ['1-2-3', 'hour'],
    ] as const)('rejects "%s" for %s', (raw, field) => {
      expect(() => parseField(raw, field)).toThrow(CronError);
    });
  });
});

describe('nextOccurrence', () => {
  it('finds the next matching minute', () => {
    const next = nextOccurrence(
      { minute: '30', hour: '4', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      at('2026-08-03 10:00'),
    );

    expect(iso(next)).toBe('2026-08-04 04:30');
  });

  // Strictly later: otherwise a task that just ran would be retriggered at
  // once, in a loop.
  it('is strictly later than the instant given', () => {
    const next = nextOccurrence(
      { minute: '0', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      at('2026-08-03 10:00'),
    );

    expect(iso(next)).toBe('2026-08-03 11:00');
  });

  it('handles a step on the minutes', () => {
    const next = nextOccurrence(
      { minute: '*/15', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      at('2026-08-03 10:07'),
    );

    expect(iso(next)).toBe('2026-08-03 10:15');
  });

  it('moves on to the next month', () => {
    const next = nextOccurrence(
      { minute: '0', hour: '0', dayOfMonth: '1', month: '*', dayOfWeek: '*' },
      at('2026-08-15 12:00'),
    );

    expect(iso(next)).toBe('2026-09-01 00:00');
  });

  it('finds a 29 February', () => {
    const next = nextOccurrence(
      { minute: '0', hour: '0', dayOfMonth: '29', month: '2', dayOfWeek: '*' },
      at('2026-03-01 00:00'),
    );

    expect(iso(next)).toBe('2028-02-29 00:00');
  });

  it('honours the day of the week', () => {
    // 3 August 2026 is a Monday; the following Tuesday is the 4th.
    const next = nextOccurrence(
      { minute: '0', hour: '6', dayOfMonth: '*', month: '*', dayOfWeek: '2' },
      at('2026-08-03 10:00'),
    );

    expect(iso(next)).toBe('2026-08-04 06:00');
    expect(next.getDay()).toBe(2);
  });

  /**
   * Cron's classic trap, and the one that restarts a server at the wrong
   * moment: when the day of the month **and** the day of the week are both
   * restricted, they combine with **or**, not with **and**.
   */
  describe('day-of-month / day-of-week crossing', () => {
    it('combines with OR when both are restricted', () => {
      const expression = { minute: '0', hour: '0', dayOfMonth: '15', month: '8', dayOfWeek: '1' };

      // Monday 10 August comes before the 15th: it really is an OR.
      const next = nextOccurrence(expression, at('2026-08-05 12:00'));

      expect(iso(next)).toBe('2026-08-10 00:00');
      expect(next.getDay()).toBe(1);
    });

    it('combines with AND as soon as one of the two is free', () => {
      // Day of month restricted, day of week free: only the 15th counts.
      const next = nextOccurrence(
        { minute: '0', hour: '0', dayOfMonth: '15', month: '8', dayOfWeek: '*' },
        at('2026-08-05 12:00'),
      );

      expect(iso(next)).toBe('2026-08-15 00:00');
    });
  });

  // An impossible expression has to report itself, not run the search forever
  // nor return a fanciful date.
  it('refuses an expression that matches no date', () => {
    expect(() =>
      nextOccurrence(
        { minute: '0', hour: '0', dayOfMonth: '30', month: '2', dayOfWeek: '*' },
        at('2026-01-01 00:00'),
      ),
    ).toThrow(CronError);
  });

  // The seconds of the starting instant must not shift the result.
  it('ignores the seconds of the instant given', () => {
    const from = at('2026-08-03 10:00');
    from.setSeconds(59, 999);

    const next = nextOccurrence(
      { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      from,
    );

    expect(iso(next)).toBe('2026-08-03 10:01');
    expect(next.getSeconds()).toBe(0);
  });
});

describe('validateCron', () => {
  it('accepts a complete expression', () => {
    expect(() =>
      validateCron({ minute: '0', hour: '5', dayOfMonth: '*', month: '*', dayOfWeek: '1-5' }),
    ).not.toThrow();
  });

  it('reports the faulty field', () => {
    expect(() =>
      validateCron({ minute: '0', hour: '99', dayOfMonth: '*', month: '*', dayOfWeek: '*' }),
    ).toThrow(/heure/);
  });
});

describe('formatCron', () => {
  it('returns the usual form', () => {
    expect(
      formatCron({ minute: '0', hour: '5', dayOfMonth: '*', month: '*', dayOfWeek: '1-5' }),
    ).toBe('0 5 * * 1-5');
  });
});

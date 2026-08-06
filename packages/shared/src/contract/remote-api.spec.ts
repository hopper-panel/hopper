import { describe, expect, it } from 'vitest';
import { statusReportSchema } from './remote-api.js';

/**
 * What a daemon may tell the panel about a stop, across versions.
 *
 * Panels and daemons are not upgraded together — that is the entire reason
 * this contract exists — so every field added here has to survive meeting a
 * peer that has never heard of it, in both directions. A status report is the
 * worst thing to lose to a version skew: it is what turns a server going down
 * into a notification somebody acts on.
 */

const MINIMAL = { state: 'offline', at: 1_754_500_000_000 };

describe('statusReportSchema', () => {
  it('accepts a report from a daemon that predates the cause', () => {
    const parsed = statusReportSchema.parse({ ...MINIMAL, expected: false, exitCode: 1 });

    expect(parsed.cause).toBeUndefined();
    expect(parsed.expected).toBe(false);
  });

  it('carries a readiness failure through', () => {
    // `expected: false` alone leaves the panel one hardcoded sentence about a
    // process that stopped on its own, which is untrue of the one stop the
    // daemon itself ordered.
    expect(statusReportSchema.parse({ ...MINIMAL, cause: 'readiness_failed' }).cause).toBe(
      'readiness_failed',
    );
  });

  it('degrades a cause it has never heard of instead of refusing the report', () => {
    // This panel is the old panel of every release after it. A cause added
    // later has to arrive as "no cause given" — the report is still the only
    // notification saying the server went down, and rejecting it outright
    // would trade a slightly vaguer sentence for complete silence.
    const parsed = statusReportSchema.safeParse({
      ...MINIMAL,
      expected: false,
      cause: 'quarantined_by_a_future_hopper',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.cause).toBeUndefined();
    expect(parsed.data?.expected).toBe(false);
  });

  it('ignores fields it does not know at all', () => {
    // The other half of the same promise, and the reason no CONTRACT_VERSION
    // bump was needed: a newer daemon sending more than this panel understands
    // has the extra stripped, not the request rejected.
    expect(
      statusReportSchema.safeParse({ ...MINIMAL, somethingAddedLater: { deep: true } }).success,
    ).toBe(true);
  });
});

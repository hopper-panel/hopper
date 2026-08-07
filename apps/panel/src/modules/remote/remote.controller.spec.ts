import type { StatusReport } from '@hopper/shared';
import { describe, expect, it } from 'vitest';
import { describeStop } from './remote.controller.js';

/**
 * What the recipient of a crash notification is told.
 *
 * This sentence is the whole of what most operators ever see about a stop:
 * the console it happened in is not open, and the panel does not store the
 * state. Getting it wrong sends somebody looking for a crash that never
 * happened.
 */

const report = (fields: Partial<StatusReport>): StatusReport => ({
  state: 'offline',
  at: Date.now(),
  expected: false,
  oomKilled: false,
  ...fields,
});

describe('describeStop', () => {
  it('names Hopper when Hopper is what stopped the server', () => {
    // The daemon stops a server whose readiness never confirmed. Reported as
    // "the process stopped on its own", that is a lie about who did it — and
    // it came with the exit code of the SIGTERM the daemon had just sent.
    expect(describeStop(report({ cause: 'readiness_failed', exitCode: 143 }))).toContain('Hopper');
  });

  it('points at the console, where the actual reason is', () => {
    // The daemon prints the precise line before giving up — which pattern
    // never matched, which port never answered. The notification says who
    // stopped the server and where to read why, rather than trying to be both.
    expect(describeStop(report({ cause: 'readiness_failed' }))).toContain('console');
  });

  it('keeps the old sentence for a daemon that sends no cause', () => {
    // The degradation that matters: a node running a daemon older than the
    // field sends nothing, and the notification is the one this panel has
    // always produced. Less precise, never missing.
    expect(describeStop(report({}))).toBe('the process stopped on its own');
  });

  it('still puts running out of memory first', () => {
    // The kernel killing the container explains a stop nobody understands, and
    // it outranks everything else: a readiness check that never confirmed
    // because the server was being killed is a symptom, not the cause.
    expect(describeStop(report({ oomKilled: true, cause: 'readiness_failed' }))).toContain(
      'out of memory',
    );
  });
});

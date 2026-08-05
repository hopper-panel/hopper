import { describe, expect, it } from 'vitest';
import { KILL_OFFERED_AFTER_MS, shouldOfferKill } from './ServerDetail';

/**
 * Kill cuts the process without saving. Offering it at the wrong moment is not
 * a cosmetic mistake: too early and it gets clicked instead of Stop, which
 * leaves a world written to disk mid-save.
 */
describe('shouldOfferKill', () => {
  it('is never offered while the server runs', () => {
    expect(shouldOfferKill('running', 10 * KILL_OFFERED_AFTER_MS)).toBe(false);
  });

  it('is never offered on a server already stopped', () => {
    expect(shouldOfferKill('offline', 10 * KILL_OFFERED_AFTER_MS)).toBe(false);
  });

  // The daemon waits `stopTimeoutSeconds` — 30 by default — then sends SIGKILL
  // itself. Offering Kill inside that window would have someone racing the
  // daemon's own escalation, and losing the save it was waiting for.
  it('is not offered while the daemon may still be waiting', () => {
    expect(shouldOfferKill('stopping', 0)).toBe(false);
    expect(shouldOfferKill('stopping', 30_000)).toBe(false);
    expect(shouldOfferKill('stopping', KILL_OFFERED_AFTER_MS)).toBe(false);
  });

  it('is offered once that window has clearly passed', () => {
    expect(shouldOfferKill('stopping', KILL_OFFERED_AFTER_MS + 1)).toBe(true);
  });

  // Null means the page is not counting: the server is not stopping at all.
  it('is not offered when nothing is being timed', () => {
    expect(shouldOfferKill('stopping', null)).toBe(false);
  });

  it('leaves the daemon its full grace period', () => {
    expect(KILL_OFFERED_AFTER_MS).toBeGreaterThan(30_000);
  });
});

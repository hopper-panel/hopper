import { describe, expect, it } from 'vitest';
import { planRetention, type RetainableBackup } from './retention.js';

function backup(uuid: string, day: number, locked = false): RetainableBackup {
  return { uuid, locked, createdAt: new Date(2026, 7, day) };
}

describe('planRetention', () => {
  it('removes nothing while a slot remains', () => {
    const plan = planRetention([backup('a', 1), backup('b', 2)], 3);

    expect(plan).toEqual({ kind: 'ok', remove: [] });
  });

  // The common case, and the easiest to get wrong: with 3 slots and 3 backups,
  // **one** has to go, not zero. A `>` instead of a `>=` would overshoot the
  // limit by one on every cycle.
  it('frees a slot when the limit is reached', () => {
    const plan = planRetention([backup('a', 1), backup('b', 2), backup('c', 3)], 3);

    expect(plan.kind).toBe('ok');
    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['a']);
  });

  it('removes the oldest, whatever order it was given', () => {
    const plan = planRetention([backup('recent', 9), backup('ancien', 1), backup('milieu', 5)], 2);

    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual([
      'ancien',
      'milieu',
    ]);
  });

  it('catches up an overshoot left by a lowered limit', () => {
    const existing = [backup('a', 1), backup('b', 2), backup('c', 3), backup('d', 4)];

    const plan = planRetention(existing, 2);

    // Four present, two slots, one to come: three have to go.
    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['a', 'b', 'c']);
  });

  // The lock's whole reason for being: it holds against retention.
  describe('locking', () => {
    it('spares a locked backup and takes the next one', () => {
      const plan = planRetention([backup('a', 1, true), backup('b', 2), backup('c', 3)], 3);

      expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['b']);
    });

    // A lock frees no slot: rather than silently erase what the user
    // explicitly protected, it refuses and says so.
    it('refuses when every slot is locked', () => {
      const plan = planRetention([backup('a', 1, true), backup('b', 2, true)], 2);

      expect(plan).toEqual({ kind: 'blocked', lockedCount: 2, limit: 2 });
    });

    it('also refuses when the unlocked ones are not enough', () => {
      const existing = [backup('a', 1, true), backup('b', 2, true), backup('c', 3)];

      const plan = planRetention(existing, 2);

      // Three present, two slots: two would have to go, but only one is
      // free.
      expect(plan.kind).toBe('blocked');
    });
  });

  it('treats a zero limit as backups disabled', () => {
    expect(planRetention([], 0).kind).toBe('blocked');
    expect(planRetention([], -1).kind).toBe('blocked');
  });

  it('accepts a server with no backup at all', () => {
    expect(planRetention([], 1)).toEqual({ kind: 'ok', remove: [] });
  });

  // A limit of 1 means "keep only the latest": every new backup replaces the
  // previous one.
  it('replaces the previous one with a limit of 1', () => {
    const plan = planRetention([backup('a', 1)], 1);

    expect(plan.kind === 'ok' && plan.remove.map((entry) => entry.uuid)).toEqual(['a']);
  });
});

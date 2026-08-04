/**
 * Backup retention policy.
 *
 * Kept apart from the service so it can be checked: it is the only part of the
 * module that **destroys data**, and a mistake here erases the backup the user
 * believed they were keeping. It touches neither the database nor the network,
 * it only decides — which makes it exhaustively testable.
 */

export interface RetainableBackup {
  uuid: string;
  locked: boolean;
  createdAt: Date;
}

export type RetentionPlan =
  | { kind: 'ok'; remove: RetainableBackup[] }
  | { kind: 'blocked'; lockedCount: number; limit: number };

/**
 * Decides which backups to remove to make room for a new one.
 *
 * A lock beats age: that is its whole reason for existing. But a locked backup
 * does occupy a slot — a server whose slots are all locked can create no more,
 * and saying so beats erasing a lock in silence.
 *
 * @param existing backups already recorded, order irrelevant.
 * @param limit number of slots; 0 or less disables backups.
 */
export function planRetention(existing: readonly RetainableBackup[], limit: number): RetentionPlan {
  if (limit <= 0) {
    return { kind: 'blocked', lockedCount: 0, limit };
  }

  // Room is needed for **one more**: with 3 slots and 3 backups, one has to go,
  // not zero.
  const surplus = existing.length - limit + 1;

  if (surplus <= 0) {
    return { kind: 'ok', remove: [] };
  }

  const removable = [...existing]
    .filter((backup) => !backup.locked)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  if (removable.length < surplus) {
    return {
      kind: 'blocked',
      lockedCount: existing.length - removable.length,
      limit,
    };
  }

  return { kind: 'ok', remove: removable.slice(0, surplus) };
}

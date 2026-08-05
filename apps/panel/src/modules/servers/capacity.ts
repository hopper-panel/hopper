/**
 * Overallocation check for a node.
 *
 * A node declares a capacity (RAM, disk) and a percentage of allowed overrun.
 * Overallocation is useful: most Minecraft servers never use their maximum
 * limit, and refusing to place one more on a half-empty machine would waste
 * hardware.
 *
 * It is also dangerous: when every server really consumes its quota, the
 * kernel's OOM killer kills processes at random. Hence the explicit per-node
 * setting, and a default of 0 — no overrun until an administrator decides
 * otherwise.
 */

export interface CapacityCheck {
  /** Declared capacity of the node, in bytes. 0 = not declared. */
  declared: bigint;
  /** Sum of the limits already assigned to the node's servers. */
  allocated: bigint;
  /** What the new server asks for. */
  requested: bigint;
  /** Percentage of overrun allowed. -1 = unlimited, 0 = strict. */
  overallocation: number;
}

export interface CapacityVerdict {
  allowed: boolean;
  /** Effective ceiling once the allowed overrun is applied. */
  limit: bigint;
  reason?: string;
}

export function checkCapacity(check: CapacityCheck, label: string): CapacityVerdict {
  // An undeclared capacity means "I do not want accounting on this node". That
  // is the case of an administrator managing space by hand.
  if (check.declared === 0n) {
    return { allowed: true, limit: 0n };
  }

  if (check.overallocation < 0) {
    return { allowed: true, limit: 0n };
  }

  const limit = check.declared + (check.declared * BigInt(check.overallocation)) / 100n;
  const wouldBe = check.allocated + check.requested;

  if (wouldBe > limit) {
    return {
      allowed: false,
      limit,
      reason:
        `${label}: the node has no room left. ` +
        `${formatBytes(check.allocated)} already assigned out of ${formatBytes(limit)} available, ` +
        `${formatBytes(check.requested)} requested.`,
    };
  }

  return { allowed: true, limit };
}

/** Readable formatting, for error messages shown to a human. */
export function formatBytes(bytes: bigint): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes);
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

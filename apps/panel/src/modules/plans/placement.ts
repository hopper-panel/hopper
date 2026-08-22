import { checkCapacity } from '../servers/capacity.js';

/**
 * Choosing which machine a sold server lands on.
 *
 * This is the decision a plan exists to take away from the billing system. That
 * system knows what was paid for; it does not know which of eleven machines has
 * room, which is in maintenance this morning, and which has a free port. Asking
 * it to know would mean giving it the node list — and then keeping that list in
 * two products at once.
 *
 * A pure function, like `checkCapacity` next door and for the same reason: the
 * rule is the part worth arguing about, and an argument settled in a test is
 * cheaper than one settled against a production database.
 */

/** A node as placement sees it: capacity, load, and whether it can take a port. */
export interface PlacementCandidate {
  id: number;
  uuid: string;
  name: string;
  maintenance: boolean;
  /** Declared capacity. 0 = not declared, i.e. no accounting on this machine. */
  memoryBytes: bigint;
  diskBytes: bigint;
  memoryOverallocation: number;
  diskOverallocation: number;
  /** Sum of the limits already handed out on this node. */
  allocatedMemoryBytes: bigint;
  allocatedDiskBytes: bigint;
  /** Ports on this node assigned to no server. */
  freeAllocations: number;
  /** Servers already there. Only used to break a tie. */
  serverCount: number;
}

export interface PlacementRequest {
  memoryBytes: bigint;
  diskBytes: bigint;
}

/**
 * Why a node was passed over.
 *
 * Reported rather than swallowed, because "no node available" is the single
 * most expensive answer this API can give: it arrives in the middle of a
 * customer's purchase, and an operator reading it has to know whether to free
 * ports, lift a maintenance flag or buy a machine. Those are three different
 * afternoons.
 */
export type PlacementRefusal =
  'maintenance' | 'no-free-port' | 'not-enough-memory' | 'not-enough-disk';

export interface PlacementRejection {
  node: string;
  reason: PlacementRefusal;
}

export interface PlacementResult {
  chosen: PlacementCandidate | null;
  /** Every node considered and passed over, in the order they were examined. */
  rejected: PlacementRejection[];
}

/**
 * Picks a node, or explains why none fits.
 *
 * The rule is **spread, not pack**: among the nodes that fit, the one with the
 * most free memory wins. Packing tightly would fill one machine before touching
 * the next, which costs less hardware and buys the worst failure mode this
 * software has — when every server on a full node really claims its quota, the
 * kernel's OOM killer picks its victims at random, across customers who have
 * nothing to do with each other. Overallocation is already the lever for
 * density, it is per node, and an operator who wants tighter packing has it.
 *
 * A node that declares no capacity is considered **last** among those that fit.
 * Declaring nothing means "I manage this machine by hand", and a machine nobody
 * is accounting for is the wrong default place to put a server sold
 * automatically — but it is still better than refusing a sale, so it is a
 * fallback rather than an exclusion.
 */
export function choosePlacement(
  candidates: readonly PlacementCandidate[],
  request: PlacementRequest,
): PlacementResult {
  const rejected: PlacementRejection[] = [];
  const eligible: PlacementCandidate[] = [];

  for (const candidate of candidates) {
    const reason = refusalFor(candidate, request);

    if (reason === null) {
      eligible.push(candidate);
    } else {
      rejected.push({ node: candidate.name, reason });
    }
  }

  if (eligible.length === 0) {
    return { chosen: null, rejected };
  }

  const best = [...eligible].sort(compare)[0]!;

  return { chosen: best, rejected };
}

/**
 * The first reason this node cannot take the server, or `null`.
 *
 * Ordered from cheapest and most actionable to least: maintenance is a flag
 * somebody set on purpose, a missing port is a minute's work, and capacity is
 * a purchase.
 */
function refusalFor(
  candidate: PlacementCandidate,
  request: PlacementRequest,
): PlacementRefusal | null {
  if (candidate.maintenance) {
    return 'maintenance';
  }

  if (candidate.freeAllocations <= 0) {
    return 'no-free-port';
  }

  const memory = checkCapacity(
    {
      declared: candidate.memoryBytes,
      allocated: candidate.allocatedMemoryBytes,
      requested: request.memoryBytes,
      overallocation: candidate.memoryOverallocation,
    },
    'memory',
  );

  if (!memory.allowed) {
    return 'not-enough-memory';
  }

  const disk = checkCapacity(
    {
      declared: candidate.diskBytes,
      allocated: candidate.allocatedDiskBytes,
      requested: request.diskBytes,
      overallocation: candidate.diskOverallocation,
    },
    'disk',
  );

  return disk.allowed ? null : 'not-enough-disk';
}

/**
 * Orders two nodes that both fit.
 *
 * Every tier of the comparison is total and deterministic, ending on the id:
 * two identical machines must not swap places between two calls, or the same
 * request answered twice would put two servers of one customer on two nodes
 * for no reason a support engineer could ever reconstruct.
 */
function compare(left: PlacementCandidate, right: PlacementCandidate): number {
  const leftAccounted = isAccounted(left);
  const rightAccounted = isAccounted(right);

  if (leftAccounted !== rightAccounted) {
    return leftAccounted ? -1 : 1;
  }

  if (leftAccounted) {
    const difference = freeMemory(right) - freeMemory(left);

    if (difference !== 0n) {
      return difference > 0n ? 1 : -1;
    }

    const disk = freeDisk(right) - freeDisk(left);

    if (disk !== 0n) {
      return disk > 0n ? 1 : -1;
    }
  }

  if (left.serverCount !== right.serverCount) {
    return left.serverCount - right.serverCount;
  }

  return left.id - right.id;
}

/**
 * True when this node's memory is being accounted for.
 *
 * Both an undeclared capacity and an unlimited overallocation mean the same
 * thing here: the numbers cannot rank this machine against another, because
 * nothing bounds it.
 */
function isAccounted(candidate: PlacementCandidate): boolean {
  return candidate.memoryBytes > 0n && candidate.memoryOverallocation >= 0;
}

function freeMemory(candidate: PlacementCandidate): bigint {
  return (
    ceiling(candidate.memoryBytes, candidate.memoryOverallocation) - candidate.allocatedMemoryBytes
  );
}

function freeDisk(candidate: PlacementCandidate): bigint {
  return ceiling(candidate.diskBytes, candidate.diskOverallocation) - candidate.allocatedDiskBytes;
}

function ceiling(declared: bigint, overallocation: number): bigint {
  if (declared === 0n || overallocation < 0) {
    return declared;
  }

  return declared + (declared * BigInt(overallocation)) / 100n;
}

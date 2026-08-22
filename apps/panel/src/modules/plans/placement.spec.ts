import { describe, expect, it } from 'vitest';
import { choosePlacement, type PlacementCandidate } from './placement.js';

const GIB = 1024n * 1024n * 1024n;

/** A node with room, which each test spoils in exactly one way. */
function node(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    id: 1,
    uuid: 'node-1',
    name: 'paris-1',
    maintenance: false,
    memoryBytes: 64n * GIB,
    diskBytes: 1000n * GIB,
    memoryOverallocation: 0,
    diskOverallocation: 0,
    allocatedMemoryBytes: 0n,
    allocatedDiskBytes: 0n,
    freeAllocations: 10,
    serverCount: 0,
    ...overrides,
  };
}

const REQUEST = { memoryBytes: 4n * GIB, diskBytes: 20n * GIB };

describe('choosing a node', () => {
  it('takes the only one that fits', () => {
    const result = choosePlacement([node()], REQUEST);

    expect(result.chosen?.name).toBe('paris-1');
    expect(result.rejected).toEqual([]);
  });

  it('spreads rather than packs', () => {
    // The one with more room wins, even though the fuller one still fits.
    // Packing would fill a machine before touching the next, and a full node
    // whose servers all claim their quota is where the kernel starts killing
    // processes belonging to customers who have nothing to do with each other.
    const full = node({ id: 1, name: 'nearly-full', allocatedMemoryBytes: 50n * GIB });
    const empty = node({ id: 2, name: 'empty', allocatedMemoryBytes: 8n * GIB });

    expect(choosePlacement([full, empty], REQUEST).chosen?.name).toBe('empty');
    // And the order they arrive in changes nothing.
    expect(choosePlacement([empty, full], REQUEST).chosen?.name).toBe('empty');
  });

  it('counts the overallocation a node allows as room', () => {
    const strict = node({ id: 1, name: 'strict', allocatedMemoryBytes: 62n * GIB });
    const generous = node({
      id: 2,
      name: 'generous',
      allocatedMemoryBytes: 62n * GIB,
      memoryOverallocation: 100,
    });

    // Both are at 62 of 64 GiB. Only the second one is allowed to go past it.
    const result = choosePlacement([strict, generous], REQUEST);

    expect(result.chosen?.name).toBe('generous');
    expect(result.rejected).toEqual([{ node: 'strict', reason: 'not-enough-memory' }]);
  });

  it('breaks a tie the same way every time', () => {
    // Two identical machines must not swap between two calls: the same request
    // answered twice would scatter one customer's servers for a reason nobody
    // could reconstruct afterwards.
    const first = node({ id: 4, name: 'a' });
    const second = node({ id: 9, name: 'b' });

    expect(choosePlacement([first, second], REQUEST).chosen?.id).toBe(4);
    expect(choosePlacement([second, first], REQUEST).chosen?.id).toBe(4);
  });

  it('prefers the emptier of two tied nodes before falling back to the id', () => {
    const busy = node({ id: 1, name: 'busy', memoryBytes: 0n, serverCount: 30 });
    const quiet = node({ id: 2, name: 'quiet', memoryBytes: 0n, serverCount: 2 });

    expect(choosePlacement([busy, quiet], REQUEST).chosen?.name).toBe('quiet');
  });
});

describe('a node that declares no capacity', () => {
  it('is used rather than refusing the sale', () => {
    const result = choosePlacement([node({ memoryBytes: 0n, diskBytes: 0n })], REQUEST);

    expect(result.chosen?.name).toBe('paris-1');
  });

  it('comes after any node that does declare one', () => {
    // Declaring nothing means "I manage this machine by hand". It is the wrong
    // default place for a server sold automatically — and still better than
    // refusing the sale, which is why it is a fallback and not an exclusion.
    const unmanaged = node({ id: 1, name: 'by-hand', memoryBytes: 0n, diskBytes: 0n });
    const accounted = node({ id: 2, name: 'accounted', allocatedMemoryBytes: 60n * GIB });

    expect(choosePlacement([unmanaged, accounted], REQUEST).chosen?.name).toBe('accounted');
  });

  it('treats an unlimited overallocation the same way, since nothing bounds it either', () => {
    const unlimited = node({ id: 1, name: 'unlimited', memoryOverallocation: -1 });
    const accounted = node({ id: 2, name: 'accounted', allocatedMemoryBytes: 60n * GIB });

    expect(choosePlacement([unlimited, accounted], REQUEST).chosen?.name).toBe('accounted');
  });
});

describe('when nothing fits, saying which afternoon this is', () => {
  it('names maintenance', () => {
    const result = choosePlacement([node({ maintenance: true })], REQUEST);

    expect(result.chosen).toBeNull();
    expect(result.rejected).toEqual([{ node: 'paris-1', reason: 'maintenance' }]);
  });

  it('names a node with no port left', () => {
    const result = choosePlacement([node({ freeAllocations: 0 })], REQUEST);

    expect(result.rejected).toEqual([{ node: 'paris-1', reason: 'no-free-port' }]);
  });

  it('names memory, and disk, apart', () => {
    const tightMemory = node({ id: 1, name: 'ram', allocatedMemoryBytes: 63n * GIB });
    const tightDisk = node({ id: 2, name: 'disk', allocatedDiskBytes: 990n * GIB });

    const result = choosePlacement([tightMemory, tightDisk], REQUEST);

    expect(result.chosen).toBeNull();
    expect(result.rejected).toEqual([
      { node: 'ram', reason: 'not-enough-memory' },
      { node: 'disk', reason: 'not-enough-disk' },
    ]);
  });

  it('reports the cheapest thing to fix first when a node fails several checks', () => {
    // A node in maintenance with no ports and no room reports maintenance: it
    // is a flag somebody set on purpose, and the other two may not even be
    // true once it is lifted.
    const hopeless = node({ maintenance: true, freeAllocations: 0, memoryBytes: 1n });

    expect(choosePlacement([hopeless], REQUEST).rejected).toEqual([
      { node: 'paris-1', reason: 'maintenance' },
    ]);
  });

  it('says nothing at all when there is no node to say anything about', () => {
    const result = choosePlacement([], REQUEST);

    expect(result.chosen).toBeNull();
    expect(result.rejected).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_ALLOCATIONS_PER_REQUEST, expandPortRanges } from './nodes.dto.js';

describe('expandPortRanges', () => {
  it('accepts a single port', () => {
    expect(expandPortRanges(['25565'])).toEqual([25565]);
  });

  it('expands a range', () => {
    expect(expandPortRanges(['25565-25568'])).toEqual([25565, 25566, 25567, 25568]);
  });

  it('combines several entries and sorts the result', () => {
    expect(expandPortRanges(['25570', '25565-25566'])).toEqual([25565, 25566, 25570]);
  });

  // Overlapping two ranges is a common move when extending a node.
  it('deduplicates ports present in several ranges', () => {
    expect(expandPortRanges(['25565-25567', '25566-25568'])).toEqual([25565, 25566, 25567, 25568]);
  });

  it('accepts a range of a single port', () => {
    expect(expandPortRanges(['25565-25565'])).toEqual([25565]);
  });

  it.each([
    ['zero port', '0'],
    ['port beyond 65535', '65536'],
    ['upper bound out of range', '25565-70000'],
  ])('refuses a port out of range: %s', (_label, entry) => {
    expect(() => expandPortRanges([entry])).toThrow(/out of range/);
  });

  it('refuses a reversed range', () => {
    expect(() => expandPortRanges(['25570-25565'])).toThrow(/Reversed/);
  });

  // Without this bound, `1-65535` would insert 65,000 rows and block the
  // database for several seconds — reachable by any administrator through a
  // simple typo.
  it('refuses a range wider than the limit', () => {
    expect(() => expandPortRanges([`1-${MAX_ALLOCATIONS_PER_REQUEST + 1}`])).toThrow(/exceeds/);
  });

  it('refuses a cumulative total above the limit', () => {
    const half = MAX_ALLOCATIONS_PER_REQUEST / 2;
    expect(() => expandPortRanges([`1000-${1000 + half}`, `20000-${20000 + half}`])).toThrow(
      /at most/,
    );
  });

  it('accepts exactly the limit', () => {
    expect(expandPortRanges([`1000-${1000 + MAX_ALLOCATIONS_PER_REQUEST - 1}`])).toHaveLength(
      MAX_ALLOCATIONS_PER_REQUEST,
    );
  });
});

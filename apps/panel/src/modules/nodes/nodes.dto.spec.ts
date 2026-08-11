import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOCATIONS_PER_REQUEST,
  createNodeSchema,
  expandPortRanges,
  updateNodeSchema,
} from './nodes.dto.js';

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

/**
 * A PATCH says "change this and nothing else".
 *
 * `updateNodeSchema` was `createNodeSchema.partial()`, and `.partial()` does
 * not remove a `.default()` — it wraps it, so every key left out of the body
 * arrived at the service holding the creation default. Editing a node's
 * address alone therefore reset its capacity to zero, its port to 8443, its
 * scheme to https and its maintenance flag, silently.
 *
 * Nothing had caught it because nothing called the route: the administration
 * had no way to edit a node until the screen that comes with this test.
 */
describe('updateNodeSchema', () => {
  it('carries only what was sent', () => {
    expect(updateNodeSchema.parse({ fqdn: '192.168.1.141' })).toEqual({ fqdn: '192.168.1.141' });
  });

  it('is empty for an empty body, rather than a whole node', () => {
    // Anything here is a column the service would overwrite with a default.
    expect(updateNodeSchema.parse({})).toEqual({});
  });

  it('leaves capacity alone when the body does not mention it', () => {
    // The one that costs the most: a node declared with 64 GiB of memory,
    // edited to fix a typo in its name, would have been sold as having none.
    const parsed = updateNodeSchema.parse({ name: 'node-paris-1' });

    expect(parsed).not.toHaveProperty('memoryBytes');
    expect(parsed).not.toHaveProperty('diskBytes');
    expect(parsed).not.toHaveProperty('maintenance');
  });

  it('still validates what it does carry', () => {
    expect(updateNodeSchema.safeParse({ port: 70000 }).success).toBe(false);
    expect(updateNodeSchema.safeParse({ fqdn: 'not a hostname' }).success).toBe(false);
    expect(updateNodeSchema.safeParse({ scheme: 'ftp' }).success).toBe(false);
  });
});

/**
 * The defaults live on creation, and have to stay there.
 *
 * They are what makes `hopper node:create --name x --fqdn y` a complete node
 * from two flags, which the installer relies on.
 */
describe('createNodeSchema', () => {
  it('fills in a whole node from the two fields that have no sensible default', () => {
    expect(createNodeSchema.parse({ name: 'node-1', fqdn: 'node1.example.com' })).toEqual({
      name: 'node-1',
      fqdn: 'node1.example.com',
      description: '',
      scheme: 'https',
      port: 8443,
      sftpPort: 2022,
      timezone: 'UTC',
      memoryBytes: 0,
      diskBytes: 0,
      memoryOverallocation: 0,
      diskOverallocation: 0,
      maintenance: false,
    });
  });

  it('still requires the two that have none', () => {
    expect(createNodeSchema.safeParse({ name: 'node-1' }).success).toBe(false);
    expect(createNodeSchema.safeParse({ fqdn: 'node1.example.com' }).success).toBe(false);
  });
});

/**
 * The timezone reaches every container on the node as `TZ`.
 *
 * Validated rather than trusted, because a name the tz database does not know
 * is not an error where it lands: the container falls back to UTC without a
 * word, which is exactly the behaviour the operator was trying to change. The
 * refusal has to happen here, at the only point where anybody is watching.
 */
describe('the node timezone', () => {
  it.each(['UTC', 'Europe/Paris', 'America/New_York', 'Asia/Tokyo'])('accepts %s', (zone) => {
    expect(
      createNodeSchema.safeParse({ name: 'n', fqdn: 'n.example.com', timezone: zone }).success,
    ).toBe(true);
  });

  it.each(['Europe/Paris ', 'Mars/Olympus', 'CEST', ''])('refuses %s', (zone) => {
    expect(
      createNodeSchema.safeParse({ name: 'n', fqdn: 'n.example.com', timezone: zone }).success,
    ).toBe(false);
  });

  it('is left alone by an update that does not mention it', () => {
    // The whole reason the shape is split: a rename must not send the node
    // back to UTC and every server's log with it.
    expect(updateNodeSchema.parse({ name: 'renamed' })).not.toHaveProperty('timezone');
  });
});

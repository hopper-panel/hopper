import { describe, expect, it } from 'vitest';
import {
  APPLICATION_RESOURCES,
  RESOURCE_LEVELS,
  decodePermissions,
  encodePermissions,
  grantsAnything,
  levelIsOffered,
  permissionAllows,
} from './application-permissions.js';

describe('what a key is granted, resource by resource', () => {
  it('lets a read grant read and refuses it a write', () => {
    const stored = encodePermissions({ servers: 'read' });

    expect(permissionAllows(stored, 'servers', 'GET')).toBe(true);
    expect(permissionAllows(stored, 'servers', 'POST')).toBe(false);
    expect(permissionAllows(stored, 'servers', 'DELETE')).toBe(false);
  });

  it('lets a write grant both', () => {
    const stored = encodePermissions({ servers: 'write' });

    expect(permissionAllows(stored, 'servers', 'GET')).toBe(true);
    expect(permissionAllows(stored, 'servers', 'POST')).toBe(true);
  });

  it('keeps one resource out of another’s business', () => {
    // The reason the matrix exists. A status page granted `plans:read` must not
    // be able to delete a customer's server because it was also given
    // something else.
    const stored = encodePermissions({ plans: 'read', servers: 'none' });

    expect(permissionAllows(stored, 'plans', 'GET')).toBe(true);
    expect(permissionAllows(stored, 'servers', 'GET')).toBe(false);
    expect(permissionAllows(stored, 'servers', 'DELETE')).toBe(false);
  });

  it('refuses everything to a key granted nothing', () => {
    for (const resource of APPLICATION_RESOURCES) {
      expect(permissionAllows([], resource, 'GET')).toBe(false);
      expect(permissionAllows([], resource, 'POST')).toBe(false);
    }
  });
});

describe('how it is stored', () => {
  it('reads back exactly what it wrote', () => {
    const granted = { servers: 'write', plans: 'read', nodes: 'read' } as const;

    expect(decodePermissions(encodePermissions(granted))).toEqual({
      servers: 'write',
      users: 'none',
      plans: 'read',
      nodes: 'read',
      allocations: 'none',
      templates: 'none',
    });
  });

  it('stores nothing for a resource left at none', () => {
    // A row listing what a key *cannot* do would have to be rewritten every
    // time a resource is added, and the keys nobody rewrote would silently gain
    // whatever a missing entry defaulted to.
    expect(encodePermissions({ servers: 'read', users: 'none' })).toEqual(['servers:read']);
  });

  it('treats an entry it does not understand as absent', () => {
    // A permission written by a future version, or by hand. Reading it as
    // "granted" would be the one direction that cannot be undone.
    expect(decodePermissions(['servers:admin', 'nonsense', 'backups:write']).servers).toBe('none');
  });

  it('ignores an explicit none somebody wrote anyway', () => {
    expect(decodePermissions(['servers:none']).servers).toBe('none');
  });

  it('knows when a key opens nothing', () => {
    expect(grantsAnything({})).toBe(false);
    expect(grantsAnything({ servers: 'none' })).toBe(false);
    expect(grantsAnything({ servers: 'read' })).toBe(true);
  });
});

describe('the levels each resource actually offers', () => {
  it('offers write only where a write route exists', () => {
    // Pterodactyl offers "Read & Write" on every line whether or not anything
    // is behind it. A checkbox that changes nothing is worse than a missing
    // one: somebody grants it, believes their integration can write, and finds
    // out in production.
    expect(levelIsOffered('servers', 'write')).toBe(true);
    expect(levelIsOffered('users', 'write')).toBe(true);

    expect(levelIsOffered('plans', 'write')).toBe(false);
    expect(levelIsOffered('nodes', 'write')).toBe(false);
    expect(levelIsOffered('allocations', 'write')).toBe(false);
    expect(levelIsOffered('templates', 'write')).toBe(false);
  });

  it('lets every resource be granted read, or nothing at all', () => {
    for (const resource of APPLICATION_RESOURCES) {
      expect(levelIsOffered(resource, 'read')).toBe(true);
      expect(levelIsOffered(resource, 'none')).toBe(true);
    }
  });

  it('describes every resource, so the interface cannot render a blank row', () => {
    for (const resource of APPLICATION_RESOURCES) {
      expect(RESOURCE_LEVELS[resource].length).toBeGreaterThan(0);
    }
  });
});

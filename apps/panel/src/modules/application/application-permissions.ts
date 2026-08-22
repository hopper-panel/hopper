import { z } from 'zod';

/**
 * What an application key may touch, resource by resource.
 *
 * The first version of these keys had two scopes, `read` and `write`, applied
 * to the whole surface. That is too coarse for what people actually run beside
 * a panel: a billing system needs to create and delete servers, a status page
 * needs to count them, an internal dashboard needs to read the estate — and
 * handing the status page a credential that can delete a customer's world
 * because it also needs to list plans is not a trade anybody would make
 * knowingly.
 *
 * So a key holds one decision per resource. The shape is deliberately the one
 * Pterodactyl's application keys use, because a hosting provider migrating from
 * it should recognise the screen and be able to reproduce their existing
 * credential split without translating it in their head.
 */

export const APPLICATION_RESOURCES = [
  'servers',
  'plans',
  'users',
  'nodes',
  'allocations',
  'templates',
] as const;

export type ApplicationResource = (typeof APPLICATION_RESOURCES)[number];

export const applicationResourceSchema = z.enum(APPLICATION_RESOURCES);

/**
 * `none` is a level and not the absence of one.
 *
 * It exists so a key can be *described* completely — "this one reads servers
 * and touches nothing else" — rather than by what is missing from a list. It is
 * never stored: a resource at `none` simply has no entry.
 */
export const PERMISSION_LEVELS = ['none', 'read', 'write'] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const permissionLevelSchema = z.enum(PERMISSION_LEVELS);

/** What a key holds, as an operator sets it. */
export type ApplicationPermissions = Record<ApplicationResource, PermissionLevel>;

export const applicationPermissionsSchema = z.record(
  applicationResourceSchema,
  permissionLevelSchema,
);

/**
 * Which levels each resource can actually be granted.
 *
 * Pterodactyl offers "Read & Write" on every line of its matrix whether or not
 * a write route exists behind it. That is a checkbox that changes nothing, and
 * a checkbox that changes nothing is worse than a missing one: somebody grants
 * it, believes their integration can write, and finds out otherwise in
 * production.
 *
 * So the table says what is true today, the interface greys out the rest, and
 * adding a write route means adding it here — where the reviewer will see it.
 */
export const RESOURCE_LEVELS: Record<ApplicationResource, readonly PermissionLevel[]> = {
  /** Provisioning, suspending, changing plan, deleting. */
  servers: ['none', 'read', 'write'],
  /** Accounts are found or created while provisioning; writing edits them. */
  users: ['none', 'read', 'write'],
  /** Offers are written from the administration, never through this API. */
  plans: ['none', 'read'],
  /** The estate, for a dashboard. Nodes are declared by an operator. */
  nodes: ['none', 'read'],
  /** Free ports, for capacity reporting. Assigned by provisioning, not here. */
  allocations: ['none', 'read'],
  /** The catalogue a plan points at. Imported and edited by an operator. */
  templates: ['none', 'read'],
};

/** True if this resource can be granted this level at all. */
export function levelIsOffered(resource: ApplicationResource, level: PermissionLevel): boolean {
  return RESOURCE_LEVELS[resource].includes(level);
}

/**
 * Serialises the permissions for storage, one `resource:level` per entry.
 *
 * Resources left at `none` are absent rather than stored as `servers:none`. A
 * row listing what a key *cannot* do would have to be rewritten every time a
 * resource is added — and the keys that were not rewritten would silently gain
 * whatever the reader defaulted a missing entry to.
 */
export function encodePermissions(permissions: Partial<ApplicationPermissions>): string[] {
  return APPLICATION_RESOURCES.flatMap((resource) => {
    const level = permissions[resource] ?? 'none';

    return level === 'none' ? [] : [`${resource}:${level}`];
  });
}

/** Reads back what `encodePermissions` wrote, defaulting anything absent to `none`. */
export function decodePermissions(stored: readonly string[]): ApplicationPermissions {
  const decoded = Object.fromEntries(
    APPLICATION_RESOURCES.map((resource) => [resource, 'none']),
  ) as ApplicationPermissions;

  for (const entry of stored) {
    const [resource, level] = entry.split(':');

    if (
      resource !== undefined &&
      level !== undefined &&
      isResource(resource) &&
      isLevel(level) &&
      level !== 'none'
    ) {
      decoded[resource] = level;
    }
  }

  return decoded;
}

/**
 * True if this key may make this request.
 *
 * The verb decides which level is needed, as it did before: everything that is
 * not a read needs `write`. What changed is that the question is now asked of
 * one resource rather than of the whole API.
 */
export function permissionAllows(
  stored: readonly string[],
  resource: ApplicationResource,
  method: string,
): boolean {
  const level = decodePermissions(stored)[resource];
  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  return readOnly ? level === 'read' || level === 'write' : level === 'write';
}

/** True if the key can reach anything at all — used to refuse an empty grant. */
export function grantsAnything(permissions: Partial<ApplicationPermissions>): boolean {
  return encodePermissions(permissions).length > 0;
}

function isResource(value: string): value is ApplicationResource {
  return (APPLICATION_RESOURCES as readonly string[]).includes(value);
}

function isLevel(value: string): value is PermissionLevel {
  return (PERMISSION_LEVELS as readonly string[]).includes(value);
}

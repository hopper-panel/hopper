import type { INestApplicationContext } from '@nestjs/common';
import {
  APPLICATION_RESOURCES,
  PERMISSION_LEVELS,
  levelIsOffered,
  RESOURCE_LEVELS,
  type ApplicationPermissions,
  type ApplicationResource,
  type PermissionLevel,
} from '../../modules/application/application-permissions.js';
import { ApplicationKeysService } from '../../modules/application/application-keys.service.js';
import { textOf, type Flags } from '../flags.js';
import { bold, dim, fatal, line } from '../output.js';

/**
 * Application keys from a shell.
 *
 * The first one has to be creatable without a browser. A hosting provider
 * installs the panel and wires their billing system to it in the same session,
 * often over SSH on a machine with no desktop; asking them to sign in to a web
 * interface to obtain the credential that automates the web interface is a
 * detour with no purpose.
 *
 * The token is printed **once**, on standard output and alone on its line, so
 * `hopper application-key:create --name Paymenter --scopes write | tail -1` is
 * a usable thing to write in an installation script. Everything else goes
 * through the same service the API uses, so a key made here is validated,
 * hashed and named exactly like one made from the administration.
 */

export async function applicationKeyCreate(
  context: INestApplicationContext,
  flags: Flags,
): Promise<void> {
  const keys = context.get(ApplicationKeysService);

  const name = textOf(flags, 'name');

  if (name === undefined) {
    fatal(
      'Missing --name. Name it after the software that will present it, e.g. --name Paymenter.',
    );
  }

  const permissions = parsePermissions(textOf(flags, 'permissions'));
  const allowedIps = splitList(textOf(flags, 'allowed-ips'));
  const expiresAt = textOf(flags, 'expires-at');

  if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
    fatal(
      `Unreadable --expires-at: ${expiresAt}. Expected an ISO 8601 date, e.g. 2027-01-01T00:00:00Z.`,
    );
  }

  // No actor: a key created from a shell is attributed to nobody rather than
  // to whichever administrator happens to be first in the table. The audit
  // trail then reads "created by the system", which is what happened.
  const created = await keys.create({ name, permissions, allowedIps, expiresAt }, undefined);

  line(`\n${bold('Application key created')} — ${created.name}`);
  line(dim(`  Permissions: ${describe(created.permissions)}`));
  line(
    dim(
      `  Addresses: ${created.allowedIps.length === 0 ? 'no restriction' : created.allowedIps.join(', ')}`,
    ),
  );
  line(dim('  Shown once. It is stored hashed; losing it means creating another.'));
  line();
  line(created.token);
}

export async function applicationKeyList(context: INestApplicationContext): Promise<void> {
  const keys = context.get(ApplicationKeysService);
  const all = await keys.list();

  if (all.length === 0) {
    line(`\n${bold('No application key')}`);
    line(dim('  hopper application-key:create --name Paymenter --scopes write'));
    return;
  }

  line(`\n${bold('Application keys')}`);

  for (const key of all) {
    const state =
      key.revokedAt !== null
        ? 'revoked'
        : key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'active';

    line(`  ${key.name} ${dim(`(${state})`)}`);
    line(dim(`    ${key.key}`));
    line(dim(`    Permissions: ${describe(key.permissions)}`));
    line(dim(`    Last used: ${key.lastUsedAt === null ? 'never' : key.lastUsedAt.toISOString()}`));
  }
}

export async function applicationKeyRevoke(
  context: INestApplicationContext,
  flags: Flags,
): Promise<void> {
  const keys = context.get(ApplicationKeysService);
  const uuid = textOf(flags, 'uuid');

  if (uuid === undefined) {
    fatal(
      'Missing --uuid. `hopper application-key:list` does not print it; take it from the administration.',
    );
  }

  await keys.revoke(uuid);

  line(`\n${bold('Key revoked')} — ${uuid}`);
  line(dim('  It is kept, revoked, so the audit entries it left still name it.'));
}

/**
 * Reads `--permissions servers:write,plans:read`.
 *
 * No default. The first version of this command defaulted to everything a key
 * could do, which was defensible when there were two scopes and is not now: a
 * credential is going into a configuration file, and the shortest path must not
 * be the one that grants the most. `--permissions all:read` and
 * `--permissions all:write` exist for the cases that genuinely want the lot.
 */
function parsePermissions(raw: string | undefined): Partial<ApplicationPermissions> {
  if (raw === undefined) {
    fatal(
      'Missing --permissions.\n' +
        `  Resources: ${APPLICATION_RESOURCES.join(', ')}\n` +
        '  Example:   --permissions servers:write,plans:read\n' +
        '  Shorthand: --permissions all:read',
    );
  }

  const permissions: Partial<ApplicationPermissions> = {};

  for (const entry of splitList(raw)) {
    const [resource, level] = entry.split(':');

    if (resource === undefined || level === undefined) {
      fatal(`Unreadable permission: ${entry}. Expected resource:level, e.g. servers:write.`);
    }

    if (!isLevel(level)) {
      fatal(`Unknown level: ${level}.\n  Known levels: ${PERMISSION_LEVELS.join(', ')}.`);
    }

    if (resource === 'all') {
      for (const known of APPLICATION_RESOURCES) {
        // `all:write` means "as much as each resource allows", not "write
        // everywhere": four of them have no write route, and refusing the whole
        // command over that would make the shorthand useless.
        permissions[known] = levelIsOffered(known, level) ? level : 'read';
      }

      continue;
    }

    if (!isResource(resource)) {
      fatal(
        `Unknown resource: ${resource}.\n  Known resources: ${APPLICATION_RESOURCES.join(', ')}.`,
      );
    }

    if (!levelIsOffered(resource, level)) {
      fatal(
        `"${resource}" cannot be granted "${level}".\n` +
          `  It accepts: ${RESOURCE_LEVELS[resource].join(', ')}.`,
      );
    }

    permissions[resource] = level;
  }

  return permissions;
}

/** One line an operator can read back, rather than a serialised array. */
function describe(permissions: ApplicationPermissions): string {
  const granted = APPLICATION_RESOURCES.filter((resource) => permissions[resource] !== 'none').map(
    (resource) => `${resource}:${permissions[resource]}`,
  );

  return granted.length === 0 ? 'none' : granted.join(', ');
}

function isResource(value: string): value is ApplicationResource {
  return (APPLICATION_RESOURCES as readonly string[]).includes(value);
}

function isLevel(value: string): value is PermissionLevel {
  return (PERMISSION_LEVELS as readonly string[]).includes(value);
}

function splitList(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

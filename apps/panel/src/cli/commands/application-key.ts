import type { INestApplicationContext } from '@nestjs/common';
import {
  APPLICATION_KEY_SCOPES,
  type ApplicationKeyScope,
} from '../../modules/application/application-key.js';
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

  const scopes = parseScopes(textOf(flags, 'scopes') ?? 'read,write');
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
  const created = await keys.create({ name, scopes, allowedIps, expiresAt }, undefined);

  line(`\n${bold('Application key created')} — ${created.name}`);
  line(dim(`  Scopes: ${created.scopes.join(', ')}`));
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
    line(dim(`    Scopes: ${key.scopes.join(', ')}`));
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

function parseScopes(raw: string): ApplicationKeyScope[] {
  const asked = splitList(raw);

  if (asked.length === 0) {
    fatal(`Empty --scopes. Expected one or both of: ${APPLICATION_KEY_SCOPES.join(', ')}.`);
  }

  const unknown = asked.filter(
    (scope) => !APPLICATION_KEY_SCOPES.includes(scope as ApplicationKeyScope),
  );

  if (unknown.length > 0) {
    // Named, with the list: the caller is usually a script, and "invalid
    // scope" without saying which one is a trip to the source.
    fatal(
      `Unknown scope: ${unknown.join(', ')}.\n  Known scopes: ${APPLICATION_KEY_SCOPES.join(', ')}.`,
    );
  }

  return asked as ApplicationKeyScope[];
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

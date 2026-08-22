import { z } from 'zod';
import { API_KEY_PREFIX, randomString } from '../api-keys/api-key.js';

/**
 * Application keys — the credential a hosting provider's own software presents.
 *
 * Format: `hpa_<identifier>.<secret>`, deliberately one letter away from the
 * personal keys' `hpk_`. Both are secrets of the same shape and the same
 * lifetime; what differs is who they answer for, and that difference has to be
 * legible in a log line, in a configuration file and in a support ticket. A
 * separate prefix also lets the authentication guard route the request without
 * a database lookup, and lets a secret scanner recognise either.
 *
 * The identifier is public and stored in clear: it finds the row. The secret is
 * only ever stored hashed, with the same SHA-256 the personal keys use — 48
 * random characters give a dictionary attack nothing to work with, and a slow
 * hash would be paid on every provisioning call.
 */

export const APPLICATION_KEY_PREFIX = 'hpa_';
export const APPLICATION_KEY_IDENTIFIER_LENGTH = 16;
export const APPLICATION_KEY_SECRET_LENGTH = 48;

const PATTERN = new RegExp(
  `^${APPLICATION_KEY_PREFIX}([A-Za-z0-9]{${APPLICATION_KEY_IDENTIFIER_LENGTH}})\\.([A-Za-z0-9]{${APPLICATION_KEY_SECRET_LENGTH}})$`,
);

/**
 * What a key may do.
 *
 * Two, not three: there is no `admin` here because the whole surface an
 * application key reaches *is* administrative. The question left is whether the
 * integration only reads — a status page, a stock display, a reconciliation job
 * — or acts. A provider running both is expected to hold two keys, so the one
 * sitting in a public-facing status page cannot delete a server.
 */
export const APPLICATION_KEY_SCOPES = ['read', 'write'] as const;

export type ApplicationKeyScope = (typeof APPLICATION_KEY_SCOPES)[number];

export const applicationKeyScopeSchema = z.enum(APPLICATION_KEY_SCOPES);

export interface ParsedApplicationKey {
  identifier: string;
  secret: string;
}

export function generateApplicationKey(): {
  token: string;
  identifier: string;
  secret: string;
} {
  const identifier = randomString(APPLICATION_KEY_IDENTIFIER_LENGTH);
  const secret = randomString(APPLICATION_KEY_SECRET_LENGTH);

  return {
    token: `${APPLICATION_KEY_PREFIX}${identifier}.${secret}`,
    identifier,
    secret,
  };
}

/** Splits a key. `null` on an invalid format, without saying why. */
export function parseApplicationKey(token: string): ParsedApplicationKey | null {
  const match = PATTERN.exec(token);

  if (!match) {
    return null;
  }

  const [, identifier, secret] = match;

  return identifier === undefined || secret === undefined ? null : { identifier, secret };
}

/**
 * True if the token announces itself as an application key.
 *
 * Checked on the prefix alone, before any parsing: a malformed `hpa_…` has to
 * be refused as a bad application key rather than fall through and be tried as
 * a session token, which would fail signature verification and say something
 * misleading.
 *
 * The assertion below is not decoration. `hpa_` and `hpk_` share their first
 * three characters, and the day somebody shortens either prefix,
 * `startsWith` would start answering yes to both and this function would hand
 * personal keys to the application guard.
 */
export function looksLikeApplicationKey(token: string): boolean {
  return token.startsWith(APPLICATION_KEY_PREFIX);
}

/**
 * True if the two prefixes cannot be confused.
 *
 * Called once at module load rather than left as a comment: the property is
 * cheap to check and expensive to lose.
 */
export function prefixesAreDistinguishable(): boolean {
  return (
    !APPLICATION_KEY_PREFIX.startsWith(API_KEY_PREFIX) &&
    !API_KEY_PREFIX.startsWith(APPLICATION_KEY_PREFIX)
  );
}

/**
 * True if the scope allows the request.
 *
 * The verb decides, as it does for personal keys: everything that is not a read
 * needs `write`. Provisioning a server is a `POST`, suspending one is a `POST`,
 * and reading a plan is a `GET` — so a read key describes the estate and
 * changes none of it.
 */
export function applicationScopeAllows(scopes: readonly string[], method: string): boolean {
  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  return readOnly ? scopes.includes('read') || scopes.includes('write') : scopes.includes('write');
}

/** What is displayed of a key: its prefix, never its secret. */
export function displayableApplicationKey(identifier: string): string {
  return `${APPLICATION_KEY_PREFIX}${identifier}.${'•'.repeat(8)}`;
}

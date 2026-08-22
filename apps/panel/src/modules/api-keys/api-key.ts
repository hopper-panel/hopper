import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Personal API keys.
 *
 * Format: `hpk_<identifier>.<secret>`. The prefix is there so the key is
 * recognisable — by the authentication guard, which has to tell it from a
 * session token, but also by repository-scanning tools, which warn when a
 * secret is pushed by accident.
 *
 * The identifier is public and stored in the clear: it allows finding the row
 * without comparing the secret against the whole table. The secret is only ever
 * stored hashed.
 */

export const API_KEY_PREFIX = 'hpk_';
export const API_KEY_IDENTIFIER_LENGTH = 16;
export const API_KEY_SECRET_LENGTH = 48;

const PATTERN = new RegExp(
  `^${API_KEY_PREFIX}([A-Za-z0-9]{${API_KEY_IDENTIFIER_LENGTH}})\\.([A-Za-z0-9]{${API_KEY_SECRET_LENGTH}})$`,
);

/**
 * A key's scopes.
 *
 * Three only, and deliberately coarse: a key never grants more than its owner
 * already holds, so the question is not *what* but *how far*. A finer mechanism
 * would give the illusion of a control nobody reads back.
 */
export const API_KEY_SCOPES = ['read', 'write', 'admin'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export interface ParsedApiKey {
  identifier: string;
  secret: string;
}

export function generateApiKey(): { token: string; identifier: string; secret: string } {
  const identifier = randomString(API_KEY_IDENTIFIER_LENGTH);
  const secret = randomString(API_KEY_SECRET_LENGTH);

  return { token: `${API_KEY_PREFIX}${identifier}.${secret}`, identifier, secret };
}

/** Splits a key. `null` on an invalid format, without saying why. */
export function parseApiKey(token: string): ParsedApiKey | null {
  const match = PATTERN.exec(token);

  if (!match) {
    return null;
  }

  const [, identifier, secret] = match;

  return identifier === undefined || secret === undefined ? null : { identifier, secret };
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/**
 * Digest of the secret.
 *
 * SHA-256 and not argon2, unlike passwords: the secret is 48 random characters,
 * a dictionary attack has no purchase, and a slow hash would be paid on
 * **every** API request.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison, so the digest cannot be guessed. */
export function apiKeySecretMatches(secret: string, hashed: string): boolean {
  const expected = Buffer.from(hashed, 'hex');
  const received = Buffer.from(hashApiKeySecret(secret), 'hex');

  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * True if the scope allows the request.
 *
 * `read` lets only reads through: a key pasted into a dashboard must not be
 * able to stop a server. `admin` gates access to the administration routes — a
 * key from an administrator account stays bounded to their own servers until
 * that scope is granted explicitly.
 */
export function scopeAllows(scopes: readonly string[], method: string, path: string): boolean {
  const administrative = path.startsWith('/api/admin/');

  if (administrative) {
    return scopes.includes('admin');
  }

  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  return readOnly ? scopes.includes('read') || scopes.includes('write') : scopes.includes('write');
}

/**
 * True if the source address is allowed.
 *
 * An empty list imposes no restriction: that is the default, and it has to read
 * as such rather than as "no address allowed".
 */
export function ipAllowed(allowedIps: readonly string[], ip: string | undefined): boolean {
  return allowedIps.length === 0 || (ip !== undefined && allowedIps.includes(ip));
}

/** What is displayed of a key: its prefix, never its secret. */
export function displayableKey(identifier: string): string {
  return `${API_KEY_PREFIX}${identifier}.${'•'.repeat(8)}`;
}

/**
 * Random string over an alphanumeric alphabet.
 *
 * Exported because the application keys generate their secret the same way, and
 * the reasoning below about the modulo bias is worth having written once rather
 * than judged twice.
 */
export function randomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let value = '';

  for (const byte of bytes) {
    // The modulo introduces a negligible bias — 62 does not divide 256 — but
    // bounded to a ratio of 1.03 between the most and least likely characters.
    // Over 48 characters, the entropy stays far beyond what is attackable.
    value += alphabet[byte % alphabet.length];
  }

  return value;
}

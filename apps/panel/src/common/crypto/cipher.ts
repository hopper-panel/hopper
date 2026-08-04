import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto';

/**
 * Encryption primitives, with no dependency on NestJS.
 *
 * Extracted from `CryptoService` so that the seed script can produce values the
 * panel will be able to read back. Duplicating the key derivation between the
 * two would have guaranteed they diverge one day, and the symptom — unreadable
 * node secrets — would have appeared long after the mistake.
 */

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'v1';

/** Alphabet without ambiguous characters: no 0/O, no 1/l/I. */
export const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derives a 32-byte key from `APP_SECRET`.
 *
 * The salt is empty and deliberately so: HKDF's salt does not have to be
 * secret, and a fixed salt guarantees the same `APP_SECRET` yields the same key
 * after a restart — without which every already-stored secret would become
 * unreadable. It is `info` that separates the uses.
 */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), info, 32));
}

export const ENCRYPTION_INFO = 'hopper:encryption:v1';
export const SIGNING_INFO = 'hopper:signing:v1';

/**
 * Encrypts a value bound for the database.
 *
 * The `v1.<iv>.<tag>.<data>` format allows rotating the algorithm later without
 * having to guess how an existing row was encrypted.
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    ENCRYPTED_PREFIX,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptWithKey(key: Buffer, payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split('.');

  if (version !== ENCRYPTED_PREFIX || !ivPart || !tagPart || !dataPart) {
    throw new Error('Unreadable encrypted value: unexpected format.');
  }

  const decipher = createDecipheriv(AES_ALGORITHM, key, Buffer.from(ivPart, 'base64url'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  // GCM authenticates: a value tampered with in the database makes `final()`
  // throw instead of returning corrupt bytes.
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Digest of an opaque token.
 *
 * Bare SHA-256 and not argon2: these tokens are 64 random characters, they have
 * neither the low entropy nor the reuse risk of a password. A slow hash here
 * would cost hundreds of milliseconds on every daemon call for no gain.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Random string, drawn from a cryptographic source. */
export function randomString(length: number, alphabet: string = ALPHANUMERIC): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[randomInt(alphabet.length)];
  }
  return output;
}

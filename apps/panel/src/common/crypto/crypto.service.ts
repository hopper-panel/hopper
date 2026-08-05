import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';
import {
  ALPHANUMERIC,
  ENCRYPTION_INFO,
  SIGNING_INFO,
  UNAMBIGUOUS_ALPHABET,
  decryptWithKey,
  deriveKey,
  encryptWithKey,
  hashToken,
  randomString,
} from './cipher.js';

/**
 * The panel's cryptographic primitives.
 *
 * Two distinct keys are derived from `APP_SECRET` by HKDF, with different
 * `info` values: one to encrypt the secrets stored in the database, one to sign
 * the tokens. Reusing the same raw key for both uses would mean a weakness in
 * one weakened the other.
 *
 * The primitives themselves live in `cipher.ts`, with no dependency on Nest, so
 * the seed script produces values the panel can read back.
 */
@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;

  constructor(config: ConfigService<Environment, true>) {
    const secret = config.get('APP_SECRET', { infer: true });
    this.encryptionKey = deriveKey(secret, ENCRYPTION_INFO);
    this.signingKey = deriveKey(secret, SIGNING_INFO);
  }

  /** Signing key, for the tokens the panel issues. */
  getSigningKey(): Buffer {
    return this.signingKey;
  }

  encrypt(plaintext: string): string {
    return encryptWithKey(this.encryptionKey, plaintext);
  }

  decrypt(payload: string): string {
    return decryptWithKey(this.encryptionKey, payload);
  }

  hashToken(token: string): string {
    return hashToken(token);
  }

  /** Compare deux empreintes en temps constant. */
  verifyTokenHash(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashToken(token), 'utf8');
    const expected = Buffer.from(expectedHash, 'utf8');

    if (actual.length !== expected.length) {
      timingSafeEqual(actual, actual);
      return false;
    }

    return timingSafeEqual(actual, expected);
  }

  randomString(length: number, alphabet: string = ALPHANUMERIC): string {
    return randomString(length, alphabet);
  }

  /**
   * 2FA recovery code, in the form `XXXXX-XXXXX`.
   * The alphabet excludes the characters one confuses when copying from paper:
   * these codes are typed by hand, often under stress.
   */
  randomRecoveryCode(): string {
    const half = (): string => randomString(5, UNAMBIGUOUS_ALPHABET);
    return `${half()}-${half()}`;
  }
}

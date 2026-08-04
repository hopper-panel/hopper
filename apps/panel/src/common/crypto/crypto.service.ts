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
 * Primitives cryptographiques du panel.
 *
 * Deux clés distinctes sont dérivées d'`APP_SECRET` par HKDF, avec des `info`
 * différents : une pour chiffrer les secrets stockés en base, une pour signer
 * les jetons. Réutiliser la même clé brute pour les deux usages ferait qu'une
 * faiblesse dans l'un affaiblirait l'autre.
 *
 * Les primitives elles-mêmes vivent dans `cipher.ts`, sans dépendance à Nest,
 * pour que le script d'amorçage produise des valeurs relisibles par le panel.
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

  /** Clé de signature, pour les jetons émis par le panel. */
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
   * Code de récupération 2FA, au format `XXXXX-XXXXX`.
   * L'alphabet exclut les caractères qu'on confond en recopiant depuis un
   * papier : ces codes sont saisis à la main, souvent sous stress.
   */
  randomRecoveryCode(): string {
    const half = (): string => randomString(5, UNAMBIGUOUS_ALPHABET);
    return `${half()}-${half()}`;
  }
}

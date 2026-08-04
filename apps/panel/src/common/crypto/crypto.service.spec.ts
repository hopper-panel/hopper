import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Environment } from '../../config/environment.js';
import { CryptoService } from './crypto.service.js';

function makeService(secret = 'a-test-secret-long-enough-1234567890'): CryptoService {
  const config = {
    get: () => secret,
  } as unknown as ConfigService<Environment, true>;

  return new CryptoService(config);
}

describe('CryptoService', () => {
  describe('encryption', () => {
    const crypto = makeService();

    it('gives the encrypted value back', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
    });

    it('handles non-ASCII characters', () => {
      const value = 'a very special password — 日本語 🔐';
      expect(crypto.decrypt(crypto.encrypt(value))).toBe(value);
    });

    // A reused IV in GCM allows recovering the plaintext: two encryptions of
    // the same value must never produce the same result.
    it('produces a different ciphertext on every call', () => {
      const first = crypto.encrypt('identical');
      const second = crypto.encrypt('identical');
      expect(first).not.toBe(second);
      expect(crypto.decrypt(first)).toBe(crypto.decrypt(second));
    });

    it('never exposes the plaintext inside the ciphertext', () => {
      expect(crypto.encrypt('SECRET-VISIBLE')).not.toContain('SECRET-VISIBLE');
    });

    it('rejects a tampered ciphertext', () => {
      const encrypted = crypto.encrypt('value');
      const parts = encrypted.split('.');
      const tampered = [parts[0], parts[1], parts[2], 'YWJjZGVmZ2g'].join('.');
      expect(() => crypto.decrypt(tampered)).toThrow();
    });

    it('rejects an unknown format', () => {
      expect(() => crypto.decrypt('pas-un-chiffre')).toThrow(/unexpected format/);
      expect(() => crypto.decrypt('v2.a.b.c')).toThrow(/unexpected format/);
    });

    // Without this, changing APP_SECRET would make the secrets silently
    // unreadable instead of raising an explicit error.
    it('refuses to decrypt with a different key', () => {
      const encrypted = makeService('first-test-secret-of-32-characters-min').encrypt('value');
      const other = makeService('second-test-secret-of-32-characters!');
      expect(() => other.decrypt(encrypted)).toThrow();
    });

    it('yields the same key for the same APP_SECRET', () => {
      const encrypted = makeService().encrypt('persistent');
      expect(makeService().decrypt(encrypted)).toBe('persistent');
    });
  });

  describe('token digests', () => {
    const crypto = makeService();

    it('validates the right token', () => {
      const token = crypto.randomString(64);
      expect(crypto.verifyTokenHash(token, crypto.hashToken(token))).toBe(true);
    });

    it('refuses a different token', () => {
      const hash = crypto.hashToken(crypto.randomString(64));
      expect(crypto.verifyTokenHash(crypto.randomString(64), hash)).toBe(false);
    });

    it('refuses a digest of a different length', () => {
      expect(crypto.verifyTokenHash('token', 'too-short')).toBe(false);
    });

    it('is not reversible', () => {
      expect(crypto.hashToken('my-token')).not.toContain('my-token');
    });
  });

  describe('randomness', () => {
    const crypto = makeService();

    it('honours the requested length', () => {
      expect(crypto.randomString(64)).toHaveLength(64);
    });

    it('does not repeat itself', () => {
      const values = new Set(Array.from({ length: 200 }, () => crypto.randomString(32)));
      expect(values.size).toBe(200);
    });

    it('generates readable recovery codes', () => {
      const code = crypto.randomRecoveryCode();
      expect(code).toMatch(
        /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/,
      );
      // The characters one misreads are excluded from the alphabet.
      expect(code).not.toMatch(/[0O1lI]/);
    });
  });
});

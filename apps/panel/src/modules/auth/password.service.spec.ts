import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  describe('hash et verify', () => {
    it('validates the right password', async () => {
      const hashed = await service.hash('correct horse battery staple');
      expect(await service.verify(hashed, 'correct horse battery staple')).toBe(true);
    });

    it('refuses a wrong password', async () => {
      const hashed = await service.hash('correct horse battery staple');
      expect(await service.verify(hashed, 'correct horse battery stapl')).toBe(false);
    });

    // A reused salt would let one spot two accounts sharing the same password
    // just by reading the database.
    it('produces a different digest for the same password', async () => {
      const first = await service.hash('identique');
      const second = await service.hash('identique');
      expect(first).not.toBe(second);
      expect(await service.verify(second, 'identique')).toBe(true);
    });

    it('uses Argon2id with the expected parameters', async () => {
      expect(await service.hash('peu importe')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    });

    it('handles non-ASCII passwords', async () => {
      const password = 'a very long passphrase with accents éàü 🔐';
      expect(await service.verify(await service.hash(password), password)).toBe(true);
    });

    // A corrupt row has to refuse the sign-in, not produce a 500 that
    // would reveal that the account exists.
    it('returns false on an unreadable digest rather than throwing', async () => {
      expect(await service.verify('pas-une-empreinte', 'peu importe')).toBe(false);
      expect(await service.verify('', 'peu importe')).toBe(false);
    });
  });

  describe('needsRehash', () => {
    it('accepts a digest produced with the current parameters', async () => {
      expect(service.needsRehash(await service.hash('peu importe'))).toBe(false);
    });

    it.each([
      ['not enough memory', '$argon2id$v=19$m=4096,t=2,p=1$c2VsCg$aGFzaAo'],
      ['not enough iterations', '$argon2id$v=19$m=19456,t=1,p=1$c2VsCg$aGFzaAo'],
      ['variante argon2i', '$argon2i$v=19$m=19456,t=2,p=1$c2VsCg$aGFzaAo'],
      ['variante argon2d', '$argon2d$v=19$m=19456,t=2,p=1$c2VsCg$aGFzaAo'],
    ])('demands a re-encode: %s', (_label, hashed) => {
      expect(service.needsRehash(hashed)).toBe(true);
    });

    // Downgrading an already better-protected password because an operator
    // lowered the settings would be a step backwards.
    it('does not demand a re-encode for costlier parameters', () => {
      expect(service.needsRehash('$argon2id$v=19$m=65536,t=4,p=1$c2VsCg$aGFzaAo')).toBe(false);
    });

    it('demands a re-encode on an unreadable digest', () => {
      expect(service.needsRehash('pas-une-empreinte')).toBe(true);
      expect(service.needsRehash('$2y$10$abcdefghijklmnopqrstuv')).toBe(true);
    });
  });
});

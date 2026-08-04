import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Environment } from '../../config/environment.js';
import { CryptoService } from './crypto.service.js';

function makeService(secret = 'un-secret-de-test-suffisamment-long-1234'): CryptoService {
  const config = {
    get: () => secret,
  } as unknown as ConfigService<Environment, true>;

  return new CryptoService(config);
}

describe('CryptoService', () => {
  describe('chiffrement', () => {
    const crypto = makeService();

    it('restitue la valeur chiffrée', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
    });

    it('gère les caractères non ASCII', () => {
      const value = 'mot de passe très spécial — 日本語 🔐';
      expect(crypto.decrypt(crypto.encrypt(value))).toBe(value);
    });

    // Un IV réutilisé en GCM permet de retrouver le clair : deux chiffrements
    // de la même valeur ne doivent jamais produire le même résultat.
    it('produit un chiffré différent à chaque appel', () => {
      const first = crypto.encrypt('identique');
      const second = crypto.encrypt('identique');
      expect(first).not.toBe(second);
      expect(crypto.decrypt(first)).toBe(crypto.decrypt(second));
    });

    it("n'expose jamais le clair dans le chiffré", () => {
      expect(crypto.encrypt('SECRET-VISIBLE')).not.toContain('SECRET-VISIBLE');
    });

    it('rejette un chiffré altéré', () => {
      const encrypted = crypto.encrypt('valeur');
      const parts = encrypted.split('.');
      const tampered = [parts[0], parts[1], parts[2], 'YWJjZGVmZ2g'].join('.');
      expect(() => crypto.decrypt(tampered)).toThrow();
    });

    it('rejette un format inconnu', () => {
      expect(() => crypto.decrypt('pas-un-chiffre')).toThrow(/format inattendu/);
      expect(() => crypto.decrypt('v2.a.b.c')).toThrow(/format inattendu/);
    });

    // Sans cela, changer APP_SECRET rendrait les secrets illisibles en silence
    // au lieu de lever une erreur explicite.
    it('refuse de déchiffrer avec une autre clé', () => {
      const encrypted = makeService('premier-secret-de-test-de-32-caracteres').encrypt('valeur');
      const other = makeService('second-secret-de-test-de-32-caracteres!');
      expect(() => other.decrypt(encrypted)).toThrow();
    });

    it('redonne la même clé pour un même APP_SECRET', () => {
      const encrypted = makeService().encrypt('persistant');
      expect(makeService().decrypt(encrypted)).toBe('persistant');
    });
  });

  describe('empreintes de jetons', () => {
    const crypto = makeService();

    it('valide le bon jeton', () => {
      const token = crypto.randomString(64);
      expect(crypto.verifyTokenHash(token, crypto.hashToken(token))).toBe(true);
    });

    it('refuse un jeton différent', () => {
      const hash = crypto.hashToken(crypto.randomString(64));
      expect(crypto.verifyTokenHash(crypto.randomString(64), hash)).toBe(false);
    });

    it('refuse une empreinte de longueur différente', () => {
      expect(crypto.verifyTokenHash('jeton', 'trop-court')).toBe(false);
    });

    it("n'est pas réversible", () => {
      expect(crypto.hashToken('mon-jeton')).not.toContain('mon-jeton');
    });
  });

  describe('aléa', () => {
    const crypto = makeService();

    it('respecte la longueur demandée', () => {
      expect(crypto.randomString(64)).toHaveLength(64);
    });

    it('ne se répète pas', () => {
      const values = new Set(Array.from({ length: 200 }, () => crypto.randomString(32)));
      expect(values.size).toBe(200);
    });

    it('génère des codes de récupération lisibles', () => {
      const code = crypto.randomRecoveryCode();
      expect(code).toMatch(
        /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/,
      );
      // Les caractères qu'on confond à la lecture sont exclus de l'alphabet.
      expect(code).not.toMatch(/[0O1lI]/);
    });
  });
});

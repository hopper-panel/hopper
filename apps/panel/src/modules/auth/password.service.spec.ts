import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  describe('hash et verify', () => {
    it('valide le bon mot de passe', async () => {
      const hashed = await service.hash('correct horse battery staple');
      expect(await service.verify(hashed, 'correct horse battery staple')).toBe(true);
    });

    it('refuse un mot de passe erroné', async () => {
      const hashed = await service.hash('correct horse battery staple');
      expect(await service.verify(hashed, 'correct horse battery stapl')).toBe(false);
    });

    // Un sel réutilisé permettrait de repérer deux comptes partageant le même
    // mot de passe à la simple lecture de la base.
    it('produit une empreinte différente pour un même mot de passe', async () => {
      const first = await service.hash('identique');
      const second = await service.hash('identique');
      expect(first).not.toBe(second);
      expect(await service.verify(second, 'identique')).toBe(true);
    });

    it('utilise Argon2id avec les paramètres attendus', async () => {
      expect(await service.hash('peu importe')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    });

    it('gère les mots de passe non ASCII', async () => {
      const password = 'phrase de passe très longue avec des accents éàü 🔐';
      expect(await service.verify(await service.hash(password), password)).toBe(true);
    });

    // Une ligne corrompue doit refuser la connexion, pas produire une 500 qui
    // révélerait que le compte existe.
    it('renvoie false sur une empreinte illisible plutôt que de lever', async () => {
      expect(await service.verify('pas-une-empreinte', 'peu importe')).toBe(false);
      expect(await service.verify('', 'peu importe')).toBe(false);
    });
  });

  describe('needsRehash', () => {
    it('accepte une empreinte produite avec les paramètres courants', async () => {
      expect(service.needsRehash(await service.hash('peu importe'))).toBe(false);
    });

    it.each([
      ['mémoire insuffisante', '$argon2id$v=19$m=4096,t=2,p=1$c2VsCg$aGFzaAo'],
      ['itérations insuffisantes', '$argon2id$v=19$m=19456,t=1,p=1$c2VsCg$aGFzaAo'],
      ['variante argon2i', '$argon2i$v=19$m=19456,t=2,p=1$c2VsCg$aGFzaAo'],
      ['variante argon2d', '$argon2d$v=19$m=19456,t=2,p=1$c2VsCg$aGFzaAo'],
    ])('exige un réencodage : %s', (_label, hashed) => {
      expect(service.needsRehash(hashed)).toBe(true);
    });

    // Rétrograder un mot de passe déjà mieux protégé parce qu'un opérateur a
    // baissé les réglages serait un recul.
    it("n'exige pas de réencodage pour des paramètres plus coûteux", () => {
      expect(service.needsRehash('$argon2id$v=19$m=65536,t=4,p=1$c2VsCg$aGFzaAo')).toBe(false);
    });

    it('exige un réencodage sur une empreinte illisible', () => {
      expect(service.needsRehash('pas-une-empreinte')).toBe(true);
      expect(service.needsRehash('$2y$10$abcdefghijklmnopqrstuv')).toBe(true);
    });
  });
});

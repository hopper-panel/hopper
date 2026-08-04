import { describe, expect, it } from 'vitest';
import { checkCapacity, formatBytes } from './capacity.js';

const GIB = BigInt(1024 ** 3);

describe('checkCapacity', () => {
  it('autorise tant que la capacité déclarée suffit', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 16n * GIB, requested: 8n * GIB, overallocation: 0 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('refuse le serveur qui ferait déborder le node', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 30n * GIB, requested: 8n * GIB, overallocation: 0 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('Mémoire');
    // Le message doit donner les trois chiffres, sinon l'administrateur ne sait
    // pas de combien il dépasse.
    expect(verdict.reason).toContain('30 Gio');
    expect(verdict.reason).toContain('32 Gio');
    expect(verdict.reason).toContain('8 Gio');
  });

  it('accepte pile la capacité restante', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 24n * GIB, requested: 8n * GIB, overallocation: 0 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('applique le pourcentage de dépassement autorisé', () => {
    const check = {
      declared: 32n * GIB,
      allocated: 32n * GIB,
      requested: 8n * GIB,
      overallocation: 50,
    };

    expect(checkCapacity(check, 'Mémoire').allowed).toBe(true);
    expect(checkCapacity(check, 'Mémoire').limit).toBe(48n * GIB);
  });

  it('refuse au-delà du dépassement autorisé', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 47n * GIB, requested: 8n * GIB, overallocation: 50 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(false);
  });

  // Un administrateur qui gère la place à la main ne veut pas être bloqué par
  // une comptabilité qu'il n'a pas renseignée.
  it('ne compte rien si la capacité du node n’est pas déclarée', () => {
    const verdict = checkCapacity(
      { declared: 0n, allocated: 999n * GIB, requested: 64n * GIB, overallocation: 0 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('autorise sans limite quand la surallocation vaut -1', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 500n * GIB, requested: 64n * GIB, overallocation: -1 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('accepte un serveur sans limite de mémoire', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 8n * GIB, requested: 0n, overallocation: 0 },
      'Mémoire',
    );

    expect(verdict.allowed).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [0n, '0 o'],
    [512n, '512 o'],
    [1024n, '1 Kio'],
    [BigInt(1024 ** 2), '1 Mio'],
    [GIB, '1 Gio'],
    [BigInt(1024 ** 4), '1 Tio'],
    [GIB + GIB / 2n, '1.5 Gio'],
  ])('formate %s en %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

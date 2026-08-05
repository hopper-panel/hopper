import { describe, expect, it } from 'vitest';
import { checkCapacity, formatBytes } from './capacity.js';

const GIB = BigInt(1024 ** 3);

describe('checkCapacity', () => {
  it('allows as long as the declared capacity is enough', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 16n * GIB, requested: 8n * GIB, overallocation: 0 },
      'Memory',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('refuses the server that would overflow the node', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 30n * GIB, requested: 8n * GIB, overallocation: 0 },
      'Memory',
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('Memory');
    // The message has to give all three figures, otherwise the administrator
    // does not know by how much they are over.
    expect(verdict.reason).toContain('30 GiB');
    expect(verdict.reason).toContain('32 GiB');
    expect(verdict.reason).toContain('8 GiB');
  });

  it('accepts exactly the remaining capacity', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 24n * GIB, requested: 8n * GIB, overallocation: 0 },
      'Memory',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('applies the allowed overrun percentage', () => {
    const check = {
      declared: 32n * GIB,
      allocated: 32n * GIB,
      requested: 8n * GIB,
      overallocation: 50,
    };

    expect(checkCapacity(check, 'Memory').allowed).toBe(true);
    expect(checkCapacity(check, 'Memory').limit).toBe(48n * GIB);
  });

  it('refuses beyond the allowed overrun', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 47n * GIB, requested: 8n * GIB, overallocation: 50 },
      'Memory',
    );

    expect(verdict.allowed).toBe(false);
  });

  // An administrator managing space by hand does not want to be blocked by
  // accounting they never filled in.
  it('counts nothing when the node capacity is not declared', () => {
    const verdict = checkCapacity(
      { declared: 0n, allocated: 999n * GIB, requested: 64n * GIB, overallocation: 0 },
      'Memory',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('allows without limit when overallocation is -1', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 500n * GIB, requested: 64n * GIB, overallocation: -1 },
      'Memory',
    );

    expect(verdict.allowed).toBe(true);
  });

  it('accepts a server with no memory limit', () => {
    const verdict = checkCapacity(
      { declared: 32n * GIB, allocated: 8n * GIB, requested: 0n, overallocation: 0 },
      'Memory',
    );

    expect(verdict.allowed).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [0n, '0 B'],
    [512n, '512 B'],
    [1024n, '1 KiB'],
    [BigInt(1024 ** 2), '1 MiB'],
    [GIB, '1 GiB'],
    [BigInt(1024 ** 4), '1 TiB'],
    [GIB + GIB / 2n, '1.5 GiB'],
  ])('formats %s as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

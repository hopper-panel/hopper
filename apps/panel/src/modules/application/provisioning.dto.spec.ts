import { describe, expect, it } from 'vitest';
import { usernameSchema } from '../users/users.dto.js';
import { provisionServerSchema, usernameFromEmail } from './provisioning.dto.js';

const free = (): boolean => false;

describe('what a purchase has to say', () => {
  it('needs a plan, a name and an email, and nothing else', () => {
    // Everything absent — node, port, template, twelve limits — is a decision
    // the panel is better placed to make, and one that would otherwise have to
    // be configured a second time in a second product.
    const result = provisionServerSchema.safeParse({
      plan: 'minecraft-4gb',
      name: 'Survival',
      owner: { email: 'customer@example.com' },
    });

    expect(result.success).toBe(true);
    expect(result.data?.startOnCompletion).toBe(true);
    expect(result.data?.variables).toEqual({});
  });

  it('refuses an address that is not one', () => {
    const result = provisionServerSchema.safeParse({
      plan: 'minecraft-4gb',
      name: 'Survival',
      owner: { email: 'not-an-email' },
    });

    expect(result.success).toBe(false);
  });

  it('refuses a plan named in a shape no plan can have', () => {
    const result = provisionServerSchema.safeParse({
      plan: 'Minecraft 4GB',
      name: 'Survival',
      owner: { email: 'customer@example.com' },
    });

    expect(result.success).toBe(false);
  });
});

describe('deriving a username nobody chose', () => {
  it('takes the local part of the address', () => {
    expect(usernameFromEmail('julien@example.com', free)).toBe('julien');
  });

  it('drops what a username may not contain', () => {
    expect(usernameFromEmail('jean.dupont+mc@example.com', free)).toBe('jeandupontmc');
  });

  it('always produces something the panel would accept', () => {
    // The derived name goes straight into `users.create`, which validates it.
    // A local part of one character, or of none once cleaned, must not produce
    // an account creation that fails after the customer has paid.
    for (const email of ['a@example.com', '..@example.com', '++@example.com', 'é@example.com']) {
      const derived = usernameFromEmail(email, free);

      expect(usernameSchema.safeParse(derived).success).toBe(true);
    }
  });

  it('truncates a local part longer than a username may be', () => {
    const derived = usernameFromEmail(`${'a'.repeat(60)}@example.com`, free);

    expect(usernameSchema.safeParse(derived).success).toBe(true);
  });

  it('suffixes rather than collides', () => {
    const taken = new Set(['julien', 'julien-2']);

    expect(usernameFromEmail('julien@example.com', (name) => taken.has(name))).toBe('julien-3');
  });

  it('produces a name still valid after being suffixed', () => {
    const taken = new Set([`${'a'.repeat(24)}`]);
    const derived = usernameFromEmail(`${'a'.repeat(60)}@example.com`, (name) => taken.has(name));

    expect(usernameSchema.safeParse(derived).success).toBe(true);
  });

  it('gives up rather than loop for ever', () => {
    // A thousand accounts sharing one local part is not a collision to work
    // around, it is a caller sending the same address in a loop.
    expect(() => usernameFromEmail('julien@example.com', () => true)).toThrow();
  });
});

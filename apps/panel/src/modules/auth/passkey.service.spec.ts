import { describe, expect, it } from 'vitest';
import { challengeIsUsable, isCounterRegression } from './passkey.service.js';

/**
 * The two rules in the passkey path that refuse a login.
 *
 * Both are cheap to get wrong in a way nobody notices: too strict and real
 * users are locked out of their own accounts with a message accusing them of
 * cloning hardware; too loose and a copied credential signs in. Neither
 * failure shows up in a manual test with one working key.
 */

describe('isCounterRegression', () => {
  it('accepts a counter that moved forward', () => {
    expect(isCounterRegression(4, 5)).toBe(false);
  });

  it('refuses a counter that stood still', () => {
    // Same value twice from an authenticator that does count means the second
    // signature came from a copy that never saw the first.
    expect(isCounterRegression(5, 5)).toBe(true);
  });

  it('refuses a counter that went backwards', () => {
    expect(isCounterRegression(9, 3)).toBe(true);
  });

  it('accepts zero, however many times it is presented', () => {
    // Most platform authenticators — phones, laptops — never implement the
    // counter and report zero forever. Treating that as a clone would lock out
    // the majority of real passkeys on their second use.
    expect(isCounterRegression(0, 0)).toBe(false);
  });

  it('still accepts zero after a non-zero counter has been recorded', () => {
    // A credential synchronised to a new device can restart at zero. Refusing
    // would strand someone who changed phones, which is the case passkeys are
    // supposed to handle best.
    expect(isCounterRegression(12, 0)).toBe(false);
  });
});

describe('challengeIsUsable', () => {
  const now = new Date('2026-08-05T12:00:00Z');
  const later = new Date('2026-08-05T12:04:00Z');
  const earlier = new Date('2026-08-05T11:59:00Z');

  it('accepts a live challenge for its own ceremony', () => {
    expect(
      challengeIsUsable({ purpose: 'authentication', expiresAt: later }, 'authentication', now),
    ).toBe(true);
  });

  it('refuses a registration challenge presented at the login endpoint', () => {
    // Otherwise anyone able to start a registration could mint something the
    // login path accepts.
    expect(
      challengeIsUsable({ purpose: 'registration', expiresAt: later }, 'authentication', now),
    ).toBe(false);
  });

  it('refuses a challenge presented at the login endpoint the other way round', () => {
    expect(
      challengeIsUsable({ purpose: 'authentication', expiresAt: later }, 'registration', now),
    ).toBe(false);
  });

  it('refuses an expired challenge', () => {
    expect(
      challengeIsUsable({ purpose: 'authentication', expiresAt: earlier }, 'authentication', now),
    ).toBe(false);
  });

  it('refuses one expiring exactly now', () => {
    // The boundary belongs to the past: a challenge whose deadline has been
    // reached has been reached.
    expect(
      challengeIsUsable({ purpose: 'authentication', expiresAt: now }, 'authentication', now),
    ).toBe(false);
  });
});

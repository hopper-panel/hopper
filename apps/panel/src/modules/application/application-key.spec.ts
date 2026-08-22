import { describe, expect, it } from 'vitest';
import { API_KEY_PREFIX, looksLikeApiKey, parseApiKey } from '../api-keys/api-key.js';
import {
  APPLICATION_KEY_PREFIX,
  displayableApplicationKey,
  generateApplicationKey,
  looksLikeApplicationKey,
  parseApplicationKey,
  prefixesAreDistinguishable,
} from './application-key.js';

describe('application key format', () => {
  it('generates a token its own parser reads back', () => {
    const { token, identifier, secret } = generateApplicationKey();

    expect(parseApplicationKey(token)).toEqual({ identifier, secret });
  });

  it('generates a different secret every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateApplicationKey().secret));

    expect(secrets.size).toBe(50);
  });

  it.each([
    ['no prefix', 'abcdefghijklmnop.secret'],
    ['the personal keys prefix', 'hpk_abcdefghijklmnop.secret'],
    ['no separator', 'hpa_abcdefghijklmnopsecret'],
    ['a short identifier', 'hpa_abc.secret'],
    ['an empty secret', 'hpa_abcdefghijklmnop.'],
    ['a character outside the alphabet', 'hpa_abcdefghijklmno-.secret'],
  ])('refuses %s', (_case, token) => {
    expect(parseApplicationKey(token)).toBeNull();
  });

  it('shows the identifier and never the secret', () => {
    const { identifier, secret } = generateApplicationKey();
    const shown = displayableApplicationKey(identifier);

    expect(shown).toContain(identifier);
    expect(shown).not.toContain(secret);
  });
});

describe('telling the two kinds of key apart', () => {
  /**
   * The whole exclusion rests on this. `hpa_` and `hpk_` are three characters
   * apart in one position, and the guard routes on `startsWith` alone: shorten
   * either prefix and one of them starts matching the other, at which point a
   * personal key is handed to the application branch — which does not check an
   * account's role, because it has no account to check.
   */
  it('has prefixes neither of which is a prefix of the other', () => {
    expect(prefixesAreDistinguishable()).toBe(true);
  });

  it('does not take an application key for a personal one, or the reverse', () => {
    const application = generateApplicationKey().token;

    expect(looksLikeApplicationKey(application)).toBe(true);
    expect(looksLikeApiKey(application)).toBe(false);

    const personal = `${API_KEY_PREFIX}${'a'.repeat(16)}.${'b'.repeat(48)}`;

    expect(looksLikeApiKey(personal)).toBe(true);
    expect(looksLikeApplicationKey(personal)).toBe(false);
  });

  it('does not let one parser read the other kind', () => {
    const application = generateApplicationKey().token;
    const personal = `${API_KEY_PREFIX}${'a'.repeat(16)}.${'b'.repeat(48)}`;

    expect(parseApiKey(application)).toBeNull();
    expect(parseApplicationKey(personal)).toBeNull();
  });

  it('announces itself as an application key even when malformed', () => {
    // Deliberate: `hpa_nonsense` has to be refused as a bad application key
    // rather than fall through to the session branch, which would answer
    // "invalid or expired token" and send the reader looking at the wrong
    // thing.
    expect(looksLikeApplicationKey(`${APPLICATION_KEY_PREFIX}nonsense`)).toBe(true);
    expect(parseApplicationKey(`${APPLICATION_KEY_PREFIX}nonsense`)).toBeNull();
  });
});

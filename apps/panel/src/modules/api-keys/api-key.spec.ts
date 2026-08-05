import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  apiKeySecretMatches,
  displayableKey,
  generateApiKey,
  hashApiKeySecret,
  ipAllowed,
  looksLikeApiKey,
  parseApiKey,
  scopeAllows,
} from './api-key.js';

describe('generateApiKey', () => {
  it('produces a parseable key', () => {
    const { token, identifier, secret } = generateApiKey();

    expect(token).toBe(`${API_KEY_PREFIX}${identifier}.${secret}`);
    expect(parseApiKey(token)).toEqual({ identifier, secret });
  });

  it('never produces the same one twice', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().token));

    expect(keys.size).toBe(200);
  });
});

describe('parseApiKey', () => {
  it.each([
    '',
    'hpk_',
    'hpk_too-short.abc',
    // Without the prefix it would be a node token: the two formats must not be
    // confused, each is checked against a different table.
    'AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'hpk_AAAAAAAAAAAAAAAA_BBBB',
    'hpk_AAAAAAAAAAAAAAAA.with-hyphens-forbidden-in-the-secret-1234',
  ])('rejects %s', (token) => {
    expect(parseApiKey(token)).toBeNull();
  });

  it('refuses a key that is too long even if it starts well', () => {
    const { token } = generateApiKey();

    expect(parseApiKey(`${token}suite`)).toBeNull();
  });
});

describe('hashApiKeySecret', () => {
  it('is stable and verifiable', () => {
    const { secret } = generateApiKey();
    const hashed = hashApiKeySecret(secret);

    expect(apiKeySecretMatches(secret, hashed)).toBe(true);
    expect(apiKeySecretMatches('autre', hashed)).toBe(false);
  });

  it('does not throw on a digest corrupted in the database', () => {
    expect(apiKeySecretMatches('x', 'pas-de-l-hexadecimal')).toBe(false);
    expect(apiKeySecretMatches('x', '')).toBe(false);
  });
});

describe('scopeAllows', () => {
  it('lets a read key read', () => {
    expect(scopeAllows(['read'], 'GET', '/api/servers')).toBe(true);
  });

  it('stops a read key from acting', () => {
    // The case that matters: a key pasted into a dashboard must not be able to
    // stop a server.
    expect(scopeAllows(['read'], 'POST', '/api/servers/x/power')).toBe(false);
    expect(scopeAllows(['read'], 'DELETE', '/api/servers/x/files')).toBe(false);
  });

  it('lets a write key read as well', () => {
    expect(scopeAllows(['write'], 'GET', '/api/servers')).toBe(true);
    expect(scopeAllows(['write'], 'POST', '/api/servers/x/power')).toBe(true);
  });

  it('reserves administration for the dedicated scope', () => {
    expect(scopeAllows(['write'], 'GET', '/api/admin/nodes')).toBe(false);
    expect(scopeAllows(['read', 'write'], 'GET', '/api/admin/nodes')).toBe(false);
    expect(scopeAllows(['admin'], 'GET', '/api/admin/nodes')).toBe(true);
  });

  it('is not fooled by a path that starts the same', () => {
    // `/api/administration` is not `/api/admin/`: the comparison is on
    // le segment complet, barre oblique comprise.
    expect(scopeAllows(['read'], 'GET', '/api/administration')).toBe(true);
  });

  it('refuses everything to a key with no scope', () => {
    expect(scopeAllows([], 'GET', '/api/servers')).toBe(false);
    expect(scopeAllows([], 'POST', '/api/servers')).toBe(false);
  });
});

describe('ipAllowed', () => {
  it('imposes nothing when the list is empty', () => {
    expect(ipAllowed([], '203.0.113.7')).toBe(true);
    expect(ipAllowed([], undefined)).toBe(true);
  });

  it('accepts only the listed addresses', () => {
    expect(ipAllowed(['203.0.113.7'], '203.0.113.7')).toBe(true);
    expect(ipAllowed(['203.0.113.7'], '203.0.113.8')).toBe(false);
    // A request with no known source address must not pass a restriction: the
    // absence of information is not an authorisation.
    expect(ipAllowed(['203.0.113.7'], undefined)).toBe(false);
  });
});

describe('looksLikeApiKey et displayableKey', () => {
  it('recognises the prefix', () => {
    expect(looksLikeApiKey(generateApiKey().token)).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJI')).toBe(false);
  });

  it('never displays the secret', () => {
    const { identifier, secret } = generateApiKey();
    const shown = displayableKey(identifier);

    expect(shown).toContain(identifier);
    expect(shown).not.toContain(secret);
  });
});

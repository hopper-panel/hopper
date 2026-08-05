import { describe, expect, it } from 'vitest';
import { extractBearerToken, parseNodeToken, redactNodeToken } from './node-token.js';

const VALID_ID = 'a'.repeat(16);
const VALID_SECRET = 'b'.repeat(64);
const VALID_TOKEN = `${VALID_ID}.${VALID_SECRET}`;

describe('parseNodeToken', () => {
  it('splits a valid token', () => {
    expect(parseNodeToken(VALID_TOKEN)).toEqual({ id: VALID_ID, secret: VALID_SECRET });
  });

  it.each([
    ['empty string', ''],
    ['no separator', VALID_ID + VALID_SECRET],
    ['identifier too short', `${'a'.repeat(15)}.${VALID_SECRET}`],
    ['secret too short', `${VALID_ID}.${'b'.repeat(63)}`],
    ['non-alphanumeric characters', `${'a'.repeat(15)}-.${VALID_SECRET}`],
    ['multiple separators', `${VALID_ID}.${VALID_SECRET}.extra`],
    ['espaces en bordure', ` ${VALID_TOKEN} `],
  ])('rejects a token with %s', (_label, token) => {
    expect(parseNodeToken(token)).toBeNull();
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from the Bearer scheme', () => {
    expect(extractBearerToken(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  it('accepts a different case for the scheme', () => {
    expect(extractBearerToken(`bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  it.each([
    ['header absent', undefined],
    ['unknown scheme', `Basic ${VALID_TOKEN}`],
    ['scheme alone', 'Bearer'],
    ['an empty value', 'Bearer '],
  ])('returns null for %s', (_label, header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('redactNodeToken', () => {
  it('never exposes the secret', () => {
    const redacted = redactNodeToken(VALID_TOKEN);
    expect(redacted).toBe(`${VALID_ID}.<redacted>`);
    expect(redacted).not.toContain(VALID_SECRET);
  });

  it('does not leak a malformed token', () => {
    expect(redactNodeToken('not-a-token-but-a-secret')).toBe('<invalid-token>');
  });
});

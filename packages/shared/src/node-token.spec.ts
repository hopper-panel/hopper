import { describe, expect, it } from 'vitest';
import { extractBearerToken, parseNodeToken, redactNodeToken } from './node-token.js';

const VALID_ID = 'a'.repeat(16);
const VALID_SECRET = 'b'.repeat(64);
const VALID_TOKEN = `${VALID_ID}.${VALID_SECRET}`;

describe('parseNodeToken', () => {
  it('découpe un jeton valide', () => {
    expect(parseNodeToken(VALID_TOKEN)).toEqual({ id: VALID_ID, secret: VALID_SECRET });
  });

  it.each([
    ['chaîne vide', ''],
    ['sans séparateur', VALID_ID + VALID_SECRET],
    ['identifiant trop court', `${'a'.repeat(15)}.${VALID_SECRET}`],
    ['secret trop court', `${VALID_ID}.${'b'.repeat(63)}`],
    ['caractères non alphanumériques', `${'a'.repeat(15)}-.${VALID_SECRET}`],
    ['séparateurs multiples', `${VALID_ID}.${VALID_SECRET}.extra`],
    ['espaces en bordure', ` ${VALID_TOKEN} `],
  ])('refuse un jeton %s', (_label, token) => {
    expect(parseNodeToken(token)).toBeNull();
  });
});

describe('extractBearerToken', () => {
  it('extrait le jeton du schéma Bearer', () => {
    expect(extractBearerToken(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  it('accepte une casse différente pour le schéma', () => {
    expect(extractBearerToken(`bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  it.each([
    ['en-tête absent', undefined],
    ['schéma inconnu', `Basic ${VALID_TOKEN}`],
    ['schéma seul', 'Bearer'],
    ['valeur vide', 'Bearer '],
  ])('retourne null pour %s', (_label, header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('redactNodeToken', () => {
  it("n'expose jamais le secret", () => {
    const redacted = redactNodeToken(VALID_TOKEN);
    expect(redacted).toBe(`${VALID_ID}.<redacted>`);
    expect(redacted).not.toContain(VALID_SECRET);
  });

  it('ne laisse pas fuiter un jeton malformé', () => {
    expect(redactNodeToken('pas-un-jeton-mais-un-secret')).toBe('<invalid-token>');
  });
});

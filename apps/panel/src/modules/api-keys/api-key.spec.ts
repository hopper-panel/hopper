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
  it('produit une clé analysable', () => {
    const { token, identifier, secret } = generateApiKey();

    expect(token).toBe(`${API_KEY_PREFIX}${identifier}.${secret}`);
    expect(parseApiKey(token)).toEqual({ identifier, secret });
  });

  it('ne produit jamais deux fois la même', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().token));

    expect(keys.size).toBe(200);
  });
});

describe('parseApiKey', () => {
  it.each([
    '',
    'hpk_',
    'hpk_trop-court.abc',
    // Sans préfixe, ce serait un jeton de node : les deux formats ne doivent
    // pas se confondre, chacun est vérifié contre une table différente.
    'AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'hpk_AAAAAAAAAAAAAAAA_BBBB',
    'hpk_AAAAAAAAAAAAAAAA.avec-des-tirets-interdits-dans-le-secret-1234',
  ])('refuse %s', (token) => {
    expect(parseApiKey(token)).toBeNull();
  });

  it('refuse une clé trop longue même si elle commence bien', () => {
    const { token } = generateApiKey();

    expect(parseApiKey(`${token}suite`)).toBeNull();
  });
});

describe('hashApiKeySecret', () => {
  it('est stable et vérifiable', () => {
    const { secret } = generateApiKey();
    const hashed = hashApiKeySecret(secret);

    expect(apiKeySecretMatches(secret, hashed)).toBe(true);
    expect(apiKeySecretMatches('autre', hashed)).toBe(false);
  });

  it('ne lève pas sur une empreinte corrompue en base', () => {
    expect(apiKeySecretMatches('x', 'pas-de-l-hexadecimal')).toBe(false);
    expect(apiKeySecretMatches('x', '')).toBe(false);
  });
});

describe('scopeAllows', () => {
  it('laisse une clé de lecture consulter', () => {
    expect(scopeAllows(['read'], 'GET', '/api/servers')).toBe(true);
  });

  it('empêche une clé de lecture d’agir', () => {
    // Le cas qui compte : une clé collée dans un tableau de bord ne doit pas
    // pouvoir éteindre un serveur.
    expect(scopeAllows(['read'], 'POST', '/api/servers/x/power')).toBe(false);
    expect(scopeAllows(['read'], 'DELETE', '/api/servers/x/files')).toBe(false);
  });

  it('laisse une clé d’écriture lire aussi', () => {
    expect(scopeAllows(['write'], 'GET', '/api/servers')).toBe(true);
    expect(scopeAllows(['write'], 'POST', '/api/servers/x/power')).toBe(true);
  });

  it('réserve l’administration à la portée dédiée', () => {
    expect(scopeAllows(['write'], 'GET', '/api/admin/nodes')).toBe(false);
    expect(scopeAllows(['read', 'write'], 'GET', '/api/admin/nodes')).toBe(false);
    expect(scopeAllows(['admin'], 'GET', '/api/admin/nodes')).toBe(true);
  });

  it('ne se laisse pas prendre par un chemin qui commence pareil', () => {
    // `/api/administration` n'est pas `/api/admin/` : la comparaison porte sur
    // le segment complet, barre oblique comprise.
    expect(scopeAllows(['read'], 'GET', '/api/administration')).toBe(true);
  });

  it('refuse tout à une clé sans portée', () => {
    expect(scopeAllows([], 'GET', '/api/servers')).toBe(false);
    expect(scopeAllows([], 'POST', '/api/servers')).toBe(false);
  });
});

describe('ipAllowed', () => {
  it('n’impose rien quand la liste est vide', () => {
    expect(ipAllowed([], '203.0.113.7')).toBe(true);
    expect(ipAllowed([], undefined)).toBe(true);
  });

  it('n’accepte que les adresses listées', () => {
    expect(ipAllowed(['203.0.113.7'], '203.0.113.7')).toBe(true);
    expect(ipAllowed(['203.0.113.7'], '203.0.113.8')).toBe(false);
    // Une requête sans adresse source connue ne doit pas passer une
    // restriction : l'absence d'information n'est pas une autorisation.
    expect(ipAllowed(['203.0.113.7'], undefined)).toBe(false);
  });
});

describe('looksLikeApiKey et displayableKey', () => {
  it('reconnaît le préfixe', () => {
    expect(looksLikeApiKey(generateApiKey().token)).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJI')).toBe(false);
  });

  it('n’affiche jamais le secret', () => {
    const { identifier, secret } = generateApiKey();
    const shown = displayableKey(identifier);

    expect(shown).toContain(identifier);
    expect(shown).not.toContain(secret);
  });
});

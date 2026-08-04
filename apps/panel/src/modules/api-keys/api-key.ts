import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Clés d'API personnelles.
 *
 * Format : `hpk_<identifiant>.<secret>`. Le préfixe est là pour que la clé soit
 * reconnaissable — par le garde d'authentification, qui doit la distinguer d'un
 * jeton de session, mais aussi par les outils de balayage de dépôts, qui
 * préviennent quand un secret est poussé par accident.
 *
 * L'identifiant est public et stocké en clair : il permet de retrouver la ligne
 * sans comparer le secret à toute la table. Le secret n'est stocké que haché.
 */

export const API_KEY_PREFIX = 'hpk_';
export const API_KEY_IDENTIFIER_LENGTH = 16;
export const API_KEY_SECRET_LENGTH = 48;

const PATTERN = new RegExp(
  `^${API_KEY_PREFIX}([A-Za-z0-9]{${API_KEY_IDENTIFIER_LENGTH}})\\.([A-Za-z0-9]{${API_KEY_SECRET_LENGTH}})$`,
);

/**
 * Portées d'une clé.
 *
 * Trois seulement, et volontairement grossières : une clé n'accorde jamais plus
 * que ce que son propriétaire possède déjà, la question n'est donc pas *quoi*
 * mais *jusqu'où*. Un mécanisme plus fin donnerait l'illusion d'un contrôle que
 * personne ne relit.
 */
export const API_KEY_SCOPES = ['read', 'write', 'admin'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export interface ParsedApiKey {
  identifier: string;
  secret: string;
}

export function generateApiKey(): { token: string; identifier: string; secret: string } {
  const identifier = randomString(API_KEY_IDENTIFIER_LENGTH);
  const secret = randomString(API_KEY_SECRET_LENGTH);

  return { token: `${API_KEY_PREFIX}${identifier}.${secret}`, identifier, secret };
}

/** Découpe une clé. `null` sur un format invalide, sans distinguer la raison. */
export function parseApiKey(token: string): ParsedApiKey | null {
  const match = PATTERN.exec(token);

  if (!match) {
    return null;
  }

  const [, identifier, secret] = match;

  return identifier === undefined || secret === undefined ? null : { identifier, secret };
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/**
 * Empreinte du secret.
 *
 * SHA-256 et non argon2, contrairement aux mots de passe : le secret fait 48
 * caractères tirés au hasard, une attaque par dictionnaire n'a aucune prise, et
 * un hachage lent serait payé à **chaque requête** d'API.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Comparaison à temps constant, pour ne pas laisser deviner l'empreinte. */
export function apiKeySecretMatches(secret: string, hashed: string): boolean {
  const expected = Buffer.from(hashed, 'hex');
  const received = Buffer.from(hashApiKeySecret(secret), 'hex');

  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Vrai si la portée autorise la requête.
 *
 * `read` ne laisse passer que les lectures : une clé collée dans un tableau de
 * bord ne doit pas pouvoir éteindre un serveur. `admin` conditionne l'accès aux
 * routes d'administration — une clé d'un compte administrateur reste bornée à
 * ses propres serveurs tant que la portée n'est pas accordée explicitement.
 */
export function scopeAllows(scopes: readonly string[], method: string, path: string): boolean {
  const administrative = path.startsWith('/api/admin/');

  if (administrative) {
    return scopes.includes('admin');
  }

  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  return readOnly ? scopes.includes('read') || scopes.includes('write') : scopes.includes('write');
}

/**
 * Vrai si l'adresse source est autorisée.
 *
 * Une liste vide n'impose aucune restriction : c'est le cas par défaut, et il
 * doit rester lisible comme tel plutôt que comme « aucune adresse autorisée ».
 */
export function ipAllowed(allowedIps: readonly string[], ip: string | undefined): boolean {
  return allowedIps.length === 0 || (ip !== undefined && allowedIps.includes(ip));
}

/** Ce qu'on affiche d'une clé : son préfixe, jamais son secret. */
export function displayableKey(identifier: string): string {
  return `${API_KEY_PREFIX}${identifier}.${'•'.repeat(8)}`;
}

function randomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let value = '';

  for (const byte of bytes) {
    // Le modulo introduit un biais négligeable — 62 ne divise pas 256 — mais
    // borné à un rapport de 1,03 entre les caractères les plus et les moins
    // probables. Sur 48 caractères, l'entropie reste très au-delà de ce qui est
    // attaquable.
    value += alphabet[byte % alphabet.length];
  }

  return value;
}

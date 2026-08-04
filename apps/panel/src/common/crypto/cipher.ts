import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomInt,
} from 'node:crypto';

/**
 * Primitives de chiffrement, sans dépendance à NestJS.
 *
 * Extraites de `CryptoService` pour que le script d'amorçage puisse produire
 * des valeurs que le panel saura relire. Dupliquer la dérivation de clé entre
 * les deux aurait garanti qu'elles divergent un jour, et le symptôme — des
 * secrets de node illisibles — serait apparu longtemps après la faute.
 */

const AES_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'v1';

/** Alphabet sans caractères ambigus : pas de 0/O, ni 1/l/I. */
export const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Dérive une clé de 32 octets à partir d'`APP_SECRET`.
 *
 * Le sel est vide et volontaire : celui de HKDF n'a pas besoin d'être secret,
 * et un sel fixe garantit qu'un même `APP_SECRET` redonne la même clé après un
 * redémarrage — sans quoi tous les secrets déjà stockés deviendraient
 * illisibles. C'est `info` qui sépare les usages.
 */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), info, 32));
}

export const ENCRYPTION_INFO = 'hopper:encryption:v1';
export const SIGNING_INFO = 'hopper:signing:v1';

/**
 * Chiffre une valeur destinée à la base.
 *
 * Le format `v1.<iv>.<tag>.<données>` permet une rotation d'algorithme plus
 * tard sans avoir à deviner comment une ligne existante a été chiffrée.
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    ENCRYPTED_PREFIX,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptWithKey(key: Buffer, payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split('.');

  if (version !== ENCRYPTED_PREFIX || !ivPart || !tagPart || !dataPart) {
    throw new Error('Valeur chiffrée illisible : format inattendu.');
  }

  const decipher = createDecipheriv(AES_ALGORITHM, key, Buffer.from(ivPart, 'base64url'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  // GCM authentifie : une valeur modifiée en base fait lever `final()` au lieu
  // de retourner des octets corrompus.
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Empreinte d'un jeton opaque.
 *
 * SHA-256 nu et non argon2 : ces jetons font 64 caractères aléatoires, ils
 * n'ont ni la faible entropie ni le risque de réutilisation d'un mot de passe.
 * Un hash lent ici coûterait des centaines de millisecondes à chaque appel du
 * daemon sans rien apporter.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Chaîne aléatoire, tirée d'une source cryptographique. */
export function randomString(length: number, alphabet: string = ALPHANUMERIC): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[randomInt(alphabet.length)];
  }
  return output;
}

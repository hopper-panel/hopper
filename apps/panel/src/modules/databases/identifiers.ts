/**
 * Fabrication et échappement des identifiants MySQL.
 *
 * **C'est le point d'injection du module.** Une requête préparée protège les
 * *valeurs*, mais un nom de base ou d'utilisateur est un **identifiant** : il ne
 * peut pas être passé en paramètre, il faut l'écrire dans le texte de la
 * requête. `CREATE DATABASE ?` n'existe pas.
 *
 * Deux barrières se superposent, et aucune ne suffit seule :
 *
 *  1. **Validation stricte à l'entrée** — un identifiant n'accepte que des
 *     lettres, des chiffres et le souligné. Rien de ce qui pourrait clore une
 *     citation, ouvrir un commentaire ou terminer une instruction ne passe.
 *  2. **Échappement à l'écriture** — l'identifiant est encadré de backticks et
 *     les backticks internes sont doublés, comme MySQL l'exige. La validation
 *     les exclut déjà ; le doublement reste là pour que la fonction soit sûre
 *     même appelée avec une valeur qui n'aurait pas été validée.
 *
 * Le nom demandé par l'utilisateur n'est de plus jamais utilisé tel quel : il
 * est préfixé par l'identifiant du serveur. Deux serveurs ne peuvent donc pas
 * se disputer un nom, ni deviner celui du voisin.
 */

/** Longueur maximale d'un nom de base MySQL. */
const MAX_DATABASE_NAME = 64;

/**
 * Longueur maximale d'un nom d'utilisateur MySQL.
 *
 * 32 caractères depuis MySQL 5.7 — et 16 avant. On s'en tient à 32, en
 * réservant assez de place au préfixe pour que le suffixe aléatoire garde son
 * entropie.
 */
const MAX_USER_NAME = 32;

export class IdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierError';
  }
}

/** Un identifiant sûr : lettres, chiffres, souligné, ne commençant pas par un chiffre. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Valide la partie du nom choisie par l'utilisateur.
 *
 * @throws {IdentifierError} sur tout caractère hors de l'alphabet autorisé.
 */
export function assertSafeName(name: string): string {
  const trimmed = name.trim();

  if (trimmed === '') {
    throw new IdentifierError('Le nom de la base est obligatoire.');
  }

  if (trimmed.length > 32) {
    throw new IdentifierError('Le nom de la base ne peut pas dépasser 32 caractères.');
  }

  if (!SAFE_IDENTIFIER.test(trimmed)) {
    throw new IdentifierError(
      'Le nom ne peut contenir que des lettres, des chiffres et des soulignés, et doit ' +
        'commencer par une lettre.',
    );
  }

  return trimmed;
}

/**
 * Encadre un identifiant de backticks.
 *
 * Le doublement des backticks internes est la seule façon prévue par MySQL
 * d'en insérer un dans un identifiant cité. Il ne devrait jamais servir — la
 * validation les exclut — mais une fonction d'échappement qui suppose son
 * entrée déjà propre n'échappe rien.
 */
export function quoteIdentifier(identifier: string): string {
  if (identifier.includes('\0')) {
    throw new IdentifierError("Un identifiant ne peut pas contenir d'octet nul.");
  }

  return `\`${identifier.replace(/`/g, '``')}\``;
}

/** Nom complet d'une base : `s<serveur>_<nom>`. */
export function databaseNameFor(serverId: number, name: string): string {
  const full = `s${serverId}_${assertSafeName(name)}`;

  if (full.length > MAX_DATABASE_NAME) {
    throw new IdentifierError(`Le nom complet dépasserait ${MAX_DATABASE_NAME} caractères.`);
  }

  return full;
}

/**
 * Nom d'utilisateur d'une base : `u<serveur>_<aléa>`.
 *
 * Aléatoire et non dérivé du nom de la base : deux bases d'un même serveur ont
 * ainsi des comptes distincts, et supprimer l'une ne coupe pas l'accès à
 * l'autre.
 */
export function userNameFor(serverId: number, random: string): string {
  const full = `u${serverId}_${random}`;

  if (full.length > MAX_USER_NAME) {
    throw new IdentifierError(`Le nom d'utilisateur dépasserait ${MAX_USER_NAME} caractères.`);
  }

  if (!SAFE_IDENTIFIER.test(full)) {
    throw new IdentifierError("Nom d'utilisateur invalide.");
  }

  return full;
}

/**
 * Motif d'hôte autorisé à se connecter.
 *
 * MySQL accepte une adresse, un nom d'hôte, ou `%` comme joker. La valeur est
 * placée dans une **chaîne** de la requête `CREATE USER … @ '…'`, donc passable
 * en paramètre — mais elle est validée quand même, parce qu'un motif fantaisiste
 * produit un compte qui ne se connecte de nulle part, sans que rien ne le dise.
 */
export function assertSafeHostPattern(remote: string): string {
  const trimmed = remote.trim();

  if (trimmed === '') {
    return '%';
  }

  if (trimmed.length > 60) {
    throw new IdentifierError('Le motif de connexion est trop long.');
  }

  // Lettres, chiffres, point, tiret, souligné, deux-points (IPv6) et les
  // jokers `%` et `_` de MySQL.
  if (!/^[A-Za-z0-9._:%-]+$/.test(trimmed)) {
    throw new IdentifierError(
      "Motif de connexion invalide : une adresse, un nom d'hôte, ou % pour n'importe où.",
    );
  }

  return trimmed;
}

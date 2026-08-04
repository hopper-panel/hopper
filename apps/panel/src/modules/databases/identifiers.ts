/**
 * Building and escaping MySQL identifiers.
 *
 * **This is the module's injection point.** A prepared statement protects
 * *values*, but a database or user name is an **identifier**: it cannot be
 * passed as a parameter, it has to be written into the text of the query.
 * `CREATE DATABASE ?` does not exist.
 *
 * Two barriers stack, and neither is enough on its own:
 *
 *  1. **Strict validation on input** — an identifier accepts letters, digits
 *     and the underscore only. Nothing that could close a quote, open a comment
 *     or end a statement gets through.
 *  2. **Escaping on write** — the identifier is wrapped in backticks and inner
 *     backticks are doubled, as MySQL requires. Validation already excludes
 *     them; the doubling stays so the function is safe even when called with a
 *     value that was never validated.
 *
 * The name the user asks for is moreover never used as is: it is prefixed with
 * the server's identifier. Two servers therefore cannot fight over a name, nor
 * guess their neighbour's.
 */

/** Longueur maximale d'un nom de base MySQL. */
const MAX_DATABASE_NAME = 64;

/**
 * Longest a MySQL user name may be.
 *
 * 32 characters since MySQL 5.7 — and 16 before. We stick to 32, reserving
 * enough room for the prefix that the random suffix keeps its entropy.
 */
const MAX_USER_NAME = 32;

export class IdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierError';
  }
}

/** A safe identifier: letters, digits, underscore, not starting with a digit. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates the part of the name chosen by the user.
 *
 * @throws {IdentifierError} on any character outside the allowed alphabet.
 */
export function assertSafeName(name: string): string {
  const trimmed = name.trim();

  if (trimmed === '') {
    throw new IdentifierError('Le nom de la base est obligatoire.');
  }

  if (trimmed.length > 32) {
    throw new IdentifierError('The database name cannot exceed 32 characters.');
  }

  if (!SAFE_IDENTIFIER.test(trimmed)) {
    throw new IdentifierError(
      'The name may contain only letters, digits and underscores, and has to ' +
        'start with a letter.',
    );
  }

  return trimmed;
}

/**
 * Wraps an identifier in backticks.
 *
 * Doubling inner backticks is the only way MySQL provides to put one inside a
 * quoted identifier. It should never be needed — validation excludes them — but
 * an escaping function that assumes its input is already clean escapes nothing.
 */
export function quoteIdentifier(identifier: string): string {
  if (identifier.includes('\0')) {
    throw new IdentifierError('An identifier cannot contain a null byte.');
  }

  return `\`${identifier.replace(/`/g, '``')}\``;
}

/** Nom complet d'une base : `s<serveur>_<nom>`. */
export function databaseNameFor(serverId: number, name: string): string {
  const full = `s${serverId}_${assertSafeName(name)}`;

  if (full.length > MAX_DATABASE_NAME) {
    throw new IdentifierError(`The full name would exceed ${MAX_DATABASE_NAME} characters.`);
  }

  return full;
}

/**
 * User name for a database: `u<server>_<random>`.
 *
 * Random rather than derived from the database name: two databases of the same
 * server thus get distinct accounts, and deleting one does not cut access to
 * the other.
 */
export function userNameFor(serverId: number, random: string): string {
  const full = `u${serverId}_${random}`;

  if (full.length > MAX_USER_NAME) {
    throw new IdentifierError(`The user name would exceed ${MAX_USER_NAME} characters.`);
  }

  if (!SAFE_IDENTIFIER.test(full)) {
    throw new IdentifierError("Nom d'utilisateur invalide.");
  }

  return full;
}

/**
 * Host pattern allowed to connect.
 *
 * MySQL accepts an address, a host name, or `%` as a wildcard. The value goes
 * into a **string** of the `CREATE USER … @ '…'` query, so it could be passed
 * as a parameter — but it is validated anyway, because a fanciful pattern
 * produces an account that connects from nowhere, with nothing to say so.
 */
export function assertSafeHostPattern(remote: string): string {
  const trimmed = remote.trim();

  if (trimmed === '') {
    return '%';
  }

  if (trimmed.length > 60) {
    throw new IdentifierError('Le motif de connexion est trop long.');
  }

  // Letters, digits, dot, hyphen, underscore, colon (IPv6) and MySQL's `%` and
  // `_` wildcards.
  if (!/^[A-Za-z0-9._:%-]+$/.test(trimmed)) {
    throw new IdentifierError(
      'Invalid connection pattern: an address, a host name, or % for anywhere.',
    );
  }

  return trimmed;
}

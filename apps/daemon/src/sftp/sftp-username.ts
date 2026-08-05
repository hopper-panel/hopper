/**
 * SFTP username: `<user>.<first 8 characters of the UUID>`.
 *
 * The target server is encoded in the username because SFTP offers no other
 * channel to carry it — no header, no parameter. A client connects as
 * `julien.b10a05a8` and lands in that server.
 *
 * The suffix is a UUID prefix, not the whole UUID: a 45-character username is
 * refused by several SFTP clients, and eight hexadecimal characters are more
 * than enough to tell an instance's servers apart. The remaining ambiguity is
 * resolved panel-side, which checks the user really has access to the server
 * that was found.
 */

export const SERVER_ID_LENGTH = 8;

export interface ParsedSftpUsername {
  username: string;
  /** Prefix of the server UUID, lowercased. */
  serverIdPrefix: string;
}

/**
 * Splits an SFTP username.
 *
 * The split happens on the **last** dot: usernames cannot contain one
 * (`usernameSchema` forbids it), but splitting on the first would make the
 * format fragile if that rule ever changed.
 *
 * @returns `null` if the format does not fit. The caller must then answer as it
 *   would to a wrong password, without distinguishing the two cases.
 */
export function parseSftpUsername(raw: string): ParsedSftpUsername | null {
  const separator = raw.lastIndexOf('.');

  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }

  const username = raw.slice(0, separator);
  const serverIdPrefix = raw.slice(separator + 1).toLowerCase();

  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) {
    return null;
  }

  if (!/^[0-9a-f]{8}$/.test(serverIdPrefix)) {
    return null;
  }

  return { username, serverIdPrefix };
}

/** Builds the username to display in the interface. */
export function buildSftpUsername(username: string, serverUuid: string): string {
  return `${username}.${serverUuid.slice(0, SERVER_ID_LENGTH)}`;
}

/**
 * Nom d'utilisateur SFTP : `<utilisateur>.<8 premiers caractères de l'UUID>`.
 *
 * Le serveur visé est encodé dans le nom d'utilisateur parce que SFTP n'offre
 * aucun autre canal pour le transmettre — pas d'en-tête, pas de paramètre. Un
 * client se connecte à `julien.b10a05a8` et atterrit dans ce serveur-là.
 *
 * Le suffixe est un préfixe d'UUID, pas l'UUID entier : un nom d'utilisateur de
 * 45 caractères est refusé par plusieurs clients SFTP, et huit caractères
 * hexadécimaux suffisent largement à distinguer les serveurs d'une instance.
 * L'ambiguïté résiduelle est levée côté panel, qui vérifie que l'utilisateur a
 * bien accès au serveur trouvé.
 */

export const SERVER_ID_LENGTH = 8;

export interface ParsedSftpUsername {
  username: string;
  /** Préfixe de l'UUID du serveur, en minuscules. */
  serverIdPrefix: string;
}

/**
 * Découpe un nom d'utilisateur SFTP.
 *
 * Le découpage se fait sur le **dernier** point : les noms d'utilisateur ne
 * peuvent pas en contenir (`usernameSchema` les interdit), mais couper sur le
 * premier rendrait le format fragile si cette règle changeait un jour.
 *
 * @returns `null` si le format ne convient pas. L'appelant doit alors répondre
 *   comme à un mot de passe erroné, sans distinguer les deux cas.
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

/** Construit le nom d'utilisateur à afficher dans l'interface. */
export function buildSftpUsername(username: string, serverUuid: string): string {
  return `${username}.${serverUuid.slice(0, SERVER_ID_LENGTH)}`;
}

/**
 * Format des jetons de node : `<tokenId>.<tokenSecret>`.
 *
 * L'identifiant est public et stocké en clair — c'est lui qui permet au panel de
 * retrouver le node sans avoir à comparer le secret à toute la table. Le secret
 * n'est stocké que hashé, côté panel. Un jeton fuité se révoque en régénérant la
 * paire, sans toucher au reste de la configuration du node.
 */

export const NODE_TOKEN_ID_LENGTH = 16;
export const NODE_TOKEN_SECRET_LENGTH = 64;

const NODE_TOKEN_PATTERN = new RegExp(
  `^([A-Za-z0-9]{${NODE_TOKEN_ID_LENGTH}})\\.([A-Za-z0-9]{${NODE_TOKEN_SECRET_LENGTH}})$`,
);

export interface ParsedNodeToken {
  id: string;
  secret: string;
}

/**
 * Découpe un jeton de node. Retourne `null` sur un format invalide : les
 * appelants doivent traiter ce cas comme un échec d'authentification, sans
 * distinguer « format invalide » de « secret incorrect » dans la réponse.
 */
export function parseNodeToken(token: string): ParsedNodeToken | null {
  const match = NODE_TOKEN_PATTERN.exec(token);
  if (!match) {
    return null;
  }

  const [, id, secret] = match;
  if (id === undefined || secret === undefined) {
    return null;
  }

  return { id, secret };
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer <token>`. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) {
    return null;
  }

  return value;
}

/**
 * Masque un jeton pour les journaux : on garde l'identifiant, qui est public et
 * suffit à savoir de quel node il s'agit, et on efface le secret.
 */
export function redactNodeToken(token: string): string {
  const parsed = parseNodeToken(token);
  return parsed ? `${parsed.id}.<redacted>` : '<invalid-token>';
}

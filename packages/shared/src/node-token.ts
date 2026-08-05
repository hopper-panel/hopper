/**
 * Node token format: `<tokenId>.<tokenSecret>`.
 *
 * The id is public and stored in clear — it is what lets the panel find the
 * node without comparing the secret against the whole table. The secret is only
 * ever stored hashed. A leaked token is revoked by regenerating the pair,
 * leaving the rest of the node configuration untouched.
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
 * Splits a node token. Returns `null` on an invalid format: callers must treat
 * that as an authentication failure, without telling "malformed" apart from
 * "wrong secret" in the response.
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

/** Masks a token for logs: the id is public and identifies the node on its own. */
export function redactNodeToken(token: string): string {
  const parsed = parseNodeToken(token);
  return parsed ? `${parsed.id}.<redacted>` : '<invalid-token>';
}

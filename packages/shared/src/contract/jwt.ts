import { z } from 'zod';
import { permissionSchema } from '../permissions.js';

/**
 * Payload of the JWT the panel issues to authorise a WebSocket connection or a
 * file download with the daemon.
 *
 * The daemon checks the signature with the node's shared secret, then applies
 * `permissions` message by message. It does not call the panel back: that is
 * what keeps the console fluid, and it is why the lifetime has to stay short —
 * a permission revoked in the panel only takes effect when the token is
 * renewed.
 */
export const consoleTokenPayloadSchema = z.object({
  /** Issuer: the panel's public URL. */
  iss: z.string(),
  /** Audience: the node identifier. */
  aud: z.string(),
  /** User identifier, for the audit on the daemon side. */
  sub: z.string(),
  /** UUID of the server this token grants access to. */
  serverUuid: z.uuid(),
  permissions: z.array(permissionSchema),
  /**
   * Unique token identifier.
   *
   * It makes every token distinct even when two are minted in the same second
   * with otherwise identical claims — and that is the whole of it: nothing
   * reads this claim. It is **not** a revocation handle. There is no deny-list
   * in the panel and no seen-set in the daemon, so a token authenticates as
   * many connections as its bearer likes until it expires, and withdrawing an
   * access before then means the lifetime below and nothing else.
   */
  jti: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type ConsoleTokenPayload = z.infer<typeof consoleTokenPayloadSchema>;

/**
 * Lifetime of a console token — and, being the only bound there is on one, the
 * window during which a withdrawn access still works.
 *
 * The daemon verifies this token alone and never calls the panel back, so it
 * cannot know that the session behind it was signed out, that the password was
 * changed or that the account was suspended. Revocation reaches a console only
 * by refusing the *next* renewal, which is an ordinary authenticated call to
 * the panel; until then the console stays open. That is what this figure buys,
 * and why it was brought down from ten minutes to two.
 *
 * It cannot usefully go much lower. The daemon warns the client
 * `CONSOLE_TOKEN_RENEW_MARGIN_SECONDS` before expiry and that warning is the
 * only thing that triggers a renewal: a lifetime at or below the margin means
 * no warning at all, and every console dies at expiry and reconnects from
 * scratch instead of renewing in place. This is also the tolerance to a node
 * clock running ahead of the panel's — beyond this many seconds of skew, tokens
 * arrive already expired.
 */
export const CONSOLE_TOKEN_TTL_SECONDS = 120;

/** Margin before expiry at which the daemon emits `token_expiring`. */
export const CONSOLE_TOKEN_RENEW_MARGIN_SECONDS = 60;

/**
 * Payload of a signed URL (file or backup download). Much shorter-lived than a
 * console token: the URL travels in the clear through the address bar and the
 * browser history.
 *
 * That brevity is the whole protection. The URL is **not** single-use: its
 * `jti` is consumed by nobody, so it serves as many downloads as whoever holds
 * it cares to start, for as long as it is valid.
 */
export const signedUrlPayloadSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string(),
  serverUuid: z.uuid(),
  /** What the URL authorises, and on exactly what. */
  resource: z.discriminatedUnion('type', [
    z.object({ type: z.literal('file-download'), path: z.string() }),
    z.object({ type: z.literal('file-upload'), directory: z.string() }),
    z.object({ type: z.literal('backup-download'), backupUuid: z.uuid() }),
  ]),
  jti: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type SignedUrlPayload = z.infer<typeof signedUrlPayloadSchema>;

export const SIGNED_URL_TTL_SECONDS = 60;

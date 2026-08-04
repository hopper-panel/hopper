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
  /** Destinataire : l'identifiant du node. */
  aud: z.string(),
  /** User identifier, for the audit on the daemon side. */
  sub: z.string(),
  /** UUID of the server this token grants access to. */
  serverUuid: z.uuid(),
  permissions: z.array(permissionSchema),
  /** Unique token identifier, allowing a targeted revocation. */
  jti: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type ConsoleTokenPayload = z.infer<typeof consoleTokenPayloadSchema>;

/**
 * Lifetime of a console token. Deliberately short: the daemon cannot know a
 * permission was withdrawn between two renewals.
 */
export const CONSOLE_TOKEN_TTL_SECONDS = 600;

/** Margin before expiry at which the daemon emits `token_expiring`. */
export const CONSOLE_TOKEN_RENEW_MARGIN_SECONDS = 60;

/**
 * Payload of a single-use signed URL (file or backup download). Much shorter
 * than a console token: the URL travels in the clear through the address bar
 * and the browser history.
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

import { z } from 'zod';
import { permissionSchema } from '../permissions.js';

/**
 * Charge utile du JWT que le panel émet pour autoriser une connexion WebSocket
 * ou un téléchargement de fichier auprès du daemon.
 *
 * Le daemon vérifie la signature avec le secret partagé du node, puis applique
 * `permissions` message par message. Il ne rappelle pas le panel : c'est ce qui
 * permet à la console de rester fluide, et c'est pourquoi la durée de vie doit
 * rester courte — une permission révoquée dans le panel n'est effective qu'au
 * renouvellement du jeton.
 */
export const consoleTokenPayloadSchema = z.object({
  /** Émetteur : l'URL publique du panel. */
  iss: z.string(),
  /** Destinataire : l'identifiant du node. */
  aud: z.string(),
  /** Identifiant de l'utilisateur, pour l'audit côté daemon. */
  sub: z.string(),
  /** UUID du serveur auquel ce jeton donne accès. */
  serverUuid: z.uuid(),
  permissions: z.array(permissionSchema),
  /** Identifiant unique du jeton, permet une révocation ciblée. */
  jti: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type ConsoleTokenPayload = z.infer<typeof consoleTokenPayloadSchema>;

/**
 * Durée de vie d'un jeton de console. Volontairement courte : le daemon ne
 * peut pas savoir qu'une permission a été retirée entre deux renouvellements.
 */
export const CONSOLE_TOKEN_TTL_SECONDS = 600;

/** Marge avant expiration à laquelle le daemon émet `token_expiring`. */
export const CONSOLE_TOKEN_RENEW_MARGIN_SECONDS = 60;

/**
 * Charge utile d'une URL signée à usage unique (téléchargement de fichier ou de
 * backup). Bien plus courte qu'un jeton de console : l'URL transite en clair
 * dans la barre d'adresse et l'historique du navigateur.
 */
export const signedUrlPayloadSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string(),
  serverUuid: z.uuid(),
  /** Ce que l'URL autorise, et sur quoi exactement. */
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

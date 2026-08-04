import { z } from 'zod';
import { powerActionSchema, resourceUsageSchema, serverStateSchema } from '../server-state.js';
import { permissionSchema } from '../permissions.js';

/**
 * Protocole WebSocket **navigateur ↔ daemon**.
 *
 * Le navigateur se connecte directement au daemon : le panel ne relaie rien.
 * Il obtient d'abord un JWT court auprès du panel, puis l'envoie dans un message
 * `auth`. Tant que l'authentification n'a pas réussi, le daemon ignore tout
 * autre message et ferme la connexion après 10 secondes.
 *
 * Le JWT expirant vite, le daemon prévient le client (`token_expiring`) avant
 * l'échéance pour qu'il en demande un nouveau sans couper la console.
 */

// ---------------------------------------------------------------------------
// Navigateur → daemon
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('auth'), token: z.string().min(1) }),
  z.object({ event: z.literal('send_command'), command: z.string().max(2000) }),
  z.object({ event: z.literal('set_state'), action: powerActionSchema }),
  /** Demande le renvoi du tampon de console (à la connexion ou après un rafraîchissement). */
  z.object({ event: z.literal('request_logs') }),
  z.object({ event: z.literal('request_stats') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Daemon → navigateur
// ---------------------------------------------------------------------------

export const serverMessageSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('auth_success'),
    permissions: z.array(permissionSchema),
    /** Date d'expiration du JWT courant, en millisecondes epoch. */
    expiresAt: z.number().int().positive(),
  }),
  /** Le jeton expire bientôt : demander un nouveau jeton au panel et renvoyer `auth`. */
  z.object({ event: z.literal('token_expiring') }),
  z.object({ event: z.literal('token_expired') }),

  z.object({ event: z.literal('status'), state: serverStateSchema }),
  z.object({ event: z.literal('stats'), usage: resourceUsageSchema }),

  /** Une ligne de sortie du serveur, sans le saut de ligne final. */
  z.object({ event: z.literal('console_output'), line: z.string() }),
  /** Message émis par Hopper lui-même, à afficher distinctement de la sortie du serveur. */
  z.object({ event: z.literal('daemon_message'), message: z.string() }),

  z.object({ event: z.literal('install_started') }),
  z.object({ event: z.literal('install_output'), line: z.string() }),
  z.object({ event: z.literal('install_completed'), successful: z.boolean() }),

  z.object({ event: z.literal('backup_completed'), backupUuid: z.uuid(), successful: z.boolean() }),
  z.object({ event: z.literal('backup_restore_completed'), successful: z.boolean() }),

  z.object({ event: z.literal('error'), code: z.string(), message: z.string() }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Codes d'erreur transportés par l'événement `error`. */
export const WS_ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',
  INVALID_TOKEN: 'invalid_token',
  FORBIDDEN: 'forbidden',
  INVALID_MESSAGE: 'invalid_message',
  SERVER_LOCKED: 'server_locked',
  RATE_LIMITED: 'rate_limited',
  INTERNAL: 'internal',
} as const;

export type WsErrorCode = (typeof WS_ERROR_CODES)[keyof typeof WS_ERROR_CODES];

/**
 * Nombre de lignes de console conservées par le daemon et renvoyées à la
 * connexion. Assez pour voir une stack trace complète, assez peu pour ne pas
 * peser sur la mémoire avec cinquante serveurs.
 */
export const CONSOLE_BUFFER_LINES = 500;

import { z } from 'zod';
import { powerActionSchema, resourceUsageSchema, serverStateSchema } from '../server-state.js';
import { permissionSchema } from '../permissions.js';

/**
 * WebSocket protocol, **browser ↔ daemon**.
 *
 * The browser connects straight to the daemon: the panel relays nothing. It
 * first obtains a short JWT from the panel, then sends it in an `auth` message.
 * Until authentication has succeeded, the daemon ignores every other message
 * and closes the connection after 10 seconds.
 *
 * Since the JWT expires quickly, the daemon warns the client
 * (`token_expiring`) ahead of time so it can ask for a new one without cutting
 * the console.
 */

// ---------------------------------------------------------------------------
// Browser → daemon
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('auth'), token: z.string().min(1) }),
  z.object({ event: z.literal('send_command'), command: z.string().max(2000) }),
  z.object({ event: z.literal('set_state'), action: powerActionSchema }),
  /** Asks for the console buffer again (on connect or after a refresh). */
  z.object({ event: z.literal('request_logs') }),
  z.object({ event: z.literal('request_stats') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Daemon → browser
// ---------------------------------------------------------------------------

export const serverMessageSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('auth_success'),
    permissions: z.array(permissionSchema),
    /** Date d'expiration du JWT courant, en millisecondes epoch. */
    expiresAt: z.number().int().positive(),
  }),
  /** The token expires soon: ask the panel for a new one and send `auth` again. */
  z.object({ event: z.literal('token_expiring') }),
  z.object({ event: z.literal('token_expired') }),

  z.object({ event: z.literal('status'), state: serverStateSchema }),
  z.object({ event: z.literal('stats'), usage: resourceUsageSchema }),

  /** One line of server output, without the trailing newline. */
  z.object({ event: z.literal('console_output'), line: z.string() }),
  /** A message from Hopper itself, to be shown apart from the server's output. */
  z.object({ event: z.literal('daemon_message'), message: z.string() }),

  z.object({ event: z.literal('install_started') }),
  z.object({ event: z.literal('install_output'), line: z.string() }),
  z.object({ event: z.literal('install_completed'), successful: z.boolean() }),

  z.object({ event: z.literal('backup_completed'), backupUuid: z.uuid(), successful: z.boolean() }),
  z.object({ event: z.literal('backup_restore_completed'), successful: z.boolean() }),

  z.object({ event: z.literal('error'), code: z.string(), message: z.string() }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Error codes carried by the `error` event. */
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
 * Number of console lines the daemon keeps and replays on connect.
 *
 * Five hundred until an installation was watched: `apt-get` and `pip` between
 * them print well past that, so an operator opening the console after a
 * reinstall was replayed the tail and had lost the beginning — which is the
 * half that says what failed to download and what the package manager refused.
 * The line that mattered had scrolled out of a buffer sized for a stack trace.
 *
 * Four times as many, and the memory that figure was protecting is now
 * protected by {@link CONSOLE_BUFFER_BYTES} instead, which bounds it far more
 * tightly than a line count can.
 */
export const CONSOLE_BUFFER_LINES = 2000;

/**
 * Bytes of console the daemon keeps per server, whichever limit is reached
 * first.
 *
 * A line count is a poor bound on memory because a line is not a fixed size:
 * the assembler caps one at 8192 characters, so five hundred lines was a
 * four-megabyte worst case per server — two hundred megabytes across fifty of
 * them, for a buffer that normally holds a few tens of kilobytes. Two thousand
 * lines under this budget is a **quarter** of a megabyte at worst, so the
 * replay grew fourfold and the worst case shrank sixteenfold.
 *
 * Ordinary console lines are short, so this is reached only by output that is
 * pathological on purpose — a binary written to stdout, a minified stack trace
 * — which is exactly when a bound is wanted.
 */
export const CONSOLE_BUFFER_BYTES = 256 * 1024;

/**
 * Lines the daemon reads back from Docker when it adopts a container it did
 * not start — after its own restart, with a server still running.
 *
 * Deliberately smaller than {@link CONSOLE_BUFFER_LINES}, and not the same
 * question. Retention fills as output arrives, a line at a time, under a byte
 * budget. This is one `docker logs --tail` that materialises every one of those
 * lines at once, out of a file that on a server running for weeks is measured
 * in hundreds of megabytes — so the number that is right for a buffer filling
 * gradually is not the number that is right for a single read.
 *
 * A thousand lines is what somebody wants after a daemon restart: enough to see
 * how the server was doing, without paying for a session's worth of history
 * nobody was watching.
 */
export const CONSOLE_ADOPTION_TAIL_LINES = 1000;

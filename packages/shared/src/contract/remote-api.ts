import { z } from 'zod';
import { permissionSchema } from '../permissions.js';
import { serverStateSchema } from '../server-state.js';
import { serverConfigurationSchema } from './server-configuration.js';

/**
 * Contract of the **daemon → panel** calls, exposed by the panel under
 * `/api/remote/*`.
 *
 * The daemon authenticates with the same node token as the one it accepts on
 * input, sent as `Authorization: Bearer <tokenId>.<tokenSecret>`. The panel
 * identifies the node from `tokenId` and compares the secret to the stored
 * hash.
 *
 * These routes are never called by a browser: they have to be refused if the
 * request carries a session cookie instead of a node token.
 */

export const REMOTE_ROUTES = {
  /** Reconciliation at daemon startup: the list of servers it has to host. */
  servers: '/api/remote/servers',
  server: (uuid: string) => `/api/remote/servers/${uuid}`,
  serverInstall: (uuid: string) => `/api/remote/servers/${uuid}/install`,
  serverStatus: (uuid: string) => `/api/remote/servers/${uuid}/status`,
  sftpAuth: '/api/remote/sftp/auth',
  backupStatus: (uuid: string) => `/api/remote/backups/${uuid}/status`,
  activity: '/api/remote/activity',
} as const;

// ---------------------------------------------------------------------------
// GET /api/remote/servers
// ---------------------------------------------------------------------------

/**
 * The daemon pages through this list at startup to learn which containers have
 * to exist. Any Hopper container present on the host but absent from this list
 * is reported to the operator, never deleted automatically: a configuration
 * mistake must not destroy a server's data.
 */
export const remoteServersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(200).default(50),
});

export const remoteServersResponseSchema = z.object({
  data: z.array(serverConfigurationSchema),
  meta: z.object({
    currentPage: z.number().int().positive(),
    lastPage: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  }),
});

export type RemoteServersResponse = z.infer<typeof remoteServersResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/servers/:uuid/install
// ---------------------------------------------------------------------------

export const installReportSchema = z.object({
  successful: z.boolean(),
  /** True if this was a reinstall, not a first installation. */
  reinstall: z.boolean().default(false),
});

export type InstallReport = z.infer<typeof installReportSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/servers/:uuid/status
// ---------------------------------------------------------------------------

export const statusReportSchema = z.object({
  state: serverStateSchema,
  /** Epoch milliseconds of the transition, to order reports that arrive out of order. */
  at: z.number().int().positive(),
  /**
   * False when nobody asked for the stop.
   *
   * That is the whole difference between "the server is off" and "the server
   * went off on its own" — the second deserves a notification, the first does
   * not.
   */
  expected: z.boolean().default(true),
  /** Exit code of the container, when the daemon could read it. */
  exitCode: z.number().int().optional(),
  /** True if the kernel killed the container for lack of memory. */
  oomKilled: z.boolean().default(false),
  /**
   * Who ended the server, when it was the daemon itself.
   *
   * `expected: false` on its own leaves the panel one sentence — "the process
   * stopped on its own" — and that sentence is a plain lie for the one stop
   * Hopper orders: a start whose readiness check never succeeded is stopped by
   * the daemon, and the operator was then told their process had died, next to
   * the exit code of the SIGTERM the daemon had just sent them.
   *
   * `readiness_failed` covers the whole of that path — the deadline running
   * out, and the checks that fail outright such as an RCON password the server
   * refuses. Which of them it was is on the server's console, in the line the
   * daemon printed before giving up; this field exists so the notification
   * says who stopped it, not to reproduce that line.
   *
   * Additive, optional, and no `CONTRACT_VERSION` bump. A panel that predates
   * it drops the key — `z.object` strips what it does not know — and falls
   * back to the sentence it has always used, so a new daemon reporting to an
   * old panel loses precision and nothing else. `.catch(undefined)` buys the
   * same indulgence forward: a cause added later arrives here as "no cause
   * given" instead of failing the parse and taking the entire crash
   * notification down with it, which is the report nobody can afford to lose.
   */
  cause: z.enum(['readiness_failed']).optional().catch(undefined),
});

export type StatusReport = z.infer<typeof statusReportSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/sftp/auth
// ---------------------------------------------------------------------------

/**
 * The daemon delegates SFTP authentication to the panel: it alone knows the
 * accounts. The username carries the target server, in the form
 * `<username>.<first 8 characters of the server UUID>`.
 */
export const sftpAuthRequestSchema = z.object({
  username: z.string().min(1).max(191),
  password: z.string().min(1).max(1024),
  /** Source IP, logged and rate-limited on the panel side. */
  ip: z.string().min(1),
});

export const sftpAuthResponseSchema = z.object({
  serverUuid: z.uuid(),
  userUuid: z.uuid(),
  permissions: z.array(permissionSchema),
});

export type SftpAuthRequest = z.infer<typeof sftpAuthRequestSchema>;
export type SftpAuthResponse = z.infer<typeof sftpAuthResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/backups/:uuid/status
// ---------------------------------------------------------------------------

export const backupReportSchema = z.object({
  successful: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  /** SHA-256 of the archive, checked on restore. */
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  /** Filled in on failure, shown to the user. */
  error: z.string().optional(),
});

export type BackupReport = z.infer<typeof backupReportSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/activity
// ---------------------------------------------------------------------------

/**
 * Audit events produced by the daemon (file upload, SFTP sign-in, deletion).
 * Sent in batches so as not to generate one request per action.
 */
export const remoteActivityEntrySchema = z.object({
  serverUuid: z.uuid(),
  userUuid: z.uuid().nullable(),
  event: z.string().min(1).max(191),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.number().int().positive(),
});

export const remoteActivityRequestSchema = z.object({
  entries: z.array(remoteActivityEntrySchema).min(1).max(200),
});

export type RemoteActivityEntry = z.infer<typeof remoteActivityEntrySchema>;
export type RemoteActivityRequest = z.infer<typeof remoteActivityRequestSchema>;

import { z } from 'zod';
import { powerActionSchema, resourceUsageSchema, serverStateSchema } from '../server-state.js';
import { serverConfigurationSchema } from './server-configuration.js';

/**
 * Contract of the **panel → daemon** calls.
 *
 * Every one of these routes requires the header
 * `Authorization: Bearer <tokenId>.<tokenSecret>` matching the node. The daemon
 * compares the secret to its configuration file; it never queries the panel to
 * authenticate anybody.
 */

export const DAEMON_ROUTES = {
  system: '/api/system',
  servers: '/api/servers',
  server: (uuid: string) => `/api/servers/${uuid}`,
  serverPower: (uuid: string) => `/api/servers/${uuid}/power`,
  serverCommands: (uuid: string) => `/api/servers/${uuid}/commands`,
  serverSync: (uuid: string) => `/api/servers/${uuid}/sync`,
  serverReinstall: (uuid: string) => `/api/servers/${uuid}/reinstall`,
  serverWebsocket: (uuid: string) => `/api/servers/${uuid}/ws`,
} as const;

// ---------------------------------------------------------------------------
// GET /api/system
// ---------------------------------------------------------------------------

export const systemInformationSchema = z.object({
  version: z.string(),
  kernelVersion: z.string(),
  architecture: z.string(),
  os: z.string(),
  cpuCount: z.number().int().positive(),
  memoryTotalBytes: z.number().int().nonnegative(),
  docker: z.object({
    version: z.string(),
    storageDriver: z.string(),
    cgroupVersion: z.string(),
    /** Number of Hopper-managed containers currently running. */
    runningContainers: z.number().int().nonnegative(),
  }),
});

export type SystemInformation = z.infer<typeof systemInformationSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers
// ---------------------------------------------------------------------------

export const createServerRequestSchema = z.object({
  configuration: serverConfigurationSchema,
  /** Start the installation at once, then start the server when it finishes. */
  startOnCompletion: z.boolean().default(false),
});

export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;

// ---------------------------------------------------------------------------
// GET /api/servers/:uuid
// ---------------------------------------------------------------------------

export const serverStatusResponseSchema = z.object({
  uuid: z.uuid(),
  state: serverStateSchema,
  usage: resourceUsageSchema.nullable(),
  /** The container exists on the host. False right after a creation or a rebuild. */
  containerExists: z.boolean(),
});

export type ServerStatusResponse = z.infer<typeof serverStatusResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers/:uuid/power
// ---------------------------------------------------------------------------

export const powerRequestSchema = z.object({
  action: powerActionSchema,
  /**
   * Wait for the action to finish before answering. By default the daemon
   * acknowledges at once and reports the final state over the WebSocket:
   * stopping a Minecraft server can take tens of seconds.
   */
  wait: z.boolean().default(false),
});

export type PowerRequest = z.infer<typeof powerRequestSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers/:uuid/commands
// ---------------------------------------------------------------------------

export const sendCommandsRequestSchema = z.object({
  commands: z.array(z.string().max(2000)).min(1).max(50),
});

export type SendCommandsRequest = z.infer<typeof sendCommandsRequestSchema>;

// ---------------------------------------------------------------------------
// DELETE /api/servers/:uuid
// ---------------------------------------------------------------------------

export const deleteServerRequestSchema = z.object({
  /** Delete the data volume too. Without it, only the container goes. */
  purgeVolume: z.boolean().default(true),
});

export type DeleteServerRequest = z.infer<typeof deleteServerRequestSchema>;

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/**
 * The daemon's uniform error response.
 *
 * `requestId` also appears in the daemon's logs: it is what an operator looks
 * for to tie an error shown in the panel to a complete trace.
 */
export const daemonErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export type DaemonError = z.infer<typeof daemonErrorSchema>;

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

/**
 * Things a daemon can do that an older one silently could not.
 *
 * The alternative was bumping `CONTRACT_VERSION`, and that is not a version
 * check, it is a quarantine: the panel marks any node announcing a different
 * one unreachable outright, so a bump takes every node offline until the last
 * one has been upgraded. A capability is the same information without the
 * outage — the panel learns what this node honours and refuses only the
 * operations that node cannot honour.
 *
 * The list is open on purpose: an unknown string here means a daemon newer
 * than this panel, and reading it as "one more thing it can do that I have no
 * use for" is the only reading that lets the two be upgraded in either order.
 */
export const NODE_CAPABILITIES = {
  /**
   * Understands `allocation.role`, and therefore resolves a readiness strategy
   * naming a port against the server's allocations instead of assuming the
   * primary one.
   *
   * An older daemon strips the field — Zod discards what it does not know — and
   * knocks on the game port, which fails for the whole deadline while the
   * server is up and then stops it as a start that never became ready. Nothing
   * in the payload can warn it, so the panel refuses to name a port on a node
   * that does not announce this.
   */
  allocationRoles: 'allocation-roles',
} as const;

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
  /**
   * What this daemon honours beyond the contract every version 1 daemon
   * honours. Defaulted to empty rather than required: a daemon predating the
   * field sends nothing, and "announces no capability" is precisely the truth
   * about it. Free-form strings, so a newer daemon announcing something this
   * panel has never heard of parses rather than being declared unreadable —
   * which `fetchSystemInformation` reports as "its version is probably too
   * old", the exact opposite of what would have happened.
   */
  capabilities: z.array(z.string()).default([]),
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
// Errors
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

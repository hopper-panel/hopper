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

  /**
   * Understands `stop.type === 'rcon'`, and therefore stops a server by sending
   * its shutdown command over RCON instead of writing to a standard input
   * nothing is reading.
   *
   * The same silent stripping as above, with a worse ending. An older daemon
   * receives a `stop` whose `type` it has never heard of; `stopConfigurationSchema`
   * is a discriminated union, so the whole object fails to parse and the server
   * is refused rather than misread — which is at least loud, but loud on the
   * node's console and nowhere the operator is looking. The panel therefore
   * refuses to put a server built from such a template on such a node in the
   * first place, rather than let it be created and then discover at the first
   * stop that the only clean shutdown this game has is unavailable.
   */
  rconStop: 'rcon-stop',
} as const;

/**
 * Whether the servers on a node are still isolated from one another.
 *
 * The isolation rests on a single Docker option — inter-container communication
 * turned off on the bridge the servers share — and that option is only settable
 * when the network is created. A network that already existed when hopperd
 * first ran keeps whatever it was created with, so the guarantee is a property
 * of *this node right now* rather than of the daemon's version, and the daemon
 * measures it instead of assuming it.
 *
 * **Three answers, and the third is what keeps the other two honest.** `open` is
 * an accusation — it says every server on that node can reach every other one's
 * unpublished ports — and an accusation must only ever be made from an answer
 * Docker actually gave. A Docker that is restarting, a socket that is not
 * answering yet, a network that was removed under a running daemon: all of them
 * are `unknown`, never `open`.
 */
export const networkIsolationSchema = z.object({
  /** The network the servers are attached to, as this node's own config names it. */
  network: z.string(),
  /**
   * `isolated` — traffic between containers is refused. `open` — it is not, and
   * the guarantee is false on this node. `unknown` — it could not be checked,
   * which is not the same as either.
   *
   * Caught rather than enumerated strictly: a newer daemon that one day answers
   * a fourth word must not make the whole payload unreadable, which
   * `fetchSystemInformation` reports as "its version is probably too old" —
   * the exact opposite of the truth, and it would take the node offline for
   * being ahead.
   */
  status: z.enum(['isolated', 'open', 'unknown']).catch('unknown'),
  /** One sentence naming what was found, written to be shown to an operator. */
  detail: z.string(),
});

export type NetworkIsolation = z.infer<typeof networkIsolationSchema>;

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
  /**
   * What this node's server network is doing about traffic between containers.
   *
   * A field of its own rather than one more string in `capabilities`, and the
   * reason is the same one that makes the list above work at all: a capability
   * is *absent* on every daemon too old to announce it, so a missing
   * `network-isolated` could not be told apart from a daemon that predates the
   * check — and reading "old daemon" as "this node is wide open" is precisely
   * the false accusation this whole report exists to avoid. Capabilities also
   * describe what a build can do, which is fixed at compile time; this is what
   * one host is doing right now, it has three answers rather than two, and it
   * carries a sentence for whoever has to fix it.
   *
   * Optional, so a daemon predating the check parses as it always did. Absent
   * means "not reported", never "not isolated": `hopper doctor` says so in
   * those words and asks for an upgrade rather than passing a verdict.
   */
  networkIsolation: networkIsolationSchema.optional().catch(undefined),
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

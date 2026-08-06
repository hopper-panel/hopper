import { z } from 'zod';

/**
 * Everything the daemon knows about a server.
 *
 * The daemon never reaches the database: whatever it needs to start, stop,
 * watch or reinstall a server has to be in here.
 */

export const configParserSchema = z.enum(['properties', 'yaml', 'json', 'ini', 'xml', 'file']);
export type ConfigParser = z.infer<typeof configParserSchema>;

export const configReplacementSchema = z.object({
  /** Dotted path, e.g. `server-port` or `settings.bungeecord`. */
  match: z.string().min(1),
  /** Replace only if the current value equals this. Otherwise always overwrite. */
  ifValue: z.string().optional(),
  replaceWith: z.string(),
});

export const configFileSchema = z.object({
  /** Relative to the server root. The daemon rejects any path leading outside. */
  file: z.string().min(1),
  parser: configParserSchema,
  replacements: z.array(configReplacementSchema),
});

/**
 * How to stop the server cleanly.
 *
 * `command` writes a string to stdin (`stop` for Minecraft) and waits for the
 * process to end; `signal` signals PID 1 of the container. Either way a SIGKILL
 * follows after `stopTimeoutSeconds`.
 */
export const stopConfigurationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), value: z.string().min(1) }),
  z.object({ type: z.literal('signal'), value: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']) }),
]);

/**
 * The name a port answers to.
 *
 * Declared here, above the readiness strategies, because they are its first
 * consumer: `role` is what a strategy knocks on something other than the game
 * port by.
 *
 * A lookup key, not a label: a strategy matches against it exactly, and it is
 * meant to become part of a variable name as well — the way a startup command
 * will reach a port that is not the primary one. The shape is therefore
 * constrained rather than free text, and each restriction pays for itself:
 *
 * - **Lowercase only**, because the match is exact. `RCON` and `rcon` naming
 *   the same port would be two ports as far as any lookup is concerned, and
 *   the operator who typed the second one would get a refusal about a port
 *   they can see on the screen in front of them.
 * - **No dot**, because the variable name it is bound for —
 *   `{{server.allocations.<role>.port}}` — is a dotted path, and a role
 *   carrying one would split it: `voice.udp` would be read as a `udp` field of
 *   a `voice` allocation, and either resolve to nothing or, far worse, to
 *   something else. Constraining the key now costs nothing; loosening it later,
 *   once operators have named ports, is a migration.
 * - **No brace, dash or underscore** either. None of them break a path today,
 *   and every one of them invents a second spelling of the same intent —
 *   `rcon-port`, `rcon_port`, `rconport` — in a field whose only job is to be
 *   typed identically in two places, months apart, by two different people.
 * - **Starts with a letter and stays short**, because it becomes part of a
 *   variable name.
 *
 * `default` is not reserved: the primary allocation is given no `role` field
 * at all to put it in — see `serverAllocationsSchema`.
 */
export const allocationRoleSchema = z
  .string()
  .min(1)
  .max(24)
  .regex(
    /^[a-z][a-z0-9]*$/,
    'A port name is lowercase letters and digits, starting with a letter — "rcon", "query", "voice2".',
  );

/**
 * How long the daemon waits for a strategy to answer before it gives up.
 *
 * Optional, and deliberately without a default: **declaring a deadline is how
 * a template opts into a start that can fail.** Expiry is not a console line
 * any more — it stops the server and reports the stop as one nobody asked for
 * — and that is a verdict only whoever wrote the template is in a position to
 * pass. The right figure is a property of the workload: a modded pack loading
 * three hundred mods needs minutes, a dedicated server binding a port needs
 * seconds, and one number covering both either cuts the first short or leaves
 * the second hanging for ten minutes over a start that failed in two seconds.
 *
 * Saying nothing keeps the open-ended wait every server had before this field
 * existed: the daemon goes on believing the start until something else ends
 * it. A default here would not be a default at all — it would be a stop,
 * handed to every shipped template and every already-imported Pterodactyl egg,
 * none of whose authors chose one.
 *
 * Bounded at an hour when it is declared. Past that a deadline stops being
 * one, and the server is back to sitting in `starting` while somebody waits
 * for a spinner to mean something. `immediate` carries none for the same
 * reason it has no wait.
 */
const readinessTimeoutSchema = z.number().int().positive().max(3_600_000).optional();

/**
 * When a started server becomes a running one.
 *
 * Exported before the configuration that uses it, because the daemon resolves
 * it through a pure function the panel never runs.
 */
export const readinessSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('log'),
    /** Any one of them matching is enough; they are alternatives, not steps. */
    patterns: z.array(z.string().min(1)).min(1),
    timeoutMs: readinessTimeoutSchema,
  }),
  z.object({
    type: z.literal('port'),
    /**
     * Which of the server's ports to knock on, by the name the operator gave
     * it in the Network tab. The primary one when nothing is named.
     *
     * A role naming no port on the server is refused by the daemon rather than
     * quietly read as "the primary one": knocking on the game port instead
     * fails for the whole deadline while the server is up and taking players,
     * and then stops it and reports the stop as a crash.
     */
    role: allocationRoleSchema.optional(),
    /**
     * `udp` is accepted here and not probed by the daemon, on purpose. The
     * field describes the server, not what this node can do about it, and a
     * template author naming the protocol their game actually speaks deserves
     * to be told so rather than silently knocked on over TCP.
     *
     * Told, and then got on with: the daemon says on the console that it
     * cannot run the check and calls the server running as soon as its
     * container is up. See `readiness` below for why that beats refusing.
     */
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    /** Time to leave the process before knocking at all. */
    delayMs: z.number().int().nonnegative().max(600_000).default(0),
    timeoutMs: readinessTimeoutSchema,
  }),
  z.object({
    type: z.literal('rcon'),
    /**
     * The RCON port, when it is not the game's own — which is the ordinary
     * case, and the reason names exist at all. See `port` above.
     */
    role: allocationRoleSchema.optional(),
    /** Template variable holding the password. Never the password itself. */
    secretVariable: z.string().min(1),
    timeoutMs: readinessTimeoutSchema,
  }),
  z.object({ type: z.literal('immediate') }),
]);

export type Readiness = z.infer<typeof readinessSchema>;

export const serverMetaSchema = z.object({
  name: z.string().min(1).max(191),
  description: z.string().max(2000).default(''),
});

export const allocationSchema = z.object({
  ip: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /**
   * What this port is for, when the operator has said. Absent on the vast
   * majority of allocations, and absent is what every allocation that existed
   * before names did carries.
   */
  role: allocationRoleSchema.optional(),
});

export const serverAllocationsSchema = z.object({
  /**
   * Injected into `server-port` and announced to players.
   *
   * **Carries no role, deliberately.** The primary port is already reachable
   * by name — it is what a `readiness` naming no role resolves to, and what
   * every existing template and command means by "the port". Letting it hold
   * one as well would give a single port two names, and there is no reading of
   * that which stays true: a template resolving `game` would find the primary
   * today and, the moment an operator moved the primary elsewhere, find a
   * different port under the same name without anybody editing anything. It
   * would also make the lookup itself ambiguous — the same role could sit on
   * the primary and on an additional port at once, with no rule to break the
   * tie. One port, one way to name it; the primary's way is to say nothing.
   */
  default: allocationSchema.omit({ role: true }),
  /** Extra exposed ports: dynmap, voice chat, query… */
  additional: z.array(allocationSchema).default([]),
});

/** Hard container limits: the kernel enforces them, the daemon only relays them. */
export const serverBuildSchema = z.object({
  /** 0 means unlimited. */
  memoryBytes: z.number().int().nonnegative(),
  /**
   * Swap allowed on top of memory. -1 unlimited, 0 forbidden. Docker expects
   * `memory + swap`; the daemon converts.
   */
  swapBytes: z.number().int().min(-1),
  /** Percent of one core: 200 means two cores. 0 means unlimited. */
  cpuPercent: z.number().int().nonnegative(),
  /** Pinning, e.g. `0-3` or `0,2`. Empty means no pinning. */
  cpuSet: z.string().default(''),
  ioWeight: z.number().int().min(10).max(1000).default(500),
  /** 0 means unlimited. Enforced by the daemon, not Docker (bind mounts). */
  diskBytes: z.number().int().nonnegative(),
  /** Guard against a plugin fork bomb: never set 0 in production. */
  pidsLimit: z.number().int().positive().default(512),
  /**
   * Disabling the OOM killer lets an overflowing server freeze the host instead
   * of being killed. Only on an explicit operator request.
   */
  oomKillDisabled: z.boolean().default(false),
});

export const serverContainerSchema = z.object({
  image: z.string().min(1),
  /** The daemon must recreate the container on the next start. */
  requiresRebuild: z.boolean().default(false),
});

export const installConfigurationSchema = z.object({
  /** Install image, distinct from the runtime image. */
  containerImage: z.string().min(1),
  entrypoint: z.string().min(1).default('/bin/bash'),
  script: z.string(),
});

export const serverConfigurationSchema = z.object({
  uuid: z.uuid(),
  meta: serverMetaSchema,

  /** A suspended server cannot start, be modified, or serve over SFTP. */
  suspended: z.boolean().default(false),

  /**
   * Startup command template, e.g.
   * `java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}`.
   *
   * The daemon splits this into arguments BEFORE substituting variables, then
   * executes without a shell. A variable holding a space, a `;` or a `$` can
   * therefore inject neither an argument nor a command.
   */
  invocation: z.string().min(1),

  /** Template variables, passed as container environment variables. */
  environment: z.record(z.string(), z.string()).default({}),

  allocations: serverAllocationsSchema,
  build: serverBuildSchema,
  container: serverContainerSchema,

  stop: stopConfigurationSchema,
  stopTimeoutSeconds: z.number().int().positive().max(600).default(30),

  /**
   * Pattern announcing the server is ready, e.g. `\)! For help, type "help"`.
   *
   * @deprecated Superseded by `readiness`. Kept because every imported
   * Pterodactyl egg carries this shape and nothing else, and an import that
   * stopped working the day the field moved would be a migration imposed on
   * people who never asked for one. The daemon reads it when `readiness` is
   * absent, and treats it as a single-pattern `log` **with no deadline**: it
   * was written when the daemon waited for ever, and a pack that takes a
   * quarter of an hour to load its world must not be stopped mid-start by a
   * timeout its author never chose. There is no way to attach one here either:
   * a deadline is opted into by declaring a `readiness` that names a
   * `timeoutMs`, and a `readiness` that names none waits just as openly as
   * this field does.
   */
  startupDetection: z.string().optional(),

  /**
   * How the daemon decides the server is ready to be called `running`.
   *
   * A regular expression over the console was the only answer for as long as
   * Minecraft was the only workload — `Done (12.4s)!` is a line a Source
   * server will never print, and a game that says nothing at all on stdout
   * cannot be waited for that way at all.
   *
   * Four answers, and each is somebody's only option:
   *
   * - `log` takes **several** patterns. Different versions of the same server
   *   announce themselves differently, and the importer had to throw all but
   *   one away.
   * - `port` waits for something to accept a connection. Crude, and the only
   *   thing available for a server that logs nothing useful. TCP only: a
   *   connectionless socket cannot tell a closed port from a silent one
   *   without reading ICMP through a raw socket the daemon has no capability
   *   for, so a `udp` probe is not run at all. The daemon says so on the
   *   console, in the daemon log, and calls the server running once its
   *   container is up. Loudly wrong beats a server parked in `starting` for
   *   ever while it quietly takes players — the operator can see the first
   *   and act on it, and cannot tell the second from a server that died.
   * - `rcon` authenticates, which is the cheapest true readiness probe there
   *   is — the server answers only once it is serving.
   * - `immediate` is today's silent default, made explicit. A container that
   *   is up is called running, which is right for a workload with no notion
   *   of "ready" and wrong for every other one — so it has to be chosen.
   *
   * The three that wait accept a `timeoutMs`, and declaring one is how a
   * template opts into a start that can fail: the deadline expiring stops the
   * server and tells the panel the stop was nobody's idea. Declaring nothing
   * leaves the wait open-ended, which is what every server did before
   * deadlines existed and what a configuration carrying only
   * `startupDetection` still does.
   *
   * Deliberately no game-specific query protocol. A2S_INFO would answer the
   * same question as `rcon` for Source alone, and put a per-game UDP parser
   * inside a daemon that has no business knowing what game it runs.
   */
  readiness: readinessSchema.optional(),

  /** Rewritten by the daemon right before every start. */
  configFiles: z.array(configFileSchema).default([]),

  /**
   * Files the user can neither read, write nor delete, whatever their
   * permissions. Glob patterns relative to the server root.
   */
  fileDenylist: z.array(z.string()).default([]),

  install: installConfigurationSchema.optional(),
});

export type ServerConfiguration = z.infer<typeof serverConfigurationSchema>;
export type ServerBuild = z.infer<typeof serverBuildSchema>;
export type ServerAllocations = z.infer<typeof serverAllocationsSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;
export type StopConfiguration = z.infer<typeof stopConfigurationSchema>;
export type InstallConfiguration = z.infer<typeof installConfigurationSchema>;

/**
 * Which port a role means, for the one server these allocations belong to.
 *
 * The single definition of that question, so that everything asking it agrees:
 * a readiness strategy deciding what to knock on, and — next — a startup
 * command resolving `{{server.allocations.<role>.port}}`. Two lookups written
 * separately would eventually disagree about the fallback, and the disagreement
 * would show up as a daemon probing one port while the server was told to
 * listen on another.
 *
 * Naming nothing means the primary port. That is what every configuration
 * written before names existed asks for, and it has to keep meaning exactly
 * what it always did.
 *
 * `undefined` is a real answer and not an oversight: it means the role names no
 * port on this server. Callers have to say so rather than fall back to the
 * primary, which is the whole reason this returns nothing instead of
 * `allocations.default`.
 */
export function allocationForRole(
  allocations: ServerAllocations,
  role: string | undefined,
): Allocation | undefined {
  if (role === undefined) {
    return allocations.default;
  }

  return allocations.additional.find((allocation) => allocation.role === role);
}

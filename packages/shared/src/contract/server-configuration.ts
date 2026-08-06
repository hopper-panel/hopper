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
  }),
  z.object({
    type: z.literal('port'),
    /** Which of the server's ports to knock on. The primary one by default. */
    role: z.string().min(1).optional(),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    /** Time to leave the process before knocking at all. */
    delayMs: z.number().int().nonnegative().max(600_000).default(0),
  }),
  z.object({
    type: z.literal('rcon'),
    role: z.string().min(1).optional(),
    /** Template variable holding the password. Never the password itself. */
    secretVariable: z.string().min(1),
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
});

export const serverAllocationsSchema = z.object({
  /** Injected into `server-port` and announced to players. */
  default: allocationSchema,
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
   * absent, and treats it as a single-pattern `log`.
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
   *   thing available for a server that logs nothing useful.
   * - `rcon` authenticates, which is the cheapest true readiness probe there
   *   is — the server answers only once it is serving. **Declared and not yet
   *   implemented**: there is no RCON client in the daemon, and a template
   *   asking for it is refused rather than silently downgraded.
   * - `immediate` is today's silent default, made explicit. A container that
   *   is up is called running, which is right for a workload with no notion
   *   of "ready" and wrong for every other one — so it has to be chosen.
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

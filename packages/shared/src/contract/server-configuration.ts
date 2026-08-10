import { z } from 'zod';

/**
 * Everything the daemon knows about a server.
 *
 * The daemon never reaches the database: whatever it needs to start, stop,
 * watch or reinstall a server has to be in here.
 */

export const configParserSchema = z.enum(['properties', 'yaml', 'json', 'ini', 'xml', 'file']);
export type ConfigParser = z.infer<typeof configParserSchema>;

/**
 * The parsers this contract accepts and no daemon writes.
 *
 * A gap on purpose, and worth stating rather than leaving to be discovered.
 * The enum above is what a template is allowed to *say*, and an imported
 * Pterodactyl egg gets to say what its author wrote — the importer then
 * refuses what will not be honoured, in front of somebody who can act on it.
 * The rewriter is a separate list and a shorter one.
 *
 * What that gap does when nobody notices it is the reason this is declared:
 * the daemon leaves the file exactly as it is, and the server starts. On the
 * port that file already named — the template author's, not the one the panel
 * allocated. No failure, no refusal, one console line.
 *
 * Declared here rather than in the daemon because the packages that need the
 * answer must not depend on it: `@hopper/templates` holds that no shipped
 * template may name one, and the panel refuses one on its way in — at the API
 * and again in the editor's form, so the message names the file next to the
 * field. The list belongs to the contract because it is the contract that
 * declares the enum whose gap it describes.
 *
 * Kept in step with the rewriter by an assertion over the whole enum in the
 * daemon's `config-writer.spec.ts` — a list this side and a `switch` the other
 * side cannot drift apart in silence, since the symptom of their drifting is a
 * wrong port nobody is told about.
 *
 * Meant to shrink. Writing a rewriter and taking a parser off this list is not
 * the whole of it, and the rest is worth naming rather than discovering: the
 * egg importer's `CONFIG_PARSERS` and the exporter's parser map both encode
 * which names translate — a different question, but one that is answered `no`
 * for the same parsers today — and the editor's help text lists them in prose
 * a test holds to this list rather than deriving from it.
 */
export const PARSERS_NOT_WRITTEN: readonly ConfigParser[] = ['xml'];

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
 * The name a port answers to.
 *
 * Declared here, above the readiness strategies, because they are its first
 * consumer: `role` is what a strategy knocks on something other than the game
 * port by. The stop configuration below is its second, and the two mean the
 * same thing by it — see `stopConfigurationSchema`.
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

/**
 * How to stop the server cleanly.
 *
 * Declared below `allocationRoleSchema` rather than at the top of the file,
 * where it used to sit, because the third arm names a port the same way a
 * readiness strategy does — and the two definitions have to be readable side by
 * side to stay in agreement about what a name means.
 *
 * `command` writes a string to stdin (`stop` for Minecraft) and waits for the
 * process to end; `signal` signals PID 1 of the container. Either way what is
 * waited for is the **container** going down, and a SIGKILL follows if it has
 * not within `stopTimeoutSeconds`. That is worth reading literally wherever
 * PID 1 is a launcher script rather than the game: a server that obeys the
 * command and exits cleanly into a wrapper that starts it again — `srcds_run`
 * without `-norestart` — leaves the container up, so its stop is delivered,
 * obeyed and killed all the same.
 *
 * `rcon` is the third, and it exists because the first two answer for fewer
 * games than it looks. **Rust, ARK and Palworld read no standard input at
 * all**: the string goes into a pipe nobody is holding, nothing happens for the
 * whole deadline, and the server is SIGKILLed — a "clean stop" that is a kill
 * with extra waiting. `signal` was the only alternative, and a signal is a
 * request the game may handle, ignore, or handle by exiting without writing its
 * world. RCON is the channel those servers do answer on, and their own shutdown
 * command is the one that ends in a save.
 *
 * **Source servers were named in that list and do not belong in it.** `srcds`
 * reads its console from standard input, and `quit` written to it is the clean
 * stop every Pterodactyl Source egg performs — so `command` is the right
 * transport there, not this one. The correction is recorded rather than quietly
 * made, because this list is what a template author picks a transport from: a
 * wrong name in it sends a game to RCON — a password, a port and four fresh
 * ways for a stop to be refused — for a channel it already had. What a Source
 * template does need is `-norestart` on `srcds_run`, whose wrapper otherwise
 * relaunches the server after the clean exit and leaves PID 1 alive — which
 * ends in the `stopTimeoutSeconds` SIGKILL whichever transport carried the
 * command, as the paragraph above says.
 *
 * The password is **named, never carried**, exactly as in the rcon readiness
 * arm above: a stop configuration holding a secret would be a secret in every
 * configuration payload the panel sends and in every log line that printed one.
 *
 * **Choosing `rcon` here also chooses it for the console**, and that is a
 * property of this field worth stating where it is declared rather than leaving
 * to be discovered in the daemon. A template reaches for this transport for one
 * reason — the game reads nothing on standard input — and a console writing to
 * a standard input nobody reads is the same failure as a stop writing to it,
 * minus the SIGKILL that eventually made the stop visible. So the daemon routes
 * console commands the same way, to the port named by `role`, with the password
 * held in `secretVariable`.
 *
 * There is deliberately no separate field saying so. It would repeat all three
 * values, and two copies of a port name and a password variable have exactly
 * one interesting state: disagreeing. The symptom of that would be a server
 * that stops perfectly and a console that reaches nobody, with nothing anywhere
 * saying the two were meant to match.
 *
 * The corollary, equally deliberate: declaring `command` or `signal` leaves the
 * console on standard input, which is right for Minecraft — it reads stdin and
 * speaks RCON, and the channel that needs no password is the better of the two.
 */
export const stopConfigurationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), value: z.string().min(1) }),
  z.object({ type: z.literal('signal'), value: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']) }),
  z.object({
    type: z.literal('rcon'),
    /**
     * The game's own shutdown command — `quit` for Rust, `DoExit` for ARK,
     * `shutdown 30 Restarting` for Palworld, `/quit` for Factorio, whose console
     * reads a line without the leading slash as chat and goes on running.
     *
     * Sent as written. Nothing here knows which game is on the other end, so
     * nothing here can add a leading slash, a delay or a save beforehand; a
     * template that wants its world flushed first names a command that does
     * that.
     */
    command: z.string().min(1),
    /**
     * Which port to speak RCON to, when it is not the game's own — which is the
     * ordinary case, and the reason names exist at all.
     *
     * The same meaning as `readiness`'s `role`, down to the failure: a role
     * naming no port on this server is **refused**, never read as "the primary
     * one then". Guessing there speaks the RCON handshake at the game port,
     * which answers nothing — and the stop that follows a failed handshake is a
     * SIGKILL through the save this transport was chosen to protect.
     */
    role: allocationRoleSchema.optional(),
    /** Template variable holding the password. Never the password itself. */
    secretVariable: z.string().min(1),
  }),
]);

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

  /**
   * How long the installation may **do nothing at all** before the daemon gives
   * up on it.
   *
   * A deadline on inactivity, not on duration, and the distinction is the whole
   * field. A forty-gigabyte Steam depot that is pulling bytes down a wire is
   * alive — taking them off the socket is work, and work is CPU time charged to
   * its cgroup; one whose container has burned no CPU, touched no disk and
   * printed nothing for a quarter of an hour is not. A cap on total duration
   * cannot tell those apart: set high enough to let a real depot finish it never
   * fires on anything, and set low enough to be useful it kills the installs it
   * was meant to protect.
   *
   * Inactivity and not silence, which is the correction worth recording because
   * the mistake was made here first. Nearly every install script in existence
   * downloads with `curl -sSL`, and `-s` suppresses the progress meter: the
   * transfer emits not one byte of output from start to finish. A deadline on
   * *output* would therefore have been a total-duration cap applied to precisely
   * the step that legitimately takes hours — a 2 GiB modpack on a slow uplink is
   * a working install it would have killed. What the daemon watches is what the
   * container does; see `INSTALL_INACTIVITY_DEFAULT_MS` there.
   *
   * Optional, and deliberately without a default *here*. The daemon supplies one
   * because that is where the timer is armed, and because a default materialised
   * in this schema would be written into every configuration payload the panel
   * sends, including the ones bound for a node whose daemon has never heard of
   * the field. Absent therefore means "this template did not say", and the node
   * running the install decides what that is worth.
   *
   * An older daemon strips the field, as Zod discards what it does not know, and
   * goes on waiting for ever — which is exactly what it does today. That is a
   * guard not applied, not a configuration misread, so nothing gates on it: no
   * capability, no refusal, no server that cannot be placed on an older node
   * over a timeout it would have been given.
   */
  inactivityTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(6 * 3_600_000)
    .optional(),

  /**
   * What this installation is expected to write, in bytes, when the template
   * knows.
   *
   * Checked before the install container is created, and a shortfall is
   * **refused**. Filling a node's disk is not one server's failure:
   * `/var/lib/docker` and every other server's volume are on that filesystem,
   * and the whole machine goes down with it.
   *
   * Checked against the free space on the volume's filesystem *plus what the
   * volume already holds*, because nothing wipes it first: a reinstall writes
   * over the files that are there, so their space counts towards the figure and
   * not against it. Demanding the whole of it as free would mean a 40 GiB
   * Palworld server could never be reinstalled on the node it is already
   * installed on.
   *
   * Only a template can answer this, and only for some games. A Steam depot has
   * a knowable size; a Minecraft server's is whatever modpack the operator's
   * variables point at, so most templates say nothing and the daemon falls back
   * to requiring a floor of headroom rather than inventing a figure.
   *
   * Deliberately **not** `build.diskBytes`. That number is a policy ceiling the
   * operator sells, not a prediction: a 50 GiB Minecraft server that will use
   * 900 MiB would start refusing to install on a node with 20 GiB free, and the
   * panel has already weighed it once at creation, against the node's declared
   * capacity and the overallocation percentage the operator chose. Reading it
   * again here would overrule that decision from the far end of the wire.
   *
   * An older daemon strips this too and installs with no preflight at all,
   * which is what every daemon did until now. Ungated for the same reason as
   * the field above: a node that cannot honour a new guard is a node without
   * the guard, not a node that misreads the configuration.
   */
  requiredDiskBytes: z.number().int().nonnegative().optional(),
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

  /**
   * How long the server is given to go down before it is SIGKILLed.
   *
   * The one number in this contract that is measured in lost work. A stop is
   * requested, the game begins writing its world, and this expires: the kernel
   * cuts the process mid-write, and what the operator gets back is whatever the
   * last autosave held — or a save file half-written by a process that will
   * never finish it.
   *
   * Thirty seconds is the default and it is a Minecraft figure: a Bukkit server
   * flushes its regions in a second or two. It is not a figure for a game that
   * writes its entire world on shutdown, where the time taken scales with the
   * world — and those are exactly the games the `rcon` transport above exists
   * for. A template declares its own through `stopTimeoutSeconds`, which the
   * panel reads when it builds this object; templates that say nothing keep the
   * thirty they have always had.
   *
   * Bounded at ten minutes. Past that a stop stops being one, and an operator
   * watching a spinner has no way to tell a server that is saving from one that
   * has hung.
   */
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

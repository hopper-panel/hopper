import { configFileSchema, readinessSchema, stopConfigurationSchema } from '@hopper/shared';
import { z } from 'zod';

/**
 * Definition of a server template.
 *
 * This is the shape of the templates shipped with Hopper, and the one the
 * Pterodactyl egg importer converts into. The panel then translates it into
 * database rows.
 */

export const templateVariableDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  envVariable: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Variable name does not follow POSIX syntax.'),
  defaultValue: z.string().default(''),
  userViewable: z.boolean().default(true),
  /**
   * An editable variable feeds the startup command: it is user input that
   * influences what the JVM runs. The default is therefore "not editable", and
   * every exception has to be a conscious choice.
   */
  userEditable: z.boolean().default(false),
  rules: z.string().default('nullable|string'),
});

export const dockerImageOptionSchema = z.object({
  /** Displayed label, e.g. "Java 21". */
  name: z.string().min(1),
  image: z.string().min(1),
});

export const templateDefinitionSchema = z.object({
  /**
   * Stable identifier, independent of the displayed name.
   * Used as the upsert key: renaming "Paper" to "PaperMC" must not create a
   * second template nor orphan the existing servers.
   */
  key: z.string().regex(/^[a-z0-9-]+$/),
  group: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  author: z.string().default('Hopper'),

  /** Ordered: the first is the default offered at creation. */
  dockerImages: z.array(dockerImageOptionSchema).min(1),

  startup: z.string().min(1),
  /** `command:stop` ou `signal:SIGTERM`. */
  stopCommand: z.string().default('command:stop'),

  /**
   * How to stop a server built from this template, when the string above cannot
   * say it.
   *
   * `stopCommand` is a colon-encoded pair — one word for the transport, one for
   * the value — and an RCON stop is three fields: a command, the name of the
   * variable holding the password, and optionally the name of the port to send
   * it to. There is no encoding of that which survives a password containing a
   * colon, and inventing one would put a parser between a template author and
   * the only clean shutdown their game has.
   *
   * Optional, and it must stay optional, for the same reason `readiness` sits
   * beside `startupDetection` rather than replacing it: `stopCommand` is what
   * every shipped template and every imported Pterodactyl egg carries, and the
   * panel still reads it whenever this is absent. Nothing about an existing
   * template changes by this field existing.
   */
  stop: stopConfigurationSchema.optional(),

  /**
   * How long a server built from this template is given to shut down before it
   * is SIGKILLed.
   *
   * The contract has always had this field and no template could ever set it,
   * so every server on every installation runs on the thirty-second default —
   * which is a Minecraft figure, taken from a Bukkit server flushing its
   * regions in a second or two.
   *
   * It is the wrong figure for a game that writes its whole world on shutdown,
   * and those are precisely the games the `stop` above exists for: the time a
   * save takes scales with the world, so the template that most needs a stop
   * that waits is the one whose stop was most likely to be cut in half. A
   * SIGKILL landing inside that write is the single way a correctly configured
   * RCON stop still loses data.
   *
   * Optional rather than defaulted here, so that "this template said nothing"
   * stays distinguishable from "this template chose thirty". A template saying
   * nothing keeps the contract's thirty and behaves exactly as it did before
   * this field existed.
   */
  stopTimeoutSeconds: z.number().int().positive().max(600).optional(),

  /** Regular expression signalling that the server accepts connections. */
  startupDetection: z.string().optional(),

  /**
   * How a server built from this template announces it is ready.
   *
   * The same union the daemon resolves, declared here so a template can pick
   * something other than a console regex. A single pattern over stdout was the
   * only answer while Minecraft was the only workload, and it is no answer at
   * all for a game that prints nothing recognisable — the operator had no way
   * to say so, because there was no field to say it in.
   *
   * Optional, and it must stay optional. `startupDetection` above is what
   * every shipped template and every imported Pterodactyl egg carries, and the
   * daemon still reads it whenever this is absent. Making this required would
   * invalidate the whole existing catalogue to express something none of those
   * templates needed.
   */
  readiness: readinessSchema.optional(),

  configFiles: z.array(configFileSchema).default([]),
  fileDenylist: z.array(z.string()).default([]),

  installContainer: z.string().default('debian:bookworm-slim'),
  installEntrypoint: z.string().default('/bin/bash'),
  installScript: z.string().min(1),

  /**
   * How long this template's installation may **do nothing at all** before the
   * daemon stops it.
   *
   * On inactivity, not on total duration, and a template author has to hold that
   * distinction to pick a figure: an anonymous Steam depot takes an hour to
   * download and is healthy throughout, so what is being sized here is the
   * longest pause in the work, not the length of the install.
   *
   * Not on output either, which is the trap this field was nearly built into.
   * The scripts in this very catalogue download with `curl -sSL`, and `-s`
   * suppresses the progress meter: a two-gigabyte transfer prints nothing from
   * beginning to end. So the daemon watches the CPU and the block I/O the kernel
   * charges the container as well as its output — its network counters
   * deliberately not, since those count frames the interface accepted rather
   * than work it did — and a template author sizing this figure should be
   * thinking about how long the work could plausibly stand completely still, not
   * how long it could stay quiet.
   *
   * Optional, and a template that says nothing gets the daemon's own figure —
   * a quarter of an hour, chosen to be ignored by anything that works. Raise it
   * for a script that genuinely idles: a wait on an external job, a licence
   * check that blocks on a slow endpoint. Lower it for a download that should
   * never pause at all, and get told sooner.
   *
   * A node running a daemon that predates the field ignores it and waits for
   * ever, which is what every node did until now. Nothing is refused over it.
   */
  installInactivityTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(6 * 3_600_000)
    .optional(),

  /**
   * How much free disk this template's installation needs, in bytes.
   *
   * The daemon checks it against the volume's filesystem before the install
   * container is created, and **refuses** a shortfall — filling a node's disk
   * takes down every server on the machine, not only this one. What the volume
   * already holds counts towards the figure rather than against it, because a
   * reinstall writes over those files; otherwise no large server could ever be
   * reinstalled on the node it is already installed on.
   *
   * Declare it when the figure is knowable and large: a Steam depot has a size
   * the store page states, and it is the whole reason this field exists. Leave
   * it out when it is not — a Minecraft server's size is whatever modpack the
   * operator's variables point at, and a guess here refuses installations that
   * would have worked. A template that says nothing still cannot install onto a
   * node with nothing left: the daemon requires a floor of headroom from
   * everything.
   *
   * Not the server's disk limit, which is a different question the panel has
   * already answered against the node's declared capacity. This is what the
   * installation writes, and it is the template that knows.
   */
  installRequiredDiskBytes: z.number().int().nonnegative().optional(),

  variables: z.array(templateVariableDefinitionSchema).default([]),

  /** UUID of the original Pterodactyl egg, to avoid double imports. */
  importedFromEgg: z.string().optional(),
});

export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type TemplateVariableDefinition = z.infer<typeof templateVariableDefinitionSchema>;
export type DockerImageOption = z.infer<typeof dockerImageOptionSchema>;

/**
 * Template groups shipped with Hopper.
 *
 * These strings are not labels: each one is stored as `TemplateGroup.name` and
 * that column is the upsert key, so renaming a group does not rename anything
 * — it creates a second group and leaves every existing template pointing at
 * the first. They are also rendered exactly as written in the create-server
 * dropdown, untranslated. Both facts mean the wording has to be chosen once
 * and then stay chosen.
 *
 * **Every key here is named by a template that ships.** Nothing reads this
 * object to create a group — `TemplateSyncService.upsert` and the seed both
 * upsert on `definition.group`, walking the catalogue — so a key no template
 * names creates nothing, means nothing to an operator, and is only a promise
 * made in a place nobody reads. `BEDROCK` was one for six releases. The rule
 * is held by `catalog.spec.ts` now rather than by whoever is looking.
 */
export const TEMPLATE_GROUPS = {
  JAVA: 'Minecraft: Java Edition',
  PROXY: 'Proxies',
  /**
   * Everything that is not Minecraft.
   *
   * Named for the category rather than for the game, so that the second and
   * the tenth non-Minecraft template can join it without a rename this schema
   * cannot perform. A group per game would read better in a list of one and
   * turn the dropdown into a catalogue of one-entry sections as the list
   * grows; the three groups above are families too.
   */
  OTHER_GAMES: 'Other games',
  /**
   * The Source engine, and a change of mind worth recording.
   *
   * `OTHER_GAMES` above was named for the category precisely so that a second
   * non-Minecraft template would need no new group, and Garry's Mod joined
   * Factorio there on that reasoning. What changed is that Source is not one
   * game: `srcds_run`, `-norestart`, the console on standard input, the
   * anonymous depot and the Steam-login readiness marker are shared by every
   * dedicated server on the engine, and the catalogue now ships two of them
   * with a third and fourth obvious. That is a family, like the proxies, not a
   * one-entry section.
   *
   * Moving Garry's Mod costs an existing installation nothing it can notice: a
   * group name is the upsert key, so the next resynchronisation creates this
   * group and moves the template into it, leaving `Other games` holding
   * Factorio. A Garry's Mod an administrator has edited is skipped by that
   * sync, as it is by every other, and stays where it is.
   */
  SOURCE: 'Source engine',
  /**
   * Bots, which are not games and do not behave like them.
   *
   * Named for the platform rather than for the language: the two templates in
   * it differ only in which interpreter runs the operator's code, and a group
   * per language would be two sections of one entry each. What they share is
   * the shape — no depot, no port, no map, somebody else's dependency tree —
   * and that is what a group is for.
   */
  DISCORD: 'Discord bots',
} as const;

/**
 * Java images offered by default.
 *
 * The order matters: the first is used when the user picks none. Java 21 suits
 * every modern version; Java 8 is only there for 1.8 to 1.12 servers, still
 * very common in PvP.
 */
export const JAVA_IMAGES: DockerImageOption[] = [
  { name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' },
  { name: 'Java 17', image: 'eclipse-temurin:17-jre-noble' },
  { name: 'Java 11', image: 'eclipse-temurin:11-jre-noble' },
  { name: 'Java 8', image: 'eclipse-temurin:8-jre-noble' },
];

/**
 * Line a Bukkit server emits once it has finished loading.
 * Escaped so it can be stored as is and compiled by the daemon.
 */
export const BUKKIT_STARTUP_DETECTION = '\\)! For help, type "help"';

/** Rewrite of `server.properties` applied before every start. */
export const SERVER_PROPERTIES_CONFIG = {
  file: 'server.properties',
  parser: 'properties' as const,
  replacements: [
    // The server has to listen on every interface of the container: it is
    // Docker that restricts publication to the allocated port.
    { match: 'server-ip', replaceWith: '0.0.0.0' },
    { match: 'server-port', replaceWith: '{{server.build.default.port}}' },
  ],
};

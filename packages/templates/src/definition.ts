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
 */
export const TEMPLATE_GROUPS = {
  JAVA: 'Minecraft: Java Edition',
  BEDROCK: 'Minecraft: Bedrock Edition',
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

import { configFileSchema } from '@hopper/shared';
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
  /** Regular expression signalling that the server accepts connections. */
  startupDetection: z.string().optional(),

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

/** Template groups shipped with Hopper. */
export const TEMPLATE_GROUPS = {
  JAVA: 'Minecraft: Java Edition',
  BEDROCK: 'Minecraft: Bedrock Edition',
  PROXY: 'Proxies',
} as const;

/**
 * Java images offered by default.
 *
 * The order matters: the first is used when the user picks none. Java 21 suits
 * every modern version; Java 8 is only there for 1.8 to 1.12 servers, still
 * very common in PvP.
 */
export const JAVA_IMAGES: DockerImageOption[] = [
  { name: 'Java 21', image: 'ghcr.io/hopper-panel/java:21' },
  { name: 'Java 17', image: 'ghcr.io/hopper-panel/java:17' },
  { name: 'Java 11', image: 'ghcr.io/hopper-panel/java:11' },
  { name: 'Java 8', image: 'ghcr.io/hopper-panel/java:8' },
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

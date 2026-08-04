import { configFileSchema } from '@hopper/shared';
import { z } from 'zod';

/**
 * Définition d'un template de serveur.
 *
 * C'est la forme qu'ont les templates livrés avec Hopper, et celle vers
 * laquelle l'importeur d'« eggs » Pterodactyl convertit. Le panel la traduit
 * ensuite en lignes de base de données.
 */

export const templateVariableDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  envVariable: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Nom de variable non conforme à la syntaxe POSIX.'),
  defaultValue: z.string().default(''),
  userViewable: z.boolean().default(true),
  /**
   * Une variable modifiable entre dans la commande de démarrage : c'est une
   * entrée utilisateur qui influe sur ce que la JVM exécute. Le défaut est donc
   * « non modifiable », et chaque exception doit être un choix conscient.
   */
  userEditable: z.boolean().default(false),
  rules: z.string().default('nullable|string'),
});

export const dockerImageOptionSchema = z.object({
  /** Libellé affiché, ex. « Java 21 ». */
  name: z.string().min(1),
  image: z.string().min(1),
});

export const templateDefinitionSchema = z.object({
  /**
   * Identifiant stable, indépendant du nom affiché.
   * Sert de clé d'upsert : renommer « Paper » en « PaperMC » ne doit pas créer
   * un second template ni orpheliner les serveurs existants.
   */
  key: z.string().regex(/^[a-z0-9-]+$/),
  group: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  author: z.string().default('Hopper'),

  /** Ordonnées : la première est le défaut proposé à la création. */
  dockerImages: z.array(dockerImageOptionSchema).min(1),

  startup: z.string().min(1),
  /** `command:stop` ou `signal:SIGTERM`. */
  stopCommand: z.string().default('command:stop'),
  /** Expression régulière signalant que le serveur accepte les connexions. */
  startupDetection: z.string().optional(),

  configFiles: z.array(configFileSchema).default([]),
  fileDenylist: z.array(z.string()).default([]),

  installContainer: z.string().default('debian:bookworm-slim'),
  installEntrypoint: z.string().default('/bin/bash'),
  installScript: z.string().min(1),

  variables: z.array(templateVariableDefinitionSchema).default([]),

  /** UUID de l'egg Pterodactyl d'origine, pour éviter les doubles imports. */
  importedFromEgg: z.string().optional(),
});

export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type TemplateVariableDefinition = z.infer<typeof templateVariableDefinitionSchema>;
export type DockerImageOption = z.infer<typeof dockerImageOptionSchema>;

/** Groupes de templates livrés avec Hopper. */
export const TEMPLATE_GROUPS = {
  JAVA: 'Minecraft: Java Edition',
  BEDROCK: 'Minecraft: Bedrock Edition',
  PROXY: 'Proxies',
} as const;

/**
 * Images Java proposées par défaut.
 *
 * L'ordre compte : la première est retenue quand l'utilisateur n'en choisit
 * pas. Java 21 convient à toutes les versions modernes ; Java 8 n'est là que
 * pour les serveurs 1.8 à 1.12, encore très répandus en PvP.
 */
export const JAVA_IMAGES: DockerImageOption[] = [
  { name: 'Java 21', image: 'ghcr.io/hopper-panel/java:21' },
  { name: 'Java 17', image: 'ghcr.io/hopper-panel/java:17' },
  { name: 'Java 11', image: 'ghcr.io/hopper-panel/java:11' },
  { name: 'Java 8', image: 'ghcr.io/hopper-panel/java:8' },
];

/**
 * Ligne émise par un serveur Bukkit quand il a fini de charger.
 * Échappée pour être stockée telle quelle et compilée par le daemon.
 */
export const BUKKIT_STARTUP_DETECTION = '\\)! For help, type "help"';

/** Réécriture de `server.properties` appliquée avant chaque démarrage. */
export const SERVER_PROPERTIES_CONFIG = {
  file: 'server.properties',
  parser: 'properties' as const,
  replacements: [
    // Le serveur doit écouter sur toutes les interfaces du conteneur : c'est
    // Docker qui restreint la publication au port alloué.
    { match: 'server-ip', replaceWith: '0.0.0.0' },
    { match: 'server-port', replaceWith: '{{server.build.default.port}}' },
  ],
};

import { z } from 'zod';

/**
 * Configuration complète d'un serveur, telle qu'envoyée par le panel au daemon.
 *
 * C'est la seule vue que le daemon a d'un serveur : il n'accède jamais à la base
 * de données. Toute information dont le daemon a besoin pour démarrer, arrêter,
 * surveiller ou réinstaller un serveur doit se trouver ici.
 */

/** Format d'un fichier de configuration que le daemon sait réécrire au démarrage. */
export const configParserSchema = z.enum(['properties', 'yaml', 'json', 'ini', 'xml', 'file']);
export type ConfigParser = z.infer<typeof configParserSchema>;

export const configReplacementSchema = z.object({
  /**
   * Chemin de la valeur dans le fichier, notation pointée.
   * Ex. `server-port` pour un .properties, `settings.bungeecord` pour un YAML.
   */
  match: z.string().min(1),
  /** Ne remplacer que si la valeur actuelle vaut ceci. Sinon, on écrase toujours. */
  ifValue: z.string().optional(),
  /** Gabarit de la nouvelle valeur, ex. `{{server.build.default.port}}`. */
  replaceWith: z.string(),
});

export const configFileSchema = z.object({
  /** Chemin relatif à la racine du serveur. Le daemon refuse tout chemin sortant. */
  file: z.string().min(1),
  parser: configParserSchema,
  replacements: z.array(configReplacementSchema),
});

/**
 * Comment arrêter proprement le serveur.
 *
 * `command` envoie une chaîne sur stdin (`stop` pour un serveur Minecraft) et
 * attend la fin du processus. `signal` envoie un signal au PID 1 du conteneur.
 * Dans les deux cas, un SIGKILL suit après `timeoutSeconds`.
 */
export const stopConfigurationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), value: z.string().min(1) }),
  z.object({ type: z.literal('signal'), value: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']) }),
]);

export const serverMetaSchema = z.object({
  name: z.string().min(1).max(191),
  description: z.string().max(2000).default(''),
});

export const allocationSchema = z.object({
  ip: z.string().min(1),
  port: z.number().int().min(1).max(65535),
});

export const serverAllocationsSchema = z.object({
  /** Allocation injectée dans `server-port` et annoncée aux joueurs. */
  default: allocationSchema,
  /** Ports supplémentaires exposés (dynmap, plugin de voice chat, query…). */
  additional: z.array(allocationSchema).default([]),
});

/**
 * Limites appliquées au conteneur. Toutes sont des limites dures : le noyau les
 * fait respecter, le daemon ne fait que les transmettre à Docker.
 */
export const serverBuildSchema = z.object({
  /** 0 = illimité. */
  memoryBytes: z.number().int().nonnegative(),
  /**
   * Swap autorisé en plus de la mémoire. -1 = illimité, 0 = swap interdit.
   * Docker attend `memory + swap` : la conversion est faite par le daemon.
   */
  swapBytes: z.number().int().min(-1),
  /** Pourcentage d'un cœur : 200 = deux cœurs. 0 = illimité. */
  cpuPercent: z.number().int().nonnegative(),
  /** Épinglage sur des cœurs précis, ex. `0-3` ou `0,2`. Vide = pas d'épinglage. */
  cpuSet: z.string().default(''),
  /** Poids d'E/S bloc, 10 à 1000. */
  ioWeight: z.number().int().min(10).max(1000).default(500),
  /** 0 = illimité. Vérifié par le daemon, pas par Docker (volumes bind). */
  diskBytes: z.number().int().nonnegative(),
  /**
   * Nombre maximal de processus dans le conteneur. Garde-fou contre les fork
   * bombs déclenchées par un plugin : ne jamais mettre 0 en production.
   */
  pidsLimit: z.number().int().positive().default(512),
  /**
   * Désactiver l'OOM killer laisse un serveur qui déborde geler l'hôte au lieu
   * d'être tué. À n'activer que sur demande explicite de l'opérateur.
   */
  oomKillDisabled: z.boolean().default(false),
});

export const serverContainerSchema = z.object({
  /** Image Docker complète, ex. `ghcr.io/hopper-panel/java:21`. */
  image: z.string().min(1),
  /** Le daemon doit recréer le conteneur au prochain démarrage. */
  requiresRebuild: z.boolean().default(false),
});

/** Ce que le daemon doit exécuter pour installer le serveur avant son premier démarrage. */
export const installConfigurationSchema = z.object({
  /** Image du conteneur d'installation, distincte de l'image d'exécution. */
  containerImage: z.string().min(1),
  /** Interpréteur du script, ex. `/bin/bash`. */
  entrypoint: z.string().min(1).default('/bin/bash'),
  /** Contenu du script d'installation. */
  script: z.string(),
});

export const serverConfigurationSchema = z.object({
  uuid: z.uuid(),
  meta: serverMetaSchema,

  /** Un serveur suspendu ne peut ni démarrer, ni être modifié, ni servir en SFTP. */
  suspended: z.boolean().default(false),

  /**
   * Gabarit de la commande de démarrage, ex.
   * `java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}`.
   *
   * Le daemon découpe ce gabarit en arguments AVANT de substituer les variables,
   * puis exécute le résultat sans passer par un shell. Une valeur de variable
   * contenant un espace, un `;` ou un `$` ne peut donc pas injecter d'argument
   * ni de commande supplémentaire.
   */
  invocation: z.string().min(1),

  /** Variables du template, injectées comme variables d'environnement du conteneur. */
  environment: z.record(z.string(), z.string()).default({}),

  allocations: serverAllocationsSchema,
  build: serverBuildSchema,
  container: serverContainerSchema,

  stop: stopConfigurationSchema,
  /** Délai avant SIGKILL si l'arrêt propre n'aboutit pas. */
  stopTimeoutSeconds: z.number().int().positive().max(600).default(30),

  /**
   * Expression régulière signalant que le serveur est prêt.
   * Ex. `\)! For help, type "help"` pour un serveur Bukkit.
   * Absente, le serveur passe `running` dès que le conteneur tourne.
   */
  startupDetection: z.string().optional(),

  /** Fichiers réécrits par le daemon juste avant chaque démarrage. */
  configFiles: z.array(configFileSchema).default([]),

  /**
   * Fichiers que l'utilisateur ne peut ni lire, ni modifier, ni supprimer, même
   * avec toutes les permissions. Motifs glob relatifs à la racine du serveur.
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

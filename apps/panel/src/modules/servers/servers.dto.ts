import { z } from 'zod';

const GIBIBYTE = 1024 ** 3;

export const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),

  /** UUID du propriétaire. */
  ownerUuid: z.uuid(),
  nodeUuid: z.uuid(),
  templateUuid: z.uuid(),

  /** Identifiant de l'allocation principale, libre sur le node choisi. */
  allocationId: z.number().int().positive(),

  // Limites de ressources. 0 = illimité pour mémoire, disque et CPU.
  memoryBytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * GIBIBYTE),
  diskBytes: z
    .number()
    .int()
    .nonnegative()
    .max(4096 * GIBIBYTE),
  swapBytes: z.number().int().min(-1).default(0),
  cpuPercent: z.number().int().min(0).max(6400).default(0),
  cpuSet: z
    .string()
    .max(100)
    .regex(/^[0-9,-]*$/, 'Format attendu : 0-3 ou 0,2,4.')
    .default(''),
  ioWeight: z.number().int().min(10).max(1000).default(500),
  /**
   * Sans limite de processus, un plugin qui fork en boucle fait tomber l'hôte
   * entier, pas seulement son serveur. Le minimum est haut assez pour une JVM
   * et ses threads de GC.
   */
  pidsLimit: z.number().int().min(64).max(8192).default(512),
  oomKillDisabled: z.boolean().default(false),

  backupLimit: z.number().int().min(0).max(100).default(3),
  allocationLimit: z.number().int().min(0).max(50).default(0),
  databaseLimit: z.number().int().min(0).max(50).default(0),

  /** Valeurs des variables du template, par nom de variable d'environnement. */
  variables: z.record(z.string(), z.string().max(2000)).default({}),

  /** Image Docker choisie parmi celles proposées par le template. */
  dockerImage: z.string().min(1).max(255).optional(),

  /** Démarrer le serveur dès la fin de l'installation. */
  startOnCompletion: z.boolean().default(true),
});

export const updateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
});

/** Modification des limites : réservé aux administrateurs. */
export const updateServerBuildSchema = z.object({
  memoryBytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * GIBIBYTE)
    .optional(),
  diskBytes: z
    .number()
    .int()
    .nonnegative()
    .max(4096 * GIBIBYTE)
    .optional(),
  swapBytes: z.number().int().min(-1).optional(),
  cpuPercent: z.number().int().min(0).max(6400).optional(),
  cpuSet: z
    .string()
    .max(100)
    .regex(/^[0-9,-]*$/)
    .optional(),
  ioWeight: z.number().int().min(10).max(1000).optional(),
  pidsLimit: z.number().int().min(64).max(8192).optional(),
  oomKillDisabled: z.boolean().optional(),
  backupLimit: z.number().int().min(0).max(100).optional(),
  allocationLimit: z.number().int().min(0).max(50).optional(),
  databaseLimit: z.number().int().min(0).max(50).optional(),
});

export type CreateServerDto = z.infer<typeof createServerSchema>;
export type UpdateServerDto = z.infer<typeof updateServerSchema>;
export type UpdateServerBuildDto = z.infer<typeof updateServerBuildSchema>;

/**
 * Action de puissance demandée en REST.
 *
 * `kill` est accepté mais reste une opération de dernier recours : il coupe le
 * processus sans laisser au serveur le temps d'écrire son monde sur le disque.
 */
export const powerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'kill']),
});

export type PowerActionDto = z.infer<typeof powerActionSchema>;

import { z } from 'zod';

/**
 * Une liste d'exclusion trop longue ne protège de rien mais rend le parcours
 * du volume coûteux : chaque règle est évaluée pour chaque fichier.
 */
const MAX_IGNORE_PATTERNS = 100;

export const createBackupSchema = z.object({
  /** Vide, le panel forge un nom daté et lisible. */
  name: z.string().trim().max(120).optional(),
  ignoredFiles: z.array(z.string().max(512)).max(MAX_IGNORE_PATTERNS).optional(),
  /**
   * Verrouiller dès la création.
   *
   * Sans cela, une sauvegarde faite avant une opération risquée pouvait être
   * effacée par la rétention avant même qu'on pense à la verrouiller — c'est
   * précisément le moment où on en a besoin.
   */
  locked: z.boolean().default(false),
});

export type CreateBackupDto = z.infer<typeof createBackupSchema>;

export const restoreBackupSchema = z.object({
  truncate: z.boolean().default(true),
});

export type RestoreBackupDto = z.infer<typeof restoreBackupSchema>;

export const lockBackupSchema = z.object({
  locked: z.boolean(),
});

export type LockBackupDto = z.infer<typeof lockBackupSchema>;

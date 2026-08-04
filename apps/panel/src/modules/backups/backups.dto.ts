import { z } from 'zod';

/**
 * An exclusion list that is too long protects nothing but makes walking the
 * volume expensive: every rule is evaluated for every file.
 */
const MAX_IGNORE_PATTERNS = 100;

export const createBackupSchema = z.object({
  /** Empty, the panel forges a dated, readable name. */
  name: z.string().trim().max(120).optional(),
  ignoredFiles: z.array(z.string().max(512)).max(MAX_IGNORE_PATTERNS).optional(),
  /**
   * Lock it on creation.
   *
   * Without this, a backup taken before a risky operation could be erased by
   * retention before anyone thought to lock it — which is precisely the moment
   * it is needed.
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

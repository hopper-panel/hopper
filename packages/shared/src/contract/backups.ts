import { z } from 'zod';

/**
 * Backup contract.
 *
 * The division of roles follows the rest of the panel: **the panel decides, the
 * daemon executes**. The panel keeps the register of backups, applies retention
 * and checks permissions; the daemon alone knows where the volumes live and
 * never trusts a path it is handed.
 *
 * A backup is asynchronous: the request returns at once, and the daemon calls
 * `POST /api/remote/backups/:uuid/status` when the archive is closed. Archiving
 * several gigabytes cannot fit in an HTTP request, and a server restarting
 * mid-operation must not leave the panel waiting forever.
 */

export const BACKUP_ROUTES = {
  backups: (serverUuid: string) => `/api/servers/${serverUuid}/backups`,
  backup: (serverUuid: string, backupUuid: string) =>
    `/api/servers/${serverUuid}/backups/${backupUuid}`,
  backupRestore: (serverUuid: string, backupUuid: string) =>
    `/api/servers/${serverUuid}/backups/${backupUuid}/restore`,
  backupDownload: (serverUuid: string, backupUuid: string) =>
    `/api/servers/${serverUuid}/backups/${backupUuid}/download`,
} as const;

/**
 * Compression format of the archive.
 *
 * zstd compresses a Minecraft world markedly faster than gzip at an equal
 * ratio, but is only available in `node:zlib` from Node 22.15 on. The format
 * used is therefore decided at runtime and written into the file name, so that
 * an archive produced by one version stays restorable by another.
 */
export const backupCompressionSchema = z.enum(['gzip', 'zstd']);
export type BackupCompression = z.infer<typeof backupCompressionSchema>;

export const BACKUP_EXTENSIONS: Record<BackupCompression, string> = {
  gzip: '.tar.gz',
  zstd: '.tar.zst',
};

// ---------------------------------------------------------------------------
// POST /api/servers/:uuid/backups
// ---------------------------------------------------------------------------

export const createBackupRequestSchema = z.object({
  /** Backup identifier, chosen by the panel that already recorded it. */
  uuid: z.uuid(),
  /**
   * Patterns to exclude, `.gitignore` syntax.
   *
   * Excluding logs and caches routinely halves the size, and above all avoids
   * archiving files the server rewrites constantly.
   */
  ignoredFiles: z.array(z.string()).default([]),
});

export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

export const backupStatusSchema = z.enum(['running', 'completed', 'failed']);
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const backupResponseSchema = z.object({
  uuid: z.uuid(),
  status: backupStatusSchema,
  compression: backupCompressionSchema,
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string().optional(),
  error: z.string().optional(),
});

export type BackupResponse = z.infer<typeof backupResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers/:uuid/backups/:backupUuid/restore
// ---------------------------------------------------------------------------

export const restoreBackupRequestSchema = z.object({
  /**
   * Empty the volume before extracting.
   *
   * Without it, the archive is laid over the files present: files added since
   * the backup survive. That is sometimes wanted — recovering a world without
   * losing plugins installed since — but it is not the usual meaning of
   * "restore", hence the default of `true`.
   */
  truncate: z.boolean().default(true),
});

export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

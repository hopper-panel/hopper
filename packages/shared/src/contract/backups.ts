import { z } from 'zod';

/**
 * Contrat des sauvegardes.
 *
 * Le partage des rôles suit celui du reste du panel : **le panel décide, le
 * daemon exécute**. Le panel tient le registre des sauvegardes, applique la
 * rétention et vérifie les permissions ; le daemon sait seul où vivent les
 * volumes et ne fait jamais confiance à un chemin qu'on lui donne.
 *
 * Une sauvegarde est asynchrone : la requête rend la main tout de suite, et le
 * daemon rappelle `POST /api/remote/backups/:uuid/status` quand l'archive est
 * close. Archiver plusieurs gigaoctets ne peut pas tenir dans une requête HTTP,
 * et un serveur qui redémarre pendant l'opération ne doit pas laisser le panel
 * en attente indéfinie.
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
 * Format de compression de l'archive.
 *
 * zstd compresse un monde Minecraft nettement plus vite que gzip à taux égal,
 * mais n'est disponible dans `node:zlib` qu'à partir de Node 22.15. Le format
 * retenu est donc décidé à l'exécution et inscrit dans le nom du fichier, pour
 * qu'une archive produite par une version reste restaurable par une autre.
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
  /** Identifiant de la sauvegarde, choisi par le panel qui l'a déjà enregistrée. */
  uuid: z.uuid(),
  /**
   * Motifs à exclure, syntaxe `.gitignore`.
   *
   * Exclure les journaux et les caches divise couramment la taille par deux, et
   * surtout évite d'archiver des fichiers que le serveur réécrit en permanence.
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
   * Vider le volume avant extraction.
   *
   * Sans cela, l'archive est superposée aux fichiers présents : les fichiers
   * ajoutés depuis la sauvegarde survivent. C'est parfois voulu — récupérer un
   * monde sans perdre des plugins installés depuis — mais ce n'est pas le sens
   * habituel de « restaurer », d'où le défaut à `true`.
   */
  truncate: z.boolean().default(true),
});

export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

import { z } from 'zod';
import { permissionSchema } from '../permissions.js';
import { serverStateSchema } from '../server-state.js';
import { serverConfigurationSchema } from './server-configuration.js';

/**
 * Contrat des appels **daemon → panel**, exposés par le panel sous `/api/remote/*`.
 *
 * Le daemon s'authentifie avec le même jeton de node que celui qu'il accepte en
 * entrée, envoyé en `Authorization: Bearer <tokenId>.<tokenSecret>`. Le panel
 * identifie le node à partir de `tokenId` et compare le secret au hash stocké.
 *
 * Ces routes ne sont jamais appelées par un navigateur : elles doivent être
 * refusées si la requête porte un cookie de session au lieu d'un jeton de node.
 */

export const REMOTE_ROUTES = {
  /** Réconciliation au démarrage du daemon : la liste des serveurs qu'il doit héberger. */
  servers: '/api/remote/servers',
  server: (uuid: string) => `/api/remote/servers/${uuid}`,
  serverInstall: (uuid: string) => `/api/remote/servers/${uuid}/install`,
  serverStatus: (uuid: string) => `/api/remote/servers/${uuid}/status`,
  sftpAuth: '/api/remote/sftp/auth',
  backupStatus: (uuid: string) => `/api/remote/backups/${uuid}/status`,
  activity: '/api/remote/activity',
} as const;

// ---------------------------------------------------------------------------
// GET /api/remote/servers
// ---------------------------------------------------------------------------

/**
 * Le daemon pagine cette liste au démarrage pour savoir quels conteneurs doivent
 * exister. Tout conteneur Hopper présent sur l'hôte mais absent de cette liste
 * est signalé à l'opérateur, jamais supprimé automatiquement : une erreur de
 * configuration ne doit pas détruire les données d'un serveur.
 */
export const remoteServersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(200).default(50),
});

export const remoteServersResponseSchema = z.object({
  data: z.array(serverConfigurationSchema),
  meta: z.object({
    currentPage: z.number().int().positive(),
    lastPage: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  }),
});

export type RemoteServersResponse = z.infer<typeof remoteServersResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/servers/:uuid/install
// ---------------------------------------------------------------------------

export const installReportSchema = z.object({
  successful: z.boolean(),
  /** Vrai s'il s'agissait d'une réinstallation, pas d'une première installation. */
  reinstall: z.boolean().default(false),
});

export type InstallReport = z.infer<typeof installReportSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/servers/:uuid/status
// ---------------------------------------------------------------------------

export const statusReportSchema = z.object({
  state: serverStateSchema,
  /** Millisecondes epoch de la transition, pour ordonner des rapports arrivés en désordre. */
  at: z.number().int().positive(),
});

export type StatusReport = z.infer<typeof statusReportSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/sftp/auth
// ---------------------------------------------------------------------------

/**
 * Le daemon délègue au panel l'authentification SFTP : lui seul connaît les
 * comptes. Le nom d'utilisateur porte le serveur visé, sous la forme
 * `<username>.<8 premiers caractères de l'UUID du serveur>`.
 */
export const sftpAuthRequestSchema = z.object({
  username: z.string().min(1).max(191),
  password: z.string().min(1).max(1024),
  /** IP source, journalisée et soumise au rate-limit côté panel. */
  ip: z.string().min(1),
});

export const sftpAuthResponseSchema = z.object({
  serverUuid: z.uuid(),
  userUuid: z.uuid(),
  permissions: z.array(permissionSchema),
});

export type SftpAuthRequest = z.infer<typeof sftpAuthRequestSchema>;
export type SftpAuthResponse = z.infer<typeof sftpAuthResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/backups/:uuid/status
// ---------------------------------------------------------------------------

export const backupReportSchema = z.object({
  successful: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  /** SHA-256 de l'archive, vérifié à la restauration. */
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  /** Renseigné en cas d'échec, affiché à l'utilisateur. */
  error: z.string().optional(),
});

export type BackupReport = z.infer<typeof backupReportSchema>;

// ---------------------------------------------------------------------------
// POST /api/remote/activity
// ---------------------------------------------------------------------------

/**
 * Événements d'audit produits par le daemon (upload de fichier, connexion SFTP,
 * suppression). Envoyés par lots pour ne pas générer une requête par action.
 */
export const remoteActivityEntrySchema = z.object({
  serverUuid: z.uuid(),
  userUuid: z.uuid().nullable(),
  event: z.string().min(1).max(191),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.number().int().positive(),
});

export const remoteActivityRequestSchema = z.object({
  entries: z.array(remoteActivityEntrySchema).min(1).max(200),
});

export type RemoteActivityEntry = z.infer<typeof remoteActivityEntrySchema>;
export type RemoteActivityRequest = z.infer<typeof remoteActivityRequestSchema>;

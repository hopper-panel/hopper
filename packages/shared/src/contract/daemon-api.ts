import { z } from 'zod';
import { powerActionSchema, resourceUsageSchema, serverStateSchema } from '../server-state.js';
import { serverConfigurationSchema } from './server-configuration.js';

/**
 * Contrat des appels **panel → daemon**.
 *
 * Toutes ces routes exigent l'en-tête `Authorization: Bearer <tokenId>.<tokenSecret>`
 * correspondant au node. Le daemon compare le secret à son fichier de configuration ;
 * il n'interroge jamais le panel pour s'authentifier lui-même.
 */

export const DAEMON_ROUTES = {
  system: '/api/system',
  servers: '/api/servers',
  server: (uuid: string) => `/api/servers/${uuid}`,
  serverPower: (uuid: string) => `/api/servers/${uuid}/power`,
  serverCommands: (uuid: string) => `/api/servers/${uuid}/commands`,
  serverSync: (uuid: string) => `/api/servers/${uuid}/sync`,
  serverReinstall: (uuid: string) => `/api/servers/${uuid}/reinstall`,
  serverWebsocket: (uuid: string) => `/api/servers/${uuid}/ws`,
} as const;

// ---------------------------------------------------------------------------
// GET /api/system
// ---------------------------------------------------------------------------

export const systemInformationSchema = z.object({
  version: z.string(),
  kernelVersion: z.string(),
  architecture: z.string(),
  os: z.string(),
  cpuCount: z.number().int().positive(),
  memoryTotalBytes: z.number().int().nonnegative(),
  docker: z.object({
    version: z.string(),
    storageDriver: z.string(),
    cgroupVersion: z.string(),
    /** Nombre de conteneurs gérés par Hopper actuellement en cours d'exécution. */
    runningContainers: z.number().int().nonnegative(),
  }),
});

export type SystemInformation = z.infer<typeof systemInformationSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers
// ---------------------------------------------------------------------------

export const createServerRequestSchema = z.object({
  configuration: serverConfigurationSchema,
  /** Lancer l'installation immédiatement, puis démarrer le serveur une fois terminée. */
  startOnCompletion: z.boolean().default(false),
});

export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;

// ---------------------------------------------------------------------------
// GET /api/servers/:uuid
// ---------------------------------------------------------------------------

export const serverStatusResponseSchema = z.object({
  uuid: z.uuid(),
  state: serverStateSchema,
  usage: resourceUsageSchema.nullable(),
  /** Le conteneur existe sur l'hôte. Faux juste après une création ou un rebuild. */
  containerExists: z.boolean(),
});

export type ServerStatusResponse = z.infer<typeof serverStatusResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers/:uuid/power
// ---------------------------------------------------------------------------

export const powerRequestSchema = z.object({
  action: powerActionSchema,
  /**
   * Attendre la fin de l'action avant de répondre. Par défaut le daemon accuse
   * réception immédiatement et notifie l'état final par WebSocket : un arrêt de
   * serveur Minecraft peut prendre plusieurs dizaines de secondes.
   */
  wait: z.boolean().default(false),
});

export type PowerRequest = z.infer<typeof powerRequestSchema>;

// ---------------------------------------------------------------------------
// POST /api/servers/:uuid/commands
// ---------------------------------------------------------------------------

export const sendCommandsRequestSchema = z.object({
  commands: z.array(z.string().max(2000)).min(1).max(50),
});

export type SendCommandsRequest = z.infer<typeof sendCommandsRequestSchema>;

// ---------------------------------------------------------------------------
// DELETE /api/servers/:uuid
// ---------------------------------------------------------------------------

export const deleteServerRequestSchema = z.object({
  /** Supprimer aussi le volume de données. Sans cela, seul le conteneur part. */
  purgeVolume: z.boolean().default(true),
});

export type DeleteServerRequest = z.infer<typeof deleteServerRequestSchema>;

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/**
 * Réponse d'erreur uniforme du daemon.
 *
 * `requestId` est repris dans les logs du daemon : c'est ce qu'un opérateur
 * cherche pour relier une erreur affichée dans le panel à une trace complète.
 */
export const daemonErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export type DaemonError = z.infer<typeof daemonErrorSchema>;

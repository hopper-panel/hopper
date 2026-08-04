import { z } from 'zod';

/**
 * États possibles d'un serveur, tels que rapportés par le daemon.
 *
 * `starting` couvre la période entre le lancement du conteneur et la détection
 * de la ligne de démarrage du template (voir `startupDetection`). Un serveur qui
 * plante au démarrage repasse `offline` sans jamais atteindre `running`.
 */
export const SERVER_STATES = [
  'offline',
  'starting',
  'running',
  'stopping',
  'installing',
  'install_failed',
  'restoring_backup',
  'suspended',
  /** Le conteneur ou le volume a disparu de l'hôte : intervention manuelle requise. */
  'missing',
] as const;

export const serverStateSchema = z.enum(SERVER_STATES);
export type ServerState = z.infer<typeof serverStateSchema>;

/** États dans lesquels le serveur consomme des ressources sur l'hôte. */
export const ACTIVE_STATES: readonly ServerState[] = [
  'starting',
  'running',
  'stopping',
  'installing',
  'restoring_backup',
];

/** États qui interdisent toute action de puissance ou modification de fichiers. */
export const LOCKED_STATES: readonly ServerState[] = [
  'installing',
  'install_failed',
  'restoring_backup',
  'suspended',
  'missing',
];

export function isActiveState(state: ServerState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isLockedState(state: ServerState): boolean {
  return LOCKED_STATES.includes(state);
}

export const POWER_ACTIONS = ['start', 'stop', 'restart', 'kill'] as const;

export const powerActionSchema = z.enum(POWER_ACTIONS);
export type PowerAction = z.infer<typeof powerActionSchema>;

/** Consommation de ressources d'un serveur, échantillonnée par le daemon. */
export const resourceUsageSchema = z.object({
  state: serverStateSchema,
  /** Millisecondes depuis le démarrage du conteneur, 0 si arrêté. */
  uptime: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  memoryLimitBytes: z.number().int().nonnegative(),
  /** Pourcentage d'un cœur : 250 = deux cœurs et demi saturés. */
  cpuPercent: z.number().nonnegative(),
  diskBytes: z.number().int().nonnegative(),
  networkRxBytes: z.number().int().nonnegative(),
  networkTxBytes: z.number().int().nonnegative(),
});

export type ResourceUsage = z.infer<typeof resourceUsageSchema>;

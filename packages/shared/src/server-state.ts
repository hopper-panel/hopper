import { z } from 'zod';

/**
 * Server states as reported by the daemon.
 *
 * `starting` covers the gap between the container launching and the template's
 * startup pattern matching. A server that crashes while starting falls back to
 * `offline` without ever reaching `running`.
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
  /** Container or volume vanished from the host: needs manual attention. */
  'missing',
] as const;

export const serverStateSchema = z.enum(SERVER_STATES);
export type ServerState = z.infer<typeof serverStateSchema>;

/** States in which the server consumes host resources. */
export const ACTIVE_STATES: readonly ServerState[] = [
  'starting',
  'running',
  'stopping',
  'installing',
  'restoring_backup',
];

/** States that forbid any power action or file change. */
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

/** Resource usage sampled by the daemon. */
export const resourceUsageSchema = z.object({
  state: serverStateSchema,
  /** Milliseconds since the container started, 0 when stopped. */
  uptime: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  memoryLimitBytes: z.number().int().nonnegative(),
  /** Percent of one core: 250 means two and a half cores saturated. */
  cpuPercent: z.number().nonnegative(),
  diskBytes: z.number().int().nonnegative(),
  networkRxBytes: z.number().int().nonnegative(),
  networkTxBytes: z.number().int().nonnegative(),
});

export type ResourceUsage = z.infer<typeof resourceUsageSchema>;

import { z } from 'zod';

const GIBIBYTE = 1024 ** 3;

export const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),

  /** Owner UUID. */
  ownerUuid: z.uuid(),
  nodeUuid: z.uuid(),
  templateUuid: z.uuid(),

  /** Identifier of the primary allocation, free on the chosen node. */
  allocationId: z.number().int().positive(),

  // Resource limits. 0 = unlimited for memory, disk and CPU.
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
    .regex(/^[0-9,-]*$/, 'Expected format: 0-3 or 0,2,4.')
    .default(''),
  ioWeight: z.number().int().min(10).max(1000).default(500),
  /**
   * Without a process limit, a plugin forking in a loop brings down the whole
   * host, not just its own server. The minimum is high enough for a JVM and its
   * GC threads.
   */
  pidsLimit: z.number().int().min(64).max(8192).default(512),
  oomKillDisabled: z.boolean().default(false),

  backupLimit: z.number().int().min(0).max(100).default(3),
  allocationLimit: z.number().int().min(0).max(50).default(0),
  databaseLimit: z.number().int().min(0).max(50).default(0),

  /** Template variable values, keyed by environment variable name. */
  variables: z.record(z.string(), z.string().max(2000)).default({}),

  /** Docker image chosen among those the template offers. */
  dockerImage: z.string().min(1).max(255).optional(),

  /** Start the server as soon as the installation finishes. */
  startOnCompletion: z.boolean().default(true),
});

export const updateServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
});

/** Changing the limits: administrators only. */
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
 * Power action requested over REST.
 *
 * `kill` is accepted but stays a last resort: it cuts the process without
 * leaving the server time to write its world to disk.
 */
export const powerActionSchema = z.object({
  action: z.enum(['start', 'stop', 'restart', 'kill']),
});

export type PowerActionDto = z.infer<typeof powerActionSchema>;

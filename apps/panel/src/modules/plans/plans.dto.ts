import { z } from 'zod';

const GIBIBYTE = 1024 ** 3;

/**
 * The limits, with the same bounds as `createServerSchema`.
 *
 * Written out here rather than imported from there because they are validated
 * at a different moment for a different reason: those bound a server an
 * administrator is creating now, these bound an offer that will create servers
 * for a year. The numbers agreeing is what matters, and a plan that could hold
 * a value the server refuses would fail at the worst possible time — in the
 * middle of a customer's purchase, having already taken their money.
 */
const limits = {
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
  swapBytes: z.number().int().min(-1),
  cpuPercent: z.number().int().min(0).max(6400),
  ioWeight: z.number().int().min(10).max(1000),
  pidsLimit: z.number().int().min(64).max(8192),
  oomKillDisabled: z.boolean(),
  backupLimit: z.number().int().min(0).max(100),
  allocationLimit: z.number().int().min(0).max(50),
  databaseLimit: z.number().int().min(0).max(50),
};

/**
 * The name a billing system quotes.
 *
 * Constrained to what survives being typed into another product's
 * configuration field, pasted into a support ticket and put in a URL: lower
 * case, digits and dashes. Rejecting `Minecraft 4GB` up front is kinder than
 * accepting it and having an integrator discover the encoding themselves.
 */
export const planSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lower case, digits and single dashes: minecraft-4gb.');

export const createPlanSchema = z.object({
  slug: planSlugSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),

  templateUuid: z.uuid(),
  /** One of the template's images. Empty = the template's default. */
  dockerImage: z.string().max(255).default(''),

  memoryBytes: limits.memoryBytes,
  diskBytes: limits.diskBytes,
  swapBytes: limits.swapBytes.default(0),
  cpuPercent: limits.cpuPercent.default(0),
  ioWeight: limits.ioWeight.default(500),
  pidsLimit: limits.pidsLimit.default(512),
  oomKillDisabled: limits.oomKillDisabled.default(false),

  backupLimit: limits.backupLimit.default(3),
  allocationLimit: limits.allocationLimit.default(0),
  databaseLimit: limits.databaseLimit.default(0),

  /**
   * Nodes this offer may be placed on. Empty = anywhere.
   *
   * Empty is the default and the right one for an instance with a single node:
   * an operator should not have to name their only machine to be allowed to
   * sell anything on it.
   */
  nodeUuids: z.array(z.uuid()).max(100).default([]),

  active: z.boolean().default(true),
});

/**
 * Editing an offer.
 *
 * Every field optional, and none of them reaches an existing server: the limits
 * are copied at creation. What changes here is what the *next* purchase gets.
 */
export const updatePlanSchema = z.object({
  slug: planSlugSchema.optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  templateUuid: z.uuid().optional(),
  dockerImage: z.string().max(255).optional(),

  memoryBytes: limits.memoryBytes.optional(),
  diskBytes: limits.diskBytes.optional(),
  swapBytes: limits.swapBytes.optional(),
  cpuPercent: limits.cpuPercent.optional(),
  ioWeight: limits.ioWeight.optional(),
  pidsLimit: limits.pidsLimit.optional(),
  oomKillDisabled: limits.oomKillDisabled.optional(),

  backupLimit: limits.backupLimit.optional(),
  allocationLimit: limits.allocationLimit.optional(),
  databaseLimit: limits.databaseLimit.optional(),

  nodeUuids: z.array(z.uuid()).max(100).optional(),
  active: z.boolean().optional(),
});

export type CreatePlanDto = z.infer<typeof createPlanSchema>;
export type UpdatePlanDto = z.infer<typeof updatePlanSchema>;

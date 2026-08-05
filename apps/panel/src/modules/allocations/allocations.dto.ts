import { z } from 'zod';

export const updateAllocationSchema = z.object({
  /**
   * Free-form note shown beside the port: "dynmap", "voice", the domain given
   * to players. Empty, it is cleared.
   */
  alias: z.string().trim().max(120).nullable().default(null),
});

export type UpdateAllocationDto = z.infer<typeof updateAllocationSchema>;

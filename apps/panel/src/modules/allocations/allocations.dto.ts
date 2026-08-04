import { z } from 'zod';

export const updateAllocationSchema = z.object({
  /**
   * Note libre affichée à côté du port : « dynmap », « voice », le domaine
   * annoncé aux joueurs. Vide, elle est effacée.
   */
  alias: z.string().trim().max(120).nullable().default(null),
});

export type UpdateAllocationDto = z.infer<typeof updateAllocationSchema>;

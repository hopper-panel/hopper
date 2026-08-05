import { z } from 'zod';
import { MAX_VARIABLE_LENGTH } from './variable-rules.js';

export const updateStartupSchema = z.object({
  /**
   * Values keyed by environment variable name.
   *
   * The length bound is set here **and** in the rule validator: here to reject
   * an outsized payload before any processing, there to cover calls that would
   * not go through this schema.
   */
  variables: z.record(z.string(), z.string().max(MAX_VARIABLE_LENGTH)).optional(),
  dockerImage: z.string().min(1).max(255).optional(),
});

export type UpdateStartupDto = z.infer<typeof updateStartupSchema>;

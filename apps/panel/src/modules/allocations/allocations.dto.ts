import { allocationRoleSchema } from '@hopper/shared';
import { z } from 'zod';

export const updateAllocationSchema = z.object({
  /**
   * Free-form note shown beside the port: "dynmap", "voice", the domain given
   * to players. Empty, it is cleared.
   */
  alias: z.string().trim().max(120).nullable().default(null),
});

export type UpdateAllocationDto = z.infer<typeof updateAllocationSchema>;

/**
 * Naming a port, on its own route rather than beside the alias.
 *
 * Two reasons, and the second is the real one. The shapes differ — an absent
 * `alias` clears it, which is a semantic no field acquiring a second meaning
 * should inherit — and, more to the point, saving a name has to ask the node
 * whether its daemon understands names at all. That is an HTTP round trip to
 * another machine, and every edit of a free-text note should not be paying for
 * it.
 *
 * The shape comes from the contract itself, not a copy of it: this is the same
 * key the daemon matches a readiness `role` against, and a panel that accepted
 * a spelling the daemon cannot match would be storing a name that silently
 * names nothing.
 */
export const setAllocationRoleSchema = z.object({
  /** `null` clears the name and puts the port back to being reached by number. */
  role: allocationRoleSchema.nullable(),
});

export type SetAllocationRoleDto = z.infer<typeof setAllocationRoleSchema>;

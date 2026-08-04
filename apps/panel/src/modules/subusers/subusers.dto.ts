import { permissionSchema } from '@hopper/shared';
import { z } from 'zod';

export const createSubuserSchema = z.object({
  /**
   * The account named by its address.
   *
   * And not by its identifier: the address is what the server's owner knows of
   * the person they are opening access to.
   */
  email: z.email(),
  permissions: z.array(permissionSchema).max(64),
});

export type CreateSubuserDto = z.infer<typeof createSubuserSchema>;

export const updateSubuserSchema = z.object({
  permissions: z.array(permissionSchema).max(64),
});

export type UpdateSubuserDto = z.infer<typeof updateSubuserSchema>;

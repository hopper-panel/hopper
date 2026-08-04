import { permissionSchema } from '@hopper/shared';
import { z } from 'zod';

export const createSubuserSchema = z.object({
  /**
   * Compte désigné par son adresse.
   *
   * Et non par son identifiant : l'adresse est ce que le propriétaire du
   * serveur connaît de la personne à qui il ouvre l'accès.
   */
  email: z.email(),
  permissions: z.array(permissionSchema).max(64),
});

export type CreateSubuserDto = z.infer<typeof createSubuserSchema>;

export const updateSubuserSchema = z.object({
  permissions: z.array(permissionSchema).max(64),
});

export type UpdateSubuserDto = z.infer<typeof updateSubuserSchema>;

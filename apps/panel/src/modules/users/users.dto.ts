import { z } from 'zod';
import { passwordSchema } from '../auth/auth.dto.js';

/**
 * Le nom d'utilisateur sert d'identifiant de connexion SFTP (`julien.a1b2c3d4`),
 * d'où l'absence de point : il servirait de séparateur avec l'identifiant du
 * serveur et rendrait le découpage ambigu.
 */
export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Le nom d’utilisateur ne peut contenir que des lettres, chiffres, tirets et tirets bas.',
  );

export const createUserSchema = z.object({
  email: z.email().max(191),
  username: usernameSchema,
  /**
   * Facultatif : sans mot de passe, le compte est créé inutilisable et son
   * titulaire reçoit un lien pour en choisir un. C'est le comportement à
   * préférer — un mot de passe choisi par l'administrateur transite par un
   * canal qu'il ne maîtrise pas, et reste souvent inchangé.
   */
  password: passwordSchema.optional(),
  role: z.enum(['ADMIN', 'USER']).default('USER'),
});

export const updateUserSchema = z.object({
  email: z.email().max(191).optional(),
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  suspended: z.boolean().optional(),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;

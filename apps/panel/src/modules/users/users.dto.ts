import { z } from 'zod';
import { passwordSchema } from '../auth/auth.dto.js';

/**
 * The username doubles as the SFTP sign-in identifier (`julien.a1b2c3d4`),
 * hence the absence of a dot: it would act as the separator with the server
 * identifier and make the split ambiguous.
 */
export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'The username may contain only letters, digits, hyphens and underscores.',
  );

export const createUserSchema = z.object({
  email: z.email().max(191),
  username: usernameSchema,
  /**
   * Optional: with no password, the account is created unusable and its holder
   * receives a link to choose one. That is the behaviour to prefer — a password
   * chosen by the administrator travels through a channel they do not control,
   * and often stays unchanged.
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

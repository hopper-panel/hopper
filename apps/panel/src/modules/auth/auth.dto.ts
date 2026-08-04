import { z } from 'zod';

/**
 * Password rules.
 *
 * A 12-character minimum and no composition rule: demanding "one capital, one
 * digit, one symbol" pushes people towards `Password1!`, which is quicker to
 * crack than a 16-letter passphrase. It is also NIST SP 800-63B's advice since
 * 2017.
 */
export const passwordSchema = z
  .string()
  .min(12, 'The password must be at least 12 characters long.')
  .max(4096);

export const loginSchema = z.object({
  /** Adresse e-mail ou nom d'utilisateur. */
  identifier: z.string().min(1).max(191),
  password: z.string().min(1).max(4096),
  /** TOTP code or recovery code, if 2FA is on. */
  totpCode: z.string().min(1).max(32).optional(),
});

export const refreshSchema = z.object({
  /** Optional: the web interface carries the token in an httpOnly cookie. */
  refreshToken: z.string().min(1).optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(4096),
    newPassword: passwordSchema,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    message: 'The new password must differ from the old one.',
    path: ['newPassword'],
  });

export const totpCodeSchema = z.object({
  code: z.string().min(6).max(32),
});

export const disableTwoFactorSchema = z.object({
  password: z.string().min(1).max(4096),
});

export type LoginDto = z.infer<typeof loginSchema>;
export type RefreshDto = z.infer<typeof refreshSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
export type TotpCodeDto = z.infer<typeof totpCodeSchema>;
export type DisableTwoFactorDto = z.infer<typeof disableTwoFactorSchema>;

/**
 * Choosing the initial password, from the link received by email.
 *
 * The token is bounded in length: a JWT signed with HS256 rarely exceeds four
 * hundred characters, and refusing earlier avoids verifying a signature over an
 * arbitrary payload.
 */
export const passwordSetupSchema = z.object({
  token: z.string().min(1).max(2048),
  password: passwordSchema,
});

export type PasswordSetupDto = z.infer<typeof passwordSetupSchema>;

import { z } from 'zod';

/**
 * Règles de mot de passe.
 *
 * Longueur minimale de 12 caractères et aucune règle de composition : imposer
 * « une majuscule, un chiffre, un symbole » pousse les gens vers `Password1!`,
 * qui est plus court à casser qu'une phrase de passe de 16 lettres. C'est aussi
 * la recommandation du NIST SP 800-63B depuis 2017.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caractères.')
  .max(4096);

export const loginSchema = z.object({
  /** Adresse e-mail ou nom d'utilisateur. */
  identifier: z.string().min(1).max(191),
  password: z.string().min(1).max(4096),
  /** Code TOTP ou code de récupération, si la 2FA est active. */
  totpCode: z.string().min(1).max(32).optional(),
});

export const refreshSchema = z.object({
  /** Optionnel : l'interface web transmet le jeton par cookie httpOnly. */
  refreshToken: z.string().min(1).optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(4096),
    newPassword: passwordSchema,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    message: 'Le nouveau mot de passe doit être différent de l’ancien.',
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
 * Choix du mot de passe initial, depuis le lien reçu par courriel.
 *
 * Le jeton est borné en longueur : un JWT signé en HS256 dépasse rarement
 * quatre cents caractères, et refuser plus tôt évite de faire vérifier une
 * signature sur une charge arbitraire.
 */
export const passwordSetupSchema = z.object({
  token: z.string().min(1).max(2048),
  password: passwordSchema,
});

export type PasswordSetupDto = z.infer<typeof passwordSetupSchema>;

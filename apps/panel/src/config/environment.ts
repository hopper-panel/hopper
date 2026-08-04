import { z } from 'zod';

/**
 * Variables d'environnement du panel.
 *
 * La validation est faite au démarrage, avant que Nest ne construise le moindre
 * module : un secret manquant doit faire échouer le lancement immédiatement, pas
 * à la première connexion d'un utilisateur.
 */
export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** URL publique du panel. Sert d'émetteur des JWT et d'origine autorisée. */
  APP_URL: z.url().default('http://localhost:8080'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),

  /**
   * Emplacement de l'interface construite, servie par le panel en production.
   *
   * Le défaut suppose que le processus est lancé depuis `apps/panel`, ce que
   * fait l'unité systemd. Un déploiement qui range le front ailleurs surcharge
   * cette variable plutôt que de reposer sur la position du code compilé.
   */
  WEB_ROOT: z.string().min(1).default('web/dist'),

  /**
   * Secret de signature des sessions et des jetons de console.
   * 32 caractères minimum : en dessous, une clé HMAC-SHA256 est plus courte que
   * sa propre sortie et perd l'essentiel de sa résistance.
   */
  APP_SECRET: z.string().min(32),

  /**
   * Connexion vers un daemon de développement, en attendant que les nodes soient
   * stockés en base (phase 1). Absente, la sonde de node reste inactive.
   */
  DEV_NODE_URL: z.url().optional(),
  DEV_NODE_TOKEN: z.string().optional(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')} : ${issue.message}`)
      .join('\n');

    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }

  return result.data;
}

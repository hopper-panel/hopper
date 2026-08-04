import { z } from 'zod';

/**
 * The panel's environment variables.
 *
 * Validation happens at startup, before Nest builds a single module: a missing
 * secret has to fail the launch immediately, not at a user's first sign-in.
 */
export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** The panel's public URL. Serves as JWT issuer and allowed origin. */
  APP_URL: z.url().default('http://localhost:8080'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),

  /**
   * Location of the built interface, served by the panel in production.
   *
   * The default assumes the process is launched from `apps/panel`, which is
   * what the systemd unit does. A deployment that puts the front elsewhere
   * overrides this variable rather than relying on where the compiled code
   * sits.
   */
  WEB_ROOT: z.string().min(1).default('web/dist'),

  /**
   * Signing secret for the sessions and the console tokens.
   * 32 characters minimum: below that, an HMAC-SHA256 key is shorter than its
   * own output and loses most of its strength.
   */
  APP_SECRET: z.string().min(32),

  /**
   * Connection to a development daemon, kept for local work. When absent, the
   * node probe stays inactive.
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

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

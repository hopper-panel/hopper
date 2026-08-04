import { z } from 'zod';
import { webhookEventSchema } from './events.js';

/**
 * The URL is validated here on its shape only: its destination — that is, the
 * IP addresses behind its name — is checked by `assertSafeWebhookUrl`, which
 * has to resolve DNS and therefore cannot live in a synchronous schema.
 */
const urlSchema = z.url().max(2048);

export const createWebhookSchema = z.object({
  url: urlSchema,
  description: z.string().max(200).default(''),
  /** At least one event: a silent webhook would have no observable effect. */
  events: z.array(webhookEventSchema).min(1),
});

export const updateWebhookSchema = z.object({
  url: urlSchema.optional(),
  description: z.string().max(200).optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
  active: z.boolean().optional(),
});

export type CreateWebhookDto = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookDto = z.infer<typeof updateWebhookSchema>;

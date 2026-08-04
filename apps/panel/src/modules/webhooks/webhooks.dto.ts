import { z } from 'zod';
import { webhookEventSchema } from './events.js';

/**
 * L'URL n'est validée ici que sur sa forme : sa destination — c'est-à-dire les
 * adresses IP derrière son nom — est contrôlée par `assertSafeWebhookUrl`, qui
 * doit résoudre le DNS et ne peut donc pas vivre dans un schéma synchrone.
 */
const urlSchema = z.url().max(2048);

export const createWebhookSchema = z.object({
  url: urlSchema,
  description: z.string().max(200).default(''),
  /** Au moins un événement : un webhook muet n'aurait aucun effet observable. */
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

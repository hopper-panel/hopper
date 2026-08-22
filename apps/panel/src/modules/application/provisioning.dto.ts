import { z } from 'zod';
import { planSlugSchema } from '../plans/plans.dto.js';
import { usernameSchema } from '../users/users.dto.js';

/**
 * What a billing system sends to deliver a server.
 *
 * Short on purpose. Everything absent from it — the node, the port, the
 * template, twelve resource limits — is a decision the panel is better placed
 * to make and that would otherwise have to be configured a second time, in a
 * second product, and kept in step by hand.
 */
export const provisionServerSchema = z.object({
  /** The offer, by the name the operator gave it. */
  plan: planSlugSchema,

  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),

  /**
   * Who it is for, by email.
   *
   * By email and not by uuid because a billing system knows an email — it is
   * what the customer bought with — and does not know a uuid it has never been
   * told. An account is found by it, or created and sent an invitation to
   * choose a password. Which happened is reported back, so the integration can
   * tell "existing customer" from "first purchase" without guessing.
   */
  owner: z.object({
    email: z.email(),
    /**
     * Only used if the account has to be created; ignored when it exists.
     *
     * Optional, and derived from the email when absent. An integrator who has
     * no username to offer should not be forced to invent one, and a customer
     * who already has an account must not have it renamed by a purchase.
     */
    username: usernameSchema.optional(),
  }),

  /** Template variable values. Anything absent keeps the template's default. */
  variables: z.record(z.string(), z.string().max(2000)).default({}),

  /** Start the server as soon as the installation finishes. */
  startOnCompletion: z.boolean().default(true),
});

/**
 * Moving a server onto another offer.
 *
 * Only the plan: an upgrade is a change of offer, and letting a billing system
 * send arbitrary limits alongside it would make "what is this customer paying
 * for" unanswerable from the panel.
 */
export const changePlanSchema = z.object({
  plan: planSlugSchema,
});

export type ProvisionServerDto = z.infer<typeof provisionServerSchema>;
export type ChangePlanDto = z.infer<typeof changePlanSchema>;

/**
 * Turns an email into a username nobody has.
 *
 * The local part, stripped of what `usernameSchema` refuses, truncated, and
 * suffixed if it is taken. Deliberately dull: a username invented by the panel
 * is one the customer never chose, so its only job is to be valid, stable and
 * not to collide.
 */
export function usernameFromEmail(email: string, taken: (candidate: string) => boolean): string {
  const local = email.split('@')[0] ?? 'user';
  const cleaned = local.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  // `min(3)`: `a@example.com` and `..@example.com` both have to end somewhere
  // valid.
  const base = cleaned.length >= 3 ? cleaned : `user${cleaned}`.slice(0, 24);

  if (!taken(base)) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 28)}-${suffix}`;

    if (!taken(candidate)) {
      return candidate;
    }
  }

  // A thousand accounts sharing one local part is not a collision to work
  // around, it is a caller sending the same address in a loop.
  throw new Error(`Could not derive a free username from ${email}.`);
}

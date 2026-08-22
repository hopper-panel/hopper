import { z } from 'zod';

/**
 * What an operator's own software can be told about.
 *
 * Chosen by one rule: an event is here if an integration cannot reasonably
 * observe it for itself. Everything else it can ask about, and turning the
 * whole audit log into outbound requests would give a recipient nothing but
 * volume.
 *
 * By that rule the important two are the installation ones. Provisioning
 * answers in a second with `INSTALLING`, and whether the container came up is
 * decided minutes later, long after that call returned — so without these a
 * billing system has no choice but to poll every server it has ever sold.
 *
 * The lifecycle events are here for a different reason: an operator's estate is
 * changed from two directions. A server suspended from the panel by an
 * administrator, and one suspended by the billing system, are the same event to
 * anything keeping a mirror — and only one of them is something the billing
 * system already knows.
 */
export const INSTANCE_WEBHOOK_EVENTS = {
  /** A server was created through the application API. */
  SERVER_PROVISIONED: 'server.provisioned',
  /** Its installation finished and it is usable. */
  SERVER_INSTALLED: 'server.installed',
  /** Its installation failed. The server exists and will not start. */
  SERVER_INSTALL_FAILED: 'server.install-failed',
  SERVER_SUSPENDED: 'server.suspended',
  SERVER_UNSUSPENDED: 'server.unsuspended',
  SERVER_PLAN_CHANGED: 'server.plan-changed',
  SERVER_DELETED: 'server.deleted',
} as const;

export type InstanceWebhookEvent =
  (typeof INSTANCE_WEBHOOK_EVENTS)[keyof typeof INSTANCE_WEBHOOK_EVENTS];

export const instanceWebhookEventSchema = z.enum(INSTANCE_WEBHOOK_EVENTS);

export const ALL_INSTANCE_WEBHOOK_EVENTS: readonly InstanceWebhookEvent[] =
  Object.values(INSTANCE_WEBHOOK_EVENTS);

/** Labels shown in the administration. */
export const INSTANCE_WEBHOOK_EVENT_LABELS: Record<InstanceWebhookEvent, string> = {
  [INSTANCE_WEBHOOK_EVENTS.SERVER_PROVISIONED]: 'Server sold',
  [INSTANCE_WEBHOOK_EVENTS.SERVER_INSTALLED]: 'Installation finished',
  [INSTANCE_WEBHOOK_EVENTS.SERVER_INSTALL_FAILED]: 'Installation failed',
  [INSTANCE_WEBHOOK_EVENTS.SERVER_SUSPENDED]: 'Server suspended',
  [INSTANCE_WEBHOOK_EVENTS.SERVER_UNSUSPENDED]: 'Server reinstated',
  [INSTANCE_WEBHOOK_EVENTS.SERVER_PLAN_CHANGED]: 'Plan changed',
  [INSTANCE_WEBHOOK_EVENTS.SERVER_DELETED]: 'Server deleted',
};

/** What every instance notification carries about the server it concerns. */
export interface InstanceWebhookSubject {
  uuid: string;
  name: string;
  /** Null for a server an administrator created by hand. */
  planSlug: string | null;
  ownerEmail: string;
  /** Null while a server has no port, and after it has given one back. */
  address: string | null;
  node: string;
}

/**
 * The body sent.
 *
 * Deliberately not the same shape as the per-server notifications, and no
 * Discord formatting: the reader here is a program keeping a mirror of an
 * estate, not a person watching a channel. What it needs is the identifiers it
 * can act on — the server's uuid, the plan it was sold under, the customer's
 * email — and it needs them in the same place for every event.
 */
export function buildInstancePayload(
  event: InstanceWebhookEvent,
  subject: InstanceWebhookSubject,
  occurredAt: Date,
  details?: Record<string, unknown>,
): string {
  return JSON.stringify({
    event,
    occurredAt: occurredAt.toISOString(),
    server: subject,
    details: details ?? {},
  });
}

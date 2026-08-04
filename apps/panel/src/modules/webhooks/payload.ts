import { createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_EVENT_COLORS, WEBHOOK_EVENT_LABELS, type WebhookEvent } from './events.js';

/** An event's context, as the recipient receives it. */
export interface WebhookContext {
  serverUuid: string;
  serverName: string;
  /** Connection address of the server, if it has one. */
  address: string | null;
  panelUrl: string;
  occurredAt: Date;
  /** Details specific to the event: a backup's size, the cause of a stop. */
  details?: Record<string, unknown>;
}

/**
 * True for a Discord webhook address.
 *
 * Discord does not accept arbitrary JSON: it expects `content` or `embeds`, and
 * answers 400 for anything else. Since it is by far the most common
 * destination, we speak its language rather than let the user discover the
 * failure in the delivery log.
 */
export function isDiscordUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);

    return (
      (hostname === 'discord.com' ||
        hostname === 'discordapp.com' ||
        hostname.endsWith('.discord.com')) &&
      pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

/** Generic body: stable, documented JSON, easy for a script to handle. */
export function buildGenericPayload(event: WebhookEvent, context: WebhookContext): string {
  return JSON.stringify({
    event,
    occurredAt: context.occurredAt.toISOString(),
    server: {
      uuid: context.serverUuid,
      name: context.serverName,
      address: context.address,
      url: `${context.panelUrl.replace(/\/$/, '')}/server/${context.serverUuid}`,
    },
    details: context.details ?? {},
  });
}

/** The body Discord expects: an embed coloured by severity. */
export function buildDiscordPayload(event: WebhookEvent, context: WebhookContext): string {
  const fields = Object.entries(context.details ?? {}).map(([name, value]) => ({
    name,
    value: String(value).slice(0, 1024),
    inline: true,
  }));

  if (context.address) {
    fields.unshift({ name: 'Address', value: context.address, inline: true });
  }

  return JSON.stringify({
    embeds: [
      {
        title: `${context.serverName} — ${WEBHOOK_EVENT_LABELS[event]}`,
        url: `${context.panelUrl.replace(/\/$/, '')}/server/${context.serverUuid}`,
        color: WEBHOOK_EVENT_COLORS[event],
        timestamp: context.occurredAt.toISOString(),
        // Discord refuses an embed with more than 25 fields.
        fields: fields.slice(0, 25),
        footer: { text: 'Hopper' },
      },
    ],
  });
}

export function buildPayload(
  url: string,
  event: WebhookEvent,
  context: WebhookContext,
): { body: string; discord: boolean } {
  const discord = isDiscordUrl(url);

  return {
    body: discord ? buildDiscordPayload(event, context) : buildGenericPayload(event, context),
    discord,
  };
}

/**
 * Signature of the body, for the recipient to verify.
 *
 * Without it, anyone knowing the webhook's address — it always ends up
 * circulating — could forge notifications.
 */
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Verifies a signature. Provided for recipients written against this panel, and
 * used by the tests.
 *
 * The comparison is constant-time: comparing two strings with `===` stops at
 * the first differing byte, which allows measuring the progress of a signature
 * guessed byte by byte.
 */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, body));
  const received = Buffer.from(signature);

  return expected.length === received.length && timingSafeEqual(expected, received);
}

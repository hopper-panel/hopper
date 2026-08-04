import { createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_EVENT_COLORS, WEBHOOK_EVENT_LABELS, type WebhookEvent } from './events.js';

/** Contexte d'un événement, tel que le destinataire le reçoit. */
export interface WebhookContext {
  serverUuid: string;
  serverName: string;
  /** Adresse de connexion du serveur, si elle existe. */
  address: string | null;
  panelUrl: string;
  occurredAt: Date;
  /** Détails propres à l'événement : taille d'une sauvegarde, cause d'un arrêt. */
  details?: Record<string, unknown>;
}

/**
 * Vrai pour une adresse de webhook Discord.
 *
 * Discord n'accepte pas un JSON quelconque : il attend `content` ou `embeds`,
 * et répond 400 pour tout le reste. Comme c'est la destination de très loin la
 * plus courante, on lui parle sa langue plutôt que de laisser l'utilisateur
 * découvrir l'échec dans le journal des tentatives.
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

/** Corps générique : un JSON stable, documenté, facile à traiter par un script. */
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

/** Corps attendu par Discord : un embed coloré selon la gravité. */
export function buildDiscordPayload(event: WebhookEvent, context: WebhookContext): string {
  const fields = Object.entries(context.details ?? {}).map(([name, value]) => ({
    name,
    value: String(value).slice(0, 1024),
    inline: true,
  }));

  if (context.address) {
    fields.unshift({ name: 'Adresse', value: context.address, inline: true });
  }

  return JSON.stringify({
    embeds: [
      {
        title: `${context.serverName} — ${WEBHOOK_EVENT_LABELS[event]}`,
        url: `${context.panelUrl.replace(/\/$/, '')}/server/${context.serverUuid}`,
        color: WEBHOOK_EVENT_COLORS[event],
        timestamp: context.occurredAt.toISOString(),
        // Discord refuse un embed de plus de 25 champs.
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
 * Signature du corps, à vérifier par le destinataire.
 *
 * Sans elle, n'importe qui connaissant l'adresse du webhook — elle finit
 * toujours par circuler — pourrait fabriquer de fausses notifications.
 */
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Vérifie une signature. Fournie pour les destinataires écrits contre ce panel,
 * et utilisée par les tests.
 *
 * La comparaison est à temps constant : comparer deux chaînes avec `===`
 * s'arrête au premier octet différent, ce qui laisse mesurer la progression
 * d'une signature devinée octet par octet.
 */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, body));
  const received = Buffer.from(signature);

  return expected.length === received.length && timingSafeEqual(expected, received);
}

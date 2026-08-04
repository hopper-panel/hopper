import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Webhook } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Environment } from '../../config/environment.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PANEL_VERSION } from '../../version.js';
import { ALL_WEBHOOK_EVENTS, type WebhookEvent } from './events.js';
import { buildPayload, signPayload, type WebhookContext } from './payload.js';
import { UnsafeWebhookUrlError, assertSafeWebhookUrl } from './url-guard.js';
import type { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto.js';

/** Au-delà, l'adresse est tenue pour morte et la notification se met en pause. */
const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * Un destinataire qui ne répond pas ne doit pas retenir le panel : la requête
 * qui a déclenché l'événement — un démarrage de serveur — est déjà terminée,
 * mais le processus, lui, garde la connexion ouverte.
 */
const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Notifications sortantes.
 *
 * Le panel appelle une adresse choisie par l'utilisateur : c'est une capacité
 * de requête sortante donnée à un compte non administrateur, donc un vecteur de
 * SSRF. Toute création et **tout envoi** passent par `assertSafeWebhookUrl`.
 *
 * L'envoi n'est jamais attendu par l'appelant : un webhook lent ne doit pas
 * ralentir un démarrage de serveur, et son échec ne doit rien faire échouer.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  // -------------------------------------------------------------------------
  // Gestion
  // -------------------------------------------------------------------------

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const webhooks = await this.prisma.webhook.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      data: webhooks.map((webhook) => this.toPublic(webhook)),
      meta: { events: ALL_WEBHOOK_EVENTS },
    };
  }

  async create(serverUuid: string, dto: CreateWebhookDto) {
    const server = await this.requireServer(serverUuid);
    await this.assertReachableDestination(dto.url);

    const webhook = await this.prisma.webhook.create({
      data: {
        serverId: server.id,
        url: dto.url,
        description: dto.description,
        events: dto.events,
        // Le secret est chiffré et non haché : le destinataire doit pouvoir le
        // relire pour vérifier nos signatures, donc nous aussi pour signer.
        secretEncrypted: this.crypto.encrypt(randomBytes(32).toString('base64url')),
      },
    });

    return this.toPublic(webhook);
  }

  async update(serverUuid: string, uuid: string, dto: UpdateWebhookDto) {
    const webhook = await this.requireWebhook(serverUuid, uuid);

    if (dto.url !== undefined && dto.url !== webhook.url) {
      await this.assertReachableDestination(dto.url);
    }

    const updated = await this.prisma.webhook.update({
      where: { id: webhook.id },
      data: {
        url: dto.url,
        description: dto.description,
        events: dto.events,
        active: dto.active,
        // Réactiver remet le compteur à zéro : sans cela, une notification
        // mise en pause après vingt échecs se redésactiverait au premier
        // suivant, même si la panne est réparée.
        ...(dto.active === true ? { failureCount: 0, lastError: null } : {}),
      },
    });

    return this.toPublic(updated);
  }

  async remove(serverUuid: string, uuid: string): Promise<void> {
    const webhook = await this.requireWebhook(serverUuid, uuid);
    await this.prisma.webhook.delete({ where: { id: webhook.id } });
  }

  /** Envoi de démonstration, déclenché depuis l'interface. */
  async test(serverUuid: string, uuid: string) {
    const webhook = await this.requireWebhook(serverUuid, uuid);
    const server = await this.requireServer(serverUuid);

    const context = await this.contextFor(server.id, {
      raison: 'Envoi de vérification demandé depuis le panel',
    });

    if (!context) {
      throw new NotFoundException('Serveur introuvable.');
    }

    const result = await this.deliver(webhook, 'server.started', context);

    return {
      delivered: result.ok,
      status: result.status,
      error: result.error,
    };
  }

  /** Le secret, montré une fois à la demande pour configurer le destinataire. */
  async revealSecret(serverUuid: string, uuid: string): Promise<{ secret: string }> {
    const webhook = await this.requireWebhook(serverUuid, uuid);

    return { secret: this.crypto.decrypt(webhook.secretEncrypted) };
  }

  // -------------------------------------------------------------------------
  // Diffusion
  // -------------------------------------------------------------------------

  /**
   * Prévient les destinataires abonnés à cet événement.
   *
   * Ne lève jamais et n'est pas attendue : l'appelant a fait son travail, une
   * notification est un effet de bord.
   */
  dispatch(serverId: number, event: WebhookEvent, details?: Record<string, unknown>): void {
    void this.dispatchNow(serverId, event, details).catch((error: unknown) => {
      this.logger.error(`Diffusion de ${event} impossible : ${String(error)}`);
    });
  }

  private async dispatchNow(
    serverId: number,
    event: WebhookEvent,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const webhooks = await this.prisma.webhook.findMany({
      where: { serverId, active: true, events: { has: event } },
    });

    if (webhooks.length === 0) {
      return;
    }

    const context = await this.contextFor(serverId, details);

    if (!context) {
      return;
    }

    // En parallèle : un destinataire lent ne doit pas retarder les autres.
    await Promise.all(webhooks.map((webhook) => this.deliver(webhook, event, context)));
  }

  private async contextFor(
    serverId: number,
    details?: Record<string, unknown>,
  ): Promise<WebhookContext | null> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      select: {
        uuid: true,
        name: true,
        node: { select: { fqdn: true } },
        primaryAllocation: { select: { ip: true, port: true, alias: true } },
      },
    });

    if (!server) {
      return null;
    }

    const allocation = server.primaryAllocation;
    const wildcard = allocation?.ip === '0.0.0.0' || allocation?.ip === '::';

    return {
      serverUuid: server.uuid,
      serverName: server.name,
      address: allocation
        ? `${allocation.alias ?? (wildcard ? server.node.fqdn : allocation.ip)}:${allocation.port}`
        : null,
      panelUrl: this.config.get('APP_URL', { infer: true }),
      occurredAt: new Date(),
      details,
    };
  }

  private async deliver(
    webhook: Webhook,
    event: WebhookEvent,
    context: WebhookContext,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const { body } = buildPayload(webhook.url, event, context);

    let outcome: { ok: boolean; status: number | null; error: string | null };

    try {
      // Revalidée à chaque envoi : entre la création et maintenant, le nom a pu
      // se mettre à pointer vers le réseau interne.
      await assertSafeWebhookUrl(webhook.url);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `Hopper/${PANEL_VERSION}`,
          'x-hopper-event': event,
          'x-hopper-signature': signPayload(this.crypto.decrypt(webhook.secretEncrypted), body),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      outcome = {
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : `Le destinataire a répondu ${response.status}.`,
      };
    } catch (error: unknown) {
      outcome = {
        ok: false,
        status: null,
        error:
          error instanceof UnsafeWebhookUrlError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Envoi impossible.',
      };
    }

    await this.recordAttempt(webhook, outcome);

    return outcome;
  }

  private async recordAttempt(
    webhook: Webhook,
    outcome: { ok: boolean; status: number | null; error: string | null },
  ): Promise<void> {
    const failureCount = outcome.ok ? 0 : webhook.failureCount + 1;

    await this.prisma.webhook
      .update({
        where: { id: webhook.id },
        data: {
          lastStatus: outcome.status,
          lastError: outcome.error?.slice(0, 500) ?? null,
          lastAttemptAt: new Date(),
          lastSuccessAt: outcome.ok ? new Date() : undefined,
          failureCount,
          // Une adresse morte finit par être mise en pause : sans cela, chaque
          // événement paierait cinq secondes de délai d'attente, indéfiniment.
          active: failureCount >= MAX_CONSECUTIVE_FAILURES ? false : undefined,
        },
      })
      .catch(() => {
        // La notification a pu être supprimée pendant l'envoi : l'échec de
        // l'écriture ne doit pas remonter jusqu'au serveur qui démarre.
      });
  }

  // -------------------------------------------------------------------------

  private async assertReachableDestination(url: string): Promise<void> {
    try {
      await assertSafeWebhookUrl(url);
    } catch (error: unknown) {
      throw new BadRequestException(
        error instanceof UnsafeWebhookUrlError ? error.message : 'Adresse refusée.',
      );
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }

  private async requireWebhook(serverUuid: string, uuid: string): Promise<Webhook> {
    const webhook = await this.prisma.webhook.findUnique({
      where: { uuid },
      include: { server: { select: { uuid: true } } },
    });

    // Le serveur est vérifié en plus de l'identifiant : sans cela, un
    // utilisateur légitime sur *son* serveur pourrait manipuler la notification
    // d'un autre en connaissant son UUID.
    if (!webhook || webhook.server.uuid !== serverUuid) {
      throw new NotFoundException('Notification introuvable.');
    }

    return webhook;
  }

  private toPublic(webhook: Webhook) {
    return {
      uuid: webhook.uuid,
      url: webhook.url,
      description: webhook.description,
      events: webhook.events,
      active: webhook.active,
      lastStatus: webhook.lastStatus,
      lastError: webhook.lastError,
      lastAttemptAt: webhook.lastAttemptAt,
      lastSuccessAt: webhook.lastSuccessAt,
      failureCount: webhook.failureCount,
      createdAt: webhook.createdAt,
    };
  }
}

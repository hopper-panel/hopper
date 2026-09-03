import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Webhook } from '../../prisma/client.js';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Environment } from '../../config/environment.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ALL_WEBHOOK_EVENTS, type WebhookEvent } from './events.js';
import { buildPayload, type WebhookContext } from './payload.js';
import { postSigned } from './transport.js';
import { UnsafeWebhookUrlError, assertSafeWebhookUrl } from './url-guard.js';
import type { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto.js';

/** Past this, the address is taken for dead and the notification pauses. */
const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * Outgoing notifications.
 *
 * The panel calls an address chosen by the user: that is an outbound-request
 * capability handed to a non-administrator account, so an SSRF vector. Every
 * creation and **every send** goes through `assertSafeWebhookUrl`.
 *
 * The send is never awaited by the caller: a slow webhook must not slow a
 * server start, and its failure must make nothing else fail.
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
  // Management
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
        // The secret is encrypted, not hashed: the recipient has to read it
        // back to check our signatures, so we do too in order to sign.
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
        // Re-enabling resets the counter: without that, a notification paused
        // after twenty failures would pause again on the very next one, even
        // with the outage fixed.
        ...(dto.active === true ? { failureCount: 0, lastError: null } : {}),
      },
    });

    return this.toPublic(updated);
  }

  async remove(serverUuid: string, uuid: string): Promise<void> {
    const webhook = await this.requireWebhook(serverUuid, uuid);
    await this.prisma.webhook.delete({ where: { id: webhook.id } });
  }

  /** Demonstration send, triggered from the interface. */
  async test(serverUuid: string, uuid: string) {
    const webhook = await this.requireWebhook(serverUuid, uuid);
    const server = await this.requireServer(serverUuid);

    const context = await this.contextFor(server.id, {
      reason: 'Verification send requested from the panel',
    });

    if (!context) {
      throw new NotFoundException('Server not found.');
    }

    const result = await this.deliver(webhook, 'server.started', context);

    return {
      delivered: result.ok,
      status: result.status,
      error: result.error,
    };
  }

  /** The secret, shown once on request to configure the recipient. */
  async revealSecret(serverUuid: string, uuid: string): Promise<{ secret: string }> {
    const webhook = await this.requireWebhook(serverUuid, uuid);

    return { secret: this.crypto.decrypt(webhook.secretEncrypted) };
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Notifies the recipients subscribed to this event.
   *
   * Never throws and is not awaited: the caller has done its work, a
   * notification is a side effect.
   */
  dispatch(serverId: number, event: WebhookEvent, details?: Record<string, unknown>): void {
    void this.dispatchNow(serverId, event, details).catch((error: unknown) => {
      this.logger.error(`Could not dispatch ${event}: ${String(error)}`);
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

    // In parallel: a slow recipient must not delay the others.
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

    const outcome = await postSigned({
      url: webhook.url,
      secret: this.crypto.decrypt(webhook.secretEncrypted),
      event,
      body,
    });

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
          // A dead address eventually gets paused: without that, every event
          // would pay five seconds of timeout, forever.
          active: failureCount >= MAX_CONSECUTIVE_FAILURES ? false : undefined,
        },
      })
      .catch(() => {
        // The notification may have been deleted mid-send: the write failing
        // must not travel back up to the server that is starting.
      });
  }

  // -------------------------------------------------------------------------

  private async assertReachableDestination(url: string): Promise<void> {
    try {
      await assertSafeWebhookUrl(url);
    } catch (error: unknown) {
      throw new BadRequestException(
        error instanceof UnsafeWebhookUrlError ? error.message : 'Address refused.',
      );
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return server;
  }

  private async requireWebhook(serverUuid: string, uuid: string): Promise<Webhook> {
    const webhook = await this.prisma.webhook.findUnique({
      where: { uuid },
      include: { server: { select: { uuid: true } } },
    });

    // The server is checked on top of the identifier: without that, a
    // legitimate user on *their* server could manipulate another's notification
    // by knowing its UUID.
    if (!webhook || webhook.server.uuid !== serverUuid) {
      throw new NotFoundException('Notification not found.');
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

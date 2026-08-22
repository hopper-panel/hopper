import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { InstanceWebhook } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ALL_INSTANCE_WEBHOOK_EVENTS,
  buildInstancePayload,
  type InstanceWebhookEvent,
  type InstanceWebhookSubject,
} from './instance-events.js';
import { postSigned } from './transport.js';
import { UnsafeWebhookUrlError, assertSafeWebhookUrl } from './url-guard.js';

/** Past this, the address is taken for dead and the recipient pauses. */
const MAX_CONSECUTIVE_FAILURES = 20;

export interface CreateInstanceWebhookDto {
  name: string;
  url: string;
  events: InstanceWebhookEvent[];
}

export interface UpdateInstanceWebhookDto {
  name?: string;
  url?: string;
  events?: InstanceWebhookEvent[];
  active?: boolean;
}

/**
 * Notifications about the instance, for the operator's own software.
 *
 * The same three safety properties as the per-server ones, through the same
 * transport: the address is revalidated at send time, the body is signed, and
 * the call cannot hang. What differs is who they are for — a program keeping a
 * mirror of an estate, not a person watching a channel — and therefore the
 * payload, which is flat, identical across events, and never Discord.
 *
 * Sends are never awaited by the caller. A recipient that has stopped answering
 * must not add five seconds to a customer's purchase, and its failure must not
 * fail the sale that triggered it.
 */
@Injectable()
export class InstanceWebhooksService {
  private readonly logger = new Logger(InstanceWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async list() {
    const webhooks = await this.prisma.instanceWebhook.findMany({ orderBy: { createdAt: 'desc' } });

    return {
      data: webhooks.map((webhook) => this.toPublic(webhook)),
      meta: { events: ALL_INSTANCE_WEBHOOK_EVENTS },
    };
  }

  async create(dto: CreateInstanceWebhookDto) {
    await this.assertReachableDestination(dto.url);

    const webhook = await this.prisma.instanceWebhook.create({
      data: {
        name: dto.name,
        url: dto.url,
        events: dto.events,
        // Encrypted, not hashed: the recipient reads it back to check our
        // signatures, so the panel has to read it back to sign.
        secretEncrypted: this.crypto.encrypt(randomBytes(32).toString('base64url')),
      },
    });

    return this.toPublic(webhook);
  }

  async update(uuid: string, dto: UpdateInstanceWebhookDto) {
    const webhook = await this.require(uuid);

    if (dto.url !== undefined && dto.url !== webhook.url) {
      await this.assertReachableDestination(dto.url);
    }

    const updated = await this.prisma.instanceWebhook.update({
      where: { id: webhook.id },
      data: {
        name: dto.name,
        url: dto.url,
        events: dto.events,
        active: dto.active,
        // Re-enabling resets the counter: without it a recipient paused after
        // twenty failures would pause again on the very next one, outage fixed
        // or not.
        ...(dto.active === true ? { failureCount: 0, lastError: null } : {}),
      },
    });

    return this.toPublic(updated);
  }

  async remove(uuid: string): Promise<void> {
    const webhook = await this.require(uuid);
    await this.prisma.instanceWebhook.delete({ where: { id: webhook.id } });
  }

  /** The signing key, shown on request so the recipient can be configured. */
  async revealSecret(uuid: string): Promise<{ secret: string }> {
    const webhook = await this.require(uuid);

    return { secret: this.crypto.decrypt(webhook.secretEncrypted) };
  }

  /** Demonstration send, so a recipient can be verified before it matters. */
  async test(uuid: string) {
    const webhook = await this.require(uuid);

    const outcome = await this.deliver(
      webhook,
      'server.provisioned',
      {
        uuid: '00000000-0000-4000-8000-000000000000',
        name: 'Verification',
        planSlug: null,
        ownerEmail: 'nobody@example.invalid',
        address: null,
        node: 'none',
      },
      { reason: 'Verification send requested from the panel' },
    );

    return { delivered: outcome.ok, status: outcome.status, error: outcome.error };
  }

  // -------------------------------------------------------------------------

  /**
   * Notifies every subscriber to this event.
   *
   * Never throws and is not awaited. The caller has done its work — a server
   * was sold, suspended, deleted — and a notification is a side effect of that,
   * not a step in it.
   */
  dispatch(
    event: InstanceWebhookEvent,
    subject: InstanceWebhookSubject,
    details?: Record<string, unknown>,
  ): void {
    void this.dispatchNow(event, subject, details).catch((error: unknown) => {
      this.logger.error(`Could not dispatch ${event}: ${String(error)}`);
    });
  }

  /**
   * Resolves a server and notifies, by uuid.
   *
   * Provided because most callers hold a uuid and nothing else, and because the
   * shape a recipient wants — the plan's name, the owner's email, the address —
   * is a join none of them should have to write.
   */
  dispatchForServer(
    event: InstanceWebhookEvent,
    serverUuid: string,
    details?: Record<string, unknown>,
  ): void {
    void this.subjectFor(serverUuid)
      .then((subject) => {
        if (subject) {
          this.dispatch(event, subject, details);
        }
      })
      .catch((error: unknown) => {
        this.logger.error(`Could not describe ${serverUuid} for ${event}: ${String(error)}`);
      });
  }

  /**
   * Describes a server for a notification.
   *
   * Public because a deletion has to call it **before** the server is gone: by
   * the time the event is worth sending there is nothing left to read.
   */
  async subjectFor(serverUuid: string): Promise<InstanceWebhookSubject | null> {
    const server = await this.prisma.server.findUnique({
      where: { uuid: serverUuid },
      select: {
        uuid: true,
        name: true,
        owner: { select: { email: true } },
        node: { select: { name: true } },
        plan: { select: { slug: true } },
        primaryAllocation: { select: { ip: true, port: true, alias: true } },
      },
    });

    if (!server) {
      return null;
    }

    return {
      uuid: server.uuid,
      name: server.name,
      planSlug: server.plan?.slug ?? null,
      ownerEmail: server.owner.email,
      address:
        server.primaryAllocation === null
          ? null
          : `${server.primaryAllocation.alias ?? server.primaryAllocation.ip}:${server.primaryAllocation.port}`,
      node: server.node.name,
    };
  }

  private async dispatchNow(
    event: InstanceWebhookEvent,
    subject: InstanceWebhookSubject,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const webhooks = await this.prisma.instanceWebhook.findMany({
      where: { active: true, events: { has: event } },
    });

    if (webhooks.length === 0) {
      return;
    }

    await Promise.all(webhooks.map((webhook) => this.deliver(webhook, event, subject, details)));
  }

  private async deliver(
    webhook: InstanceWebhook,
    event: InstanceWebhookEvent,
    subject: InstanceWebhookSubject,
    details?: Record<string, unknown>,
  ) {
    const body = buildInstancePayload(event, subject, new Date(), details);

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
    webhook: InstanceWebhook,
    outcome: { ok: boolean; status: number | null; error: string | null },
  ): Promise<void> {
    const failureCount = outcome.ok ? 0 : webhook.failureCount + 1;

    await this.prisma.instanceWebhook
      .update({
        where: { id: webhook.id },
        data: {
          lastStatus: outcome.status,
          lastError: outcome.error,
          lastAttemptAt: new Date(),
          lastSuccessAt: outcome.ok ? new Date() : undefined,
          failureCount,
          // A dead address costs five seconds of timeout on every sale. Past
          // the threshold it stops costing anything until somebody looks.
          active: failureCount >= MAX_CONSECUTIVE_FAILURES ? false : undefined,
        },
      })
      .catch(() => {
        // The recipient may have been deleted mid-send. A failure to record
        // must not travel back up to the sale that triggered it.
      });
  }

  private async require(uuid: string): Promise<InstanceWebhook> {
    const webhook = await this.prisma.instanceWebhook.findUnique({ where: { uuid } });

    if (!webhook) {
      throw new NotFoundException('Notification not found.');
    }

    return webhook;
  }

  private async assertReachableDestination(url: string): Promise<void> {
    try {
      await assertSafeWebhookUrl(url);
    } catch (error: unknown) {
      throw new BadRequestException(
        error instanceof UnsafeWebhookUrlError ? error.message : 'Address refused.',
      );
    }
  }

  private toPublic(webhook: InstanceWebhook) {
    return {
      uuid: webhook.uuid,
      name: webhook.name,
      url: webhook.url,
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

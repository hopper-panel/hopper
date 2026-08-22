import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import { instanceWebhookEventSchema } from './instance-events.js';
import { InstanceWebhooksService } from './instance-webhooks.service.js';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.url().max(2000),
  events: z.array(instanceWebhookEventSchema).default([]),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.url().max(2000).optional(),
  events: z.array(instanceWebhookEventSchema).optional(),
  active: z.boolean().optional(),
});

type CreateDto = z.infer<typeof createSchema>;
type UpdateDto = z.infer<typeof updateSchema>;

/**
 * Instance-wide notifications, from the administration.
 *
 * Administered here and not through the application API, for the same reason a
 * plan is: pointing the panel at an address is an instance-wide decision, and a
 * credential able to add one could redirect the estate's events to somewhere
 * the operator never chose.
 */
@Controller('api/admin/instance-webhooks')
@AdminOnly()
export class InstanceWebhooksController {
  constructor(
    private readonly webhooks: InstanceWebhooksService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.webhooks.list();
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createSchema)) body: CreateDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const webhook = await this.webhooks.create(body);

    await this.audit.record({
      event: AUDIT_EVENTS.WEBHOOK_CREATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // `scope` tells this apart from a webhook on one server, which shares the
      // event name. Without it the trail says "created a webhook" for two very
      // different reaches.
      metadata: { scope: 'instance', uuid: webhook.uuid, name: webhook.name, url: webhook.url },
    });

    return webhook;
  }

  @Patch(':uuid')
  async update(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const webhook = await this.webhooks.update(uuid, body);

    await this.audit.record({
      event: AUDIT_EVENTS.WEBHOOK_UPDATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { scope: 'instance', uuid, fields: Object.keys(body) },
    });

    return webhook;
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('uuid') uuid: string,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.webhooks.remove(uuid);

    await this.audit.record({
      event: AUDIT_EVENTS.WEBHOOK_DELETED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { scope: 'instance', uuid },
    });
  }

  /** The signing key, so the recipient can be configured to check signatures. */
  @Get(':uuid/secret')
  secret(@Param('uuid') uuid: string) {
    return this.webhooks.revealSecret(uuid);
  }

  /** A send that costs nothing, so a recipient is verified before it matters. */
  @Post(':uuid/test')
  @HttpCode(HttpStatus.OK)
  test(@Param('uuid') uuid: string) {
    return this.webhooks.test(uuid);
  }
}

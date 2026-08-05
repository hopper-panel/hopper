import { PERMISSIONS } from '@hopper/shared';
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
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type AuthenticatedRequest,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import {
  createWebhookSchema,
  updateWebhookSchema,
  type CreateWebhookDto,
  type UpdateWebhookDto,
} from './webhooks.dto.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * A server's outgoing notifications.
 *
 * Creating a notification orders the panel to issue a request to an arbitrary
 * address: the action is logged with its URL, and the matching permission
 * should be granted in full knowledge of that.
 */
@Controller('api/servers/:serverId/webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.WEBHOOK_READ)
  list(@Param('serverId') serverId: string) {
    return this.webhooks.list(serverId);
  }

  @Post()
  @RequireServerPermission(PERMISSIONS.WEBHOOK_CREATE)
  async create(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const created = await this.webhooks.create(serverId, body);

    await this.audit.record({
      event: AUDIT_EVENTS.WEBHOOK_CREATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { webhookUuid: created.uuid, url: created.url, events: created.events },
    });

    return created;
  }

  @Patch(':uuid')
  @RequireServerPermission(PERMISSIONS.WEBHOOK_UPDATE)
  async update(
    @Param('serverId') serverId: string,
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateWebhookSchema)) body: UpdateWebhookDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const updated = await this.webhooks.update(serverId, uuid, body);

    await this.audit.record({
      event: AUDIT_EVENTS.WEBHOOK_UPDATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { webhookUuid: uuid, url: updated.url, active: updated.active },
    });

    return updated;
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireServerPermission(PERMISSIONS.WEBHOOK_DELETE)
  async remove(
    @Param('serverId') serverId: string,
    @Param('uuid') uuid: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.webhooks.remove(serverId, uuid);

    await this.audit.record({
      event: AUDIT_EVENTS.WEBHOOK_DELETED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { webhookUuid: uuid },
    });
  }

  /**
   * Verification send.
   *
   * Requires the **update** permission and not the read one: this is a real
   * send to the registered address, not a look at it.
   */
  @Post(':uuid/test')
  @RequireServerPermission(PERMISSIONS.WEBHOOK_UPDATE)
  test(@Param('serverId') serverId: string, @Param('uuid') uuid: string) {
    return this.webhooks.test(serverId, uuid);
  }

  /** The signing secret, to be copied over to the recipient. */
  @Get(':uuid/secret')
  @RequireServerPermission(PERMISSIONS.WEBHOOK_UPDATE)
  secret(@Param('serverId') serverId: string, @Param('uuid') uuid: string) {
    return this.webhooks.revealSecret(serverId, uuid);
  }
}

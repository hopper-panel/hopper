import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import { applicationKeyScopeSchema } from './application-key.js';
import { ApplicationKeysService } from './application-keys.service.js';

const createApplicationKeySchema = z.object({
  /**
   * The name of the integration, not a memo. It appears in the key list, in
   * the audit trail and in the log line written when a key is presented from
   * an address outside its list — so "Paymenter" reads usefully in all three
   * and "test" in none.
   */
  name: z.string().min(1).max(100),
  scopes: z.array(applicationKeyScopeSchema).min(1),
  /**
   * Restriction by source address. Compared as is, without ranges — the same
   * choice as the personal keys, for the same reason: a panel usually sits
   * behind a proxy, and matching CIDR here would suggest a network filter that
   * is not one.
   *
   * Worth filling in for these keys in a way it rarely is for a personal one:
   * a billing server has a fixed address, so the restriction costs nothing and
   * makes a leaked key useless from anywhere else.
   */
  allowedIps: z.array(z.string().min(1).max(45)).max(20).default([]),
  expiresAt: z.iso.datetime().optional(),
});

type CreateApplicationKeyDto = z.infer<typeof createApplicationKeySchema>;

/**
 * Application keys, from the administration.
 *
 * Under `/api/admin` and not `/api/account`: unlike a personal key, this one
 * belongs to the instance rather than to whoever happens to create it, and
 * handing one out is an instance-wide decision.
 *
 * The routes are ordinary administration routes — a session or a personal key
 * with the `admin` scope reaches them. An application key does **not** reach
 * them, and deliberately: a credential that could mint another credential of
 * its own kind turns one leak into a permanent foothold.
 */
@Controller('api/admin/application-keys')
@AdminOnly()
export class ApplicationKeysController {
  constructor(
    private readonly keys: ApplicationKeysService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.keys.list();
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createApplicationKeySchema)) body: CreateApplicationKeyDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const created = await this.keys.create(body, user.id);

    await this.audit.record({
      event: AUDIT_EVENTS.APPLICATION_KEY_CREATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // The token appears nowhere but in the response to this request. The
      // uuid and the name are what identify the key afterwards.
      metadata: { uuid: created.uuid, name: created.name, scopes: created.scopes },
    });

    return created;
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('uuid') uuid: string,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.keys.revoke(uuid);

    await this.audit.record({
      event: AUDIT_EVENTS.APPLICATION_KEY_REVOKED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { uuid },
    });
  }
}

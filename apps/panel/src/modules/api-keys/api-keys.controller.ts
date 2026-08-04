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
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import { apiKeyScopeSchema } from './api-key.js';
import { ApiKeysService } from './api-keys.service.js';

const createApiKeySchema = z.object({
  /** What this key is for — the only way to know which one to revoke. */
  memo: z.string().min(1).max(200),
  scopes: z.array(apiKeyScopeSchema).min(1),
  /**
   * Restriction by source address. Each entry is compared as is to the
   * request's address: no ranges, which would give the illusion of network
   * filtering when the panel often sits behind a proxy.
   */
  allowedIps: z.array(z.string().min(1).max(45)).max(20).default([]),
  expiresAt: z.iso.datetime().optional(),
});

type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

/**
 * Personal API keys.
 *
 * Under `/api/account` and not `/api/admin`: a key belongs to an account and
 * never grants more than that account already holds.
 */
@Controller('api/account/api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.keys.list(user.id);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const created = await this.keys.create(user.id, user.role, body);

    await this.audit.record({
      event: AUDIT_EVENTS.API_KEY_CREATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // The identifier is public; the token must appear nowhere other than in
      // the response to this request.
      metadata: { identifier: created.identifier, scopes: created.scopes, memo: created.memo },
    });

    return created;
  }

  @Delete(':identifier')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('identifier') identifier: string,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.keys.remove(user.id, identifier);

    await this.audit.record({
      event: AUDIT_EVENTS.API_KEY_DELETED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { identifier },
    });
  }
}

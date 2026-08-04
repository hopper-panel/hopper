import { PERMISSIONS } from '@hopper/shared';
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
import { createDatabaseSchema, type CreateDatabaseDto } from './databases.dto.js';
import { DatabasesService } from './databases.service.js';

/**
 * A server's databases.
 *
 * Reading exposes the password: that is its very purpose, the user has to be
 * able to write it into their plugin's configuration. The read permission
 * therefore amounts to full access to the databases' contents, and that is how
 * it has to be understood when granting it — hence its place among the
 * sensitive permissions.
 */
@Controller('api/servers/:serverId/databases')
export class DatabasesController {
  constructor(
    private readonly databases: DatabasesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.DATABASE_READ)
  list(@Param('serverId') serverId: string) {
    return this.databases.list(serverId);
  }

  @Post()
  @RequireServerPermission(PERMISSIONS.DATABASE_CREATE)
  async create(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(createDatabaseSchema)) body: CreateDatabaseDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const created = await this.databases.create(serverId, body);

    await this.audit.record({
      event: AUDIT_EVENTS.DATABASE_CREATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // Neither the password nor the connection string: the audit log is
      // readable by administrators and kept for a long time.
      metadata: { database: created.name, remote: created.remote },
    });

    return created;
  }

  @Post(':databaseId/rotate')
  @RequireServerPermission(PERMISSIONS.DATABASE_UPDATE)
  async rotate(
    @Param('serverId') serverId: string,
    @Param('databaseId') databaseId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const updated = await this.databases.rotatePassword(serverId, databaseId);

    await this.audit.record({
      event: AUDIT_EVENTS.DATABASE_UPDATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { database: updated.name, action: 'rotate-password' },
    });

    return updated;
  }

  @Delete(':databaseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireServerPermission(PERMISSIONS.DATABASE_DELETE)
  async remove(
    @Param('serverId') serverId: string,
    @Param('databaseId') databaseId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.databases.remove(serverId, databaseId);

    await this.audit.record({
      event: AUDIT_EVENTS.DATABASE_DELETED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { database: databaseId },
    });
  }
}

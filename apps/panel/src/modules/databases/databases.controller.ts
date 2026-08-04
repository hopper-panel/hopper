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
 * Bases de données d'un serveur.
 *
 * La lecture expose le mot de passe : c'est son objet même, l'utilisateur doit
 * pouvoir l'écrire dans la configuration de son plugin. La permission de
 * lecture vaut donc accès complet au contenu des bases, et c'est ainsi qu'elle
 * doit être comprise au moment de l'accorder — d'où son classement parmi les
 * permissions sensibles.
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
      // Ni le mot de passe, ni la chaîne de connexion : le journal d'audit est
      // lisible par les administrateurs et conservé longtemps.
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

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
  createSubuserSchema,
  updateSubuserSchema,
  type CreateSubuserDto,
  type UpdateSubuserDto,
} from './subusers.dto.js';
import { SubusersService } from './subusers.service.js';

/**
 * Sous-utilisateurs d'un serveur.
 *
 * L'attribuant est transmis au service : c'est lui qui borne ce qui peut être
 * accordé. Un sous-utilisateur autorisé à gérer les autres ne doit pas pouvoir
 * leur donner plus de droits qu'il n'en a — ce serait une élévation de
 * privilèges déguisée en délégation.
 */
@Controller('api/servers/:serverId/subusers')
export class SubusersController {
  constructor(
    private readonly subusers: SubusersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.USER_READ)
  list(@Param('serverId') serverId: string) {
    return this.subusers.list(serverId);
  }

  @Post()
  @RequireServerPermission(PERMISSIONS.USER_CREATE)
  async create(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(createSubuserSchema)) body: CreateSubuserDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const subuser = await this.subusers.create(serverId, body, {
      permissions: server.permissions,
      isOwner: server.isOwner,
    });

    await this.audit.record({
      event: AUDIT_EVENTS.SUBUSER_CREATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { subuser: subuser.uuid, permissions: subuser.permissions },
    });

    return subuser;
  }

  @Patch(':subuserId')
  @RequireServerPermission(PERMISSIONS.USER_UPDATE)
  async update(
    @Param('serverId') serverId: string,
    @Param('subuserId') subuserId: string,
    @Body(new ZodValidationPipe(updateSubuserSchema)) body: UpdateSubuserDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const subuser = await this.subusers.update(serverId, subuserId, body.permissions, {
      permissions: server.permissions,
      isOwner: server.isOwner,
    });

    await this.audit.record({
      event: AUDIT_EVENTS.SUBUSER_UPDATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { subuser: subuserId, permissions: subuser.permissions },
    });

    return subuser;
  }

  @Delete(':subuserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireServerPermission(PERMISSIONS.USER_DELETE)
  async remove(
    @Param('serverId') serverId: string,
    @Param('subuserId') subuserId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.subusers.remove(serverId, subuserId);

    await this.audit.record({
      event: AUDIT_EVENTS.SUBUSER_DELETED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { subuser: subuserId },
    });
  }
}

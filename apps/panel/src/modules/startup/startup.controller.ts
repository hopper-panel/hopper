import { PERMISSIONS } from '@hopper/shared';
import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
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
import { updateStartupSchema, type UpdateStartupDto } from './startup.dto.js';
import { StartupService } from './startup.service.js';

/**
 * Paramètres de démarrage d'un serveur.
 *
 * `startup.update` couvre les variables ; changer l'image Docker demande en
 * plus `startup.docker-image`. Les séparer n'est pas de la bureaucratie :
 * ajuster la version de Minecraft et choisir la version de Java qui l'exécute
 * ne sont pas la même responsabilité, et la seconde peut rendre un serveur
 * impossible à démarrer.
 */
@Controller('api/servers/:serverId/startup')
export class StartupController {
  constructor(
    private readonly startup: StartupService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.STARTUP_READ)
  get(@Param('serverId') serverId: string) {
    return this.startup.get(serverId);
  }

  @Patch()
  @RequireServerPermission(PERMISSIONS.STARTUP_UPDATE)
  async update(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(updateStartupSchema)) body: UpdateStartupDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.startup.update(serverId, body, {
      canChangeImage:
        server.isOwner || server.permissions.includes(PERMISSIONS.STARTUP_DOCKER_IMAGE),
    });

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {
        action: 'startup',
        variables: Object.keys(body.variables ?? {}),
        dockerImage: body.dockerImage ?? null,
      },
    });

    return result;
  }
}

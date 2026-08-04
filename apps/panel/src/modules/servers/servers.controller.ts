import { PERMISSIONS } from '@hopper/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  paginationQuerySchema,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { RequestContext } from '../auth/auth.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type AuthenticatedRequest,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import {
  powerActionSchema,
  updateServerSchema,
  type PowerActionDto,
  type UpdateServerDto,
} from './servers.dto.js';
import { ServersService, type ServerListItem } from './servers.service.js';

/**
 * Espace client : les serveurs auxquels l'utilisateur connecté a accès.
 *
 * Le paramètre de route s'appelle `serverId` — c'est ce nom que
 * `ServerPermissionGuard` cherche pour résoudre le serveur et les permissions.
 */
@Controller('api/servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
    @CurrentUser() user: RequestUser,
  ): Promise<Paginated<ServerListItem>> {
    return this.servers.listForUser(user.id, query);
  }

  @Get(':serverId')
  @RequireServerPermission()
  find(
    @Param('serverId') serverId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<ServerListItem> {
    return this.servers.findByUuid(serverId, user.id);
  }

  /** Permissions effectives de l'appelant sur ce serveur, pour l'interface. */
  @Get(':serverId/permissions')
  @RequireServerPermission()
  permissions(@CurrentServer() server: RequestServer): Record<string, unknown> {
    return { permissions: server.permissions, isOwner: server.isOwner };
  }

  /**
   * Action de puissance en REST.
   *
   * L'interface pilote le serveur par le WebSocket du daemon, ce qui donne un
   * retour immédiat dans la console. Mais tout ce qui n'est pas un navigateur a
   * besoin d'un point d'entrée ordinaire : le planificateur qui redémarre à
   * 5 h du matin, une restauration qui doit d'abord arrêter le serveur, un
   * script d'exploitation. Faire passer ces cas par un WebSocket reviendrait à
   * leur demander de simuler un navigateur.
   *
   * La permission dépend de l'action : arrêter un serveur n'est pas le même
   * droit que le démarrer, et `kill` relève de l'arrêt — en plus brutal.
   */
  @Post(':serverId/power')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireServerPermission()
  async power(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(powerActionSchema)) body: PowerActionDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.servers.power(serverId, body.action, server, user.id, contextOf(request));
  }

  @Patch(':serverId')
  @RequireServerPermission(PERMISSIONS.SETTINGS_RENAME)
  rename(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(updateServerSchema)) body: UpdateServerDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServerListItem> {
    return this.servers.update(serverId, body, user.id, contextOf(request));
  }
}

function contextOf(request: AuthenticatedRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

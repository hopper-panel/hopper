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
 * Client area: the servers the signed-in user has access to.
 *
 * The route parameter is called `serverId` — that is the name
 * `ServerPermissionGuard` looks for to resolve the server and the permissions.
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

  /** The caller's effective permissions on this server, for the interface. */
  @Get(':serverId/permissions')
  @RequireServerPermission()
  permissions(@CurrentServer() server: RequestServer): Record<string, unknown> {
    return { permissions: server.permissions, isOwner: server.isOwner };
  }

  /**
   * Power action over REST.
   *
   * The interface drives the server through the daemon's WebSocket, which gives
   * immediate feedback in the console. But anything that is not a browser needs
   * an ordinary entry point: the scheduler restarting at 5am, a restore that
   * has to stop the server first, an operations script. Routing those through a
   * WebSocket would amount to asking them to impersonate a browser.
   *
   * The permission depends on the action: stopping a server is not the same
   * right as starting it, and `kill` belongs to stopping — only more brutal.
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

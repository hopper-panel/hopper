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
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import {
  createServerSchema,
  updateServerBuildSchema,
  type CreateServerDto,
  type UpdateServerBuildDto,
} from './servers.dto.js';
import { ServersService, type ServerListItem } from './servers.service.js';

/**
 * Server administration: creation, limits, suspension, deletion.
 *
 * Separate from `ServersController` because the access rules have nothing in
 * common. Here only the role matters; there, the per-server permissions. Mixing
 * them in one controller would sooner or later leave a route behind the wrong
 * guard.
 */
@Controller('api/admin/servers')
@AdminOnly()
export class AdminServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
    @CurrentUser() actor: RequestUser,
  ): Promise<Paginated<ServerListItem>> {
    return this.servers.listAll(query, actor.id);
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string, @CurrentUser() actor: RequestUser): Promise<ServerListItem> {
    return this.servers.findByUuid(uuid, actor.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createServerSchema)) body: CreateServerDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServerListItem> {
    return this.servers.create(body, actor.id, contextOf(request));
  }

  @Patch(':uuid/build')
  updateBuild(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateServerBuildSchema)) body: UpdateServerBuildDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServerListItem> {
    return this.servers.updateBuild(uuid, body, actor.id, contextOf(request));
  }

  @Post(':uuid/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServerListItem> {
    return this.servers.setSuspended(uuid, true, actor.id, contextOf(request));
  }

  @Post(':uuid/unsuspend')
  @HttpCode(HttpStatus.OK)
  unsuspend(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServerListItem> {
    return this.servers.setSuspended(uuid, false, actor.id, contextOf(request));
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.servers.remove(uuid, actor.id, contextOf(request));
  }
}

function contextOf(request: AuthenticatedRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

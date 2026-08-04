import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
import { NodeClientService, type NodeHealth } from './node-client.service.js';
import {
  createAllocationsSchema,
  createNodeSchema,
  updateNodeSchema,
  type CreateAllocationsDto,
  type CreateNodeDto,
  type UpdateNodeDto,
} from './nodes.dto.js';
import { NodesService, type NodeView } from './nodes.service.js';

@Controller('api/admin/nodes')
@AdminOnly()
export class NodesController {
  constructor(
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Paginated<NodeView>> {
    return this.nodes.list(query);
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string): Promise<NodeView> {
    return this.nodes.findByUuid(uuid);
  }

  /**
   * Interroge le daemon pour savoir s'il répond.
   *
   * Le résultat n'est pas mis en cache : un administrateur qui ouvre cette page
   * veut l'état maintenant, pas celui d'il y a une minute. Le client applique
   * un délai d'attente court pour qu'un node éteint ne fige pas la page.
   */
  @Get(':uuid/health')
  async health(@Param('uuid') uuid: string): Promise<NodeHealth> {
    // `getConnection` déchiffre le jeton : le résultat ne sort jamais d'ici,
    // seule la réponse du daemon est renvoyée au navigateur.
    return this.client.fetchSystemInformation(await this.nodes.getConnection(uuid));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createNodeSchema)) body: CreateNodeDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ node: NodeView; configuration: string }> {
    return this.nodes.create(body, actor.id, contextOf(request));
  }

  @Patch(':uuid')
  update(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(updateNodeSchema)) body: UpdateNodeDto,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<NodeView> {
    return this.nodes.update(uuid, body, actor.id, contextOf(request));
  }

  @Post(':uuid/token')
  @HttpCode(HttpStatus.OK)
  rotateToken(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ configuration: string }> {
    return this.nodes.rotateToken(uuid, actor.id, contextOf(request));
  }

  @Delete(':uuid')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('uuid') uuid: string,
    @CurrentUser() actor: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.nodes.remove(uuid, actor.id, contextOf(request));
  }

  // -------------------------------------------------------------------------
  // Allocations
  // -------------------------------------------------------------------------

  @Get(':uuid/allocations')
  listAllocations(
    @Param('uuid') uuid: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.nodes.listAllocations(uuid, query);
  }

  @Post(':uuid/allocations')
  @HttpCode(HttpStatus.CREATED)
  createAllocations(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(createAllocationsSchema)) body: CreateAllocationsDto,
  ): Promise<{ created: number; skipped: number }> {
    return this.nodes.createAllocations(uuid, body);
  }

  @Delete(':uuid/allocations/:allocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAllocation(
    @Param('uuid') uuid: string,
    @Param('allocationId', ParseIntPipe) allocationId: number,
  ): Promise<void> {
    return this.nodes.removeAllocation(uuid, allocationId);
  }
}

function contextOf(request: AuthenticatedRequest): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

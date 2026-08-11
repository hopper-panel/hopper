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
import { NodeApplyService, type NodeApplyStatus } from './node-apply.service.js';
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
    private readonly apply: NodeApplyService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Paginated<NodeView>> {
    return this.nodes.list(query);
  }

  /**
   * Declared before `:uuid`, and it has to be.
   *
   * Nest matches routes in declaration order, so a `@Get(':uuid')` sitting
   * above this one swallows `local-apply` as a node identifier and answers
   * "Node not found" for a path that names no node at all.
   */
  @Get('local-apply/status')
  applyStatus(): Promise<NodeApplyStatus> {
    return this.apply.status();
  }

  @Get(':uuid')
  find(@Param('uuid') uuid: string): Promise<NodeView> {
    return this.nodes.findByUuid(uuid);
  }

  /**
   * Asks the daemon whether it answers.
   *
   * The result is not cached: an administrator opening this page wants the
   * state now, not the one from a minute ago. The client applies a short
   * timeout so that a powered-off node does not freeze the page.
   */
  @Get(':uuid/health')
  async health(@Param('uuid') uuid: string): Promise<NodeHealth> {
    // `getConnection` decrypts the token: the result never leaves this method,
    // only the daemon's answer is returned to the browser.
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

  /**
   * Writes this machine's `daemon.yml` and restarts hopperd.
   *
   * Only ever the machine the panel runs on: nothing here reaches across the
   * wire. See `NodeApplyService` for why the panel asks rather than writes.
   */
  @Post(':uuid/apply-locally')
  @HttpCode(HttpStatus.ACCEPTED)
  async applyLocally(@Param('uuid') uuid: string): Promise<NodeApplyStatus> {
    // Resolved first, so a uuid naming no node is a 404 rather than a request
    // the root-side unit refuses a second later with nothing to show for it.
    const node = await this.nodes.findByUuid(uuid);

    await this.apply.request(node.uuid);

    return this.apply.status();
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

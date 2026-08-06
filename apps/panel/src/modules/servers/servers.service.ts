import { PERMISSIONS, type PowerAction } from '@hopper/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  paginate,
  skipFor,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { checkCapacity } from './capacity.js';
import { ServerConfigurationService } from './server-configuration.service.js';
import type { CreateServerDto, UpdateServerBuildDto, UpdateServerDto } from './servers.dto.js';

export interface ServerListItem {
  uuid: string;
  name: string;
  description: string;
  status: string;
  memoryBytes: bigint;
  diskBytes: bigint;
  cpuPercent: number;
  node: { uuid: string; name: string; fqdn: string };
  template: { uuid: string; name: string };
  primaryAllocation: { ip: string; port: number; alias: string | null } | null;
  isOwner: boolean;
  createdAt: Date;
}

/**
 * Extracts a template's images, in the order they were declared.
 *
 * Tolerates the old object format `{ "Java 21": "…" }`: a template imported
 * before the format change must not make its servers impossible to create. The
 * order there is whatever `jsonb` happened to keep.
 */
export function parseDockerImages(raw: Prisma.JsonValue): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (entry as { image?: unknown })?.image)
      .filter((image): image is string => typeof image === 'string' && image.length > 0);
  }

  if (raw && typeof raw === 'object') {
    return Object.values(raw).filter(
      (image): image is string => typeof image === 'string' && image.length > 0,
    );
  }

  return [];
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly configurations: ServerConfigurationService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  /**
   * Servers visible to a user.
   *
   * An administrator does *not* see every server here: this list is their own
   * space. The exhaustive view is a separate administration route, so that "my
   * servers" stays readable on an instance hosting two hundred of them.
   */
  async listForUser(userId: number, query: PaginationQuery): Promise<Paginated<ServerListItem>> {
    const where: Prisma.ServerWhereInput = {
      AND: [
        { OR: [{ ownerId: userId }, { subusers: { some: { userId } } }] },
        searchClause(query.search),
      ],
    };

    return this.queryServers(where, query, userId);
  }

  /** Exhaustive view, for administrators only. */
  async listAll(query: PaginationQuery, viewerId: number): Promise<Paginated<ServerListItem>> {
    return this.queryServers(searchClause(query.search), query, viewerId);
  }

  async findByUuid(uuid: string, viewerId: number): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: this.listInclude(),
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return this.toListItem(server, viewerId);
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Creates a server's record.
   *
   * Nothing is asked of the daemon at this stage: the server stays `INSTALLING`
   * until the Docker runtime takes over. The separation is deliberate — the
   * business validation and the resource accounting have to be right before a
   * container exists.
   */
  async create(
    dto: CreateServerDto,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const [owner, node, template] = await Promise.all([
      this.prisma.user.findUnique({ where: { uuid: dto.ownerUuid }, select: { id: true } }),
      this.prisma.node.findUnique({ where: { uuid: dto.nodeUuid } }),
      this.prisma.template.findUnique({
        where: { uuid: dto.templateUuid },
        include: { variables: true },
      }),
    ]);

    if (!owner) throw new BadRequestException('Owner not found.');
    if (!node) throw new BadRequestException('Node not found.');
    if (!template) throw new BadRequestException('Template not found.');

    if (node.maintenance) {
      throw new ConflictException(
        'This node is under maintenance: no new server can be created on it.',
      );
    }

    const allocation = await this.prisma.allocation.findFirst({
      where: { id: dto.allocationId, nodeId: node.id },
    });

    if (!allocation) {
      throw new BadRequestException('This allocation does not exist on this node.');
    }

    if (allocation.serverId !== null) {
      throw new ConflictException(`Port ${allocation.port} is already assigned to a server.`);
    }

    await this.assertNodeHasCapacity(node, BigInt(dto.memoryBytes), BigInt(dto.diskBytes));

    const dockerImage = this.resolveDockerImage(template.dockerImages, dto.dockerImage);
    const variables = this.resolveVariables(template.variables, dto.variables);

    const server = await this.prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: dto.name,
          description: dto.description,
          ownerId: owner.id,
          nodeId: node.id,
          templateId: template.id,
          status: 'INSTALLING',
          memoryBytes: BigInt(dto.memoryBytes),
          diskBytes: BigInt(dto.diskBytes),
          swapBytes: BigInt(dto.swapBytes),
          cpuPercent: dto.cpuPercent,
          cpuSet: dto.cpuSet,
          ioWeight: dto.ioWeight,
          pidsLimit: dto.pidsLimit,
          oomKillDisabled: dto.oomKillDisabled,
          backupLimit: dto.backupLimit,
          allocationLimit: dto.allocationLimit,
          databaseLimit: dto.databaseLimit,
          dockerImage,
          // Copied from the template: editing the template later must not
          // change an existing server's startup command without anyone asking
          // for it.
          startupCommand: template.startup,
          primaryAllocationId: allocation.id,
          variables: {
            create: Object.entries(variables).map(([envVariable, value]) => ({
              envVariable,
              value,
            })),
          },
        },
      });

      // The port has to point at the server from both sides:
      // `primaryAllocationId` for the main port, `serverId` so it shows as
      // taken.
      //
      // `role: null` for the same reason it is cleared when a port is added to
      // an existing server: a port released by a deleted server keeps whatever
      // name it was given, because the foreign key only nulls `serverId`. A
      // primary port carrying an inherited name would be one `setPrimary`
      // refuses to create, reached without anyone naming anything.
      await tx.allocation.update({
        where: { id: allocation.id },
        data: { serverId: created.id, role: null },
      });

      return created;
    });

    // The daemon is told after the transaction: there must be no container for
    // a server that does not exist in the database.
    try {
      const configuration = await this.configurations.build(server.uuid);
      const connection = await this.nodes.getConnection(node.uuid);

      await this.client.createServer(connection, configuration, dto.startOnCompletion);
    } catch (error: unknown) {
      // Creation is atomic from the user's point of view: an unreachable node
      // must not leave a phantom server in the database, with its port tied up
      // and no container behind it.
      this.logger.error(
        `Creation refused by node ${node.name}, removing ${server.uuid}: ${String(error)}`,
      );
      await this.prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
      throw error;
    }

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_CREATED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { name: server.name, node: node.name, template: template.name },
    });

    return this.findByUuid(server.uuid, actorId);
  }

  /**
   * Sends a server's up-to-date configuration back to the daemon.
   *
   * Failure-tolerant: an offline node must not prevent renaming a server or
   * adjusting its limits in the panel. Reconciliation when the daemon starts
   * will catch up.
   */
  private async pushConfiguration(serverUuid: string, nodeUuid: string): Promise<void> {
    try {
      const configuration = await this.configurations.build(serverUuid);
      const connection = await this.nodes.getConnection(nodeUuid);

      await this.client.syncServer(connection, configuration);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not sync server ${serverUuid}; it will be caught up the next time the daemon starts: ${String(error)}`,
      );
    }
  }

  /**
   * Applies a power action through the daemon.
   *
   * The permission required depends on the action, and `kill` belongs to
   * stopping: a subuser allowed to stop a server can kill it, but one who can
   * only start it cannot. Confusing the two would give a moderator the power to
   * cut the server off mid-world-save.
   */
  async power(
    uuid: string,
    action: PowerAction,
    server: { id: number; nodeId: number; permissions: string[]; isOwner: boolean },
    actorId: number,
    context: RequestContext,
  ): Promise<void> {
    const required = POWER_PERMISSIONS[action];

    if (!server.isOwner && !server.permissions.includes(required)) {
      throw new ForbiddenException(`Permission "${required}" is required for this action.`);
    }

    const record = await this.prisma.server.findUniqueOrThrow({
      where: { uuid },
      include: { node: { select: { uuid: true } } },
    });

    // A suspended server, or one being installed or deleted, has no usable
    // container: starting it would produce a daemon error far less telling than
    // this refusal.
    if (record.status !== 'READY') {
      throw new ConflictException(
        `This server is not available (state: ${record.status.toLowerCase()}).`,
      );
    }

    const connection = await this.nodes.getConnection(record.node.uuid);
    await this.client.powerServer(connection, uuid, action);

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_POWER,
      actorId,
      serverId: record.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { action },
    });
  }

  async update(
    uuid: string,
    dto: UpdateServerDto,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true, node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { name: dto.name, description: dto.description },
    });

    await this.pushConfiguration(uuid, server.node.uuid);

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { changed: Object.keys(dto) },
    });

    return this.findByUuid(uuid, actorId);
  }

  /**
   * Changes the resource limits.
   *
   * `requiresRebuild` is set: a Docker container's limits cannot be changed
   * live in a reliable way. The daemon will recreate the container on the next
   * start, without touching the data volume.
   */
  async updateBuild(
    uuid: string,
    dto: UpdateServerBuildDto,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: { node: true },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    if (dto.memoryBytes !== undefined || dto.diskBytes !== undefined) {
      await this.assertNodeHasCapacity(
        server.node,
        BigInt(dto.memoryBytes ?? server.memoryBytes),
        BigInt(dto.diskBytes ?? server.diskBytes),
        server.id,
      );
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: {
        memoryBytes: dto.memoryBytes === undefined ? undefined : BigInt(dto.memoryBytes),
        diskBytes: dto.diskBytes === undefined ? undefined : BigInt(dto.diskBytes),
        swapBytes: dto.swapBytes === undefined ? undefined : BigInt(dto.swapBytes),
        cpuPercent: dto.cpuPercent,
        cpuSet: dto.cpuSet,
        ioWeight: dto.ioWeight,
        pidsLimit: dto.pidsLimit,
        oomKillDisabled: dto.oomKillDisabled,
        backupLimit: dto.backupLimit,
        allocationLimit: dto.allocationLimit,
        databaseLimit: dto.databaseLimit,
        requiresRebuild: true,
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { changed: Object.keys(dto), requiresRebuild: true },
    });

    return this.findByUuid(uuid, actorId);
  }

  async setSuspended(
    uuid: string,
    suspended: boolean,
    actorId: number,
    context: RequestContext,
  ): Promise<ServerListItem> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true, node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { status: suspended ? 'SUSPENDED' : 'READY' },
    });

    // The daemon has to learn about the suspension: it is the one that refuses
    // the start and cuts SFTP access.
    await this.pushConfiguration(uuid, server.node.uuid);

    await this.audit.record({
      event: suspended ? AUDIT_EVENTS.SERVER_SUSPENDED : AUDIT_EVENTS.SERVER_UNSUSPENDED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return this.findByUuid(uuid, actorId);
  }

  async remove(uuid: string, actorId: number, context: RequestContext): Promise<void> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { id: true, name: true, node: { select: { uuid: true } } },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    // The container and the volume go first: deleting the database row before
    // would leave a container nothing references any more, and that nobody
    // could trace back to an owner.
    try {
      const connection = await this.nodes.getConnection(server.node.uuid);
      await this.client.deleteServer(connection, uuid, true);
    } catch (error: unknown) {
      this.logger.error(`Deletion refused by the node for ${uuid}: ${String(error)}`);
      throw error;
    }

    // The audit entry is written BEFORE the deletion, and without `serverId`:
    // the cascade would otherwise erase the trace of the action at the very
    // moment it becomes most useful.
    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_DELETED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { serverUuid: uuid, name: server.name },
    });

    // Allocations are released by `onDelete: SetNull`, not deleted: they are
    // the node's ports, and stay available for another server.
    await this.prisma.server.delete({ where: { id: server.id } });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async assertNodeHasCapacity(
    node: {
      id: number;
      memoryBytes: bigint;
      diskBytes: bigint;
      memoryOverallocation: number;
      diskOverallocation: number;
    },
    memoryBytes: bigint,
    diskBytes: bigint,
    excludeServerId?: number,
  ): Promise<void> {
    const totals = await this.prisma.server.aggregate({
      where: { nodeId: node.id, id: excludeServerId ? { not: excludeServerId } : undefined },
      _sum: { memoryBytes: true, diskBytes: true },
    });

    const memory = checkCapacity(
      {
        declared: node.memoryBytes,
        allocated: totals._sum.memoryBytes ?? 0n,
        requested: memoryBytes,
        overallocation: node.memoryOverallocation,
      },
      'Memory',
    );

    if (!memory.allowed) {
      throw new ConflictException(memory.reason);
    }

    const disk = checkCapacity(
      {
        declared: node.diskBytes,
        allocated: totals._sum.diskBytes ?? 0n,
        requested: diskBytes,
        overallocation: node.diskOverallocation,
      },
      'Disk',
    );

    if (!disk.allowed) {
      throw new ConflictException(disk.reason);
    }
  }

  /**
   * Picks the Docker image, refusing any absent from the template.
   *
   * The template declares them in an ordered array: the first is the default.
   * A JSON object would not do — `jsonb` reorders its keys, and "the first
   * image" would then mean an unpredictable entry.
   */
  private resolveDockerImage(dockerImages: Prisma.JsonValue, requested?: string): string {
    const available = parseDockerImages(dockerImages);

    if (available.length === 0) {
      throw new BadRequestException('This template declares no Docker image.');
    }

    if (!requested) {
      return available[0]!;
    }

    // An arbitrary image would be user-chosen code execution on the host
    // machine: only the template's own get through.
    if (!available.includes(requested)) {
      throw new BadRequestException(
        `Docker image not offered by this template. Accepted values: ${available.join(', ')}.`,
      );
    }

    return requested;
  }

  /**
   * Builds the server's variables from the template.
   *
   * A non-editable variable keeps its default value even if the client sends
   * another: these variables feed the startup command, and letting them past
   * validation would amount to handing the command line's content to the user.
   */
  private resolveVariables(
    templateVariables: { envVariable: string; defaultValue: string; userEditable: boolean }[],
    provided: Record<string, string>,
  ): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const variable of templateVariables) {
      const candidate = provided[variable.envVariable];
      resolved[variable.envVariable] =
        variable.userEditable && candidate !== undefined ? candidate : variable.defaultValue;
    }

    return resolved;
  }

  private listInclude() {
    return {
      node: { select: { uuid: true, name: true, fqdn: true } },
      template: { select: { uuid: true, name: true } },
      primaryAllocation: { select: { ip: true, port: true, alias: true } },
    } satisfies Prisma.ServerInclude;
  }

  private async queryServers(
    where: Prisma.ServerWhereInput,
    query: PaginationQuery,
    viewerId: number,
  ): Promise<Paginated<ServerListItem>> {
    const [servers, total] = await this.prisma.$transaction([
      this.prisma.server.findMany({
        where,
        include: this.listInclude(),
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query),
        take: query.perPage,
      }),
      this.prisma.server.count({ where }),
    ]);

    return paginate(
      servers.map((server) => this.toListItem(server, viewerId)),
      total,
      query,
    );
  }

  private toListItem(
    server: Prisma.ServerGetPayload<{
      include: {
        node: { select: { uuid: true; name: true; fqdn: true } };
        template: { select: { uuid: true; name: true } };
        primaryAllocation: { select: { ip: true; port: true; alias: true } };
      };
    }>,
    viewerId: number,
  ): ServerListItem {
    return {
      uuid: server.uuid,
      name: server.name,
      description: server.description,
      status: server.status,
      memoryBytes: server.memoryBytes,
      diskBytes: server.diskBytes,
      cpuPercent: server.cpuPercent,
      node: server.node,
      template: server.template,
      primaryAllocation: server.primaryAllocation,
      isOwner: server.ownerId === viewerId,
      createdAt: server.createdAt,
    };
  }
}

/**
 * Permission required per power action.
 *
 * `kill` shares the stop permission: it is a stop, only more brutal. Giving it
 * its own permission would create a right nobody would think to take away.
 */
const POWER_PERMISSIONS: Record<PowerAction, string> = {
  start: PERMISSIONS.CONTROL_START,
  stop: PERMISSIONS.CONTROL_STOP,
  restart: PERMISSIONS.CONTROL_RESTART,
  kill: PERMISSIONS.CONTROL_STOP,
};

/**
 * Search criterion for a server.
 *
 * Three ways to designate a server, because they are the three one has to
 * hand: its **name** when you know it, its **identifier** when you picked it up
 * from a log, and its **port** when all you have is the address given to
 * players.
 *
 * Shared between the personal list and the administration view: the former only
 * searched by name, so pasting a UUID into the search returned nothing — while
 * the field claimed otherwise.
 */
function searchClause(search: string | undefined): Prisma.ServerWhereInput {
  const term = search?.trim();

  if (!term) {
    return {};
  }

  const port = Number.parseInt(term, 10);

  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { uuid: { equals: term } },
      ...(Number.isInteger(port) && port > 0 && port <= 65535
        ? [{ allocations: { some: { port } } } satisfies Prisma.ServerWhereInput]
        : []),
    ],
  };
}

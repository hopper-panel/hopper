import { NODE_TOKEN_ID_LENGTH, NODE_TOKEN_SECRET_LENGTH } from '@hopper/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Node, Prisma } from '@prisma/client';
import { stringify as stringifyYaml } from 'yaml';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Environment } from '../../config/environment.js';
import {
  paginate,
  skipFor,
  type Paginated,
  type PaginationQuery,
} from '../../common/pagination.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import {
  expandPortRanges,
  type CreateAllocationsDto,
  type CreateNodeDto,
  type UpdateNodeDto,
} from './nodes.dto.js';

/** A node view. Never holds the token secret nor the JWT secret. */
export interface NodeView {
  uuid: string;
  name: string;
  description: string;
  fqdn: string;
  scheme: string;
  port: number;
  sftpPort: number;
  /** IANA name; reaches every container on the node as `TZ`. */
  timezone: string;
  memoryBytes: bigint;
  diskBytes: bigint;
  memoryOverallocation: number;
  diskOverallocation: number;
  maintenance: boolean;
  /** Public half of the token: enough to identify the node in the logs. */
  daemonTokenId: string;
  serverCount: number;
  allocationCount: number;
  createdAt: Date;
}

export function toNodeView(
  node: Node & { _count?: { servers: number; allocations: number } },
): NodeView {
  return {
    uuid: node.uuid,
    name: node.name,
    description: node.description,
    fqdn: node.fqdn,
    scheme: node.scheme,
    port: node.port,
    sftpPort: node.sftpPort,
    timezone: node.timezone,
    memoryBytes: node.memoryBytes,
    diskBytes: node.diskBytes,
    memoryOverallocation: node.memoryOverallocation,
    diskOverallocation: node.diskOverallocation,
    maintenance: node.maintenance,
    daemonTokenId: node.daemonTokenId,
    serverCount: node._count?.servers ?? 0,
    allocationCount: node._count?.allocations ?? 0,
    createdAt: node.createdAt,
  };
}

@Injectable()
export class NodesService {
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    config: ConfigService<Environment, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  async list(query: PaginationQuery): Promise<Paginated<NodeView>> {
    const where: Prisma.NodeWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { fqdn: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [nodes, total] = await this.prisma.$transaction([
      this.prisma.node.findMany({
        where,
        include: { _count: { select: { servers: true, allocations: true } } },
        orderBy: { createdAt: 'asc' },
        skip: skipFor(query),
        take: query.perPage,
      }),
      this.prisma.node.count({ where }),
    ]);

    return paginate(nodes.map(toNodeView), total, query);
  }

  async findByUuid(uuid: string): Promise<NodeView> {
    const node = await this.prisma.node.findUnique({
      where: { uuid },
      include: { _count: { select: { servers: true, allocations: true } } },
    });

    if (!node) {
      throw new NotFoundException('Node not found.');
    }

    return toNodeView(node);
  }

  /**
   * Creates a node and its token pair.
   *
   * The secret is returned here only, once, inside the configuration file ready
   * to paste on the host machine. No other route exposes it again: losing it
   * forces a rotation, which is the intended behaviour.
   */
  async create(
    dto: CreateNodeDto,
    /** Null when the creation comes from the command line, with no session. */
    actorId: number | null,
    context: RequestContext,
  ): Promise<{ node: NodeView; configuration: string }> {
    const tokenId = this.crypto.randomString(NODE_TOKEN_ID_LENGTH);
    const tokenSecret = this.crypto.randomString(NODE_TOKEN_SECRET_LENGTH);
    const jwtSecret = this.crypto.randomString(64);

    const node = await this.prisma.node.create({
      data: {
        name: dto.name,
        description: dto.description,
        fqdn: dto.fqdn,
        scheme: dto.scheme,
        port: dto.port,
        sftpPort: dto.sftpPort,
        timezone: dto.timezone,
        memoryBytes: BigInt(dto.memoryBytes),
        diskBytes: BigInt(dto.diskBytes),
        memoryOverallocation: dto.memoryOverallocation,
        diskOverallocation: dto.diskOverallocation,
        maintenance: dto.maintenance,
        daemonTokenId: tokenId,
        daemonTokenEncrypted: this.crypto.encrypt(tokenSecret),
        jwtSecret: this.crypto.encrypt(jwtSecret),
      },
      include: { _count: { select: { servers: true, allocations: true } } },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.NODE_CREATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { nodeUuid: node.uuid, name: node.name, fqdn: node.fqdn },
    });

    return {
      node: toNodeView(node),
      configuration: this.buildDaemonConfiguration(node, tokenId, tokenSecret, jwtSecret),
    };
  }

  async update(
    uuid: string,
    dto: UpdateNodeDto,
    /** Null when the change comes from the command line, with no session. */
    actorId: number | null,
    context: RequestContext,
  ): Promise<NodeView> {
    const existing = await this.prisma.node.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('Node not found.');
    }

    const node = await this.prisma.node.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        description: dto.description,
        fqdn: dto.fqdn,
        scheme: dto.scheme,
        port: dto.port,
        sftpPort: dto.sftpPort,
        timezone: dto.timezone,
        memoryBytes: dto.memoryBytes === undefined ? undefined : BigInt(dto.memoryBytes),
        diskBytes: dto.diskBytes === undefined ? undefined : BigInt(dto.diskBytes),
        memoryOverallocation: dto.memoryOverallocation,
        diskOverallocation: dto.diskOverallocation,
        maintenance: dto.maintenance,
      },
      include: { _count: { select: { servers: true, allocations: true } } },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.NODE_UPDATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { nodeUuid: uuid, changed: Object.keys(dto) },
    });

    return toNodeView(node);
  }

  /**
   * Regenerates the token pair and the JWT secret.
   *
   * The daemon becomes unreachable until its configuration is updated and the
   * service restarted. Servers already running keep running: it is the control
   * link that is cut, not the containers.
   */
  async rotateToken(
    uuid: string,
    /** Null when the rotation comes from the command line, with no session. */
    actorId: number | null,
    context: RequestContext,
  ): Promise<{ configuration: string }> {
    const existing = await this.prisma.node.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('Node not found.');
    }

    const tokenId = this.crypto.randomString(NODE_TOKEN_ID_LENGTH);
    const tokenSecret = this.crypto.randomString(NODE_TOKEN_SECRET_LENGTH);
    const jwtSecret = this.crypto.randomString(64);

    const node = await this.prisma.node.update({
      where: { id: existing.id },
      data: {
        daemonTokenId: tokenId,
        daemonTokenEncrypted: this.crypto.encrypt(tokenSecret),
        jwtSecret: this.crypto.encrypt(jwtSecret),
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.NODE_TOKEN_ROTATED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { nodeUuid: uuid },
    });

    return {
      configuration: this.buildDaemonConfiguration(node, tokenId, tokenSecret, jwtSecret),
    };
  }

  async remove(uuid: string, actorId: number, context: RequestContext): Promise<void> {
    const node = await this.prisma.node.findUnique({
      where: { uuid },
      include: { _count: { select: { servers: true } } },
    });

    if (!node) {
      throw new NotFoundException('Node not found.');
    }

    if (node._count.servers > 0) {
      throw new BadRequestException(
        `This node still hosts ${node._count.servers} server(s). Delete or move them first.`,
      );
    }

    await this.prisma.node.delete({ where: { id: node.id } });

    await this.audit.record({
      event: AUDIT_EVENTS.NODE_DELETED,
      actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { nodeUuid: uuid, name: node.name },
    });
  }

  /** Plaintext JWT secret, to sign a console token. Internal use. */
  async getJwtSecret(nodeId: number): Promise<string> {
    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: nodeId },
      select: { jwtSecret: true },
    });

    return this.crypto.decrypt(node.jwtSecret);
  }

  /**
   * A node's full address, decrypted token included, to call its daemon.
   *
   * Reserved for the panel's internal calls: the token must never cross the
   * HTTP boundary towards a browser. No controller returns the result of this
   * method as is.
   */
  async getConnection(uuid: string): Promise<{ uuid: string; url: string; token: string }> {
    const node = await this.prisma.node.findUnique({
      where: { uuid },
      select: {
        uuid: true,
        scheme: true,
        fqdn: true,
        port: true,
        daemonTokenId: true,
        daemonTokenEncrypted: true,
      },
    });

    if (!node) {
      throw new NotFoundException('Node not found.');
    }

    return {
      uuid: node.uuid,
      url: `${node.scheme}://${node.fqdn}:${node.port}`,
      token: `${node.daemonTokenId}.${this.crypto.decrypt(node.daemonTokenEncrypted)}`,
    };
  }

  // -------------------------------------------------------------------------
  // Allocations
  // -------------------------------------------------------------------------

  async listAllocations(uuid: string, query: PaginationQuery) {
    const node = await this.prisma.node.findUnique({ where: { uuid }, select: { id: true } });

    if (!node) {
      throw new NotFoundException('Node not found.');
    }

    const where: Prisma.AllocationWhereInput = { nodeId: node.id };

    const [allocations, total] = await this.prisma.$transaction([
      this.prisma.allocation.findMany({
        where,
        include: { server: { select: { uuid: true, name: true } } },
        orderBy: [{ ip: 'asc' }, { port: 'asc' }],
        skip: skipFor(query),
        take: query.perPage,
      }),
      this.prisma.allocation.count({ where }),
    ]);

    return paginate(
      allocations.map((allocation) => ({
        id: allocation.id,
        ip: allocation.ip,
        port: allocation.port,
        alias: allocation.alias,
        assignedTo: allocation.server,
      })),
      total,
      query,
    );
  }

  async createAllocations(
    uuid: string,
    dto: CreateAllocationsDto,
  ): Promise<{ created: number; skipped: number }> {
    const node = await this.prisma.node.findUnique({ where: { uuid }, select: { id: true } });

    if (!node) {
      throw new NotFoundException('Node not found.');
    }

    let ports: number[];
    try {
      ports = expandPortRanges(dto.ports);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid range.');
    }

    // `skipDuplicates` rather than an error: reapplying a range that partly
    // overlaps existing ports is a common move. The count of skipped ports is
    // returned so the interface can say so plainly.
    const result = await this.prisma.allocation.createMany({
      data: ports.map((port) => ({
        nodeId: node.id,
        ip: dto.ip,
        port,
        alias: dto.alias ?? null,
      })),
      skipDuplicates: true,
    });

    return { created: result.count, skipped: ports.length - result.count };
  }

  async removeAllocation(uuid: string, allocationId: number): Promise<void> {
    const allocation = await this.prisma.allocation.findFirst({
      where: { id: allocationId, node: { uuid } },
      select: { id: true, serverId: true, port: true },
    });

    if (!allocation) {
      throw new NotFoundException('Allocation not found on this node.');
    }

    if (allocation.serverId !== null) {
      throw new ConflictException(
        `Port ${allocation.port} is assigned to a server. Remove it from that server first.`,
      );
    }

    await this.prisma.allocation.delete({ where: { id: allocation.id } });
  }

  // -------------------------------------------------------------------------

  /**
   * Produces the `daemon.yml` ready to paste on the host machine.
   *
   * Generated panel-side rather than left to the administrator: it is the only
   * way to guarantee the UUID, the tokens and the panel URL agree. A typo in
   * any of those fields would show up as an "unreachable" node with no clue as
   * to the cause.
   */
  private buildDaemonConfiguration(
    node: Node,
    tokenId: string,
    tokenSecret: string,
    jwtSecret: string,
  ): string {
    const configuration = {
      debug: false,
      uuid: node.uuid,
      tokenId,
      tokenSecret,
      api: {
        host: '0.0.0.0',
        port: node.port,
        // The certificate paths are **mandatory** as soon as `enabled` is
        // true: without them the daemon refuses to start with a configuration
        // it has just received from the panel. So Let's Encrypt's paths are
        // offered, by far the most common — another issuer is a two-line fix,
        // an invalid configuration is a twenty-minute diagnosis.
        ssl:
          node.scheme === 'https'
            ? {
                enabled: true,
                certificatePath: `/etc/letsencrypt/live/${node.fqdn}/fullchain.pem`,
                keyPath: `/etc/letsencrypt/live/${node.fqdn}/privkey.pem`,
              }
            : { enabled: false },
        // Without this origin, the daemon would refuse every WebSocket
        // connection coming from the panel and no console would open.
        allowedOrigins: [this.appUrl],
      },
      panel: { url: this.appUrl, jwtSecret },
      system: {
        rootDirectory: '/var/lib/hopper',
        sftp: { enabled: true, bindPort: node.sftpPort },
        // Written from the row and not from whatever the file said before: this
        // document is regenerated on every token rotation, so a timezone edited
        // into it by hand survives exactly until the next one.
        timezone: node.timezone,
      },
      docker: { socket: '/var/run/docker.sock' },
    };

    return stringifyYaml(configuration, { lineWidth: 0 });
  }
}

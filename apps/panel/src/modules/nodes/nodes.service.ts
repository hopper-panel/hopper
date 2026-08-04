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

/** Vue d'un node. Ne contient jamais le secret du jeton ni le secret JWT. */
export interface NodeView {
  uuid: string;
  name: string;
  description: string;
  fqdn: string;
  scheme: string;
  port: number;
  sftpPort: number;
  memoryBytes: bigint;
  diskBytes: bigint;
  memoryOverallocation: number;
  diskOverallocation: number;
  maintenance: boolean;
  /** Partie publique du jeton : suffit à identifier le node dans les journaux. */
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
      throw new NotFoundException('Node introuvable.');
    }

    return toNodeView(node);
  }

  /**
   * Crée un node et sa paire de jetons.
   *
   * Le secret n'est retourné qu'ici, une seule fois, à l'intérieur du fichier
   * de configuration prêt à coller sur la machine hôte. Aucune autre route ne
   * le réexpose : le perdre impose une rotation, ce qui est le comportement
   * voulu.
   */
  async create(
    dto: CreateNodeDto,
    actorId: number,
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
    actorId: number,
    context: RequestContext,
  ): Promise<NodeView> {
    const existing = await this.prisma.node.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('Node introuvable.');
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
   * Régénère la paire de jetons et le secret JWT.
   *
   * Le daemon devient injoignable jusqu'à ce que sa configuration soit mise à
   * jour et le service redémarré. Les serveurs déjà lancés continuent de
   * tourner : c'est le lien de contrôle qui est coupé, pas les conteneurs.
   */
  async rotateToken(
    uuid: string,
    actorId: number,
    context: RequestContext,
  ): Promise<{ configuration: string }> {
    const existing = await this.prisma.node.findUnique({ where: { uuid } });

    if (!existing) {
      throw new NotFoundException('Node introuvable.');
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
      throw new NotFoundException('Node introuvable.');
    }

    if (node._count.servers > 0) {
      throw new BadRequestException(
        `Ce node héberge encore ${node._count.servers} serveur(s). Supprimez-les ou déplacez-les d'abord.`,
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

  /** Secret JWT en clair, pour signer un jeton de console. Usage interne. */
  async getJwtSecret(nodeId: number): Promise<string> {
    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: nodeId },
      select: { jwtSecret: true },
    });

    return this.crypto.decrypt(node.jwtSecret);
  }

  /**
   * Coordonnées complètes d'un node, jeton déchiffré compris, pour appeler son
   * daemon.
   *
   * Réservé aux appels internes du panel : le jeton ne doit jamais franchir la
   * frontière HTTP vers un navigateur. Aucun contrôleur ne retourne le résultat
   * de cette méthode tel quel.
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
      throw new NotFoundException('Node introuvable.');
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
      throw new NotFoundException('Node introuvable.');
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
      throw new NotFoundException('Node introuvable.');
    }

    let ports: number[];
    try {
      ports = expandPortRanges(dto.ports);
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Plage invalide.');
    }

    // `skipDuplicates` plutôt qu'une erreur : réappliquer une plage qui recouvre
    // partiellement des ports existants est un geste courant. Le compte des
    // ignorés est renvoyé pour que l'interface le dise clairement.
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
      throw new NotFoundException('Allocation introuvable sur ce node.');
    }

    if (allocation.serverId !== null) {
      throw new ConflictException(
        `Le port ${allocation.port} est attribué à un serveur. Retirez-le du serveur d'abord.`,
      );
    }

    await this.prisma.allocation.delete({ where: { id: allocation.id } });
  }

  // -------------------------------------------------------------------------

  /**
   * Produit le `daemon.yml` prêt à coller sur la machine hôte.
   *
   * Généré côté panel plutôt que laissé à la charge de l'administrateur : c'est
   * le seul moyen de garantir que l'UUID, les jetons et l'URL du panel
   * concordent. Une faute de frappe dans un de ces champs se traduirait par un
   * node « injoignable » sans indication de la cause.
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
        ssl: { enabled: node.scheme === 'https' },
        // Sans cette origine, le daemon refuserait toutes les connexions
        // WebSocket venant du panel et aucune console ne s'ouvrirait.
        allowedOrigins: [this.appUrl],
      },
      panel: { url: this.appUrl, jwtSecret },
      system: {
        rootDirectory: '/var/lib/hopper',
        sftp: { enabled: true, bindPort: node.sftpPort },
      },
      docker: { socket: '/var/run/docker.sock' },
    };

    return stringifyYaml(configuration, { lineWidth: 0 });
  }
}

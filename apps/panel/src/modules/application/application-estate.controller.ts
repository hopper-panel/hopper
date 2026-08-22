import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApplicationApi } from '../auth/decorators.js';

/**
 * The estate, read-only: nodes, their free ports, and the catalogue.
 *
 * These exist because the permission matrix names them, and a permission whose
 * resource has no route is a line an operator can tick that changes nothing.
 * They are also what a provider's own dashboard needs and what, without them,
 * they would go and read out of the panel's database.
 *
 * Read-only, and the matrix says so. Declaring a node, importing a template and
 * opening a range of ports are decisions an operator makes about their own
 * hardware, from the administration — not things a billing system should be
 * able to do because its credential leaked.
 */
@Controller('api/application')
export class ApplicationEstateController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The machines, with what is on them.
   *
   * The figures are the ones placement decides on, so a dashboard built from
   * this shows the same picture the panel used when it refused a sale.
   */
  @Get('nodes')
  @ApplicationApi('nodes')
  async nodes() {
    const nodes = await this.prisma.node.findMany({
      select: {
        uuid: true,
        name: true,
        maintenance: true,
        memoryBytes: true,
        diskBytes: true,
        memoryOverallocation: true,
        diskOverallocation: true,
      },
      orderBy: { name: 'asc' },
    });

    const [load, free] = await Promise.all([
      this.prisma.server.groupBy({
        by: ['nodeId'],
        _sum: { memoryBytes: true, diskBytes: true },
        _count: { _all: true },
      }),
      this.prisma.allocation.groupBy({
        by: ['nodeId'],
        where: { serverId: null },
        _count: { _all: true },
      }),
    ]);

    // Keyed by id, which is not exposed: the join happens here so the answer
    // carries uuids only. A node's numeric id is an implementation detail an
    // integration would otherwise start depending on.
    const ids = await this.prisma.node.findMany({ select: { id: true, uuid: true } });
    const uuidOf = new Map(ids.map((node) => [node.id, node.uuid]));
    const loadByUuid = new Map(load.map((row) => [uuidOf.get(row.nodeId), row]));
    const freeByUuid = new Map(free.map((row) => [uuidOf.get(row.nodeId), row._count._all]));

    return nodes.map((node) => ({
      uuid: node.uuid,
      name: node.name,
      maintenance: node.maintenance,
      capacity: {
        // 0 means "not declared", exactly as it does everywhere else: this node
        // is managed by hand and nothing is accounting for it.
        memoryBytes: node.memoryBytes,
        diskBytes: node.diskBytes,
        memoryOverallocation: node.memoryOverallocation,
        diskOverallocation: node.diskOverallocation,
      },
      allocated: {
        memoryBytes: loadByUuid.get(node.uuid)?._sum.memoryBytes ?? 0n,
        diskBytes: loadByUuid.get(node.uuid)?._sum.diskBytes ?? 0n,
      },
      servers: loadByUuid.get(node.uuid)?._count._all ?? 0,
      freeAllocations: freeByUuid.get(node.uuid) ?? 0,
    }));
  }

  /**
   * The ports of one node.
   *
   * `free=true` by default: the question this answers is "can this machine take
   * another server", and a list of two thousand ports of which four are free
   * answers it badly.
   */
  @Get('nodes/:uuid/allocations')
  @ApplicationApi('allocations')
  async allocations(@Param('uuid') uuid: string, @Query('free') free?: string) {
    const node = await this.prisma.node.findUnique({ where: { uuid }, select: { id: true } });

    if (!node) {
      throw new NotFoundException('Node not found.');
    }

    const onlyFree = free !== 'false';

    const allocations = await this.prisma.allocation.findMany({
      where: { nodeId: node.id, ...(onlyFree ? { serverId: null } : {}) },
      select: {
        ip: true,
        port: true,
        alias: true,
        server: { select: { uuid: true } },
      },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
      take: 1000,
    });

    return allocations.map((allocation) => ({
      ip: allocation.ip,
      port: allocation.port,
      alias: allocation.alias,
      /** Null when the port is free. */
      serverUuid: allocation.server?.uuid ?? null,
    }));
  }

  /**
   * The catalogue a plan points at.
   *
   * Enough to write a plan against — the uuid a plan needs, the key an operator
   * recognises, and the images the plan may pin — and nothing about install
   * scripts, which are the operator's and would be a much larger thing to hand
   * a leaked credential.
   */
  @Get('templates')
  @ApplicationApi('templates')
  async templates() {
    const templates = await this.prisma.template.findMany({
      select: {
        uuid: true,
        key: true,
        name: true,
        description: true,
        dockerImages: true,
        group: { select: { uuid: true, name: true } },
      },
      orderBy: [{ group: { name: 'asc' } }, { name: 'asc' }],
    });

    return templates.map((template) => ({
      uuid: template.uuid,
      key: template.key,
      name: template.name,
      description: template.description,
      group: template.group,
      images: parseImages(template.dockerImages),
    }));
  }
}

/**
 * The images a template offers, as a plain list.
 *
 * The column holds Pterodactyl's shape — a map of label to image — and handing
 * that out would make an integration depend on labels an operator renames.
 */
function parseImages(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }

  return Object.values(raw as Record<string, unknown>).filter(
    (value): value is string => typeof value === 'string',
  );
}

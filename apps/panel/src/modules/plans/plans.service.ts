import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { parseDockerImages } from '../servers/servers.service.js';
import type { CreatePlanDto, UpdatePlanDto } from './plans.dto.js';
import { choosePlacement, type PlacementCandidate, type PlacementResult } from './placement.js';

/** A plan as the API hands it out. */
export interface PlanView {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  template: { uuid: string; name: string };
  dockerImage: string;
  limits: {
    memoryBytes: bigint;
    diskBytes: bigint;
    swapBytes: bigint;
    cpuPercent: number;
    ioWeight: number;
    pidsLimit: number;
    oomKillDisabled: boolean;
    backupLimit: number;
    allocationLimit: number;
    databaseLimit: number;
  };
  /** Empty means "anywhere", not "nowhere". */
  nodes: { uuid: string; name: string }[];
  active: boolean;
  createdAt: Date;
}

const planInclude = {
  template: { select: { uuid: true, name: true } },
  nodes: { select: { uuid: true, name: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.PlanInclude;

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    options: { includeInactive: boolean } = { includeInactive: true },
  ): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      where: options.includeInactive ? {} : { active: true },
      include: planInclude,
      orderBy: [{ active: 'desc' }, { memoryBytes: 'asc' }, { slug: 'asc' }],
    });

    return plans.map((plan) => toView(plan));
  }

  /**
   * Finds a plan by the name a billing system quotes.
   *
   * By slug and not by uuid, on purpose: the slug is what an operator typed
   * into the other product's configuration, so it is what appears in the
   * request that fails, in the log line and in the support ticket. Answering
   * "plan not found: minecraft-4go" names the typo; answering it about a uuid
   * names nothing.
   */
  async findBySlug(slug: string): Promise<PlanView> {
    const plan = await this.prisma.plan.findUnique({ where: { slug }, include: planInclude });

    if (!plan) {
      throw new NotFoundException(`No plan named "${slug}".`);
    }

    return toView(plan);
  }

  async create(dto: CreatePlanDto): Promise<PlanView> {
    const [template, nodes] = await Promise.all([
      this.prisma.template.findUnique({
        where: { uuid: dto.templateUuid },
        select: { id: true, dockerImages: true },
      }),
      this.resolveNodes(dto.nodeUuids),
    ]);

    if (!template) {
      throw new BadRequestException('Template not found.');
    }

    this.assertImageBelongsToTemplate(dto.dockerImage, template.dockerImages);

    const existing = await this.prisma.plan.findUnique({
      where: { slug: dto.slug },
      select: { id: true },
    });

    if (existing) {
      // Named rather than left to the unique constraint, which surfaces as a
      // P2002 an operator reads as "Internal server error".
      throw new ConflictException(`A plan named "${dto.slug}" already exists.`);
    }

    const plan = await this.prisma.plan.create({
      data: {
        slug: dto.slug,
        name: dto.name,
        description: dto.description,
        templateId: template.id,
        dockerImage: dto.dockerImage,
        memoryBytes: BigInt(dto.memoryBytes),
        diskBytes: BigInt(dto.diskBytes),
        swapBytes: BigInt(dto.swapBytes),
        cpuPercent: dto.cpuPercent,
        ioWeight: dto.ioWeight,
        pidsLimit: dto.pidsLimit,
        oomKillDisabled: dto.oomKillDisabled,
        backupLimit: dto.backupLimit,
        allocationLimit: dto.allocationLimit,
        databaseLimit: dto.databaseLimit,
        active: dto.active,
        nodes: { connect: nodes.map((node) => ({ id: node.id })) },
      },
      include: planInclude,
    });

    return toView(plan);
  }

  async update(uuid: string, dto: UpdatePlanDto): Promise<PlanView> {
    const plan = await this.prisma.plan.findUnique({
      where: { uuid },
      select: { id: true, templateId: true },
    });

    if (!plan) {
      throw new NotFoundException('Plan not found.');
    }

    const data: Prisma.PlanUpdateInput = {};

    if (dto.templateUuid !== undefined) {
      const template = await this.prisma.template.findUnique({
        where: { uuid: dto.templateUuid },
        select: { id: true },
      });

      if (!template) {
        throw new BadRequestException('Template not found.');
      }

      data.template = { connect: { id: template.id } };
    }

    if (dto.dockerImage !== undefined) {
      // Checked against the template the plan will have once this update
      // lands, not the one it has now: moving both at once is exactly how an
      // operator switches an offer from one server software to another.
      const templateUuid = dto.templateUuid;
      const template = await this.prisma.template.findUnique({
        where: templateUuid === undefined ? { id: plan.templateId } : { uuid: templateUuid },
        select: { dockerImages: true },
      });

      this.assertImageBelongsToTemplate(dto.dockerImage, template?.dockerImages ?? null);
      data.dockerImage = dto.dockerImage;
    }

    if (dto.slug !== undefined) {
      const clash = await this.prisma.plan.findUnique({
        where: { slug: dto.slug },
        select: { id: true },
      });

      if (clash && clash.id !== plan.id) {
        throw new ConflictException(`A plan named "${dto.slug}" already exists.`);
      }

      data.slug = dto.slug;
    }

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.memoryBytes !== undefined) data.memoryBytes = BigInt(dto.memoryBytes);
    if (dto.diskBytes !== undefined) data.diskBytes = BigInt(dto.diskBytes);
    if (dto.swapBytes !== undefined) data.swapBytes = BigInt(dto.swapBytes);
    if (dto.cpuPercent !== undefined) data.cpuPercent = dto.cpuPercent;
    if (dto.ioWeight !== undefined) data.ioWeight = dto.ioWeight;
    if (dto.pidsLimit !== undefined) data.pidsLimit = dto.pidsLimit;
    if (dto.oomKillDisabled !== undefined) data.oomKillDisabled = dto.oomKillDisabled;
    if (dto.backupLimit !== undefined) data.backupLimit = dto.backupLimit;
    if (dto.allocationLimit !== undefined) data.allocationLimit = dto.allocationLimit;
    if (dto.databaseLimit !== undefined) data.databaseLimit = dto.databaseLimit;
    if (dto.active !== undefined) data.active = dto.active;

    if (dto.nodeUuids !== undefined) {
      const nodes = await this.resolveNodes(dto.nodeUuids);
      // `set` and not `connect`: the list replaces what was there, so removing
      // a node from an offer is expressible. `connect` alone would make the
      // list only ever grow, silently.
      data.nodes = { set: nodes.map((node) => ({ id: node.id })) };
    }

    const updated = await this.prisma.plan.update({
      where: { id: plan.id },
      data,
      include: planInclude,
    });

    return toView(updated);
  }

  /**
   * Deletes an offer.
   *
   * The servers sold under it are untouched — `planId` is nulled by the
   * foreign key — so this is safe in the sense that nothing stops running. It
   * still loses the answer to "what was this sold under", which is why
   * deactivating is the gentler move and the one an operator usually wants.
   */
  async remove(uuid: string): Promise<void> {
    const plan = await this.prisma.plan.findUnique({ where: { uuid }, select: { id: true } });

    if (!plan) {
      throw new NotFoundException('Plan not found.');
    }

    await this.prisma.plan.delete({ where: { id: plan.id } });
  }

  /**
   * Where a server on this plan could go right now, and why not.
   *
   * Exposed as a question of its own rather than only answered while
   * provisioning: a provider wants to know whether an offer is still sellable
   * *before* a customer pays for it, and "sold out" shown on a website is worth
   * far more than a refund issued afterwards.
   */
  async placementFor(slug: string): Promise<{ plan: PlanView; placement: PlacementResult }> {
    const plan = await this.findBySlug(slug);
    const candidates = await this.candidates(plan);

    return {
      plan,
      placement: choosePlacement(candidates, {
        memoryBytes: plan.limits.memoryBytes,
        diskBytes: plan.limits.diskBytes,
      }),
    };
  }

  /**
   * Builds the candidate list a placement decides on.
   *
   * Three aggregates rather than one query per node: an instance with fifty
   * nodes would otherwise spend a hundred and fifty round trips answering a
   * question asked on every purchase.
   */
  async candidates(plan: PlanView): Promise<PlacementCandidate[]> {
    const allowed = plan.nodes.map((node) => node.uuid);

    const nodes = await this.prisma.node.findMany({
      where: allowed.length === 0 ? {} : { uuid: { in: allowed } },
      select: {
        id: true,
        uuid: true,
        name: true,
        maintenance: true,
        memoryBytes: true,
        diskBytes: true,
        memoryOverallocation: true,
        diskOverallocation: true,
      },
      orderBy: { id: 'asc' },
    });

    if (nodes.length === 0) {
      return [];
    }

    const ids = nodes.map((node) => node.id);

    const [load, free] = await Promise.all([
      this.prisma.server.groupBy({
        by: ['nodeId'],
        where: { nodeId: { in: ids } },
        _sum: { memoryBytes: true, diskBytes: true },
        _count: { _all: true },
      }),
      this.prisma.allocation.groupBy({
        by: ['nodeId'],
        where: { nodeId: { in: ids }, serverId: null },
        _count: { _all: true },
      }),
    ]);

    const loadByNode = new Map(load.map((row) => [row.nodeId, row]));
    const freeByNode = new Map(free.map((row) => [row.nodeId, row._count._all]));

    return nodes.map((node) => {
      const row = loadByNode.get(node.id);

      return {
        id: node.id,
        uuid: node.uuid,
        name: node.name,
        maintenance: node.maintenance,
        memoryBytes: node.memoryBytes,
        diskBytes: node.diskBytes,
        memoryOverallocation: node.memoryOverallocation,
        diskOverallocation: node.diskOverallocation,
        allocatedMemoryBytes: row?._sum.memoryBytes ?? 0n,
        allocatedDiskBytes: row?._sum.diskBytes ?? 0n,
        freeAllocations: freeByNode.get(node.id) ?? 0,
        serverCount: row?._count._all ?? 0,
      };
    });
  }

  private async resolveNodes(uuids: string[]): Promise<{ id: number }[]> {
    if (uuids.length === 0) {
      return [];
    }

    const nodes = await this.prisma.node.findMany({
      where: { uuid: { in: uuids } },
      select: { id: true, uuid: true },
    });

    if (nodes.length !== uuids.length) {
      const found = new Set(nodes.map((node) => node.uuid));
      const missing = uuids.filter((uuid) => !found.has(uuid));

      // Named, because an offer restricted to a node that does not exist is an
      // offer that can never be sold — and the failure would otherwise appear
      // much later, as "no node available", on a customer's purchase.
      throw new BadRequestException(`Unknown node: ${missing.join(', ')}.`);
    }

    return nodes.map((node) => ({ id: node.id }));
  }

  /**
   * Refuses an image the template does not offer.
   *
   * `resolveDockerImage` already refuses one when a server is created, so this
   * check adds no safety — it moves *when* the refusal happens. Without it the
   * mistake is made once, writing the offer, and paid for every time somebody
   * buys it: the first person to find out is a customer whose purchase failed.
   */
  private assertImageBelongsToTemplate(image: string, dockerImages: Prisma.JsonValue): void {
    if (image === '') {
      return;
    }

    const known = parseDockerImages(dockerImages);

    if (!known.includes(image)) {
      throw new BadRequestException(
        known.length === 0
          ? 'This template declares no image, so a plan cannot pin one.'
          : `This template does not offer "${image}". It offers: ${known.join(', ')}.`,
      );
    }
  }
}

function toView(plan: Prisma.PlanGetPayload<{ include: typeof planInclude }>): PlanView {
  return {
    uuid: plan.uuid,
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    template: plan.template,
    dockerImage: plan.dockerImage,
    limits: {
      memoryBytes: plan.memoryBytes,
      diskBytes: plan.diskBytes,
      swapBytes: plan.swapBytes,
      cpuPercent: plan.cpuPercent,
      ioWeight: plan.ioWeight,
      pidsLimit: plan.pidsLimit,
      oomKillDisabled: plan.oomKillDisabled,
      backupLimit: plan.backupLimit,
      allocationLimit: plan.allocationLimit,
      databaseLimit: plan.databaseLimit,
    },
    nodes: plan.nodes,
    active: plan.active,
    createdAt: plan.createdAt,
  };
}

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../auth/auth.service.js';
import { AUDIT_EVENTS, AuditService, type AuditEvent } from '../audit/audit.service.js';
import { choosePlacement, type PlacementRejection } from '../plans/placement.js';
import { PlansService, type PlanView } from '../plans/plans.service.js';
import { ServersService } from '../servers/servers.service.js';
import { UsersService } from '../users/users.service.js';
import {
  usernameFromEmail,
  type ChangePlanDto,
  type ProvisionServerDto,
} from './provisioning.dto.js';

/** Who acted, for the entries a person did not write. */
export interface ActingApplication {
  id: number;
  name: string;
}

/**
 * A server, as the API that sold it describes it.
 *
 * Its own shape rather than the panel's `ServerListItem`. That one exists to
 * fill a screen and changes when the screen does; this one is a contract a
 * third party's software is written against, and the two moving together would
 * make every interface tweak a breaking change for every integrator.
 */
export interface ProvisionedServer {
  uuid: string;
  name: string;
  status: string;
  plan: { slug: string; name: string } | null;
  owner: { uuid: string; email: string; username: string };
  /** Where players connect. `host` is the alias when the port has one. */
  address: { host: string; port: number } | null;
  node: { name: string };
  limits: { memoryBytes: bigint; diskBytes: bigint; cpuPercent: number };
  createdAt: Date;
}

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly servers: ServersService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Delivers a server: an account if there is none, a machine, a port, and the
   * offer's limits.
   *
   * One call, because the alternative is five — find or create the customer,
   * list the nodes, pick one, find a free port, create — each of which is a
   * chance for a billing system to stop halfway and leave a customer with a
   * half-delivered purchase.
   */
  async provision(
    dto: ProvisionServerDto,
    application: ActingApplication,
    context: RequestContext,
  ): Promise<{ server: ProvisionedServer; ownerCreated: boolean }> {
    const plan = await this.plans.findBySlug(dto.plan);

    if (!plan.active) {
      // Refused rather than sold. A withdrawn offer is one an operator decided
      // to stop selling, and a billing system still holding it in a product is
      // exactly the case this catches.
      throw new ConflictException(`The plan "${plan.slug}" is no longer sold.`);
    }

    const { owner, created } = await this.findOrCreateOwner(dto.owner, context);

    const placement = choosePlacement(await this.plans.candidates(plan), {
      memoryBytes: plan.limits.memoryBytes,
      diskBytes: plan.limits.diskBytes,
    });

    if (placement.chosen === null) {
      throw new ConflictException(noRoomMessage(plan, placement.rejected));
    }

    const allocation = await this.prisma.allocation.findFirst({
      where: { nodeId: placement.chosen.id, serverId: null },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
      select: { id: true },
    });

    if (!allocation) {
      // Placement counted a free port a moment ago and there is none now:
      // another purchase took the last one in between. Told as a conflict,
      // which is what it is, and retryable — the next call will find another
      // node or say there is none.
      throw new ConflictException(
        `Node ${placement.chosen.name} ran out of free ports while this server was being created. Retry.`,
      );
    }

    const server = await this.servers.create(
      {
        name: dto.name,
        description: dto.description,
        ownerUuid: owner.uuid,
        nodeUuid: placement.chosen.uuid,
        templateUuid: plan.template.uuid,
        planUuid: plan.uuid,
        allocationId: allocation.id,
        memoryBytes: Number(plan.limits.memoryBytes),
        diskBytes: Number(plan.limits.diskBytes),
        swapBytes: Number(plan.limits.swapBytes),
        cpuPercent: plan.limits.cpuPercent,
        cpuSet: '',
        ioWeight: plan.limits.ioWeight,
        pidsLimit: plan.limits.pidsLimit,
        oomKillDisabled: plan.limits.oomKillDisabled,
        backupLimit: plan.limits.backupLimit,
        allocationLimit: plan.limits.allocationLimit,
        databaseLimit: plan.limits.databaseLimit,
        variables: dto.variables,
        dockerImage: plan.dockerImage === '' ? undefined : plan.dockerImage,
        startOnCompletion: dto.startOnCompletion,
      },
      // Nobody acted. `servers.create` records its own audit entry with a null
      // actor; the one below names the integration, which is the part a person
      // reading the trail actually wants.
      null,
      context,
    );

    await this.record(AUDIT_EVENTS.SERVER_PROVISIONED, application, context, {
      server: server.uuid,
      plan: plan.slug,
      node: placement.chosen.name,
      owner: owner.email,
      ownerCreated: created,
    });

    return { server: await this.describe(server.uuid), ownerCreated: created };
  }

  async find(uuid: string): Promise<ProvisionedServer> {
    return this.describe(uuid);
  }

  /**
   * Lists what this instance has sold, newest first.
   *
   * Filterable by owner email and by plan, which are the two questions a
   * billing system asks: "what does this customer have" and "who is on the
   * offer I am about to retire".
   */
  async list(filter: { ownerEmail?: string; plan?: string }): Promise<ProvisionedServer[]> {
    const servers = await this.prisma.server.findMany({
      where: {
        owner:
          filter.ownerEmail === undefined ? undefined : { email: filter.ownerEmail.toLowerCase() },
        plan: filter.plan === undefined ? undefined : { slug: filter.plan },
      },
      select: { uuid: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return Promise.all(servers.map((server) => this.describe(server.uuid)));
  }

  /**
   * Suspends or reinstates, and says whether anything moved.
   *
   * Repeating either is not an error. A billing system reacting to an unpaid
   * invoice sends "suspend" on a schedule, and answering `409` to the second
   * one would have every integrator write the same "is it already suspended"
   * check — a check that races with the panel's own screen.
   */
  async setSuspended(
    uuid: string,
    suspended: boolean,
    application: ActingApplication,
    context: RequestContext,
  ): Promise<{ server: ProvisionedServer; changed: boolean }> {
    const existing = await this.prisma.server.findUnique({
      where: { uuid },
      select: { status: true },
    });

    if (!existing) {
      throw new NotFoundException('Server not found.');
    }

    const already = existing.status === 'SUSPENDED';

    if (already === suspended) {
      return { server: await this.describe(uuid), changed: false };
    }

    await this.servers.setSuspended(uuid, suspended, null, context);

    await this.record(
      suspended ? AUDIT_EVENTS.SERVER_SUSPENDED : AUDIT_EVENTS.SERVER_UNSUSPENDED,
      application,
      context,
      { server: uuid },
    );

    return { server: await this.describe(uuid), changed: true };
  }

  /**
   * Moves a server onto another offer.
   *
   * Limits only — the server stays on its machine. Moving it between nodes is
   * a transfer: it copies a world across a network, takes minutes, and can
   * fail halfway. Doing that silently because somebody bought more memory
   * would be the worst possible time to find out.
   */
  async changePlan(
    uuid: string,
    dto: ChangePlanDto,
    application: ActingApplication,
    context: RequestContext,
  ): Promise<ProvisionedServer> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: {
        id: true,
        node: { select: { uuid: true, name: true } },
        plan: { select: { slug: true } },
      },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    const plan = await this.plans.findBySlug(dto.plan);

    // A retired plan is refused for a new sale and allowed here: moving a
    // customer *off* an offer being withdrawn is exactly what an operator does
    // while retiring it.
    if (plan.nodes.length > 0 && !plan.nodes.some((node) => node.uuid === server.node.uuid)) {
      throw new ConflictException(
        `The plan "${plan.slug}" is not offered on ${server.node.name}, where this server runs. Moving it there is a transfer, not a change of plan.`,
      );
    }

    await this.servers.updateBuild(
      uuid,
      {
        memoryBytes: Number(plan.limits.memoryBytes),
        diskBytes: Number(plan.limits.diskBytes),
        swapBytes: Number(plan.limits.swapBytes),
        cpuPercent: plan.limits.cpuPercent,
        ioWeight: plan.limits.ioWeight,
        pidsLimit: plan.limits.pidsLimit,
        oomKillDisabled: plan.limits.oomKillDisabled,
        backupLimit: plan.limits.backupLimit,
        allocationLimit: plan.limits.allocationLimit,
        databaseLimit: plan.limits.databaseLimit,
      },
      null,
      context,
    );

    // After the limits, and only if they were accepted: a server recorded as
    // being on an offer whose memory it does not have is a support case nobody
    // can settle.
    await this.prisma.server.update({
      where: { id: server.id },
      data: { plan: { connect: { uuid: plan.uuid } } },
    });

    await this.record(AUDIT_EVENTS.SERVER_PLAN_CHANGED, application, context, {
      server: uuid,
      from: server.plan?.slug ?? null,
      to: plan.slug,
    });

    return this.describe(uuid);
  }

  /**
   * Deletes a server and everything it holds.
   *
   * Irreversible, and reachable by a machine — which is why the route it sits
   * behind is a `DELETE` with a `write` key, and why the audit entry names the
   * integration that asked. A billing system deleting on cancellation is the
   * point; a billing system deleting on a bug is what the trail is for.
   */
  async remove(
    uuid: string,
    application: ActingApplication,
    context: RequestContext,
  ): Promise<void> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: { name: true, plan: { select: { slug: true } } },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    await this.servers.remove(uuid, null, context);

    await this.record(AUDIT_EVENTS.SERVER_DELETED, application, context, {
      server: uuid,
      name: server.name,
      plan: server.plan?.slug ?? null,
    });
  }

  // -------------------------------------------------------------------------

  private async findOrCreateOwner(
    owner: ProvisionServerDto['owner'],
    context: RequestContext,
  ): Promise<{
    owner: { id: number; uuid: string; email: string; username: string };
    created: boolean;
  }> {
    const email = owner.email.toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, uuid: true, email: true, username: true },
    });

    if (existing) {
      return { owner: existing, created: false };
    }

    const username = owner.username ?? (await this.deriveUsername(email));

    // No password. `users.create` sets one nobody will ever know and emails an
    // invitation, which is the right flow for a customer who has just bought
    // something: a password chosen here would travel through a channel neither
    // of us controls, and usually stay unchanged.
    const view = await this.users.create({ email, username, role: 'USER' }, null, context);

    const created = await this.prisma.user.findUniqueOrThrow({
      where: { uuid: view.uuid },
      select: { id: true, uuid: true, email: true, username: true },
    });

    return { owner: created, created: true };
  }

  private async deriveUsername(email: string): Promise<string> {
    // The candidates are computed against a snapshot: two purchases landing in
    // the same millisecond can still collide, and `users.create` refuses the
    // second with "username taken". Rare, retryable, and cheaper than holding
    // a lock across an email being sent.
    const local = email.split('@')[0] ?? 'user';
    const like = local.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);

    const neighbours = await this.prisma.user.findMany({
      where: { username: { startsWith: like.slice(0, 3) } },
      select: { username: true },
      take: 2000,
    });

    const taken = new Set(neighbours.map((user) => user.username));

    return usernameFromEmail(email, (candidate) => taken.has(candidate));
  }

  private async describe(uuid: string): Promise<ProvisionedServer> {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      select: {
        uuid: true,
        name: true,
        status: true,
        memoryBytes: true,
        diskBytes: true,
        cpuPercent: true,
        createdAt: true,
        owner: { select: { uuid: true, email: true, username: true } },
        node: { select: { name: true } },
        plan: { select: { slug: true, name: true } },
        primaryAllocation: { select: { ip: true, port: true, alias: true } },
      },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return {
      uuid: server.uuid,
      name: server.name,
      status: server.status,
      plan: server.plan,
      owner: server.owner,
      address:
        server.primaryAllocation === null
          ? null
          : {
              // The alias when there is one: it is what a customer is told to
              // type, and an IP shown in its place is one they will paste into
              // a launcher and keep using after the node moves.
              host: server.primaryAllocation.alias ?? server.primaryAllocation.ip,
              port: server.primaryAllocation.port,
            },
      node: server.node,
      limits: {
        memoryBytes: server.memoryBytes,
        diskBytes: server.diskBytes,
        cpuPercent: server.cpuPercent,
      },
      createdAt: server.createdAt,
    };
  }

  /**
   * Writes an audit entry for an action no person took.
   *
   * `actorId` stays null — the column already means "issued by the system" —
   * and the integration's name goes in the metadata. Inventing a user to put
   * there would have the trail name somebody who was asleep.
   */
  private async record(
    event: AuditEvent,
    application: ActingApplication,
    context: RequestContext,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      event,
      actorId: null,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { ...metadata, applicationKey: application.name },
    });
  }
}

/**
 * Why a sale could not be delivered, in one sentence somebody can act on.
 *
 * "No node available" is the most expensive answer this API gives — it arrives
 * mid-purchase — and lifting a maintenance flag, adding ports and buying a
 * machine are three different afternoons.
 */
function noRoomMessage(plan: PlanView, rejected: PlacementRejection[]): string {
  if (rejected.length === 0) {
    return plan.nodes.length === 0
      ? `No node is declared, so "${plan.slug}" cannot be placed anywhere.`
      : `The plan "${plan.slug}" is restricted to nodes that no longer exist.`;
  }

  const detail = rejected.map((entry) => `${entry.node} (${entry.reason})`).join(', ');

  return `No node can take a server on "${plan.slug}" right now: ${detail}.`;
}

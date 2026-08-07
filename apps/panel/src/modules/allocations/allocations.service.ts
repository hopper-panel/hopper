import { NODE_CAPABILITIES } from '@hopper/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { ServerConfigurationService } from '../servers/server-configuration.service.js';

/**
 * Ports assigned to a server.
 *
 * An allocation belongs to the **node** and is lent to the server: taking it
 * away returns it to the pool, it is never deleted. That is what lets an
 * administrator keep control of the ports open on their machine while the
 * server's user disposes of them freely within the limit they were given.
 *
 * The primary port is the one injected into `server.properties` at startup:
 * changing it means sending the configuration back to the daemon, failing which
 * the panel would show one port and the server would listen on another.
 */
@Injectable()
export class AllocationsService {
  private readonly logger = new Logger(AllocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configurations: ServerConfigurationService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const allocations = await this.prisma.allocation.findMany({
      where: { serverId: server.id },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
    });

    const available = await this.prisma.allocation.count({
      where: { nodeId: server.nodeId, serverId: null },
    });

    return {
      data: allocations.map((allocation) => ({
        id: allocation.id,
        ip: allocation.ip,
        port: allocation.port,
        alias: allocation.alias,
        role: allocation.role,
        primary: allocation.id === server.primaryAllocationId,
      })),
      meta: {
        limit: server.allocationLimit,
        used: allocations.length,
        /** Free ports on the node: without them, "add" leads nowhere. */
        availableOnNode: available,
      },
    };
  }

  /** Changes the note shown beside a port. */
  async setAlias(serverUuid: string, allocationId: number, alias: string | null) {
    const server = await this.requireServer(serverUuid);
    await this.requireAllocation(server.id, allocationId);

    const updated = await this.prisma.allocation.update({
      where: { id: allocationId },
      data: { alias: alias?.trim() ? alias.trim() : null },
    });

    return {
      id: updated.id,
      ip: updated.ip,
      port: updated.port,
      alias: updated.alias,
      role: updated.role,
      primary: updated.id === server.primaryAllocationId,
    };
  }

  /**
   * Names a port, so the server's own configuration can reach it by something
   * other than its number.
   *
   * The name is a lookup key: a readiness strategy declaring `role: 'rcon'`
   * knocks on whichever port carries it. That is why this refuses rather than
   * warns in three places — a name that does not do what it says is worse than
   * no name at all, because the thing reading it will silently use the game
   * port instead and stop a healthy server at its deadline.
   *
   * Clearing a name is never refused, whatever the node has to say. Taking a
   * name away can only ever make a strategy fall back to refusing out loud,
   * and an operator undoing a mistake must not be blocked by the machine that
   * mistake is on.
   */
  async setRole(serverUuid: string, allocationId: number, role: string | null) {
    const server = await this.requireServer(serverUuid);
    await this.requireAllocation(server.id, allocationId);

    if (role !== null) {
      if (server.primaryAllocationId === allocationId) {
        throw new ConflictException(
          'The primary port is already reached by being the primary one, and cannot carry a name as well. ' +
            'Name one of the other ports, or designate another port as primary first.',
        );
      }

      const taken = await this.prisma.allocation.findFirst({
        where: { serverId: server.id, role, id: { not: allocationId } },
      });

      // The unique index would refuse this too, as a P2002 the operator reads
      // as "Internal server error". This exists to say which port already has
      // the name.
      if (taken) {
        throw new ConflictException(
          `Port ${taken.port} on this server is already named "${role}". A name means one port.`,
        );
      }

      await this.requireRolesHonoured(server.nodeId, role);
    }

    const updated = await this.prisma.allocation.update({
      where: { id: allocationId },
      data: { role },
    });

    // No rebuild: a name changes nothing about which ports the container
    // publishes, only about how the server's own configuration finds them.
    await this.pushConfiguration(serverUuid, server.nodeId);

    return {
      id: updated.id,
      ip: updated.ip,
      port: updated.port,
      alias: updated.alias,
      role: updated.role,
      primary: updated.id === server.primaryAllocationId,
    };
  }

  /**
   * Refuses to store a name the node's daemon would throw away.
   *
   * This is the version-skew hole, and it is the silent kind. `role` travels
   * inside the server configuration, and Zod strips keys a schema does not
   * know — so a daemon predating names receives the allocation without one,
   * resolves the readiness strategy against the primary port, and reports
   * nothing at all. The panel would show a named port, the operator would
   * believe the check ran, and what actually happened is the daemon knocking
   * on the game port until the deadline stopped a server that was up.
   *
   * There is no answer to that inside the payload: the older daemon cannot
   * complain about a field it has already discarded. So the panel asks the
   * node what it honours before writing anything, and refuses if the answer is
   * not "names". `CONTRACT_VERSION` was the other candidate and is not an
   * option: the panel marks a node announcing a different one unreachable
   * outright, so bumping it takes every server on every node offline until the
   * last daemon is upgraded.
   *
   * An unreachable node is refused too. "It will probably be fine" is the same
   * guess this whole path exists to avoid, and naming a port is not urgent —
   * it takes effect on the next start either way.
   *
   * What this does **not** cover: a node downgraded after a name was saved.
   * The name stays in the database, the older daemon strips it, and nothing
   * notices. Closing that needs the capability re-checked when the
   * configuration is pushed rather than when it is stored, and that belongs
   * with whatever else the panel comes to gate on capabilities.
   *
   * The asking itself lives in `NodeClientService.honoursCapability`, shared
   * with the gate on the RCON stop transport. What must not be shared is the
   * wording: a refusal that does not name the thing being refused is a refusal
   * nobody can act on.
   */
  private async requireRolesHonoured(nodeId: number, role: string): Promise<void> {
    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: nodeId },
      select: { uuid: true },
    });

    const verdict = await this.client.honoursCapability(
      await this.nodes.getConnection(node.uuid),
      NODE_CAPABILITIES.allocationRoles,
    );

    if (verdict.honoured) {
      return;
    }

    if (!verdict.reachable) {
      throw new ServiceUnavailableException(
        `This server's node cannot be reached (${verdict.reason}), so there is no telling whether it would honour the name "${role}". Try again once it answers.`,
      );
    }

    throw new ConflictException(
      `The daemon on this server's node is too old to understand named ports: it would ignore "${role}" without a word and go on using the primary port. Upgrade the node, then name the port.`,
    );
  }

  /**
   * Designates the primary port.
   *
   * Takes effect on the **next start**: the port is written into the server's
   * configuration, which the daemon applies at launch. Changing it on a running
   * server does not move what it listens on, and saying so beats letting it
   * look like a breakage.
   */
  async setPrimary(serverUuid: string, allocationId: number) {
    const server = await this.requireServer(serverUuid);
    const allocation = await this.requireAllocation(server.id, allocationId);

    if (server.primaryAllocationId === allocationId) {
      return { changed: false };
    }

    // A named port promoted to primary would lose its name in silence — the
    // configuration gives the primary allocation no field to carry one — and
    // every strategy naming it would start refusing, on a server nobody had
    // touched apart from this click. Clearing the name is the operator's
    // decision to take, not this method's to take for them.
    if (allocation.role) {
      throw new ConflictException(
        `This port is named "${allocation.role}", and the primary port carries no name. Clear the name first, then make it primary.`,
      );
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { primaryAllocationId: allocationId, requiresRebuild: true },
    });

    await this.pushConfiguration(serverUuid, server.nodeId);

    return { changed: true };
  }

  /**
   * Assigns a free port from the node.
   *
   * The choice is made by the panel, not by the user: letting them name a port
   * would amount to letting them ask for any port on the machine, including
   * those reserved for other servers.
   */
  async add(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    if (server.allocationLimit <= 0) {
      throw new BadRequestException('This server is not allowed to hold additional ports.');
    }

    const used = await this.prisma.allocation.count({ where: { serverId: server.id } });

    if (used >= server.allocationLimit) {
      throw new ConflictException(
        `This server already uses its ${server.allocationLimit} allowed port(s).`,
      );
    }

    const free = await this.prisma.allocation.findFirst({
      where: { nodeId: server.nodeId, serverId: null },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
    });

    if (!free) {
      throw new ConflictException(
        'No free port on this node. An administrator has to add some to the machine.',
      );
    }

    // `updateMany` with the `serverId: null` condition: two simultaneous
    // requests cannot be given the same port, the database decides.
    //
    // `role: null` clears whatever name the port carried for its last owner,
    // and clearing it *here* — where a port enters a server — is what makes the
    // invariant hold rather than depending on every release path remembering.
    // Deleting a server does not go through `remove`: the foreign key is
    // `ON DELETE SET NULL`, which nulls `serverId` and leaves the name behind.
    // A port that came back from a server called `rcon` would then be handed to
    // the next server that asks for one, which would inherit a name it never
    // chose — and a template resolving that role would knock on it believing an
    // operator had meant it.
    const claimed = await this.prisma.allocation.updateMany({
      where: { id: free.id, serverId: null },
      data: { serverId: server.id, role: null },
    });

    if (claimed.count === 0) {
      throw new ConflictException('This port has just been assigned elsewhere, try again.');
    }

    // A container's published ports are fixed when it is created, so a new
    // address only becomes real once the container is rebuilt. Without this
    // flag the interface's "takes effect on the next start" was a promise
    // nothing kept: the server restarted on the old port and the panel
    // displayed the new one.
    await this.markForRebuild(server.id);
    await this.pushConfiguration(serverUuid, server.nodeId);

    return {
      id: free.id,
      ip: free.ip,
      port: free.port,
      alias: free.alias,
      role: free.role,
      primary: false,
    };
  }

  /** Returns a port to the node. The primary port cannot be taken away. */
  async remove(serverUuid: string, allocationId: number): Promise<void> {
    const server = await this.requireServer(serverUuid);
    await this.requireAllocation(server.id, allocationId);

    if (server.primaryAllocationId === allocationId) {
      throw new ConflictException(
        'The primary port cannot be taken away. Designate another one first.',
      );
    }

    // The name goes back with the port, like the alias. A name belongs to the
    // server that gave it, not to the port: leaving it on would hand the next
    // server to be given this port a `rcon` it never asked for, and the
    // uniqueness the whole design rests on is per server, so nothing in the
    // database would object.
    await this.prisma.allocation.update({
      where: { id: allocationId },
      data: { serverId: null, alias: null, role: null },
    });

    await this.markForRebuild(server.id);
    await this.pushConfiguration(serverUuid, server.nodeId);
  }

  /**
   * Marks the container as needing to be rebuilt on the next start.
   *
   * Docker fixes a container's published ports when it is created. Changing a
   * server's addresses without this changed the row, the interface and the
   * configuration the node holds — and nothing else: the server came back up
   * on exactly the ports it had before, at an address the panel no longer
   * showed.
   */
  private async markForRebuild(serverId: number): Promise<void> {
    await this.prisma.server.update({
      where: { id: serverId },
      data: { requiresRebuild: true },
    });
  }

  /**
   * Sends the configuration back to the daemon.
   *
   * A failure does not undo the change: it is recorded in the database, and the
   * daemon will pick it up at its next reconciliation. Refusing the operation
   * because the node is momentarily unreachable would leave the panel and the
   * machine lastingly out of tune.
   */
  private async pushConfiguration(serverUuid: string, nodeId: number): Promise<void> {
    try {
      const node = await this.prisma.node.findUniqueOrThrow({
        where: { id: nodeId },
        select: { uuid: true },
      });

      const configuration = await this.configurations.build(serverUuid);
      const connection = await this.nodes.getConnection(node.uuid);

      await this.client.syncServer(connection, configuration);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not sync server ${serverUuid}; it will be caught up the next time ` +
          `the daemon starts: ${String(error)}`,
      );
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({ where: { uuid } });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    return server;
  }

  private async requireAllocation(serverId: number, allocationId: number) {
    const allocation = await this.prisma.allocation.findFirst({
      where: { id: allocationId, serverId },
    });

    if (!allocation) {
      throw new NotFoundException('This port is not assigned to this server.');
    }

    return allocation;
  }
}

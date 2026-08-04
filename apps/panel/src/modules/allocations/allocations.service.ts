import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
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
      primary: updated.id === server.primaryAllocationId,
    };
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
    await this.requireAllocation(server.id, allocationId);

    if (server.primaryAllocationId === allocationId) {
      return { changed: false };
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { primaryAllocationId: allocationId },
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
      throw new BadRequestException(
        'This server is not allowed to hold additional ports.',
      );
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
    const claimed = await this.prisma.allocation.updateMany({
      where: { id: free.id, serverId: null },
      data: { serverId: server.id },
    });

    if (claimed.count === 0) {
      throw new ConflictException('This port has just been assigned elsewhere, try again.');
    }

    await this.pushConfiguration(serverUuid, server.nodeId);

    return { id: free.id, ip: free.ip, port: free.port, alias: free.alias, primary: false };
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

    await this.prisma.allocation.update({
      where: { id: allocationId },
      data: { serverId: null, alias: null },
    });

    await this.pushConfiguration(serverUuid, server.nodeId);
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
      throw new NotFoundException('Serveur introuvable.');
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

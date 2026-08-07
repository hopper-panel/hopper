import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { NodeClientService, type NodeConnection } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { ServerConfigurationService } from './server-configuration.service.js';

/**
 * Moving a server to another node.
 *
 * Everything here is driven by the panel, over endpoints the daemon already
 * has: list, compress, download, upload, decompress, delete. No node ever
 * talks to another node.
 *
 * That is the point. A daemon that could be told "fetch this URL" would be a
 * request forger sitting inside the private network, and the instruction would
 * arrive over the one channel an attacker who reached the panel already
 * controls. Relaying the bytes through the panel costs bandwidth and buys the
 * absence of that primitive — the archive is streamed, never held in memory,
 * so a twelve-gigabyte world crosses without the panel growing by a megabyte.
 *
 * The order is chosen so that a failure loses nothing. The source is only
 * destroyed once the target holds an extracted copy and the database has been
 * moved across; until that point the server still exists, still has its files,
 * and can simply be started again where it was.
 */

/** Compressing a large world takes minutes, not seconds. */
const ARCHIVE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long to wait for the server to actually stop before giving up. */
const STOP_TIMEOUT_MS = 2 * 60 * 1000;
const STOP_POLL_MS = 2000;

const TRANSFER_ARCHIVE = 'hopper-transfer.tar.gz';

export interface TransferPlan {
  /** Node the server is on today. */
  fromNode: string;
  /** Node it would move to. */
  toNode: string;
  /** Ports the target has free. Zero means the transfer cannot be prepared. */
  availableOnTarget: number;
  /** Databases whose SQL host is not reachable from the target node. */
  strandedDatabases: string[];
}

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
    private readonly configuration: ServerConfigurationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What would happen, without doing any of it.
   *
   * A transfer stops the server and moves gigabytes; an administrator deserves
   * to see the consequences — a stranded database especially — before the
   * button rather than in the log afterwards.
   */
  async plan(serverUuid: string, targetNodeUuid: string): Promise<TransferPlan> {
    const { server, target } = await this.endpoints(serverUuid, targetNodeUuid);

    const availableOnTarget = await this.prisma.allocation.count({
      where: { nodeId: target.id, serverId: null },
    });

    // A database host is either tied to a node or shared by all of them. A
    // tied one is often reachable at a loopback or a private address and from
    // that machine only, so a database on it stays behind: the server would
    // start on the target with a connection string pointing at nothing. A
    // shared host follows the server anywhere and is not a problem.
    const databases = await this.prisma.database.findMany({
      where: { serverId: server.id },
      include: { host: true },
    });

    const stranded = databases
      .filter((entry) => entry.host.nodeId !== null && entry.host.nodeId !== target.id)
      .map((entry) => entry.database);

    return {
      fromNode: server.node.name,
      toNode: target.name,
      availableOnTarget,
      strandedDatabases: stranded,
    };
  }

  /**
   * Moves the server, then removes what is left behind.
   *
   * Long — minutes for a large world — and deliberately synchronous: the caller
   * holds the request open and learns the outcome. A fire-and-forget transfer
   * would need a state machine to report a failure that happened while nobody
   * was looking, and a half-moved server is the state that machine would have
   * to be right about every time.
   */
  async transfer(
    serverUuid: string,
    targetNodeUuid: string,
    actorId: number,
    context: { ip: string; userAgent?: string },
  ): Promise<{ node: string }> {
    const { server, target } = await this.endpoints(serverUuid, targetNodeUuid);

    if (server.status !== 'READY') {
      throw new ConflictException('Only a server that is ready can be transferred.');
    }

    const freeAllocation = await this.prisma.allocation.findFirst({
      where: { nodeId: target.id, serverId: null },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
    });

    if (!freeAllocation) {
      throw new ConflictException('The target node has no free port to give this server.');
    }

    const source = await this.nodes.getConnection(server.node.uuid);
    const destination = await this.nodes.getConnection(target.uuid);

    await this.stopAndWait(source, server.uuid);

    let archive: string | null = null;

    try {
      archive = await this.archiveOn(source, server.uuid);

      // Built before the move so it still describes the server as it is; the
      // uuid does not change, which is what lets the daemon on the other side
      // adopt it without anything else being rewritten.
      const configuration = await this.configuration.build(server.uuid);

      await this.client.createServer(destination, configuration, false);

      await this.copyAcross(source, destination, server.uuid, archive);

      await this.extractOn(destination, server.uuid);
    } catch (error) {
      // The source is untouched: its files are still there and the container
      // still exists. Removing whatever reached the target leaves the instance
      // exactly as it was, with a server that can be started again in place.
      this.logger.error(`Transfer of ${server.uuid} failed: ${String(error)}`);
      await this.discard(destination, server.uuid);
      await this.removeQuietly(source, server.uuid, archive);

      throw error;
    }

    // Only now. Everything above can fail without consequence; from here the
    // database says the server lives on the target, and it does.
    await this.prisma.$transaction(async (tx) => {
      // The names go back with the ports. A role names a port *for one server*
      // — a template resolves `rcon` against the server that holds it — so a
      // name released into the source node's pool means nothing to anybody, and
      // would be inherited by whichever server is handed that port next.
      await tx.allocation.updateMany({
        where: { serverId: server.id },
        data: { serverId: null, role: null },
      });

      // And the port taken on the target arrives unnamed, whatever it carried
      // for its last owner. It becomes this server's primary below, and a
      // primary carrying a name is a state `setRole` and `setPrimary` both
      // refuse to create deliberately.
      await tx.allocation.update({
        where: { id: freeAllocation.id },
        data: { serverId: server.id, role: null },
      });

      await tx.server.update({
        where: { id: server.id },
        data: { nodeId: target.id, primaryAllocationId: freeAllocation.id },
      });
    });

    // The source copy goes last and its failure is not the transfer's failure:
    // the server is already running from the target, and an administrator can
    // clear a leftover volume. Undoing a completed move to satisfy a cleanup
    // would be the worse outcome by far.
    try {
      await this.client.deleteServer(source, server.uuid, true);
    } catch (error) {
      this.logger.error(
        `Server ${server.uuid} moved to ${target.name}, but its old copy on ${server.node.name} could not be removed: ${String(error)}`,
      );
    }

    // The address changed, so the daemon that now holds it needs to be told.
    await this.client.syncServer(destination, await this.configuration.build(server.uuid));

    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_TRANSFERRED,
      actorId,
      serverId: server.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { from: server.node.name, to: target.name, port: freeAllocation.port },
    });

    return { node: target.name };
  }

  // -------------------------------------------------------------------------

  /**
   * Stops the server and waits for it to have stopped.
   *
   * Archiving a running world copies files mid-write: the chunks the server
   * has in memory are not on disk, and the region files that are may be
   * half-written. What arrives on the other node would be a world that loads
   * with holes in it — the kind of damage nobody notices until a player walks
   * into it.
   */
  private async stopAndWait(node: NodeConnection, uuid: string): Promise<void> {
    const state = await this.client.fetchServerState(node, uuid);

    if (state === 'offline') {
      return;
    }

    await this.client.powerServer(node, uuid, 'stop');

    const deadline = Date.now() + STOP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));

      if ((await this.client.fetchServerState(node, uuid)) === 'offline') {
        return;
      }
    }

    // Not killed. A server that ignores `stop` for two minutes is saving
    // something or stuck, and killing it here would produce exactly the
    // half-written world this wait exists to avoid. The administrator decides.
    throw new ConflictException(
      'The server did not stop within two minutes. Stop it yourself — killing it here could damage the world being written.',
    );
  }

  /** Compresses the whole volume and returns the archive's path. */
  private async archiveOn(node: NodeConnection, uuid: string): Promise<string> {
    const listing = this.expectJson<{ name: string }[]>(
      await this.client.proxy(node, `/api/servers/${uuid}/files/list?directory=/`, {
        method: 'GET',
        timeoutMs: 60_000,
      }),
      'listing the files',
    );

    const files = listing.map((entry) => entry.name);

    if (files.length === 0) {
      throw new BadRequestException('This server has no files to transfer.');
    }

    // Listed first, compressed second, so the archive cannot contain itself.
    const stat = this.expectJson<{ name: string }>(
      await this.client.proxy(node, `/api/servers/${uuid}/files/compress`, {
        method: 'POST',
        body: { directory: '/', files },
        timeoutMs: ARCHIVE_TIMEOUT_MS,
      }),
      'compressing the server',
    );

    return `/${stat.name}`;
  }

  /** Streams the archive from one node to the other, through the panel. */
  private async copyAcross(
    source: NodeConnection,
    destination: NodeConnection,
    uuid: string,
    archive: string,
  ): Promise<void> {
    const download = await this.client.stream(
      source,
      `/api/servers/${uuid}/files/download?file=${encodeURIComponent(archive)}`,
    );

    if (download.status !== 200 || !download.body) {
      throw new BadRequestException('The archive could not be read from the source node.');
    }

    const upload = await this.client.pipeTo(
      destination,
      `/api/servers/${uuid}/files/upload?directory=/&name=${TRANSFER_ARCHIVE}`,
      Readable.fromWeb(download.body as never),
      download.headers.get('content-length') ?? undefined,
    );

    if (upload.status >= 400) {
      throw new BadRequestException(
        `The target node refused the archive (${upload.status}). It may not have the disk space.`,
      );
    }
  }

  private async extractOn(node: NodeConnection, uuid: string): Promise<void> {
    const extracted = await this.client.proxy(node, `/api/servers/${uuid}/files/decompress`, {
      method: 'POST',
      body: { file: `/${TRANSFER_ARCHIVE}`, directory: '/' },
      timeoutMs: ARCHIVE_TIMEOUT_MS,
    });

    if (extracted.status >= 400) {
      throw new BadRequestException('The archive could not be extracted on the target node.');
    }

    // Leaving it would charge the server's disk quota for a copy of itself.
    await this.removeQuietly(node, uuid, `/${TRANSFER_ARCHIVE}`);
  }

  /** Removes a target that never became the server. */
  private async discard(node: NodeConnection, uuid: string): Promise<void> {
    try {
      await this.client.deleteServer(node, uuid, true);
    } catch (error) {
      this.logger.error(`Could not clean up the failed transfer of ${uuid}: ${String(error)}`);
    }
  }

  /** Best effort: a leftover archive is untidy, not a failure worth raising. */
  private async removeQuietly(
    node: NodeConnection,
    uuid: string,
    file: string | null,
  ): Promise<void> {
    if (!file) {
      return;
    }

    try {
      await this.client.proxy(node, `/api/servers/${uuid}/files/delete`, {
        method: 'POST',
        body: { directory: '/', files: [file.replace(/^\//, '')] },
      });
    } catch (error) {
      this.logger.warn(`Leftover archive ${file} on ${node.uuid}: ${String(error)}`);
    }
  }

  private expectJson<T>(response: { status: number; body: Buffer }, what: string): T {
    if (response.status >= 400) {
      throw new BadRequestException(`The node refused ${what} (${response.status}).`);
    }

    try {
      return JSON.parse(response.body.toString('utf8')) as T;
    } catch {
      throw new BadRequestException(`The node answered something unreadable while ${what}.`);
    }
  }

  private async endpoints(serverUuid: string, targetNodeUuid: string) {
    const server = await this.prisma.server.findUnique({
      where: { uuid: serverUuid },
      include: { node: true },
    });

    if (!server) {
      throw new NotFoundException('Server not found.');
    }

    const target = await this.prisma.node.findUnique({ where: { uuid: targetNodeUuid } });

    if (!target) {
      throw new NotFoundException('Target node not found.');
    }

    if (target.id === server.nodeId) {
      throw new BadRequestException('The server is already on that node.');
    }

    return { server, target };
  }
}

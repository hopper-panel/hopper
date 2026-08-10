import { readinessSchema, stopConfigurationSchema } from '@hopper/shared';
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
import { assertWholeLineParserHonoured } from './config-parsers.js';
import { assertStopTransportHonoured } from './stop-transport.js';

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

/**
 * The wait a server gets when its template names no deadline of its own.
 *
 * Two minutes, which is what every transfer has waited since the first release,
 * and it stays a floor rather than becoming one term of a sum: a template
 * declaring ten seconds must not shorten a wait that works today, and a
 * template declaring nothing must not have its wait changed at all.
 */
const STOP_WAIT_FLOOR_MS = 2 * 60 * 1000;

/**
 * Room on top of the deadline the daemon itself honours.
 *
 * The panel's wait and the daemon's are not the same clock. The daemon starts
 * counting when it writes the stop command; the panel started earlier, at the
 * HTTP request that carried it, and finds out the server is down on a poll two
 * seconds wide — after the SIGKILL that ends an expired deadline, after Docker
 * has reaped the container, after the state change has reached the API. Giving
 * the daemon exactly its own figure would have the panel give up in the seconds
 * between the kill and the news of it, on a stop that had in fact happened.
 */
const STOP_WAIT_MARGIN_MS = 30 * 1000;

/**
 * The point past which no stop is worth waiting for.
 *
 * `stopTimeoutSeconds` is bounded at 600 by the contract and by the template
 * definition, so this never binds on a value either of them wrote — it binds on
 * a hand-edited row or a restored dump, where the column is a plain nullable
 * integer with nothing in the database stopping it holding a day. Without a
 * ceiling that row does not fail a transfer: it holds the request open for as
 * long as it says, with the server already stopped and the operator watching a
 * spinner that will outlive their session.
 */
const STOP_WAIT_CEILING_MS = 15 * 60 * 1000;

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

    // Refused while the server is still running on the node it knows, and
    // before the node the operator picked is even asked anything — this costs
    // no round trip, and a transfer refused for a reason no upgrade can fix
    // should not spend one.
    //
    // What a transfer does to a named port is the reason. It claims exactly one
    // allocation on the target and releases every name the old ones carried —
    // a name means a port *for one server*, so it cannot follow the row across
    // on its own — and the server lands with a single unnamed port. A template
    // that resolves a port by name then finds nothing under it, for ever: Stop
    // is refused for want of that port, Restart with it, and Kill, the one
    // power action that needs no port, becomes the only way down. Which is
    // through the save an `rcon` stop was declared to protect. Nothing about
    // that state is repairable from the Network tab either — the name can be
    // given back, but only after the move has already cost a world.
    //
    // Carrying the names across was weighed and left out, not missed. It means
    // claiming one free allocation per declared role on the target inside the
    // same transaction, naming each of them, and failing the whole transfer
    // when the target is one port short of the set — a change to how a transfer
    // chooses its ports, which is a good deal more than adding a stop
    // transport. Until that exists, the honest answer is not to move the server.
    const roles = declaredPortRoles({
      ...server.template,
      startup: server.startupCommand,
    });

    if (roles.length > 0) {
      const named =
        roles.length === 1
          ? `a port named "${roles[0]}"`
          : `ports named ${roles.map((role) => `"${role}"`).join(' and ')}`;
      const those = roles.length === 1 ? 'that name' : 'those names';

      throw new ConflictException(
        `This server's template reaches ${named}, and a transfer can only give it one unnamed port on ${target.name}. ` +
          `It would arrive with nothing answering to ${those}: every Stop and every Restart would be refused, and ` +
          'Kill — which cuts the server off before it has written its world — would be the only way to bring it ' +
          `down. Move this one by hand instead: create the server on ${target.name}, give it ${named} in its ` +
          'Network tab, and restore a backup into it.',
      );
    }

    // Checked before the server is stopped, let alone moved. A transfer is the
    // other way a template meets a node, and landing a server that stops over
    // RCON on a daemon too old to read that field would leave the target unable
    // to parse the configurations of every server it already has — after this
    // one's files had been copied across and the original deleted.
    await assertStopTransportHonoured(
      server.template.stop,
      { name: target.name, connection: () => this.nodes.getConnection(target.uuid) },
      this.client,
    );

    // Likewise, and here the target's other servers are the ones at stake: a
    // parser it cannot read makes its whole page of configurations unreadable,
    // so the servers it already hosts go dark on arrival of this one.
    await assertWholeLineParserHonoured(
      server.template.configFiles,
      { name: target.name, connection: () => this.nodes.getConnection(target.uuid) },
      this.client,
    );

    const source = await this.nodes.getConnection(server.node.uuid);
    const destination = await this.nodes.getConnection(target.uuid);

    await this.stopAndWait(source, server.uuid, server.template.stopTimeoutSeconds);

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
   *
   * How long it waits is the template's business, not this file's — see
   * `stopWaitMs`.
   */
  private async stopAndWait(
    node: NodeConnection,
    uuid: string,
    stopTimeoutSeconds: number | null,
  ): Promise<void> {
    const state = await this.client.fetchServerState(node, uuid);

    if (state === 'offline') {
      return;
    }

    await this.client.powerServer(node, uuid, 'stop');

    const waitMs = stopWaitMs(stopTimeoutSeconds);
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));

      if ((await this.client.fetchServerState(node, uuid)) === 'offline') {
        return;
      }
    }

    // Not killed. A server still up after its own deadline and the margin on
    // top has either been SIGKILLed already and not noticed, or is stuck; a
    // kill from here would produce exactly the half-written world this wait
    // exists to avoid. The administrator decides.
    throw new ConflictException(
      `The server did not stop within ${Math.round(waitMs / 1000)} seconds. Stop it yourself — killing it here could damage the world being written.`,
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
      // The template comes along for everything the stop depends on: whether
      // this server can be stopped at all on the target node decides whether it
      // may go there, `readiness` is the second place a port name can be
      // declared, `configFiles` is the fourth, and `stopTimeoutSeconds` is how
      // long the stop below is waited for.
      //
      // The startup command is read off the *server*, not the template. It is
      // copied from the template at creation and editable afterwards, and it is
      // the server's copy the daemon actually runs — a name added there by an
      // operator counts exactly as much as one the template shipped with.
      include: {
        node: true,
        template: {
          select: { stop: true, readiness: true, stopTimeoutSeconds: true, configFiles: true },
        },
      },
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

/**
 * Every `{{server.allocations.<role>.…}}` token a startup command or a config
 * file replacement reaches for.
 *
 * The two structured declarations below are the ones a reader thinks of; these
 * two are the ones that bite. A template that writes
 * `--rcon-port {{server.allocations.rcon.port}}` in its startup command has
 * named a port just as surely as one that put it in a stop transport, and after
 * a transfer stripped the name the daemon refuses the start outright rather
 * than building a command nobody wrote. Config file replacements resolve the
 * same tokens on the way into `server.properties` and its equivalents.
 *
 * Matched rather than parsed because that is how the daemon reads them too —
 * the same shape as `invocation.ts`'s own pattern, deliberately, so the two
 * cannot drift into disagreeing about what counts as a name.
 */
const ALLOCATION_TOKEN = /\{\{server\.allocations\.([a-z][a-z0-9]*)\.(?:ip|port)\}\}/g;

function rolesInText(value: unknown, into: string[]): void {
  if (typeof value !== 'string') {
    return;
  }

  for (const match of value.matchAll(ALLOCATION_TOKEN)) {
    into.push(match[1]!);
  }
}

/**
 * Every port name a template reaches for, from all four places one can appear.
 *
 * All four, because they are written months apart by different hands and a
 * check that looked at some of them would pass the template it exists for. The
 * two structured ones — the stop transport and the readiness strategy — are the
 * obvious pair; the startup command and the config file replacements name a
 * port through a `{{server.allocations.<role>.port}}` token and are the easy
 * ones to forget, which is precisely why a transfer that stripped the name
 * would break them silently.
 *
 * They are collected together rather than answered separately because the
 * caller has one question: is there a name here that a transfer cannot honour.
 *
 * A structured value that does not parse declares nothing, deliberately. It is
 * not this function's failure to report: an unreadable `stop` is refused
 * outright when the configuration is built, and an unreadable `readiness` is
 * dropped there with an error to the log. Refusing a transfer over it would put
 * a message about ports in front of an operator whose template is broken in
 * some entirely unrelated way. The two text fields are scanned regardless of
 * whether anything else parses, since a token is a token.
 */
export function declaredPortRoles(template: {
  stop: unknown;
  readiness: unknown;
  startup?: unknown;
  configFiles?: unknown;
}): string[] {
  const roles: string[] = [];

  const stop = stopConfigurationSchema.safeParse(template.stop);

  if (stop.success && stop.data.type === 'rcon' && stop.data.role) {
    roles.push(stop.data.role);
  }

  const readiness = readinessSchema.safeParse(template.readiness);

  // `immediate` and `log` have no port to name; the union narrows to the two
  // arms that do. A strategy naming no role means the primary port, which is
  // the one thing a transfer *does* hand over, so it is not a role at all here.
  if (readiness.success && 'role' in readiness.data && readiness.data.role) {
    roles.push(readiness.data.role);
  }

  rolesInText(template.startup, roles);
  // Walked as raw JSON rather than parsed into `configFileSchema` first: a
  // replacement value is a string wherever it sits in that structure, and a
  // config file list that fails to parse is still a config file list whose
  // tokens the daemon would try to resolve.
  rolesInText(JSON.stringify(template.configFiles ?? null), roles);

  return [...new Set(roles)];
}

/**
 * How long a transfer waits for a stop, given what the template asked for.
 *
 * A constant two minutes was right for exactly as long as thirty seconds was
 * the only stop deadline in existence. A template can now declare up to six
 * hundred seconds and the shipped Factorio one declares two hundred and forty,
 * so a fixed wait is a second, shorter deadline sitting in front of the
 * daemon's: a mature world that takes a hundred and fifty seconds to serialise
 * is given up on with thirty to go, the transfer fails, and the operator is
 * told to stop a server that was in the middle of doing exactly that.
 *
 * So the figure follows the template, with a margin for the round trip — see
 * `STOP_WAIT_MARGIN_MS` — and is then clamped at both ends:
 *
 * - **A floor**, because a template declaring a small number must not shorten
 *   the wait a transfer has always had. The daemon SIGKILLs at its own deadline
 *   and the server goes down whether or not the panel is still watching; the
 *   only thing a shorter wait can add is a transfer that fails after the stop
 *   it asked for succeeded.
 * - **A ceiling**, because the column holding this is a nullable integer and
 *   nothing in the database bounds it. See `STOP_WAIT_CEILING_MS`.
 *
 * Null — which is what every template that has never named a deadline stores —
 * comes out as the floor, unchanged, which is the whole point of expressing
 * this as a clamp rather than a sum.
 */
export function stopWaitMs(stopTimeoutSeconds: number | null | undefined): number {
  const declaredMs = (stopTimeoutSeconds ?? 0) * 1000;

  return Math.min(
    Math.max(declaredMs + STOP_WAIT_MARGIN_MS, STOP_WAIT_FLOOR_MS),
    STOP_WAIT_CEILING_MS,
  );
}

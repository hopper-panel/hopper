import { allocationForRole, NODE_CAPABILITIES, stopConfigurationSchema } from '@hopper/shared';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { NodeClientService, NodeConnection } from '../nodes/node-client.service.js';

/**
 * Keeping a server that stops over RCON off a node that has never heard of it.
 *
 * A free function rather than a method, because two writes put a template and a
 * node together — creating a server, and transferring one — and both have to
 * ask the same question in the same words. A private copy in each service would
 * be two answers to a question with one right answer, and the second copy is
 * always the one that is forgotten when the rule changes.
 *
 * **What an older daemon does with an `rcon` stop is worse than ignoring it.**
 * `stopConfigurationSchema` is a discriminated union, so a daemon whose copy
 * knows only `command` and `signal` does not strip the field — it fails to
 * parse the object that contains it. That object is the server configuration,
 * and the daemon fetches those a page at a time: one unreadable server makes
 * the whole page unreadable, `reconcile` throws, and the node ends up knowing
 * about **none** of its servers. Every console on that node answers "server
 * unknown to this node", every power action fails, and the containers go on
 * running with nothing driving them.
 *
 * That is a whole node taken out by one template, and nothing in the payload
 * can warn anybody: the daemon's complaint goes into its own log, on the
 * machine the operator has no shell on. Hence a gate at the write.
 *
 * A template edited into an RCON stop once its servers exist is the third way
 * in, and it needs two gates rather than one, because the daemon refuses such a
 * stop on three separate grounds and only the first is about the node:
 * `assertStopTransportHonouredEverywhere` asks the daemon question of every node
 * those servers sit on, and `assertRconStopReachesEveryServer` asks the two the
 * daemon would put to each server itself.
 *
 * What this does **not** cover, stated rather than left to be discovered:
 *
 *  - a node **downgraded** after such a server was created. The row keeps its
 *    template, the older daemon chokes on the page, and nothing checks again.
 *  - a template edited into an RCON stop by anything other than the editor —
 *    the egg importer, a catalogue resynchronisation, the database. None of
 *    those is a moment when a server meets a node, and none of them asks.
 *  - **the verdict and the delivery are not the same moment for an edit.**
 *    Creating a server and transferring one both check and then push, so a
 *    cleared check is a configuration on the node seconds later.
 *    `TemplateEditorService.update` writes the row and pushes nothing: the
 *    permitted stop sits in the database until each daemon next fetches its
 *    page, which is at its own restart (`server-manager.ts`, `reconcile`) or
 *    the next time some other write happens to sync one of those servers. Every
 *    hour of that window is an hour in which the first bullet can happen to a
 *    node that answered yes.
 *  - **a server in the middle of a transfer still carries its old `nodeId`.**
 *    The node list is read from that column, and `transfer.service.ts` only
 *    rewrites it once the volume has arrived. So an edit can be cleared against
 *    the source node and then land on a target nobody asked — the transfer's
 *    own gate checked the template as it stood when the transfer began.
 *
 * The first two need the capability re-checked when a configuration is pushed
 * rather than when the server is placed, which is a larger change than this one
 * and belongs with the same fix for named ports. The last two need the edit to
 * push, which is that same change seen from the other end.
 */
export function declaresRconStop(stop: unknown): boolean {
  return rconStopTarget(stop) !== null;
}

/**
 * The `rcon` arm of a stop, or nothing.
 *
 * One parse behind both questions this file asks, because they are asked of the
 * same value a line apart and a second `safeParse` of the same JSON is a second
 * chance to disagree about what an unreadable one means.
 *
 * An unreadable value is not gated, deliberately: it is not an RCON stop, and
 * `parseStop` refuses that server outright when its configuration is built —
 * which is the louder failure, and the right one. Guessing here would refuse a
 * creation with a message about node versions when nothing about the node is
 * wrong.
 */
export function rconStopTarget(stop: unknown): { role?: string; secretVariable: string } | null {
  if (stop === null || stop === undefined) {
    return null;
  }

  const parsed = stopConfigurationSchema.safeParse(stop);

  return parsed.success && parsed.data.type === 'rcon'
    ? { role: parsed.data.role, secretVariable: parsed.data.secretVariable }
    : null;
}

/**
 * Refuses to put a server whose only clean shutdown is RCON on a node that
 * cannot perform it.
 *
 * Nothing is asked of the node at all for the templates that do not need it,
 * which is all of them today: reaching a node costs a token decryption and a
 * round trip, and server creation is not the place to spend either on a
 * question with a constant answer.
 */
export async function assertStopTransportHonoured(
  stop: unknown,
  node: { name: string; connection: () => Promise<NodeConnection> },
  client: NodeClientService,
): Promise<void> {
  if (!declaresRconStop(stop)) {
    return;
  }

  const verdict = await client.honoursCapability(
    await node.connection(),
    NODE_CAPABILITIES.rconStop,
  );

  if (verdict.honoured) {
    return;
  }

  if (!verdict.reachable) {
    throw new ServiceUnavailableException(
      `Node ${node.name} cannot be reached (${verdict.reason}), so there is no telling whether it can stop this template's servers at all. Try again once it answers.`,
    );
  }

  throw new ConflictException(
    `This template stops its servers over RCON, and the daemon on node ${node.name} is too old to understand that. It would not merely stop them some other way: it cannot read a server configuration containing this field, so it would lose track of every server on that node. Upgrade the node, or pick a node that is already upgraded.`,
  );
}

/**
 * The same question asked of every node a template's servers already sit on.
 *
 * Editing a template is the one write where the template moves and the servers
 * do not, so there is no single node to ask — and the blast radius is the sum
 * of them: one save can make every node hosting this template lose track of
 * every server it has, including the servers of other templates entirely.
 *
 * Sequentially, and it stops at the first node that says no, so the message
 * names a node the operator can go and upgrade. Nothing is asked of any node
 * for a stop that is not RCON, which is the check `assertStopTransportHonoured`
 * already makes — the short-circuit is repeated here only so that the common
 * edit reaches no node at all rather than one round trip per node.
 */
export async function assertStopTransportHonouredEverywhere(
  stop: unknown,
  nodes: readonly { name: string; connection: () => Promise<NodeConnection> }[],
  client: NodeClientService,
): Promise<void> {
  if (!declaresRconStop(stop)) {
    return;
  }

  for (const node of nodes) {
    await assertStopTransportHonoured(stop, node, client);
  }
}

/**
 * One server, in the two terms an RCON stop is delivered on.
 *
 * Spelled out rather than taken from Prisma because what matters is that these
 * are the same four columns `ServerConfigurationService.build` reads to fill
 * `allocations` and `environment`: this check is only worth anything while it
 * looks at what the daemon will be handed.
 */
export interface RconStopPrerequisites {
  name: string;
  primaryAllocationId: number | null;
  allocations: readonly { id: number; ip: string; port: number; role: string | null }[];
  /** The rows that will exist after the write, not merely the ones that do. */
  variables: readonly { envVariable: string; value: string }[];
}

/** How many servers a refusal names before it starts counting them instead. */
const SERVERS_NAMED_IN_A_REFUSAL = 5;

/**
 * Refuses an RCON stop that the servers already built from the template could
 * not answer.
 *
 * The node capability above is the first of three grounds `resolveRconTarget`
 * refuses a stop on, and it is the only one the node owns. The other two belong
 * to each server, and a template edit reaches both at once:
 *
 *  - **no port answers to the role.** `ServersService` gives every server's
 *    primary allocation `role: null`, so a template edited to
 *    `stop: { type: 'rcon', role: 'rcon', … }` names a port that exists on no
 *    server anybody has created — until somebody names one by hand, per server,
 *    in its Network tab.
 *  - **no value behind `secretVariable`.** The environment the daemon receives
 *    is built from `ServerVariable` rows alone, and an empty password is a
 *    refusal rather than a blank login: most servers switch RCON off entirely
 *    when their password is blank.
 *
 * Mirrored from `resolveRconTarget` rather than shared with it — it lives in the
 * daemon, which the panel cannot import — and mirrored down to the fallbacks:
 * the role is resolved through the contract's own `allocationForRole`, against
 * allocations assembled the way `ServerConfigurationService.build` assembles
 * them. That last detail is load-bearing. The primary allocation is handed over
 * as `default` with its `role` column dropped, so a name that happens to sit on
 * the primary port reaches nothing; building the shape here rather than
 * scanning the rows is what keeps this agreeing with that.
 *
 * Why refuse rather than warn: a stop the daemon cannot deliver is not
 * downgraded to a signal, it is refused outright (`server-instance.ts`), so the
 * consequence of saving is that Stop and Restart stop working on every one of
 * these servers and Kill — which cuts the game off before it writes its world —
 * becomes the only way down. That is the failure the transport was chosen to
 * avoid, arrived at by an edit made on a different page.
 */
export function assertRconStopReachesEveryServer(
  stop: unknown,
  servers: readonly RconStopPrerequisites[],
): void {
  const target = rconStopTarget(stop);

  if (!target) {
    return;
  }

  const failures = servers.flatMap((server) => {
    const reason = whyRconWouldNotReach(server, target);

    return reason ? [`"${server.name}" (${reason})`] : [];
  });

  if (failures.length === 0) {
    return;
  }

  const unnamed = failures.length - SERVERS_NAMED_IN_A_REFUSAL;
  const listed = failures.slice(0, SERVERS_NAMED_IN_A_REFUSAL).join(', ');

  throw new ConflictException(
    `Saving this stop would leave ${failures.length} existing server(s) built from this template with no way to stop at all: ` +
      `${listed}${unnamed > 0 ? `, and ${unnamed} more` : ''}. ` +
      'An RCON stop that cannot be delivered is refused rather than performed some other way, so Stop and Restart would fail on each of them and Kill — which ends the game before it has written its world — would be the only way to bring them down. ' +
      'Give each server what is missing first: a port carrying the name, in its Network tab, and a value for the variable, in its Startup tab.',
  );
}

/** The refusal `resolveRconTarget` would produce for this server, or nothing. */
function whyRconWouldNotReach(
  server: RconStopPrerequisites,
  target: { role?: string; secretVariable: string },
): string | null {
  // The shape `ServerConfigurationService.build` sends: the primary port as
  // `default` and carrying no name whatever its column says, every other port
  // as `additional` and keeping its own.
  const allocation = allocationForRole(
    {
      default: primaryOf(server),
      additional: server.allocations
        .filter((candidate) => candidate.id !== server.primaryAllocationId)
        .map((candidate) => ({
          ip: candidate.ip,
          port: candidate.port,
          ...(candidate.role ? { role: candidate.role } : {}),
        })),
    },
    target.role,
  );

  if (!allocation) {
    return `no port on it is named "${target.role}"`;
  }

  const value = server.variables.find(
    (variable) => variable.envVariable === target.secretVariable,
  )?.value;

  // Empty and absent are the same answer, as they are in `rconPassword`: the
  // login is not weaker for a blank password, it is a connection the game
  // refuses at the socket.
  return value ? null : `${target.secretVariable} holds no password`;
}

/**
 * The primary port, or a placeholder standing in for one.
 *
 * A server with no primary allocation cannot be started at all — `build` throws
 * on it before any of this matters — so there is nothing useful to say about its
 * stop, and reporting it here would put a message about RCON in front of an
 * operator whose server is broken in a way that has nothing to do with this
 * edit. The placeholder makes `allocationForRole(…, undefined)` answer "yes,
 * there is a primary port", which is the answer that keeps such a server out of
 * the refusal.
 */
function primaryOf(server: RconStopPrerequisites): { ip: string; port: number } {
  const primary = server.allocations.find(
    (candidate) => candidate.id === server.primaryAllocationId,
  );

  return primary ?? { ip: '0.0.0.0', port: 0 };
}

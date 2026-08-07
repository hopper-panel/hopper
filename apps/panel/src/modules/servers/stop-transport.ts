import { NODE_CAPABILITIES, stopConfigurationSchema } from '@hopper/shared';
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
 * What this does **not** cover, stated rather than left to be discovered:
 *
 *  - a node **downgraded** after such a server was created. The row keeps its
 *    template, the older daemon chokes on the page, and nothing checks again.
 *  - a **template edited** into an RCON stop once its servers exist — through
 *    the egg importer, a catalogue resynchronisation or the database. The gate
 *    runs when a server meets a node, and neither of those is that moment.
 *
 * Both need the capability re-checked when a configuration is pushed rather
 * than when the server is placed, which is a larger change than this one and
 * belongs with the same fix for named ports.
 */
export function declaresRconStop(stop: unknown): boolean {
  if (stop === null || stop === undefined) {
    return false;
  }

  const parsed = stopConfigurationSchema.safeParse(stop);

  // An unreadable value is not gated, deliberately: it is not an RCON stop, and
  // `parseStop` refuses that server outright when its configuration is built —
  // which is the louder failure, and the right one. Guessing here would refuse
  // a creation with a message about node versions when nothing about the node
  // is wrong.
  return parsed.success && parsed.data.type === 'rcon';
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

import { NODE_CAPABILITIES, configFileSchema } from '@hopper/shared';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { NodeClientService, NodeConnection } from '../nodes/node-client.service.js';

/**
 * Keeping a template that patches whole lines off a node that cannot read one.
 *
 * The same shape as `stop-transport.ts`, for the same three writes — creating a
 * server, transferring one, editing a template — and a free function for the
 * same reason: one question, one wording, no second copy to forget.
 *
 * **What an older daemon does with `parser: 'whole-line'` is worse than either
 * of the fields already gated this way.** A named allocation role is *stripped*
 * by a daemon that has never heard of it. An `rcon` stop fails one object,
 * because a discriminated union cannot place it. This fails on a value outside
 * an enum's domain, and the failure climbs: `configFileSchema`, then
 * `serverConfigurationSchema`, then the whole page of configurations the daemon
 * fetches — `panel-client.ts` runs one `safeParse` over the page and throws. So
 * the node adopts **none** of its servers, including every server of every
 * other template on that machine. Consoles answer "unknown to this node", power
 * actions fail, and the containers keep running with nothing driving them.
 *
 * One template saved on the panel, an entire node dark, and nothing in the
 * payload can warn it: the daemon's complaint goes to its own log, on a machine
 * the operator has no shell on. Hence a gate at the write.
 *
 * What this does **not** cover is inherited wholesale from the stop transport,
 * and is worth restating because one of the gaps costs more here:
 *
 *  - a node **downgraded** after such a server exists. Nothing checks again.
 *  - a template given this parser by anything other than the editor — the egg
 *    importer, a catalogue resynchronisation, the database. The importer is the
 *    likely one now, and it is deliberately not gated: importing attaches no
 *    server to any node, so the refusal belongs at the door where one is
 *    placed, not at the door where a template is written down.
 *  - **the verdict and the delivery are not the same moment for an edit.**
 *    `TemplateEditorService.update` writes the row and pushes nothing, so a
 *    permitted parser sits in the database until each daemon next fetches its
 *    page. For a stop, that window only matters at the next stop. Here it
 *    matters at the next *fetch*, which is what a daemon does on restart —
 *    the very moment a downgraded node would come back and choke.
 *
 * Closing those needs the capability re-checked where a configuration is
 * actually pushed rather than where a server is placed. That is one change for
 * all three gated fields, and it is not this one.
 */
export function declaresWholeLineParser(configFiles: unknown): boolean {
  if (!Array.isArray(configFiles)) {
    return false;
  }

  return configFiles.some((entry) => {
    const parsed = configFileSchema.safeParse(entry);

    return parsed.success && parsed.data.parser === 'whole-line';
  });
}

/**
 * Refuses to put a server whose template patches whole lines on a node that
 * would choke on the word.
 *
 * Nothing is asked of the node for a template that does not use the parser,
 * which is every shipped one: `honoursCapability` caches nothing and costs a
 * token decryption and a round trip per call, bounded by the node timeout. The
 * short-circuit is not an optimisation here so much as what keeps the gate
 * free for everybody it does not concern.
 */
export async function assertWholeLineParserHonoured(
  configFiles: unknown,
  node: { name: string; connection: () => Promise<NodeConnection> },
  client: NodeClientService,
): Promise<void> {
  if (!declaresWholeLineParser(configFiles)) {
    return;
  }

  const verdict = await client.honoursCapability(
    await node.connection(),
    NODE_CAPABILITIES.wholeLineParser,
  );

  if (verdict.honoured) {
    return;
  }

  if (!verdict.reachable) {
    throw new ServiceUnavailableException(
      `Node ${node.name} cannot be reached (${verdict.reason}), so there is no telling whether it can read this template's configuration files at all. Try again once it answers.`,
    );
  }

  throw new ConflictException(
    `This template patches whole lines in its configuration files, and the daemon on node ${node.name} is too old to understand that parser. It would not merely leave those files alone: it cannot read a server configuration containing this parser, so it would lose track of every server on that node — including servers built from other templates. Upgrade the node, or pick a node that is already upgraded.`,
  );
}

/**
 * The same question asked of every node a template's servers already sit on.
 *
 * Editing a template is the write where the template moves and the servers do
 * not, so there is no single node to ask, and the blast radius is the sum of
 * them — one save can take out every node hosting this template, and with each
 * one every server on it, whatever template that server came from.
 *
 * Sequentially, stopping at the first refusal so the message names a node the
 * operator can go and upgrade.
 */
export async function assertWholeLineParserHonouredEverywhere(
  configFiles: unknown,
  nodes: readonly { name: string; connection: () => Promise<NodeConnection> }[],
  client: NodeClientService,
): Promise<void> {
  if (!declaresWholeLineParser(configFiles)) {
    return;
  }

  for (const node of nodes) {
    await assertWholeLineParserHonoured(configFiles, node, client);
  }
}

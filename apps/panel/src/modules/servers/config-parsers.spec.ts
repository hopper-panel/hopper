import { NODE_CAPABILITIES } from '@hopper/shared';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NodeClientService } from '../nodes/node-client.service.js';
import {
  assertWholeLineParserHonoured,
  assertWholeLineParserHonouredEverywhere,
  declaresWholeLineParser,
} from './config-parsers.js';

/**
 * Keeping a template that patches whole lines off a node that cannot read one.
 *
 * The worst version skew of the three gated this way, and worse by mechanism
 * rather than by degree: a named allocation role is stripped by an older
 * daemon, an `rcon` stop fails one object, and a parser outside the enum's
 * domain fails the whole *page* of server configurations that daemon fetches.
 * So the node adopts none of its servers — including every server built from
 * every other template on that machine.
 */

const WHOLE_LINE = [
  {
    file: '.env',
    parser: 'whole-line',
    replacements: [{ match: 'DISCORD_TOKEN', replaceWith: 'DISCORD_TOKEN=abc' }],
  },
];

const PROPERTIES = [
  {
    file: 'server.properties',
    parser: 'properties',
    replacements: [{ match: 'server-port', replaceWith: '25570' }],
  },
];

const clientAnnouncing = (capabilities: string[] | null) =>
  ({
    honoursCapability: vi.fn((_node: unknown, capability: string) =>
      Promise.resolve(
        capabilities === null
          ? { honoured: false as const, reachable: false as const, reason: 'No answer.' }
          : capabilities.includes(capability)
            ? { honoured: true as const }
            : { honoured: false as const, reachable: true as const },
      ),
    ),
  }) as unknown as NodeClientService;

const node = (name = 'node-1', connection = vi.fn(() => Promise.resolve({}))) => ({
  name,
  connection: connection as unknown as () => Promise<never>,
});

describe('declaresWholeLineParser', () => {
  it('recognises the parser that needs the gate', () => {
    expect(declaresWholeLineParser(WHOLE_LINE)).toBe(true);
  });

  it('finds it behind entries that do not need it', () => {
    // A template's files are a list, and only one of them has to carry the
    // parser for the page to become unreadable. Checking the first entry only
    // is the mistake this catches.
    expect(declaresWholeLineParser([...PROPERTIES, ...WHOLE_LINE])).toBe(true);
  });

  it.each([
    ['nothing at all', null],
    ['an absent column', undefined],
    ['an empty list', []],
    ['a list of parsers every daemon knows', PROPERTIES],
    ['something that is not a list', { file: '.env', parser: 'whole-line' }],
  ])('leaves %s ungated', (_case, configFiles) => {
    expect(declaresWholeLineParser(configFiles)).toBe(false);
  });

  it('leaves an unreadable entry to the place that refuses it properly', () => {
    // Not gated here, on purpose, and for the same reason `declaresRconStop`
    // is not: an entry the contract cannot read is refused where the
    // configuration is built, which is the louder failure and the right one.
    // Guessing here would answer a malformed template with a message about
    // node versions, when nothing about the node is wrong.
    expect(declaresWholeLineParser([{ file: '.env', parser: 'whole-line' }])).toBe(false);
    expect(declaresWholeLineParser([{ parser: 'whole-line', replacements: [] }])).toBe(false);
  });
});

describe('assertWholeLineParserHonoured', () => {
  it('allows a template whose node announces the capability', async () => {
    await expect(
      assertWholeLineParserHonoured(
        WHOLE_LINE,
        node(),
        clientAnnouncing([NODE_CAPABILITIES.wholeLineParser]),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a node whose daemon does not announce it', async () => {
    await expect(
      assertWholeLineParserHonoured(WHOLE_LINE, node(), clientAnnouncing([])),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('says what it would cost, not merely that it is refused', async () => {
    // An operator who reads "the file would not be rewritten" files this under
    // cosmetic and creates the server anyway. What actually happens is that
    // every server on that node stops being known to it.
    await expect(
      assertWholeLineParserHonoured(WHOLE_LINE, node(), clientAnnouncing([])),
    ).rejects.toThrow(/lose track of every server on that node/);
  });

  it('names the node, since that is what the operator has to go and upgrade', async () => {
    await expect(
      assertWholeLineParserHonoured(WHOLE_LINE, node('node-berlin'), clientAnnouncing([])),
    ).rejects.toThrow(/node-berlin/);
  });

  it('refuses a node it cannot ask', async () => {
    // Unreachable is a refusal, not a pass: "it will probably be fine" is the
    // guess these gates exist to remove.
    await expect(
      assertWholeLineParserHonoured(WHOLE_LINE, node(), clientAnnouncing(null)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('carries the reason it could not be asked', async () => {
    await expect(
      assertWholeLineParserHonoured(WHOLE_LINE, node(), clientAnnouncing(null)),
    ).rejects.toThrow(/No answer\./);
  });

  it('asks the node nothing at all for a template that does not need it', async () => {
    // Every shipped template is in this case. `honoursCapability` caches
    // nothing and costs a token decryption and a round trip per call, bounded
    // by the node timeout — so the short-circuit is what keeps the gate free
    // for everyone it does not concern.
    const connection = vi.fn(() => Promise.resolve({}));
    const client = clientAnnouncing([]);

    await assertWholeLineParserHonoured(PROPERTIES, node('node-1', connection), client);

    expect(connection).not.toHaveBeenCalled();
    expect(client.honoursCapability).not.toHaveBeenCalled();
  });

  it('asks about the whole-line-parser capability and no other', async () => {
    // Asking for `rcon-stop` here would pass on every node upgraded for the
    // stop and refuse on none of the ones that matter.
    const client = clientAnnouncing([NODE_CAPABILITIES.wholeLineParser]);

    await assertWholeLineParserHonoured(WHOLE_LINE, node(), client);

    expect(client.honoursCapability).toHaveBeenCalledWith(
      expect.anything(),
      NODE_CAPABILITIES.wholeLineParser,
    );
  });
});

describe('assertWholeLineParserHonouredEverywhere', () => {
  const nodes = [node('node-1'), node('node-2')];

  it('allows the edit when every node announces the capability', async () => {
    await expect(
      assertWholeLineParserHonouredEverywhere(
        WHOLE_LINE,
        nodes,
        clientAnnouncing([NODE_CAPABILITIES.wholeLineParser]),
      ),
    ).resolves.toBeUndefined();
  });

  it('names the node standing in the way rather than the count of them', async () => {
    // Sequential, stopping at the first refusal, so the message names a
    // machine somebody can go and upgrade.
    await expect(
      assertWholeLineParserHonouredEverywhere(WHOLE_LINE, nodes, clientAnnouncing([])),
    ).rejects.toThrow(/node-1/);
  });

  it('asks nothing of any node when the template has no servers anywhere', async () => {
    const client = clientAnnouncing([]);

    await assertWholeLineParserHonouredEverywhere(WHOLE_LINE, [], client);

    expect(client.honoursCapability).not.toHaveBeenCalled();
  });

  it('asks nothing of any node for a template that does not use the parser', async () => {
    const client = clientAnnouncing([]);

    await assertWholeLineParserHonouredEverywhere(PROPERTIES, nodes, client);

    expect(client.honoursCapability).not.toHaveBeenCalled();
  });
});

import { NODE_CAPABILITIES } from '@hopper/shared';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NodeClientService } from '../nodes/node-client.service.js';
import { assertStopTransportHonoured, declaresRconStop } from './stop-transport.js';

/**
 * Keeping a server that stops over RCON off a node that has never heard of it.
 *
 * The version skew here is not the ordinary one. A daemon too old for this
 * field does not ignore it: `stopConfigurationSchema` is a discriminated union,
 * so the whole server configuration fails to parse — and configurations are
 * fetched a page at a time, so one such server makes the page unreadable and
 * the node ends up knowing about **none** of its servers. One template takes
 * out a whole node, and the daemon's complaint goes into its own log on a
 * machine the operator has no shell on.
 */

const RCON_STOP = {
  type: 'rcon',
  command: 'quit',
  role: 'rcon',
  secretVariable: 'RCON_PASSWORD',
};

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

const node = (connection = vi.fn(() => Promise.resolve({}))) => ({
  name: 'node-1',
  connection: connection as unknown as () => Promise<never>,
});

describe('declaresRconStop', () => {
  it('recognises the transport that needs the gate', () => {
    expect(declaresRconStop(RCON_STOP)).toBe(true);
  });

  it.each([
    ['nothing at all', null],
    ['an absent column', undefined],
    ['a stdin command', { type: 'command', value: 'stop' }],
    ['a signal', { type: 'signal', value: 'SIGTERM' }],
  ])('leaves %s ungated', (_case, stop) => {
    expect(declaresRconStop(stop)).toBe(false);
  });

  it('leaves an unreadable value to the place that refuses it properly', () => {
    // Not gated here on purpose. It is not an RCON stop, and the configuration
    // builder refuses that server outright — which is the louder failure and
    // the right one. Guessing here would refuse a creation with a message
    // about node versions when nothing about the node is wrong.
    expect(declaresRconStop({ type: 'rcon' })).toBe(false);
    expect(declaresRconStop('rcon')).toBe(false);
  });
});

describe('assertStopTransportHonoured', () => {
  it('allows a template whose node announces the capability', async () => {
    const client = clientAnnouncing([
      NODE_CAPABILITIES.allocationRoles,
      NODE_CAPABILITIES.rconStop,
    ]);

    await expect(assertStopTransportHonoured(RCON_STOP, node(), client)).resolves.toBeUndefined();
  });

  it('refuses a node whose daemon does not announce it', async () => {
    await expect(
      assertStopTransportHonoured(RCON_STOP, node(), clientAnnouncing([])),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('says what it would cost, not merely that it is refused', async () => {
    // "Too old" on its own reads as a nuisance to work around. What actually
    // happens is that the node loses track of every server on it, and an
    // operator deciding whether to upgrade now or later needs to know that.
    await expect(
      assertStopTransportHonoured(RCON_STOP, node(), clientAnnouncing([])),
    ).rejects.toThrow(/every server on that node/);
  });

  it('refuses a node it cannot ask', async () => {
    // "It will probably be fine" is the guess this gate exists to remove, and
    // creating a server on a particular node is not urgent enough to be worth
    // it — the node is right there to be tried again.
    await expect(
      assertStopTransportHonoured(RCON_STOP, node(), clientAnnouncing(null)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('asks the node nothing at all for a template that does not need it', async () => {
    // Which is every template shipped today. Reaching a node costs a token
    // decryption and a round trip, and server creation is not the place to
    // spend either on a question with a constant answer.
    const connection = vi.fn(() => Promise.resolve({}));
    const client = clientAnnouncing([]);

    await assertStopTransportHonoured({ type: 'command', value: 'stop' }, node(connection), client);
    await assertStopTransportHonoured(null, node(connection), client);

    expect(connection).not.toHaveBeenCalled();
    expect(client.honoursCapability).not.toHaveBeenCalled();
  });

  it('asks about the rcon-stop capability and no other', async () => {
    // A gate that checked the wrong string would pass on every node that had
    // been upgraded for named ports, which is the state most of them are in.
    const client = clientAnnouncing([NODE_CAPABILITIES.rconStop]);

    await assertStopTransportHonoured(RCON_STOP, node(), client);

    expect(client.honoursCapability).toHaveBeenCalledWith(
      expect.anything(),
      NODE_CAPABILITIES.rconStop,
    );
  });
});

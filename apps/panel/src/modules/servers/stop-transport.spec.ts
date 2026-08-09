import { NODE_CAPABILITIES } from '@hopper/shared';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NodeClientService } from '../nodes/node-client.service.js';
import {
  assertRconStopReachesEveryServer,
  assertStopTransportHonoured,
  assertStopTransportHonouredEverywhere,
  declaresRconStop,
  type RconStopPrerequisites,
} from './stop-transport.js';

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

/**
 * Editing a template is the one write where the template moves and the servers
 * stay put, so there is no single node to ask — and the cost is the sum of
 * them: one save can make every node hosting this template lose track of every
 * server it has, including servers of other templates entirely.
 */
describe('assertStopTransportHonouredEverywhere', () => {
  const nodes = (...names: string[]) => names.map((name) => ({ ...node(), name }));

  it('allows the edit when every node announces the capability', async () => {
    const client = clientAnnouncing([NODE_CAPABILITIES.rconStop]);

    await expect(
      assertStopTransportHonouredEverywhere(RCON_STOP, nodes('node-1', 'node-2'), client),
    ).resolves.toBeUndefined();
    expect(client.honoursCapability).toHaveBeenCalledTimes(2);
  });

  it('names the node standing in the way rather than the count of them', async () => {
    // An operator told "some node is too old" has to go and find which. The
    // first refusal stops the loop precisely so the message can carry a name.
    await expect(
      assertStopTransportHonouredEverywhere(
        RCON_STOP,
        nodes('node-1', 'node-2'),
        clientAnnouncing([]),
      ),
    ).rejects.toThrow(/node-1/);
  });

  it('asks nothing of any node when the template has no servers left anywhere', async () => {
    const client = clientAnnouncing([]);

    await assertStopTransportHonouredEverywhere(RCON_STOP, [], client);

    expect(client.honoursCapability).not.toHaveBeenCalled();
  });

  it('asks nothing of any node for a stop that is not RCON', async () => {
    const client = clientAnnouncing([]);

    await assertStopTransportHonouredEverywhere(
      { type: 'command', value: 'stop' },
      nodes('node-1', 'node-2'),
      client,
    );

    expect(client.honoursCapability).not.toHaveBeenCalled();
  });
});

/**
 * The other two grounds the daemon refuses an RCON stop on, and the two the
 * node knows nothing about: a port answering to the role, and a value behind
 * the secret variable. Both belong to each server, and one template edit
 * reaches every server at once.
 *
 * The consequence of getting this wrong is not a degraded stop. An RCON stop
 * the daemon cannot deliver is refused outright, so Stop and Restart fail on
 * every one of these servers and Kill — which ends the game before it has
 * written its world — becomes the only way down. Mirrored from the daemon's
 * `resolveRconTarget`, down to how the allocations are assembled: this is only
 * worth anything while it looks at exactly what the daemon will be handed.
 */
describe('assertRconStopReachesEveryServer', () => {
  const server = (overrides: Partial<RconStopPrerequisites> = {}): RconStopPrerequisites => ({
    name: 'survival',
    primaryAllocationId: 10,
    allocations: [
      { id: 10, ip: '10.0.0.1', port: 25565, role: null },
      { id: 11, ip: '10.0.0.1', port: 25575, role: 'rcon' },
    ],
    variables: [{ envVariable: 'RCON_PASSWORD', value: 'hunter2' }],
    ...overrides,
  });

  it('allows a server carrying both the named port and the password', () => {
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, [server()])).not.toThrow();
  });

  it('refuses a server on which no port answers to the role', () => {
    // `ServersService` gives every server's primary allocation `role: null`, so
    // a template edited to name one names a port that exists on no server
    // anybody has created — until somebody names one by hand, in its Network
    // tab, one server at a time.
    expect(() =>
      assertRconStopReachesEveryServer(RCON_STOP, [
        server({ allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: null }] }),
      ]),
    ).toThrow(/no port on it is named "rcon"/);
  });

  it('reads a name sitting on the primary port as no name at all', () => {
    // The load-bearing detail. `ServerConfigurationService.build` hands the
    // primary allocation over as `default` with its `role` column dropped, so a
    // name that happens to sit on the primary reaches nothing on the daemon —
    // and a check that scanned the rows instead of assembling the same shape
    // would clear an edit the daemon then refuses.
    expect(() =>
      assertRconStopReachesEveryServer(RCON_STOP, [
        server({ allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: 'rcon' }] }),
      ]),
    ).toThrow(/no port on it is named "rcon"/);
  });

  it('refuses a server whose secret variable has no row', () => {
    // The environment the daemon receives is built from `ServerVariable` rows
    // and nothing else. A variable the template declares is not a value the
    // server holds.
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, [server({ variables: [] })])).toThrow(
      /RCON_PASSWORD holds no password/,
    );
  });

  it('reads an empty password as no password', () => {
    // As `rconPassword` does: the login is not weaker for a blank password, it
    // is a connection the game refuses at the socket — most servers switch RCON
    // off entirely when it is blank.
    expect(() =>
      assertRconStopReachesEveryServer(RCON_STOP, [
        server({ variables: [{ envVariable: 'RCON_PASSWORD', value: '' }] }),
      ]),
    ).toThrow(/holds no password/);
  });

  it('reads the variable the stop names and no other', () => {
    expect(() =>
      assertRconStopReachesEveryServer(RCON_STOP, [
        server({ variables: [{ envVariable: 'RCON_PASS', value: 'hunter2' }] }),
      ]),
    ).toThrow(/RCON_PASSWORD holds no password/);
  });

  it('passes over a server that has no primary port at all', () => {
    // Such a server cannot be started: `build` throws on it long before any of
    // this matters. Reporting it here would put a message about RCON in front
    // of an operator whose server is broken in a way that has nothing to do
    // with the edit they are making.
    expect(() =>
      assertRconStopReachesEveryServer(
        { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
        [server({ primaryAllocationId: null, allocations: [] })],
      ),
    ).not.toThrow();
  });

  it('names the servers in the way rather than counting them', () => {
    // The fix is per server — a port in one Network tab, a value in one Startup
    // tab — so a count alone leaves the operator to go and find which.
    expect(() =>
      assertRconStopReachesEveryServer(RCON_STOP, [
        server({ name: 'survival' }),
        server({ name: 'creative', variables: [] }),
        server({
          name: 'lobby',
          allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: null }],
        }),
      ]),
    ).toThrow(
      /"creative" \(RCON_PASSWORD holds no password\), "lobby" \(no port on it is named "rcon"\)/,
    );
  });

  it('stops naming them at five and counts the rest', () => {
    // A refusal that listed forty server names would be unreadable, and the
    // first five are enough to recognise the shape of what is missing.
    const broken = Array.from({ length: 8 }, (_, index) =>
      server({ name: `server-${index}`, variables: [] }),
    );

    expect(() => assertRconStopReachesEveryServer(RCON_STOP, broken)).toThrow(
      /8 existing server\(s\)/,
    );
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, broken)).toThrow(/"server-4"/);
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, broken)).toThrow(/, and 3 more\./);
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, broken)).not.toThrow(/"server-5"/);
  });

  it('says what saving would cost, not merely that it is refused', () => {
    // The stop is refused rather than performed some other way, which is the
    // part an operator cannot guess: what they lose is Stop and Restart, and
    // what they are left with is the one action that ends the game before it
    // has written its world.
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, [server({ variables: [] })])).toThrow(
      /Kill — which ends the game before it has written its world/,
    );
  });

  it('asks nothing of any server for a stop that is not RCON', () => {
    // Including an unreadable one: it is not an RCON stop, and the
    // configuration builder refuses that server outright, which is the louder
    // failure and the right one.
    const broken = [server({ variables: [], allocations: [] })];

    expect(() =>
      assertRconStopReachesEveryServer({ type: 'command', value: 'stop' }, broken),
    ).not.toThrow();
    expect(() => assertRconStopReachesEveryServer(null, broken)).not.toThrow();
    expect(() => assertRconStopReachesEveryServer({ type: 'rcon' }, broken)).not.toThrow();
  });

  it('allows a stop naming no role at all, which is the primary port', () => {
    // A template can stop over RCON on the port the server already has. The
    // role is what makes the check interesting, not what makes it apply.
    expect(() =>
      assertRconStopReachesEveryServer(
        { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
        [server({ allocations: [{ id: 10, ip: '10.0.0.1', port: 25565, role: null }] })],
      ),
    ).not.toThrow();
  });

  it('asks nothing when the template has no servers', () => {
    expect(() => assertRconStopReachesEveryServer(RCON_STOP, [])).not.toThrow();
  });
});

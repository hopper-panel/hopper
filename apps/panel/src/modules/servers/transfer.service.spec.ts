import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NodeClientService } from '../nodes/node-client.service.js';
import type { NodesService } from '../nodes/nodes.service.js';
import type { ServerConfigurationService } from './server-configuration.service.js';
import { TransferService, declaredPortRoles, stopWaitMs } from './transfer.service.js';

/**
 * What a transfer must refuse to do, and how long it must be prepared to wait.
 *
 * Both of these are failures a template introduced from a distance. A transfer
 * was written when every server had one port and thirty seconds to stop in, and
 * neither of those is true any more: a template can name a port it reaches by
 * role, and it can declare a stop deadline four times longer than the wait this
 * file used to hardcode.
 *
 * The two failures are opposites in cost. Naming a port is unrecoverable and
 * has to be refused before anything moves; a long deadline is recoverable only
 * by not giving up on it, so the wait has to follow the template rather than a
 * constant. What they share is that the damage lands after the point of no
 * return — one leaves a server that can only be killed, the other fails a
 * transfer thirty seconds before the save it was waiting for would have
 * finished — which is why both are tested through `transfer` itself rather than
 * through the helpers alone.
 */

const RCON_STOP_NAMING_A_PORT = {
  type: 'rcon',
  command: 'quit',
  role: 'rcon',
  secretVariable: 'RCON_PASSWORD',
};

const RCON_STOP_ON_THE_GAME_PORT = {
  type: 'rcon',
  command: 'quit',
  secretVariable: 'RCON_PASSWORD',
};

interface TemplateShape {
  stop?: unknown;
  readiness?: unknown;
  stopTimeoutSeconds?: number | null;
}

/**
 * A transfer whose every dependency answers, with the archive step refusing.
 *
 * The refusal is the point: these tests care about what happens up to and
 * including the stop, and the first call after it is the file listing. Failing
 * there gives every "this was allowed to proceed" assertion a single, specific
 * message to look for, without mocking a twelve-gigabyte copy.
 */
function transferring(options: { template?: TemplateShape; stopsAfterMs?: number } = {}): {
  service: TransferService;
  client: NodeClientService;
  nodes: NodesService;
} {
  const template = {
    stop: null,
    readiness: null,
    stopTimeoutSeconds: null,
    ...options.template,
  };

  const server = {
    id: 7,
    uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'READY',
    nodeId: 1,
    node: { id: 1, uuid: 'source-node-uuid', name: 'node-1' },
    template,
  };

  const target = { id: 2, uuid: 'target-node-uuid', name: 'node-2' };

  const prisma = {
    server: { findUnique: vi.fn(() => Promise.resolve(server)) },
    node: { findUnique: vi.fn(() => Promise.resolve(target)) },
    allocation: {
      findFirst: vi.fn(() => Promise.resolve({ id: 42, ip: '10.0.0.2', port: 25565 })),
    },
  } as unknown as PrismaService;

  // Measured from the moment the harness is built, so a test can say "this
  // world takes a hundred and fifty seconds to serialise" and mean it.
  const startedAt = Date.now();
  const stopsAfterMs = options.stopsAfterMs ?? 0;

  const client = {
    fetchServerState: vi.fn(() =>
      Promise.resolve(Date.now() - startedAt >= stopsAfterMs ? 'offline' : 'running'),
    ),
    powerServer: vi.fn(() => Promise.resolve()),
    honoursCapability: vi.fn(() => Promise.resolve({ honoured: true as const })),
    proxy: vi.fn(() => Promise.resolve({ status: 503, body: Buffer.from('') })),
    deleteServer: vi.fn(() => Promise.resolve()),
  } as unknown as NodeClientService;

  const nodes = {
    getConnection: vi.fn(() =>
      Promise.resolve({ uuid: 'node-uuid', url: 'https://node', token: 'a.b' }),
    ),
  } as unknown as NodesService;

  const configuration = { build: vi.fn(() => Promise.resolve({})) };
  const audit = { record: vi.fn(() => Promise.resolve()) };

  return {
    service: new TransferService(
      prisma,
      nodes,
      client,
      configuration as unknown as ServerConfigurationService,
      audit as unknown as AuditService,
    ),
    client,
    nodes,
  };
}

/** The transfer, whatever it threw, without an unhandled rejection on the way. */
function attempt(service: TransferService): Promise<unknown> {
  return service
    .transfer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'target-node-uuid', 1, {
      ip: '127.0.0.1',
    })
    .then(
      () => new Error('The transfer completed, which none of these tests expect.'),
      (error: unknown) => error,
    );
}

/**
 * Runs the fake clock forward until the transfer has settled.
 *
 * In poll-sized steps rather than one leap, because each step has to let the
 * awaits inside the wait loop run before the next timer falls due — a single
 * advance would schedule nothing and the promise would sit there for ever.
 */
async function elapse(outcome: Promise<unknown>, ms: number): Promise<unknown> {
  for (let elapsed = 0; elapsed < ms; elapsed += 2000) {
    await vi.advanceTimersByTimeAsync(2000);
  }

  return outcome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('declaredPortRoles', () => {
  it('finds the name a stop transport reaches for', () => {
    expect(declaredPortRoles({ stop: RCON_STOP_NAMING_A_PORT, readiness: null })).toEqual(['rcon']);
  });

  it('finds the name a readiness strategy reaches for', () => {
    // The half that is easiest to forget. A template can be perfectly stoppable
    // over stdin and still probe a named port to decide it has started, and a
    // check that only read `stop` would move that server and break its start.
    expect(declaredPortRoles({ stop: null, readiness: { type: 'port', role: 'query' } })).toEqual([
      'query',
    ]);

    expect(
      declaredPortRoles({
        stop: null,
        readiness: { type: 'rcon', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
      }),
    ).toEqual(['rcon']);
  });

  it('names a port once when both places name it', () => {
    // Which is the ordinary shape: a game that answers on RCON is stopped and
    // watched over the same port, and the message must not say it twice.
    expect(
      declaredPortRoles({
        stop: RCON_STOP_NAMING_A_PORT,
        readiness: { type: 'rcon', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
      }),
    ).toEqual(['rcon']);
  });

  it.each([
    ['a template that declares neither', { stop: null, readiness: null }],
    ['a stdin stop', { stop: { type: 'command', value: 'stop' }, readiness: null }],
    ['an RCON stop on the game port', { stop: RCON_STOP_ON_THE_GAME_PORT, readiness: null }],
    ['a log strategy', { stop: null, readiness: { type: 'log', patterns: ['Done'] } }],
    ['a port strategy on the game port', { stop: null, readiness: { type: 'port' } }],
  ])('finds no name in %s', (_case, template) => {
    // Naming no role means the primary port, and the primary port is the one
    // thing a transfer does hand over. Refusing these would refuse every
    // transfer of every server in the catalogue.
    expect(declaredPortRoles(template)).toEqual([]);
  });

  it('reads no name out of a value that is not a strategy at all', () => {
    // Not this function's failure to report. An unreadable `stop` is refused
    // where the configuration is built and an unreadable `readiness` is dropped
    // with an error to the log; a transfer refused here would put a message
    // about ports in front of an operator whose template is broken elsewhere.
    expect(declaredPortRoles({ stop: { type: 'rcon' }, readiness: 'immediate' })).toEqual([]);
  });
});

describe('a transfer of a server whose template names a port', () => {
  it('is refused before the server is stopped or the target is even asked', async () => {
    // The whole value of this check is where it sits. One step later and the
    // world has been stopped; three later and it has been copied and the
    // original deleted, leaving a server whose only way down is Kill.
    const { service, client, nodes } = transferring({
      template: { stop: RCON_STOP_NAMING_A_PORT },
    });

    const error = await attempt(service);

    expect(error).toBeInstanceOf(ConflictException);
    expect(client.powerServer).not.toHaveBeenCalled();
    expect(client.proxy).not.toHaveBeenCalled();
    expect(nodes.getConnection).not.toHaveBeenCalled();
  });

  it('names the port and what an administrator would have to do instead', async () => {
    // "This server cannot be transferred" sends somebody to read the source.
    // The name is what they would search their Network tab for, and the manual
    // route is the only way to move this server today.
    const { service } = transferring({ template: { stop: RCON_STOP_NAMING_A_PORT } });

    const message = messageOf(await attempt(service));

    expect(message).toContain('"rcon"');
    expect(message).toContain('node-2');
    expect(message).toMatch(/restore a backup/);
  });

  it('is refused for a name that only the readiness strategy declares', async () => {
    // A server stopped over stdin and watched on a named port. It transfers
    // perfectly and then never finishes starting again.
    const { service, client } = transferring({
      template: {
        stop: { type: 'command', value: 'stop' },
        readiness: { type: 'port', role: 'query' },
      },
    });

    const error = await attempt(service);

    expect(error).toBeInstanceOf(ConflictException);
    expect(messageOf(error)).toContain('"query"');
    expect(client.powerServer).not.toHaveBeenCalled();
  });

  it('names both when the two places disagree about which port', async () => {
    const { service } = transferring({
      template: {
        stop: RCON_STOP_NAMING_A_PORT,
        readiness: { type: 'port', role: 'query' },
      },
    });

    const message = messageOf(await attempt(service));

    expect(message).toContain('"rcon"');
    expect(message).toContain('"query"');
  });

  it('lets through a template that names none', async () => {
    // The regression this gate could easily become. An RCON stop on the game
    // port names nothing — the shape an imported egg arrives in, since
    // Pterodactyl has no notion of a named allocation — and has to go on
    // transferring, so the failure here is the mocked file listing, three steps
    // past the gate.
    const { service, client } = transferring({
      template: { stop: RCON_STOP_ON_THE_GAME_PORT },
    });

    const message = messageOf(await attempt(service));

    expect(message).toContain('listing the files');
    expect(client.powerServer).not.toHaveBeenCalled(); // already offline
    expect(client.fetchServerState).toHaveBeenCalled();
  });
});

describe('stopWaitMs', () => {
  it('leaves a template that declares nothing with the wait it has always had', () => {
    // Every server that existed before templates could name a deadline. Two
    // minutes is not a figure worth defending on its own — it is the figure
    // these transfers already work with, and that is the whole argument.
    expect(stopWaitMs(null)).toBe(120_000);
    expect(stopWaitMs(undefined)).toBe(120_000);
  });

  it('waits out a deadline longer than that, with room for the round trip', () => {
    // Factorio, as shipped. 240 seconds is the daemon's own deadline; the panel
    // has to still be watching when it expires, not thirty seconds before.
    expect(stopWaitMs(240)).toBeGreaterThan(240_000);
    expect(stopWaitMs(600)).toBeGreaterThan(600_000);
  });

  it('does not shorten the wait for a template that declares a small one', () => {
    // The daemon kills at its own deadline whether or not the panel is still
    // looking, so a shorter wait here buys nothing and can only produce a
    // transfer that fails after the stop it asked for succeeded.
    expect(stopWaitMs(10)).toBe(120_000);
    expect(stopWaitMs(30)).toBe(120_000);
  });

  it('refuses to hang for ever on a figure nothing validated', () => {
    // The contract and the template definition both bound this at 600, so the
    // clamp only ever meets a hand-edited row or a restored dump — where the
    // column is a plain nullable integer that will happily hold a day.
    expect(stopWaitMs(86_400)).toBe(900_000);
  });
});

describe('a transfer of a world that takes a long time to save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out the deadline the template declared', async () => {
    // The failure this replaces: a Factorio world serialising for 150 seconds
    // was abandoned at 120, thirty seconds before the save it was waiting for
    // would have finished, and the operator was told to go and stop it by hand.
    const { service, client } = transferring({
      template: { stopTimeoutSeconds: 240 },
      stopsAfterMs: 150_000,
    });

    const message = messageOf(await elapse(attempt(service), 300_000));

    // Past the stop and into the archive, which is where this harness refuses.
    expect(message).toContain('listing the files');
    expect(message).not.toContain('did not stop');
    // And it really did keep polling: sixty polls is the old two minutes.
    expect(vi.mocked(client.fetchServerState).mock.calls.length).toBeGreaterThan(60);
  });

  it('still gives up on a server whose template declared nothing', async () => {
    // The other half. A template that named no deadline is asking for the
    // daemon's thirty seconds, and a server still up two minutes later is stuck
    // — killing it here would produce exactly the half-written world the wait
    // exists to avoid, so the administrator decides.
    const { service } = transferring({ stopsAfterMs: 150_000 });

    const error = await elapse(attempt(service), 300_000);

    expect(error).toBeInstanceOf(ConflictException);
    expect(messageOf(error)).toContain('120 seconds');
  });

  it('tells the operator the deadline it actually waited', async () => {
    // It used to say "two minutes" whatever it had waited. An operator reading
    // that under a template declaring 600 has no way to tell a wait that was
    // too short from a server that is genuinely stuck.
    const { service } = transferring({
      template: { stopTimeoutSeconds: 240 },
      stopsAfterMs: Number.MAX_SAFE_INTEGER,
    });

    const error = await elapse(attempt(service), 400_000);

    expect(error).toBeInstanceOf(ConflictException);
    expect(messageOf(error)).toContain('270 seconds');
  });

  it('does not wait at all for a server that is already off', async () => {
    // A transfer of a stopped server is the common case, and it must not spend
    // a poll interval discovering that.
    const { service, client } = transferring({ template: { stopTimeoutSeconds: 600 } });

    const error = await elapse(attempt(service), 4000);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(client.powerServer).not.toHaveBeenCalled();
  });
});

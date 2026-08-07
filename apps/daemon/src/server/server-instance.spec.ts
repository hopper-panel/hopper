import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfiguration } from '@hopper/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
import { decodePackets, encodePacket } from './rcon.js';
import { ServerInstance } from './server-instance.js';

/**
 * Recovering the console after hopperd restarts.
 *
 * Attaching to a container streams what it says next, never what it has said.
 * So after an update — and the panel's own update button restarts the daemon —
 * the buffer started empty, and the console of a server that had been up for an
 * hour was a blank rectangle. A quiet Minecraft server stays quiet for hours,
 * so it read as a broken console rather than a silent one.
 *
 * Docker still had the output. It was only this process that had forgotten.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

const CONFIGURATION = {
  uuid: UUID,
  name: 'Test',
  suspended: false,
  container: { image: 'x', requiresRebuild: false },
  limits: {},
} as unknown as ServerConfiguration;

/**
 * Enough of a configuration to survive `doStart`.
 *
 * The stop is by signal rather than by console command: these servers are the
 * ones that do not read stdin, and the fake stream below has no `write` for a
 * `stop` to go down.
 */
function startable(
  readiness: unknown,
  allocations: unknown = { default: { ip: '127.0.0.1', port: 27015 }, additional: [] },
): ServerConfiguration {
  return {
    ...CONFIGURATION,
    environment: {},
    readiness,
    configFiles: [],
    fileDenylist: [],
    allocations,
    build: { memoryBytes: 0, diskBytes: 0 },
    stop: { type: 'signal', value: 'SIGTERM' },
    stopTimeoutSeconds: 30,
  } as unknown as ServerConfiguration;
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
} as unknown as Logger;

interface Fake {
  instance: ServerInstance;
  logs: ReturnType<typeof vi.fn>;
  removed: ReturnType<typeof vi.fn>;
  killed: ReturnType<typeof vi.fn>;
  panel: { reportInstall: ReturnType<typeof vi.fn>; reportStatus: ReturnType<typeof vi.fn> };
  /** The console stream, so a test can play the container's death itself. */
  stream: EventEmitter;
  tail: () => unknown;
}

function instanceWith(options: {
  running: boolean;
  logs: string | Buffer;
  logsFails?: boolean;
  /** A leftover install container, i.e. an installation nobody finished. */
  orphanedInstall?: { exitCode: number };
  panel?: { reportInstall: ReturnType<typeof vi.fn>; reportStatus?: ReturnType<typeof vi.fn> };
  configuration?: ServerConfiguration;
  /**
   * Where the volume would live. Only the tests that let a start reach
   * `createContainer` care: that path is created on disk for real, so they hand
   * over a temporary directory rather than have a test suite write to
   * `/var/lib`.
   */
  volumesRoot?: string;
}): Fake {
  const logs = vi.fn((_options: { tail?: number }) =>
    options.logsFails
      ? Promise.reject(new Error('no such container'))
      : Promise.resolve(options.logs),
  );

  const killed = vi.fn((_options?: { signal?: string }) => Promise.resolve());

  const container = {
    inspect: () =>
      Promise.resolve({
        State: { Running: options.running, StartedAt: '2026-08-05T10:00:00.000Z' },
      }),
    logs,
    start: () => Promise.resolve(),
    kill: killed,
    // The rebuild path removes the previous container before building the next
    // one; without this, a start that rebuilds fails on the fake rather than on
    // what it is meant to be failing on.
    remove: vi.fn(() => Promise.resolve()),
    stats: () => Promise.resolve({ on: () => undefined, destroy: () => undefined }),
  };

  const removed = vi.fn(() => Promise.resolve());

  const installContainer = {
    inspect: () =>
      options.orphanedInstall
        ? Promise.resolve({ State: { Running: false, ExitCode: options.orphanedInstall.exitCode } })
        : Promise.reject(new Error('no such container')),
    remove: removed,
  };

  // An emitter rather than a stub: a failed start is only half told by the
  // state it leaves behind, and the other half — what the panel is told about
  // the stop — is decided when the container's stream ends.
  const stream = new EventEmitter();

  const docker = {
    api: {
      getContainer: (name: string) =>
        name.startsWith('hopper-install-') ? installContainer : container,
    },
    // Never emits on its own: the point here is the buffer's contents before a
    // single new byte arrives.
    attachToContainer: () => Promise.resolve(stream),
  } as unknown as DockerClient;

  const panel = {
    reportInstall: vi.fn(() => Promise.resolve()),
    reportStatus: vi.fn(() => Promise.resolve()),
    ...options.panel,
  };

  const instance = new ServerInstance({
    configuration: options.configuration ?? CONFIGURATION,
    docker,
    logger,
    dataPath: '/var/lib/hopper/volumes',
    volumesRoot: options.volumesRoot ?? '/var/lib/hopper/volumes',
    tmpPath: '/tmp',
    ownership: { uid: 988, gid: 988 },
    networkName: 'hopper0',
    panel,
  } as never);

  return {
    instance,
    logs,
    removed,
    killed,
    panel,
    stream,
    tail: () => logs.mock.calls[0]?.[0]?.tail,
  };
}

/** What the operator would read in the console, as one searchable string. */
const consoleText = (instance: ServerInstance): string => instance.consoleSnapshot().join('\n');

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));

/**
 * A server is never left in `starting` for ever.
 *
 * Every branch below used to end in a console line and a state that never
 * moved: the panel showed a spinner over a server that was either dead or
 * perfectly fine, with nothing to tell the two apart. The readiness strategies
 * that made these branches reachable arrived with PR #59; the traps were
 * already there, uncovered, waiting for the first template to select one.
 */
describe('a start that never becomes ready', () => {
  it('calls the server running when this node cannot run its readiness check', async () => {
    // A UDP port cannot be probed here, and the strategy is still refused. What
    // changed is the cost of refusing: this used to leave the state at
    // `starting` for ever, so the server ran, took players, and the panel
    // showed it as still starting until somebody stopped it by hand.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'port', protocol: 'udp', delayMs: 0, timeoutMs: 600_000 }),
    });

    await fake.instance.power('start');

    expect(fake.instance.currentState).toBe('running');
  });

  it('says on the console why it could not check, and what it did instead', async () => {
    // Called running is the wrong answer. It is allowed to be the wrong answer
    // only because it is a loud one: an operator reading this knows the state
    // means "container up", not "playable".
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'port', protocol: 'udp', delayMs: 0, timeoutMs: 600_000 }),
    });

    await fake.instance.power('start');

    expect(consoleText(fake.instance)).toContain('UDP');
    expect(consoleText(fake.instance)).toContain('called running');
  });

  it('calls the server running when the strategy names a port it has not got', async () => {
    // A template naming a port the operator never created. The strategy cannot
    // run, and it must not quietly become "the game port then": the daemon
    // would fail the handshake every two seconds and stop a healthy server at
    // the deadline. It says which name it could not find and gets out of the
    // way, which is the same bargain the UDP refusal above strikes.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({
        type: 'rcon',
        role: 'rcon',
        secretVariable: 'RCON_PASSWORD',
        timeoutMs: 25,
      }),
    });

    await fake.instance.power('start');

    expect(fake.instance.currentState).toBe('running');
    expect(consoleText(fake.instance)).toContain('rcon');
    await sleep(60);
    expect(fake.killed).not.toHaveBeenCalled();
  });

  it('knocks on the named port and not on the game one', async () => {
    // The whole point of names, and the one assertion a real socket can make
    // that no amount of inspecting the resolved strategy can: only the named
    // port is listening here, and the primary is a port nothing on any machine
    // answers on. The server reaching `running` means the probe went to the
    // port the template named.
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', () => resolve(undefined)));
    const named = (listener.address() as AddressInfo).port;

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: startable(
          { type: 'port', role: 'query', protocol: 'tcp', delayMs: 0, timeoutMs: 30_000 },
          {
            // Port 1 is privileged and unbound: a connection to it is refused
            // by the kernel at once, so a probe that went there would leave the
            // server in `starting` and fail this test rather than pass it by
            // accident.
            default: { ip: '127.0.0.1', port: 1 },
            additional: [{ ip: '127.0.0.1', port: named, role: 'query' }],
          },
        ),
      });

      await fake.instance.power('start');

      await vi.waitFor(() => expect(fake.instance.currentState).toBe('running'));
    } finally {
      listener.close();
    }
  });

  /**
   * A start that ends before anything is created.
   *
   * A startup command naming a port this server has not got cannot be built,
   * and refusing is the point — dropping the argument would leave `--rcon-port`
   * holding `--port`, and the game would run with no port of its own. But the
   * state had already moved to `starting`, and a refusal that leaves it there
   * is the spinner-for-ever this whole block exists to prevent: nothing was
   * created, so nothing will ever exit to move it on.
   */
  it('ends the start, loudly, when the command names a port it has not got', async () => {
    const fake = instanceWith({
      running: false,
      logs: '',
      volumesRoot: join(tmpdir(), 'hopper-server-instance-spec'),
      configuration: {
        ...startable({ type: 'immediate' }),
        invocation: './factorio --rcon-port {{server.allocations.rcon.port}} --port 34197',
        // A rebuild, so the start reaches the builder instead of reusing the
        // container the fake already has.
        container: { image: 'x', requiresRebuild: true },
      },
    });

    await expect(fake.instance.power('start')).rejects.toThrow(/rcon/);

    // Back where it started, with the reason where the operator looks — not
    // only in hopperd's log, on a machine they have no shell on.
    expect(fake.instance.currentState).toBe('offline');
    expect(consoleText(fake.instance)).toContain('rcon');
    expect(consoleText(fake.instance)).toContain('Network tab');
  });

  it('stops the server when the startup pattern never prints in time', async () => {
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'log', patterns: ['Done \\('], timeoutMs: 25 }),
    });

    await fake.instance.power('start');
    expect(fake.instance.currentState).toBe('starting');

    // The deadline is the template's own: reaching it means the operator asked
    // to be told, on this workload, after this long.
    await vi.waitFor(() => expect(fake.killed).toHaveBeenCalled());
    expect(consoleText(fake.instance)).toContain('startup pattern');
  });

  it('reports the stop that follows as one nobody asked for', async () => {
    // This is what makes the failure visible outside the console: an expected
    // stop is a "server stopped" notification and nothing more, which is
    // exactly how a start that failed used to disappear.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'log', patterns: ['Done \\('], timeoutMs: 25 }),
    });

    await fake.instance.power('start');
    await vi.waitFor(() => expect(fake.killed).toHaveBeenCalled());

    // The container obeys the signal: its console stream ends, which is where
    // the daemon decides what to tell the panel.
    fake.stream.emit('end');

    // Named as well as flagged. `expected: false` alone lands this stop on the
    // panel's one hardcoded sentence — "the process stopped on its own" —
    // which describes a crash, next to the exit code of the SIGTERM this
    // daemon had just sent. The operator was being sent after a crash that
    // never happened by the notification meant to save them the search.
    await vi.waitFor(() =>
      expect(fake.panel.reportStatus).toHaveBeenCalledWith(
        UUID,
        expect.objectContaining({ state: 'offline', expected: false, cause: 'readiness_failed' }),
      ),
    );
    expect(fake.instance.currentState).toBe('offline');
  });

  it('fails the start at once when the RCON password variable is not set', async () => {
    // A missing variable will still be missing in ten minutes. This branch
    // used to print a line and return, leaving the wait armed by nobody.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({
        type: 'rcon',
        secretVariable: 'RCON_PASSWORD',
        timeoutMs: 600_000,
      }),
    });

    await fake.instance.power('start');

    await vi.waitFor(() => expect(fake.killed).toHaveBeenCalled());
    expect(consoleText(fake.instance)).toContain('RCON_PASSWORD');
  });

  it('leaves a legacy startupDetection waiting for ever, as it always did', async () => {
    // Every shipped template and every imported egg declares this and nothing
    // else, and they were written when the daemon waited for ever. A modded
    // pack that spends a quarter of an hour loading its world must not be
    // stopped mid-start by a deadline its author never chose.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: { ...startable(undefined), startupDetection: 'Done \\(' },
    });

    await fake.instance.power('start');
    await sleep(60);

    expect(fake.instance.currentState).toBe('starting');
    expect(fake.killed).not.toHaveBeenCalled();
  });

  it('leaves a log strategy that declares no deadline waiting too', async () => {
    // What an imported Pterodactyl egg produces: the markers it declares, and
    // nothing about deadlines, because an egg has no opinion on them. While
    // `timeoutMs` carried a default this shape silently acquired ten minutes
    // nobody chose, and expiry stops the server — so every egg already
    // imported would have gained a start that can fail. Declaring a deadline
    // is how a template opts into that; declaring none keeps the old wait.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'log', patterns: ['Done \\('] }),
    });

    await fake.instance.power('start');
    await sleep(60);

    expect(fake.instance.currentState).toBe('starting');
    expect(fake.killed).not.toHaveBeenCalled();
    // Nothing was armed at all, rather than armed and never fired.
    expect(fake.instance.listenerCount('state')).toBe(0);
  });
});

/**
 * A deadline belongs to the start that armed it.
 *
 * `waitForLog` armed a timer and a `state` listener and released neither
 * unless the wait itself ended them — so a start that died another way left
 * both behind, holding a verdict, waiting for anything to be in `starting`
 * again. The next start was.
 */
describe('a start attempt that ended before its deadline', () => {
  it('never stops the start that replaced it', async () => {
    // The reviewer's reproduction, to the millisecond: the container died 60ms
    // into a 400ms deadline, the operator started the server again at 260ms,
    // and at 400ms the timer belonging to the dead attempt stopped a start
    // 140ms old over a silence that was never its own.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'log', patterns: ['Done \\('], timeoutMs: 400 }),
    });

    const armedAt = Date.now();
    await fake.instance.power('start');

    // The container goes down on its own: its console stream ends.
    await sleep(armedAt + 60 - Date.now());
    fake.stream.emit('end');
    await vi.waitFor(() => expect(fake.instance.currentState).toBe('offline'));

    await sleep(armedAt + 260 - Date.now());
    await fake.instance.power('start');

    // Well past the first attempt's deadline, and well inside the second's,
    // which does not run out until 660ms.
    await sleep(armedAt + 520 - Date.now());

    expect(fake.instance.currentState).toBe('starting');
    expect(fake.killed).not.toHaveBeenCalled();
  });

  it('takes its listener back off the emitter', async () => {
    // One leaked per crashed start, for as long as the server existed.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'log', patterns: ['Done \\('], timeoutMs: 10_000 }),
    });

    await fake.instance.power('start');
    expect(fake.instance.listenerCount('state')).toBe(1);

    fake.stream.emit('end');
    await vi.waitFor(() => expect(fake.instance.currentState).toBe('offline'));

    expect(fake.instance.listenerCount('state')).toBe(0);
  });
});

describe('a readiness strategy corrected while hopperd runs', () => {
  it('takes effect on the next start, not on the next daemon restart', async () => {
    // Resolved once in the constructor, so a template fixed in the panel and
    // synced down changed nothing until the process was bounced. That was
    // survivable while a stale strategy could only make a server hang; it now
    // stops the server, at a deadline the operator has already corrected.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: startable({ type: 'log', patterns: ['never printed'], timeoutMs: 25 }),
    });

    fake.instance.updateConfiguration(startable({ type: 'immediate' }));
    await fake.instance.power('start');

    expect(fake.instance.currentState).toBe('running');
    await sleep(60);
    expect(fake.killed).not.toHaveBeenCalled();
  });
});

describe('an installation the daemon was restarted out of', () => {
  // An install lives in a promise chain held by the process. Restart the
  // daemon halfway — an update does exactly that — and nobody reports success,
  // nobody reports failure, and the panel keeps the row at INSTALLING for
  // ever. Seen twice on real hardware in one evening, both times during a
  // panel update.
  it('reports the failure the dead daemon never sent', async () => {
    const panel = { reportInstall: vi.fn(() => Promise.resolve()) };
    const fake = instanceWith({
      running: false,
      logs: '',
      orphanedInstall: { exitCode: 0 },
      panel,
    });

    await fake.instance.reconcile();

    // Failed, even on exit code 0. The script ran; the container that had to
    // be built afterwards was not. Calling that a success hands the operator a
    // READY server with nothing behind it.
    expect(panel.reportInstall).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', false);
    expect(fake.instance.currentState).toBe('install_failed');
  });

  it('clears the leftover container', async () => {
    const fake = instanceWith({ running: false, logs: '', orphanedInstall: { exitCode: 1 } });

    await fake.instance.reconcile();

    expect(fake.removed).toHaveBeenCalled();
  });

  it('says nothing when there is no leftover', async () => {
    // The normal case by far, and it must stay silent: reporting a failure for
    // every healthy server on every daemon start would be its own outage.
    const panel = { reportInstall: vi.fn(() => Promise.resolve()) };
    const fake = instanceWith({ running: true, logs: 'x\n', panel });

    await fake.instance.reconcile();

    expect(panel.reportInstall).not.toHaveBeenCalled();
    expect(fake.instance.currentState).toBe('running');
  });
});

describe('ServerInstance.reconcile', () => {
  it('recovers the console of a container that is already running', async () => {
    const fake = instanceWith({
      running: true,
      logs: '[10:00:00 INFO]: Done (12.4s)!\n[10:04:11 INFO]: Julien joined the game\n',
    });

    await fake.instance.reconcile();

    expect(fake.instance.consoleSnapshot()).toEqual([
      '[10:00:00 INFO]: Done (12.4s)!',
      '[10:04:11 INFO]: Julien joined the game',
    ]);
  });

  it('keeps a line the log ends in the middle of', async () => {
    // Docker cuts at a byte count, not at a newline, so the last line arrives
    // unterminated more often than not. Dropping it would lose the most recent
    // thing the server said — the one line somebody is looking for.
    const fake = instanceWith({ running: true, logs: 'first\nsecond without a newline' });

    expect((await fake.instance.reconcile(), fake.instance.consoleSnapshot())).toEqual([
      'first',
      'second without a newline',
    ]);
  });

  it('asks for a bounded tail, never the whole log', async () => {
    // A server running for weeks has a log measured in hundreds of megabytes,
    // and none of it belongs in this process's memory.
    const fake = instanceWith({ running: true, logs: '' });

    await fake.instance.reconcile();

    expect(typeof fake.tail()).toBe('number');
    expect(fake.tail()).toBeLessThanOrEqual(1000);
  });

  it('adopts the server anyway when the log cannot be read', async () => {
    // A console missing its history is a nuisance. A daemon that refuses to
    // adopt a running server because of it is an outage.
    const fake = instanceWith({ running: true, logs: '', logsFails: true });

    await fake.instance.reconcile();

    expect(fake.instance.currentState).toBe('running');
    expect(fake.instance.consoleSnapshot()).toEqual([]);
  });

  it('reads no log for a container that is not running', async () => {
    // Its buffer would be the previous run's output, presented as if it were
    // this one's, above a server that is plainly offline.
    const fake = instanceWith({ running: false, logs: 'old run\n' });

    await fake.instance.reconcile();

    expect(fake.logs).not.toHaveBeenCalled();
    expect(fake.instance.consoleSnapshot()).toEqual([]);
  });
});

/**
 * What the server's own configuration files are told.
 *
 * The same variables the startup command reads, resolved the same way — a
 * template can write the port an operator named into `server.properties`. The
 * failure is not the same failure, though: a value here is a line in a file,
 * not an argument to a process, so an unresolved one is written empty rather
 * than refusing the start. That is survivable. Being survivable is not a reason
 * for it to be silent.
 */
describe('the configuration files', () => {
  it('says which values it wrote empty', async () => {
    const volumesRoot = await mkdtemp(join(tmpdir(), 'hopper-config-files-'));

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        volumesRoot,
        configuration: {
          ...startable({ type: 'immediate' }),
          configFiles: [
            {
              file: 'server.properties',
              parser: 'properties',
              replacements: [
                { match: 'server-port', replaceWith: '{{SERVER_PORT}}' },
                // The port nobody named. Left as it was, the server would
                // listen for RCON on whatever `rcon.port=` means when it is
                // empty, and no line anywhere would connect that to a name the
                // template asked for.
                { match: 'rcon.port', replaceWith: '{{server.allocations.rcon.port}}' },
              ],
            },
          ],
        },
      });

      await fake.instance.power('start');

      expect(consoleText(fake.instance)).toContain('{{server.allocations.rcon.port}}');
      // The resolved one is not complained about, and the file is still
      // written: an unresolved value costs its own line, never the start.
      expect(consoleText(fake.instance)).not.toContain('{{SERVER_PORT}}');
      expect(fake.instance.currentState).toBe('running');
    } finally {
      await rm(volumesRoot, { recursive: true, force: true });
    }
  });
});

/**
 * A server that speaks enough RCON to be stopped.
 *
 * Built out of `encodePacket` and `decodePackets` rather than by hand, because
 * those are the two functions `rcon.spec.ts` proves correct: a double with its
 * own framing would agree with itself and disagree with every real server, and
 * the framing is exactly where RCON clients go wrong.
 *
 * It answers an authentication with type 2, which is what srcds does and what
 * the client depends on — a type 0 reply is the empty preamble some servers
 * send before the verdict, and a client that took that for the verdict would
 * decide it was logged in before the server had said so.
 */
interface RconDouble {
  port: number;
  /** Commands the double actually received, after authenticating. */
  received: string[];
  close: () => Promise<void>;
}

async function rconDouble(options: {
  password: string;
  /**
   * What the double answers a command with. Empty by default, which is what a
   * shutdown command usually returns; a console command is the case where the
   * body is the whole point.
   */
  respondWith?: (command: string) => string;
  /**
   * What the double does *instead* of answering, which is what a game server
   * that has just executed `quit` does.
   *
   * `close` is the shutdown hanging up mid-answer and `silence` is the thread
   * that reads RCON being gone; both are ordinary outcomes of a stop that
   * worked, and a client that reads them as failures refuses stops it has
   * already delivered.
   */
  afterCommand?: 'answer' | 'close' | 'silence';
}): Promise<RconDouble> {
  const received: string[] = [];
  const accepted = new Set<Socket>();

  const server = createServer((socket) => {
    // Typed from what `decodePackets` gives back rather than from
    // `Buffer.alloc`, whose `Buffer<ArrayBufferLike>` is the wider of the two.
    let pending: ReturnType<typeof decodePackets>['rest'] = Buffer.alloc(0);
    let authenticated = false;

    accepted.add(socket);
    socket.on('close', () => accepted.delete(socket));

    socket.on('data', (chunk: Buffer) => {
      const read = decodePackets(Buffer.concat([pending, chunk]));
      pending = read.rest;

      for (const packet of read.packets) {
        if (!authenticated) {
          // A refusal is a well-formed packet with an id of −1, not an error:
          // the one thing about this protocol a client gets wrong in silence.
          if (packet.body !== options.password) {
            socket.write(encodePacket({ id: -1, type: 2, body: '' }));
            return;
          }

          authenticated = true;
          socket.write(encodePacket({ id: packet.id, type: 2, body: '' }));
          continue;
        }

        if (options.afterCommand === 'close') {
          received.push(packet.body);
          socket.destroy();
          return;
        }

        if (options.afterCommand === 'silence') {
          received.push(packet.body);
          continue;
        }

        // Answered first, recorded second, so a test that has seen the command
        // knows the reply is already on the wire.
        socket.write(
          encodePacket({
            id: packet.id,
            type: 0,
            body: options.respondWith?.(packet.body) ?? '',
          }),
        );
        received.push(packet.body);
      }
    });

    socket.on('error', () => undefined);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));

  return {
    port: (server.address() as AddressInfo).port,
    received,
    // Connections are cut rather than waited out: a delivered stop leaves the
    // client socket open for an answer that may never come, and a double that
    // waited for that would add the whole RCON timeout to every stop tested
    // here.
    close: () =>
      new Promise<void>((resolve) => {
        accepted.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}

interface StoppableOptions {
  stop: unknown;
  allocations?: unknown;
  environment?: Record<string, string>;
  stopTimeoutSeconds?: number;
}

/** A started server whose stop is whatever the template said it was. */
function stoppable(options: StoppableOptions): ServerConfiguration {
  return {
    ...startable({ type: 'immediate' }, options.allocations),
    stop: options.stop,
    environment: options.environment ?? {},
    // One second: every test here either sees the stop delivered or sees it
    // refused, and neither outcome is worth waiting thirty seconds for.
    stopTimeoutSeconds: options.stopTimeoutSeconds ?? 1,
  } as unknown as ServerConfiguration;
}

/**
 * Stopping a server that reads no standard input.
 *
 * Rust, ARK, Palworld and most Source servers never read stdin: the `command`
 * transport writes into a pipe nobody holds, nothing happens for the whole
 * deadline, and the server is SIGKILLed — a "clean stop" that is a kill with
 * extra waiting. These are also the games whose save is written on shutdown and
 * nowhere else, which is what makes every refusal below worth its two lines.
 */
describe('a stop sent over RCON', () => {
  const named = (rconPort: number) => ({
    // Port 1 is privileged and unbound, so a handshake that went to the game
    // port would be refused by the kernel at once rather than pass by accident.
    default: { ip: '127.0.0.1', port: 1 },
    additional: [{ ip: '127.0.0.1', port: rconPort, role: 'rcon' }],
  });

  it("sends the game's own shutdown command, to the port the template named", async () => {
    const double = await rconDouble({ password: 'hunter2' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'hunter2' },
        }),
      });

      await fake.instance.power('start');

      const stopping = fake.instance.power('stop');

      // `stopping` is only entered once the command has been delivered, which
      // is the whole ordering this transport rests on. Delivery is the bytes
      // leaving this process, so the double has read them a moment later.
      await vi.waitFor(() => expect(fake.instance.currentState).toBe('stopping'));
      await vi.waitFor(() => expect(double.received).toEqual(['quit']));

      // The container obeys: its console stream ends.
      fake.stream.emit('end');
      await stopping;

      expect(fake.instance.currentState).toBe('offline');
      expect(fake.killed).not.toHaveBeenCalled();
    } finally {
      await double.close();
    }
  });

  it('kills after the deadline once the command has been delivered', async () => {
    // The line this transport draws is delivery, not success. The server has
    // been asked, is presumably saving, and the deadline is the template's own
    // — so the SIGKILL applies exactly as it does to a stdin command that was
    // read and ignored.
    const double = await rconDouble({ password: 'hunter2' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'hunter2' },
        }),
      });

      await fake.instance.power('start');
      await fake.instance.power('stop');

      expect(double.received).toEqual(['quit']);
      expect(fake.killed).toHaveBeenCalledWith({ signal: 'SIGKILL' });
      expect(consoleText(fake.instance)).toContain('Data loss is possible');
    } finally {
      await double.close();
    }
  });

  /**
   * The bug this transport shipped with, in the two shapes it takes.
   *
   * A server that has just executed `quit` does not answer. It hangs up
   * mid-shutdown, or its RCON thread is simply gone and the socket goes quiet
   * until the five-second timeout. Both were read as "the command was never
   * delivered", so the daemon refused a stop that had in fact been delivered:
   * the game went down because it had been told to, while nothing waited for
   * the exit and no SIGKILL was armed. `power('restart')` never restarted, and
   * `install` marked a server that was on its way down INSTALL_FAILED.
   *
   * The assertion in both is the same and it is the one that failed: the state
   * moves to `stopping`, so the exit is waited for.
   */
  const delivered: [string, 'close' | 'silence'][] = [
    ['hangs up without answering', 'close'],
    ['answers nothing at all', 'silence'],
  ];

  it.each(delivered)('waits for the exit when the server %s', async (_case, afterCommand) => {
    const double = await rconDouble({ password: 'hunter2', afterCommand });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'hunter2' },
        }),
      });

      await fake.instance.power('start');

      const stopping = fake.instance.power('stop');

      await vi.waitFor(() => expect(fake.instance.currentState).toBe('stopping'));
      await vi.waitFor(() => expect(double.received).toEqual(['quit']));

      // The server obeys the command it was sent, which is the whole premise:
      // its console stream ends, and the daemon is there to see it.
      fake.stream.emit('end');
      await stopping;

      expect(fake.instance.currentState).toBe('offline');
      expect(fake.killed).not.toHaveBeenCalled();
      expect(consoleText(fake.instance)).not.toContain('could not be stopped');
    } finally {
      await double.close();
    }
  });

  it('still arms the deadline for a server that took the command and stayed up', async () => {
    // The other half of the same fix: delivery is not obedience. A server that
    // answered nothing and then does not exit is a server choosing not to, and
    // the SIGKILL after `stopTimeoutSeconds` is the operator's declared
    // patience with that — which the refusal path was skipping entirely.
    const double = await rconDouble({ password: 'hunter2', afterCommand: 'close' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'hunter2' },
        }),
      });

      await fake.instance.power('start');
      await fake.instance.power('stop');

      expect(fake.killed).toHaveBeenCalledWith({ signal: 'SIGKILL' });
      expect(consoleText(fake.instance)).toContain('Data loss is possible');
    } finally {
      await double.close();
    }
  });

  it("puts the server's parting words on the console when it has any", async () => {
    // A bonus and never a condition. Most shutdown commands answer nothing, and
    // the ones that answer say something the operator wants — but the stop is
    // already delivered either way.
    const double = await rconDouble({
      password: 'hunter2',
      respondWith: () => 'Saving and shutting down',
    });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'hunter2' },
        }),
      });

      await fake.instance.power('start');
      await fake.instance.power('stop');

      await vi.waitFor(() =>
        expect(consoleText(fake.instance)).toContain('[RCON] Saving and shutting down'),
      );
    } finally {
      await double.close();
    }
  });

  /**
   * Every refusal below shares one assertion, and it is the important one:
   * nothing was killed.
   *
   * In all of these the game has been told nothing whatsoever — the command
   * never left this process, or never got past the handshake. It is running
   * exactly as it was a second earlier, with its world in memory. Falling
   * through to the SIGKILL would not be a less graceful stop, it would be
   * killing a process that was never asked to stop: the whole session lost, for
   * a mistyped variable name, decided on the operator's behalf.
   */
  const unreachable = { default: { ip: '127.0.0.1', port: 1 }, additional: [] };

  const refusals: [string, StoppableOptions, string][] = [
    [
      'the role names no port on this server',
      {
        stop: { type: 'rcon', command: 'quit', role: 'query', secretVariable: 'RCON_PASSWORD' },
        allocations: unreachable,
        environment: { RCON_PASSWORD: 'hunter2' },
      },
      'query',
    ],
    [
      'the variable holding the password is not set',
      {
        stop: { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
        allocations: unreachable,
      },
      'RCON_PASSWORD',
    ],
    [
      'nothing answers on the RCON port',
      {
        stop: { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
        allocations: unreachable,
        environment: { RCON_PASSWORD: 'hunter2' },
      },
      '127.0.0.1:1',
    ],
  ];

  it.each(refusals)(
    'refuses the stop when %s, and leaves the server running',
    async (_case, configuration, named_) => {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable(configuration),
      });

      await fake.instance.power('start');
      await expect(fake.instance.power('stop')).rejects.toThrow();

      expect(fake.instance.currentState).toBe('running');
      expect(fake.killed).not.toHaveBeenCalled();
      // Naming what to fix is what makes a refusal actionable rather than an
      // apology, and the console is where the operator is already looking.
      expect(consoleText(fake.instance)).toContain(named_);
      expect(consoleText(fake.instance)).toContain('still running');
    },
  );

  it('refuses a password the server rejects, and says which variable holds it', async () => {
    // Told apart from an unreachable port on purpose: the two look identical
    // from the panel and have nothing in common to fix.
    const double = await rconDouble({ password: 'hunter2' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'not the password' },
        }),
      });

      await fake.instance.power('start');
      await expect(fake.instance.power('stop')).rejects.toThrow();

      expect(fake.instance.currentState).toBe('running');
      expect(fake.killed).not.toHaveBeenCalled();
      expect(consoleText(fake.instance)).toContain('refused the password');
      expect(consoleText(fake.instance)).toContain('RCON_PASSWORD');
      expect(double.received).toEqual([]);
    } finally {
      await double.close();
    }
  });

  it('tells the panel the stop was refused, and which state the server is still in', async () => {
    // The console lines are for whoever is watching, and the caller that most
    // needs this is the one nobody watches: a nightly schedule's `stop` step is
    // acknowledged over HTTP before the stop is even attempted, so the throw
    // dies in a log on the node and the run is recorded as having succeeded —
    // over a server that is still up and still taking players.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: stoppable({
        stop: { type: 'rcon', command: 'quit', role: 'query', secretVariable: 'RCON_PASSWORD' },
        allocations: unreachable,
        environment: { RCON_PASSWORD: 'hunter2' },
      }),
    });

    await fake.instance.power('start');
    await expect(fake.instance.power('stop')).rejects.toThrow();

    expect(fake.panel.reportStatus).toHaveBeenCalledWith(
      UUID,
      // `running`, because that is where the server is: this report names a
      // state it never left, not a transition it made.
      expect.objectContaining({ state: 'running', expected: false, cause: 'stop_refused' }),
    );
  });

  it('says nothing to the panel about a stop that was delivered', async () => {
    // The other half of the guard. A `stop_refused` report on a stop that
    // worked would put a refusal in the activity log of every ordinary stop,
    // and a record that appears either way records nothing.
    const double = await rconDouble({ password: 'hunter2', afterCommand: 'close' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: stoppable({
          stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
          allocations: named(double.port),
          environment: { RCON_PASSWORD: 'hunter2' },
        }),
      });

      await fake.instance.power('start');
      await fake.instance.power('stop');

      expect(fake.panel.reportStatus).not.toHaveBeenCalledWith(
        UUID,
        expect.objectContaining({ cause: 'stop_refused' }),
      );
    } finally {
      await double.close();
    }
  });

  it('never enters `stopping` on a refusal', async () => {
    // The state the panel shows as a spinner, and one only the container can
    // leave. Entering it and then saying nothing to the server would park the
    // operator on a stop that is not happening, over a server that is fine.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: stoppable({
        stop: { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
        allocations: unreachable,
      }),
    });

    await fake.instance.power('start');

    const states: string[] = [];
    fake.instance.on('state', (state) => states.push(state));

    await expect(fake.instance.power('stop')).rejects.toThrow();

    expect(states).toEqual([]);
  });
});

/**
 * The two transports that came before RCON, unchanged.
 *
 * Every server on every existing installation stops through one of these, and a
 * third arm on a discriminated union is exactly the kind of change that quietly
 * rewires the `else` branch the other two were relying on.
 */
describe('the stop transports that already existed', () => {
  it('still writes a command stop to standard input', async () => {
    const written: string[] = [];
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: stoppable({ stop: { type: 'command', value: 'stop' } }),
    });

    // The fake console stream is an emitter; a stdin stop needs somewhere to
    // write, and what it writes is the assertion.
    (fake.stream as unknown as { write: unknown }).write = (
      chunk: string,
      done: (error?: Error) => void,
    ) => {
      written.push(chunk);
      done();
      return true;
    };

    await fake.instance.power('start');
    await fake.instance.power('stop');

    expect(written).toEqual(['stop\n']);
    expect(consoleText(fake.instance)).toContain('Stopping (command "stop")');
  });

  it('still signals PID 1 for a signal stop', async () => {
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: stoppable({ stop: { type: 'signal', value: 'SIGINT' } }),
    });

    await fake.instance.power('start');
    await fake.instance.power('stop');

    // The signal the template asked for, and only then the SIGKILL the
    // deadline brings.
    expect(fake.killed).toHaveBeenCalledWith({ signal: 'SIGINT' });
    expect(consoleText(fake.instance)).toContain('Stopping (signal SIGINT)');
  });
});

/**
 * The console of a server that reads no standard input.
 *
 * A server stopped over RCON could be stopped and not talked to. `sendCommand`
 * wrote to the container's attach stream, which for these games goes into a pty
 * nobody reads — and it **reported success**, because writing to a socket
 * succeeds whatever is on the other end. A scheduled task that ran `save-all`
 * and announced a restart was a no-op the panel recorded as having run, and
 * that is the failure the whole multi-game risk statement is built around.
 */
describe('a console command on a server that takes RCON', () => {
  const named = (rconPort: number) => ({
    // Port 1 is privileged and unbound: a command that went to the game port
    // instead is refused by the kernel rather than passing by accident.
    default: { ip: '127.0.0.1', port: 1 },
    additional: [{ ip: '127.0.0.1', port: rconPort, role: 'rcon' }],
  });

  const overRcon = (rconPort: number, environment: Record<string, string>) =>
    stoppable({
      stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
      allocations: named(rconPort),
      environment,
    });

  /**
   * Records anything written to the container's standard input.
   *
   * Present in every test here and asserted empty in most of them: the whole
   * change is that these commands stop going down a pipe nobody holds, and a
   * test that only checked the RCON side would pass just as well if they went
   * to both.
   */
  function watchStdin(stream: EventEmitter): string[] {
    const written: string[] = [];

    (stream as unknown as { write: unknown }).write = (
      chunk: string,
      done: (error?: Error) => void,
    ) => {
      written.push(chunk);
      done();
      return true;
    };

    return written;
  }

  it('goes to the RCON port, and not to standard input', async () => {
    const double = await rconDouble({ password: 'hunter2' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: overRcon(double.port, { RCON_PASSWORD: 'hunter2' }),
      });

      const stdin = watchStdin(fake.stream);

      await fake.instance.power('start');
      await fake.instance.sendCommand('save-all');

      // Waited for rather than asserted outright: `sendCommand` now settles the
      // moment the bytes leave this process, which is the definition of
      // delivery and is deliberately earlier than the peer having read them.
      // Not a flake — the same reordering that stops a server which answers
      // nothing from being reported as one that was never told.
      await vi.waitFor(() => expect(double.received).toEqual(['save-all']));
      expect(stdin).toEqual([]);
    } finally {
      await double.close();
    }
  });

  it("puts the server's answer on the console, marked as having come from RCON", async () => {
    // The half of this that stdin cannot do. Throwing the body away would be
    // worse than the silence it replaces: the operator would have asked a
    // question, been told nothing, and still have no way to tell a console that
    // works from one that discards what they type.
    const double = await rconDouble({
      password: 'hunter2',
      respondWith: () => 'There are 2 of a max of 40 players online:\nnotch\njeb_',
    });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: overRcon(double.port, { RCON_PASSWORD: 'hunter2' }),
      });

      await fake.instance.power('start');
      await fake.instance.sendCommand('list');

      // Echoed, because nothing else will: these games log nothing when a
      // command is issued, so without this an operator watches their own
      // commands vanish and never sees a scheduled one at all. The echo is
      // written before the command is sent, so it is there as soon as
      // `sendCommand` returns.
      expect(consoleText(fake.instance)).toContain('[RCON] > list');

      // The answer, on the other hand, arrives whenever the server sends it —
      // after delivery settled the call. Waiting for it is the honest shape:
      // an answer is no longer what proves the command got there.
      await vi.waitFor(() => {
        const console = consoleText(fake.instance);

        expect(console).toContain('[RCON] There are 2 of a max of 40 players online:');
        expect(console).toContain('[RCON] notch');
        expect(console).toContain('[RCON] jeb_');
      });

      // And in that order: a reply printed above the command that caused it
      // would read as the answer to the previous one.
      const text = consoleText(fake.instance);
      expect(text.indexOf('[RCON] > list')).toBeLessThan(text.indexOf('[RCON] notch'));
    } finally {
      await double.close();
    }
  });

  it('shows the command it sent even when the server answers with nothing', async () => {
    // Silence is the ordinary answer for a save or a shutdown, and it no longer
    // earns a line of its own. It used to: an answer was once what proved the
    // command had arrived, so its absence was worth naming. Delivery proves
    // that now, and an `(accepted, no output)` under almost every command would
    // say almost nothing — the echo is what tells the operator their command
    // went.
    const double = await rconDouble({ password: 'hunter2' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: overRcon(double.port, { RCON_PASSWORD: 'hunter2' }),
      });

      await fake.instance.power('start');
      await fake.instance.sendCommand('save');

      const console = consoleText(fake.instance);

      expect(console).toContain('[RCON] > save');
      expect(console).not.toContain('could not be delivered');

      await vi.waitFor(() => expect(double.received).toEqual(['save']));
    } finally {
      await double.close();
    }
  });

  /**
   * The regression guard for the silent no-op.
   *
   * Each of these is a command the server never received. Reporting success
   * would leave a scheduled `save-all` recorded as having run, which is the
   * exact shape of the bug: nothing in the panel, nothing in the audit record
   * and nothing in the console would distinguish it from a world that was
   * saved.
   */
  const undelivered: [string, unknown, Record<string, string>, string][] = [
    [
      'the role names no port on this server',
      { type: 'rcon', command: 'quit', role: 'query', secretVariable: 'RCON_PASSWORD' },
      { RCON_PASSWORD: 'hunter2' },
      'query',
    ],
    [
      'the variable holding the password is not set',
      { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
      {},
      'RCON_PASSWORD',
    ],
    [
      'nothing answers on the RCON port',
      { type: 'rcon', command: 'quit', secretVariable: 'RCON_PASSWORD' },
      { RCON_PASSWORD: 'hunter2' },
      '127.0.0.1:1',
    ],
  ];

  it.each(undelivered)('fails loudly when %s', async (_case, stop, environment, named_) => {
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: stoppable({
        stop,
        // No port named `rcon`, and a primary that is privileged and unbound.
        allocations: { default: { ip: '127.0.0.1', port: 1 }, additional: [] },
        environment,
      }),
    });

    const stdin = watchStdin(fake.stream);

    await fake.instance.power('start');

    // The assertion the whole change exists for. A resolved promise here is
    // an HTTP 204 to the panel, and an HTTP 204 is a scheduled task recorded
    // as successful.
    await expect(fake.instance.sendCommand('save-all')).rejects.toThrow('save-all');

    // And no quiet fallback to the channel that reports success whatever
    // happens.
    expect(stdin).toEqual([]);

    const console = consoleText(fake.instance);
    expect(console).toContain(named_);
    expect(console).toContain('has not run this one');
  });

  it('names the variable when the server refuses the password', async () => {
    // Told apart from an unreachable port deliberately: the two look identical
    // from the panel and have nothing in common to fix.
    const double = await rconDouble({ password: 'hunter2' });

    try {
      const fake = instanceWith({
        running: false,
        logs: '',
        configuration: overRcon(double.port, { RCON_PASSWORD: 'not the password' }),
      });

      await fake.instance.power('start');
      await expect(fake.instance.sendCommand('save-all')).rejects.toThrow();

      expect(consoleText(fake.instance)).toContain('refused the password held in RCON_PASSWORD');
      expect(double.received).toEqual([]);
    } finally {
      await double.close();
    }
  });

  it('refuses when the server is not started, in the same words as stdin', async () => {
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: overRcon(1, { RCON_PASSWORD: 'hunter2' }),
    });

    // Not started: the caller gets the answer it already knew, rather than a
    // message about an unreachable RCON port for a server that is not running.
    await expect(fake.instance.sendCommand('save-all')).rejects.toThrow(
      'The server is not started.',
    );
  });

  it('leaves a template that stops on stdin writing to stdin', async () => {
    // Every Minecraft server on every existing installation. It reads stdin and
    // speaks RCON, and the channel needing no password is the better of the
    // two — so the transport is chosen by what the template declared, never by
    // what the server happens to support.
    const fake = instanceWith({
      running: false,
      logs: '',
      configuration: stoppable({ stop: { type: 'command', value: 'stop' } }),
    });

    const stdin = watchStdin(fake.stream);

    await fake.instance.power('start');
    await fake.instance.sendCommand('say hello');

    expect(stdin).toEqual(['say hello\n']);
    // Nothing marked as RCON, and nothing claiming a command was not
    // delivered: this path is untouched.
    expect(consoleText(fake.instance)).not.toContain('[RCON]');
  });
});

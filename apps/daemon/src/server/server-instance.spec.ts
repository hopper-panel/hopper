import { EventEmitter } from 'node:events';
import type { ServerConfiguration } from '@hopper/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
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
function startable(readiness: unknown): ServerConfiguration {
  return {
    ...CONFIGURATION,
    environment: {},
    readiness,
    configFiles: [],
    fileDenylist: [],
    allocations: { default: { ip: '127.0.0.1', port: 27015 }, additional: [] },
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

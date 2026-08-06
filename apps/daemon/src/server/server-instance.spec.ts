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

const CONFIGURATION = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Test',
  suspended: false,
  container: { image: 'x', requiresRebuild: false },
  limits: {},
} as unknown as ServerConfiguration;

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
  tail: () => unknown;
}

function instanceWith(options: {
  running: boolean;
  logs: string | Buffer;
  logsFails?: boolean;
  /** A leftover install container, i.e. an installation nobody finished. */
  orphanedInstall?: { exitCode: number };
  panel?: { reportInstall: ReturnType<typeof vi.fn> };
}): Fake {
  const logs = vi.fn((_options: { tail?: number }) =>
    options.logsFails
      ? Promise.reject(new Error('no such container'))
      : Promise.resolve(options.logs),
  );

  const container = {
    inspect: () =>
      Promise.resolve({
        State: { Running: options.running, StartedAt: '2026-08-05T10:00:00.000Z' },
      }),
    logs,
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

  const docker = {
    api: {
      getContainer: (name: string) =>
        name.startsWith('hopper-install-') ? installContainer : container,
    },
    // Resolves to something stream-shaped that never emits: the point here is
    // the buffer's contents before a single new byte arrives.
    attachToContainer: () => Promise.resolve({ on: () => undefined }),
  } as unknown as DockerClient;

  const instance = new ServerInstance({
    configuration: CONFIGURATION,
    docker,
    logger,
    dataPath: '/var/lib/hopper/volumes',
    tmpPath: '/tmp',
    ownership: { uid: 988, gid: 988 },
    networkName: 'hopper0',
    panel: options.panel ?? { reportInstall: vi.fn(() => Promise.resolve()) },
  } as never);

  return {
    instance,
    logs,
    removed,
    tail: () => logs.mock.calls[0]?.[0]?.tail,
  };
}

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

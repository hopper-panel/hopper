import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../docker/client.js';
import type { ServerManager } from '../server/server-manager.js';
import { registerSystemRoutes } from './system.js';

/**
 * The wire between the daemon's measurement and the operator's screen.
 *
 * `hopper doctor` renders the isolation verdict and the daemon takes it; this
 * route is the only thing joining them, and both halves were tested while the
 * join was not — deleting the field from the payload left every test on either
 * side passing, and the doctor simply reported "this daemon does not check"
 * for a daemon that does.
 */

function harness(overrides: Partial<DockerClient> = {}) {
  const app = Fastify();

  const docker = {
    info: vi.fn(() =>
      Promise.resolve({
        version: '29.3.1',
        storageDriver: 'overlay2',
        cgroupVersion: '2',
        runningContainers: 3,
      }),
    ),
    checkNetworkIsolation: vi.fn(() =>
      Promise.resolve({
        network: 'hopper0',
        status: 'isolated' as const,
        detail: 'the option is set',
      }),
    ),
    ...overrides,
  } as unknown as DockerClient;

  const manager = { count: () => 0, all: () => [] } as unknown as ServerManager;

  registerSystemRoutes(app, docker, manager);

  return { app, docker };
}

async function get(app: ReturnType<typeof harness>['app']) {
  const response = await app.inject({ method: 'GET', url: '/api/system' });
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('GET /api/system', () => {
  it('carries the network isolation verdict', async () => {
    const { app } = harness();

    expect(await get(app)).toMatchObject({
      networkIsolation: { network: 'hopper0', status: 'isolated' },
    });
  });

  it('carries an open verdict, which is the one that has to travel', async () => {
    // The verdict nobody sees is the one that matters: an isolated node needs
    // no action, an open one is the whole reason the field exists.
    const { app } = harness({
      checkNetworkIsolation: vi.fn(() =>
        Promise.resolve({
          network: 'hopper0',
          status: 'open' as const,
          detail: 'com.docker.network.bridge.enable_icc is not set on it',
        }),
      ),
    });

    expect(await get(app)).toMatchObject({
      networkIsolation: {
        status: 'open',
        detail: expect.stringContaining('enable_icc') as unknown,
      },
    });
  });

  it('measures it per request rather than once', async () => {
    // The network can be replaced under a running daemon. A verdict cached at
    // startup would be repeated for the life of the process, which on a node
    // that was fixed an hour ago means a red cross that never clears — and on
    // one that broke an hour ago, a green tick that never appears.
    const { app, docker } = harness();

    await get(app);
    await get(app);

    expect(docker.checkNetworkIsolation).toHaveBeenCalledTimes(2);
  });

  it('still answers when Docker is not', async () => {
    // Docker can be stopped without the daemon being stopped. The node stays
    // reachable and says so, rather than returning a 500 the panel would show
    // as "offline" — hiding the real cause.
    const { app } = harness({
      info: vi.fn(() => Promise.reject(new Error('connect ENOENT /var/run/docker.sock'))),
      checkNetworkIsolation: vi.fn(() =>
        Promise.resolve({
          network: 'hopper0',
          status: 'unknown' as const,
          detail: 'Docker could not be reached',
        }),
      ),
    });

    const body = await get(app);

    expect(body).toMatchObject({ networkIsolation: { status: 'unknown' } });
    expect((body.docker as { version: string }).version).toBe('');
  });
});

import type { ServerConfiguration } from '@hopper/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedConfig } from '../config/load.js';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { ServerManager } from './server-manager.js';

/**
 * These tests cover one precise point: **the daemon must not stay blind** when
 * the panel is not ready yet.
 *
 * Both services restart together after an update, and the daemon is nearly
 * always up first. Without a retry it answered "Server unknown to this node" to
 * every console until the next manual restart — the symptom is spectacular and
 * the cause invisible.
 */

const CONFIGURATION = {
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Test',
} as unknown as ServerConfiguration;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const config = {
  paths: { data: '/var/lib/hopper/volumes', tmp: '/tmp' },
  config: {
    docker: { network: { name: 'hopper0' }, blkioWeight: false },
    system: { uid: 988, gid: 988, timezone: 'Europe/Paris' },
  },
} as unknown as LoadedConfig;

/** Simulated Docker: no container on the host, so no orphan. */
const docker = {
  listManagedContainers: () => Promise.resolve(new Map<string, unknown>()),
} as unknown as DockerClient;

function managerWith(fetchServers: () => Promise<ServerConfiguration[]>): ServerManager {
  return new ServerManager(config, docker, { fetchServers } as unknown as PanelClient, logger);
}

describe('ServerManager.reconcile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers the servers the panel returns', async () => {
    const manager = managerWith(() => Promise.resolve([CONFIGURATION]));

    await manager.reconcile();

    expect(manager.list()).toHaveLength(1);
    expect(manager.get(CONFIGURATION.uuid)).toBeDefined();
  });

  it('retries when the panel is unreachable', async () => {
    const fetchServers = vi
      .fn<() => Promise<ServerConfiguration[]>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce([CONFIGURATION]);

    const manager = managerWith(fetchServers);
    await manager.reconcile();

    expect(manager.list()).toHaveLength(0);
    expect(fetchServers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchServers).toHaveBeenCalledTimes(2);
    expect(manager.list()).toHaveLength(1);
  });

  it('spaces its attempts out while the panel stays silent', async () => {
    const fetchServers = vi
      .fn<() => Promise<ServerConfiguration[]>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const manager = managerWith(fetchServers);
    await manager.reconcile();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchServers).toHaveBeenCalledTimes(2);

    // The next attempt is further off: at a fixed five seconds, a panel down
    // for the night would produce seventeen thousand requests.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchServers).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchServers).toHaveBeenCalledTimes(3);

    manager.shutdown();
  });

  it('does not stack timers when a retry is already scheduled', async () => {
    const fetchServers = vi
      .fn<() => Promise<ServerConfiguration[]>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const manager = managerWith(fetchServers);

    await manager.reconcile();
    await manager.reconcile();
    await manager.reconcile();

    expect(fetchServers).toHaveBeenCalledTimes(3);

    // Three failures but a single retry: otherwise each manual call would add
    // its own loop, and their number would double every round.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchServers).toHaveBeenCalledTimes(4);
  });

  it('stops retrying on shutdown', async () => {
    const fetchServers = vi
      .fn<() => Promise<ServerConfiguration[]>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const manager = managerWith(fetchServers);
    await manager.reconcile();
    manager.shutdown();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchServers).toHaveBeenCalledTimes(1);
  });
});

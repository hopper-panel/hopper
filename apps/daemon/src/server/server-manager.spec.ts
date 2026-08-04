import type { ServerConfiguration } from '@hopper/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedConfig } from '../config/load.js';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { ServerManager } from './server-manager.js';

/**
 * Ces tests portent sur un point précis : **le daemon ne doit pas rester
 * aveugle** quand le panel n'est pas encore prêt.
 *
 * Les deux services redémarrent ensemble après une mise à jour, et le daemon
 * est presque toujours debout le premier. Sans reprise, il répondait « Serveur
 * inconnu de ce node » à toutes les consoles jusqu'au prochain redémarrage
 * manuel — le symptôme est spectaculaire et la cause invisible.
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

/** Docker simulé : aucun conteneur sur l'hôte, donc aucun orphelin. */
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

  it('enregistre les serveurs rendus par le panel', async () => {
    const manager = managerWith(() => Promise.resolve([CONFIGURATION]));

    await manager.reconcile();

    expect(manager.list()).toHaveLength(1);
    expect(manager.get(CONFIGURATION.uuid)).toBeDefined();
  });

  it('réessaie quand le panel n’est pas joignable', async () => {
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

  it('espace ses tentatives tant que le panel reste muet', async () => {
    const fetchServers = vi
      .fn<() => Promise<ServerConfiguration[]>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const manager = managerWith(fetchServers);
    await manager.reconcile();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchServers).toHaveBeenCalledTimes(2);

    // La tentative suivante est plus lointaine : à cinq secondes fixes, un
    // panel arrêté pour la nuit produirait dix-sept mille requêtes.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchServers).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchServers).toHaveBeenCalledTimes(3);

    manager.shutdown();
  });

  it('n’empile pas les minuteurs quand la reprise est déjà programmée', async () => {
    const fetchServers = vi
      .fn<() => Promise<ServerConfiguration[]>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const manager = managerWith(fetchServers);

    await manager.reconcile();
    await manager.reconcile();
    await manager.reconcile();

    expect(fetchServers).toHaveBeenCalledTimes(3);

    // Trois échecs, mais une seule reprise : sinon chaque appel manuel
    // ajouterait sa propre boucle, et leur nombre doublerait à chaque tour.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchServers).toHaveBeenCalledTimes(4);
  });

  it('arrête de réessayer à l’extinction', async () => {
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

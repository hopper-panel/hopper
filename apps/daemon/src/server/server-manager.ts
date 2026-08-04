import { rm } from 'node:fs/promises';
import type { ServerConfiguration } from '@hopper/shared';
import type { LoadedConfig } from '../config/load.js';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { ServerInstance } from './server-instance.js';

/**
 * Registry of the servers hosted by this node.
 *
 * The daemon knows only what the panel has told it: there is no persistence
 * here. At startup the list is reloaded from the panel then compared with the
 * containers actually present.
 */
/**
 * Delays between two attempts at fetching the server list, in milliseconds.
 * The last one repeats.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

export class ServerManager {
  private readonly servers = new Map<string, ServerInstance>();

  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;

  constructor(
    private readonly config: LoadedConfig,
    private readonly docker: DockerClient,
    private readonly panel: PanelClient,
    private readonly logger: Logger,
  ) {}

  get(uuid: string): ServerInstance | undefined {
    return this.servers.get(uuid);
  }

  /** Fetches a server, or throws an error carrying a usable code. */
  require(uuid: string): ServerInstance {
    const server = this.servers.get(uuid);

    if (!server) {
      const error = new Error('Serveur inconnu de ce node.') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }

    return server;
  }

  list(): ServerInstance[] {
    return [...this.servers.values()];
  }

  /** Registers a server, or updates its configuration if it already exists. */
  upsert(configuration: ServerConfiguration): ServerInstance {
    const existing = this.servers.get(configuration.uuid);

    if (existing) {
      existing.updateConfiguration(configuration);
      return existing;
    }

    const instance = new ServerInstance({
      configuration,
      docker: this.docker,
      logger: this.logger,
      volumesRoot: this.config.paths.data,
      networkName: this.config.config.docker.network.name,
      ownership: { uid: this.config.config.system.uid, gid: this.config.config.system.gid },
      timezone: this.config.config.system.timezone,
      enableBlkioWeight: this.config.config.docker.blkioWeight,
      tmpPath: this.config.paths.tmp,
      panel: this.panel,
    });

    this.servers.set(configuration.uuid, instance);
    return instance;
  }

  async remove(uuid: string, purgeVolume: boolean): Promise<void> {
    const server = this.servers.get(uuid);

    if (!server) {
      return;
    }

    await server.destroyContainer();

    if (purgeVolume) {
      this.logger.warn({ server: uuid, path: server.volumePath }, 'Suppression du volume');
      await rm(server.volumePath, { recursive: true, force: true });
    }

    this.servers.delete(uuid);
  }

  /**
   * Aligns the internal state with the containers present on the host.
   *
   * A Hopper container that is present but absent from the panel's list is
   * **reported, never deleted**: it is nearly always the sign of a
   * misconfigured panel or a database restored from too far back, and
   * destroying a server's data on that basis would be irreparable.
   */
  async reconcile(): Promise<void> {
    // The list comes from the panel, the only source of truth: the daemon
    // persists nothing between two starts.
    try {
      const configurations = await this.panel.fetchServers();
      configurations.forEach((configuration) => this.upsert(configuration));
      this.cancelRetry();
    } catch (error: unknown) {
      // An unreachable panel at startup must not stop the daemon from serving:
      // the containers already launched keep running, and the operator needs
      // /healthz to answer in order to diagnose.
      //
      // But it must not stay blind either. Both services restart together after
      // an update, and the daemon is nearly always ready first: without a
      // retry, it answered "Server unknown to this node" to every console until
      // the next manual restart.
      this.logger.error(
        { err: error },
        'Could not fetch the servers from the panel: another attempt scheduled',
      );

      this.scheduleRetry();
    }

    const containers = await this.docker.listManagedContainers();

    await Promise.all(this.list().map((server) => server.reconcile()));

    const orphans = [...containers.keys()].filter((uuid) => !this.servers.has(uuid));

    if (orphans.length > 0) {
      this.logger.warn(
        { count: orphans.length, servers: orphans },
        'Hopper containers present on the host but unknown to the panel. They are not deleted: check the node configuration.',
      );
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) {
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)]!;
    this.retryAttempt += 1;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile();
    }, delay);

    // `unref`: this timer must not hold the process alive. Without it, a daemon
    // stopped during a wait would stay open until the delay elapsed.
    this.retryTimer.unref();
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.retryAttempt = 0;
  }

  /** Detaches every stream. The containers keep running. */
  shutdown(): void {
    this.cancelRetry();
    this.list().forEach((server) => server.detach());
  }
}

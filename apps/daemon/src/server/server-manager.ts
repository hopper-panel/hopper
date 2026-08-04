import { rm } from 'node:fs/promises';
import type { ServerConfiguration } from '@hopper/shared';
import type { LoadedConfig } from '../config/load.js';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { ServerInstance } from './server-instance.js';

/**
 * Registre des serveurs hébergés par ce node.
 *
 * Le daemon ne connaît que ce que le panel lui a transmis : il n'y a pas de
 * persistance ici. Au démarrage, la liste est rechargée depuis le panel puis
 * confrontée aux conteneurs réellement présents.
 */
export class ServerManager {
  private readonly servers = new Map<string, ServerInstance>();

  constructor(
    private readonly config: LoadedConfig,
    private readonly docker: DockerClient,
    private readonly panel: PanelClient,
    private readonly logger: Logger,
  ) {}

  get(uuid: string): ServerInstance | undefined {
    return this.servers.get(uuid);
  }

  /** Récupère un serveur ou lève une erreur portant un code exploitable. */
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

  /** Enregistre un serveur, ou met à jour sa configuration s'il existe déjà. */
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
   * Aligne l'état interne sur les conteneurs présents sur l'hôte.
   *
   * Un conteneur Hopper présent mais absent de la liste du panel est **signalé,
   * jamais supprimé** : c'est presque toujours le signe d'un panel mal
   * configuré ou d'une base restaurée trop ancienne, et détruire les données
   * d'un serveur sur cette base serait irréparable.
   */
  async reconcile(): Promise<void> {
    // La liste vient du panel, seule source de vérité : le daemon ne persiste
    // rien entre deux démarrages.
    try {
      const configurations = await this.panel.fetchServers();
      configurations.forEach((configuration) => this.upsert(configuration));
    } catch (error: unknown) {
      // Un panel injoignable au démarrage ne doit pas empêcher le daemon de
      // servir : les conteneurs déjà lancés continuent de tourner, et
      // l'opérateur a besoin que /healthz réponde pour diagnostiquer.
      this.logger.error(
        { err: error },
        'Récupération des serveurs auprès du panel impossible : le daemon démarre sans les connaître',
      );
    }

    const containers = await this.docker.listManagedContainers();

    await Promise.all(this.list().map((server) => server.reconcile()));

    const orphans = [...containers.keys()].filter((uuid) => !this.servers.has(uuid));

    if (orphans.length > 0) {
      this.logger.warn(
        { count: orphans.length, servers: orphans },
        'Conteneurs Hopper présents sur l’hôte mais inconnus du panel. Ils ne sont pas supprimés : vérifiez la configuration du node.',
      );
    }
  }

  /** Détache tous les flux. Les conteneurs continuent de tourner. */
  shutdown(): void {
    this.list().forEach((server) => server.detach());
  }
}

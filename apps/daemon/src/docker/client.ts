import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import Dockerode from 'dockerode';
import type { Logger } from '../logger.js';
import type { DaemonConfig } from '../config/schema.js';

export interface DockerInfo {
  version: string;
  storageDriver: string;
  cgroupVersion: string;
  runningContainers: number;
}

/**
 * Accès au démon Docker de la machine hôte.
 *
 * Le socket Docker équivaut à un accès root : il n'est manipulé que par ce
 * module, et n'est jamais monté dans un conteneur de serveur.
 */
export class DockerClient {
  private readonly docker: Dockerode;

  constructor(
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
  ) {
    // `socketPath` accepte aussi bien un socket Unix (`/var/run/docker.sock`)
    // qu'un pipe nommé Windows (`//./pipe/docker_engine`) en développement.
    this.docker = new Dockerode({ socketPath: config.docker.socket });
  }

  get api(): Dockerode {
    return this.docker;
  }

  /**
   * Vérifie que Docker répond et que sa version est exploitable.
   * Appelé au démarrage : mieux vaut refuser de démarrer que découvrir le
   * problème à la première création de serveur.
   */
  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async info(): Promise<DockerInfo> {
    // `Dockerode.info()` est typé `any` : on referme le typage tout de suite
    // plutôt que de laisser cette valeur se propager dans le reste du daemon.
    const info: unknown = await this.docker.info();
    const version = await this.docker.version();

    const raw = info as {
      Driver?: string;
      CgroupVersion?: string;
      ContainersRunning?: number;
    };

    return {
      version: version.Version,
      storageDriver: raw.Driver ?? 'inconnu',
      cgroupVersion: raw.CgroupVersion ?? '1',
      runningContainers: raw.ContainersRunning ?? 0,
    };
  }

  /**
   * Crée le réseau bridge dédié s'il n'existe pas.
   *
   * Un réseau à part plutôt que le bridge par défaut : sur `bridge`, tous les
   * conteneurs se voient entre eux, et un serveur pourrait scanner puis
   * atteindre les ports internes des serveurs voisins.
   */
  async ensureNetwork(): Promise<void> {
    const { name, autoCreate, subnet, gateway, enableIpv6 } = this.config.docker.network;

    const networks = await this.docker.listNetworks({ filters: { name: [name] } });
    if (networks.some((network) => network.Name === name)) {
      this.logger.debug({ network: name }, 'Réseau Docker déjà présent');
      return;
    }

    if (!autoCreate) {
      throw new Error(
        `Le réseau Docker « ${name} » n'existe pas et docker.network.autoCreate vaut false.`,
      );
    }

    this.logger.info({ network: name, subnet }, 'Création du réseau Docker');

    await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      EnableIPv6: enableIpv6,
      IPAM: { Driver: 'default', Config: [{ Subnet: subnet, Gateway: gateway }] },
      Options: {
        'com.docker.network.bridge.enable_icc': 'false',
        'com.docker.network.bridge.name': name,
      },
    });
  }

  /**
   * Télécharge une image si elle est absente.
   *
   * Le flux de progression est consommé jusqu'au bout : ne pas le lire laisse
   * la requête HTTP ouverte et le téléchargement se bloque à mi-parcours.
   */
  async pullImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    const existing = await this.docker.listImages({ filters: { reference: [image] } });
    if (existing.length > 0) {
      return;
    }

    this.logger.info({ image }, "Téléchargement de l'image Docker");

    try {
      const stream = await this.docker.pull(image);

      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (error: Error | null) => (error ? reject(error) : resolve()),
          (event: { status?: string; progress?: string }) => {
            if (onProgress && event.status) {
              onProgress(event.progress ? `${event.status} ${event.progress}` : event.status);
            }
          },
        );
      });
    } catch (error: unknown) {
      // « denied » de Docker ne dit ni quelle image, ni pourquoi. Sur une image
      // absente d'un registre public, cela signifie presque toujours qu'elle
      // n'a jamais été publiée — un message qui nomme l'image épargne une demi-
      // heure de recherche à l'opérateur.
      throw new Error(
        `Téléchargement de l'image « ${image} » impossible. Vérifiez qu'elle existe et que ce node peut l'atteindre. Détail : ${String(error)}`,
      );
    }
  }

  /**
   * S'attache au flux d'entrée/sortie d'un conteneur, sans passer par dockerode.
   *
   * `container.attach()` sérialise ses propres options dans le corps de la
   * requête POST (`JSON.stringify(opts._body || opts)` dans docker-modem). Comme
   * la connexion est ensuite promue en flux brut, ces octets partent sur le
   * même socket que stdin : selon le moment où Docker répond, ils atterrissent
   * dans la console du serveur Minecraft, qui reçoit
   * `{"stream":true,"stdin":true,…}` comme une commande tapée par un joueur.
   *
   * Le comportement est intermittent — il dépend de la course entre l'écriture
   * du corps et la promotion de la connexion — donc invisible la moitié du
   * temps, et d'autant plus désagréable à diagnostiquer.
   *
   * Passer `_body: {}` ne suffit pas : docker-modem n'écrit alors plus rien, et
   * c'est justement cette écriture qui déclenche l'envoi des en-têtes. La
   * requête reste en suspens et l'attache n'aboutit jamais.
   *
   * On émet donc la requête d'upgrade nous-mêmes, avec `Content-Length: 0` :
   * aucun octet ne précède le flux, stdin est propre dès la première seconde.
   */
  attachToContainer(containerName: string): Promise<Duplex> {
    const query = 'stream=1&stdin=1&stdout=1&stderr=1';

    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.config.docker.socket,
        path: `/containers/${encodeURIComponent(containerName)}/attach?${query}`,
        method: 'POST',
        headers: {
          'Content-Length': '0',
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      });

      request.on('upgrade', (_response, socket: Duplex) => resolve(socket));
      request.on('error', reject);

      // Docker refuse l'attache si le conteneur n'existe pas : la réponse est
      // alors une vraie réponse HTTP, pas un upgrade.
      request.on('response', (response) => {
        reject(
          new Error(
            `Attache refusée par Docker (HTTP ${response.statusCode ?? 0}) pour ${containerName}.`,
          ),
        );
      });

      request.end();
    });
  }

  /** Conteneurs gérés par Hopper présents sur l'hôte, par UUID de serveur. */
  async listManagedContainers(): Promise<Map<string, Dockerode.ContainerInfo>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['io.hopper.managed=true'] },
    });

    const byUuid = new Map<string, Dockerode.ContainerInfo>();

    for (const container of containers) {
      const uuid = container.Labels['io.hopper.server'];
      if (uuid) {
        byUuid.set(uuid, container);
      }
    }

    return byUuid;
  }
}

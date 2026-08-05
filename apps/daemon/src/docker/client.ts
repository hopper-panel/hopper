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
 * Access to the host machine's Docker daemon.
 *
 * The Docker socket is equivalent to root access: it is handled by this module
 * only, and is never mounted into a server container.
 */
export class DockerClient {
  private readonly docker: Dockerode;

  constructor(
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
  ) {
    // `socketPath` accepts a Unix socket (`/var/run/docker.sock`) as well as a
    // Windows named pipe (`//./pipe/docker_engine`) in development.
    this.docker = new Dockerode({ socketPath: config.docker.socket });
  }

  get api(): Dockerode {
    return this.docker;
  }

  /**
   * Checks that Docker answers and that its version is usable.
   * Called at startup: better to refuse to start than to discover the problem
   * at the first server creation.
   */
  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async info(): Promise<DockerInfo> {
    // `Dockerode.info()` is typed `any`: the typing is closed back right away
    // rather than letting that value spread through the rest of the daemon.
    const info: unknown = await this.docker.info();
    const version = await this.docker.version();

    const raw = info as {
      Driver?: string;
      CgroupVersion?: string;
      ContainersRunning?: number;
    };

    return {
      version: version.Version,
      storageDriver: raw.Driver ?? 'unknown',
      cgroupVersion: raw.CgroupVersion ?? '1',
      runningContainers: raw.ContainersRunning ?? 0,
    };
  }

  /**
   * Creates the dedicated bridge network if it does not exist.
   *
   * A separate network rather than the default bridge: on `bridge`, every
   * container sees every other, and a server could scan then reach the internal
   * ports of its neighbours.
   */
  async ensureNetwork(): Promise<void> {
    const { name, autoCreate, subnet, gateway, enableIpv6 } = this.config.docker.network;

    const networks = await this.docker.listNetworks({ filters: { name: [name] } });
    if (networks.some((network) => network.Name === name)) {
      this.logger.debug({ network: name }, 'Docker network already present');
      return;
    }

    if (!autoCreate) {
      throw new Error(
        `The Docker network "${name}" does not exist and docker.network.autoCreate is false.`,
      );
    }

    this.logger.info({ network: name, subnet }, 'Creating the Docker network');

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
   * Downloads an image if it is missing.
   *
   * The progress stream is consumed to the end: not reading it leaves the HTTP
   * request open and the download stalls halfway.
   */
  async pullImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    const existing = await this.docker.listImages({ filters: { reference: [image] } });
    if (existing.length > 0) {
      return;
    }

    this.logger.info({ image }, 'Downloading the Docker image');

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
      // Docker's "denied" says neither which image nor why. On an image absent
      // from a public registry it nearly always means it was never published —
      // a message naming the image saves the operator half an hour of
      // searching.
      throw new Error(
        `Could not download the image "${image}". Check that it exists and that this node can reach it. Detail: ${String(error)}`,
      );
    }
  }

  /**
   * Attaches to a container's input/output stream, without going through
   * dockerode.
   *
   * `container.attach()` serialises its own options into the body of the POST
   * request (`JSON.stringify(opts._body || opts)` in docker-modem). Since the
   * connection is then promoted to a raw stream, those bytes leave on the same
   * socket as stdin: depending on when Docker answers, they land in the
   * Minecraft server's console, which receives
   * `{"stream":true,"stdin":true,…}` as a command typed by a player.
   *
   * The behaviour is intermittent — it depends on the race between writing the
   * body and promoting the connection — so invisible half the time, and all the
   * more unpleasant to diagnose.
   *
   * Passing `_body: {}` is not enough: docker-modem then writes nothing at all,
   * and it is precisely that write which triggers sending the headers. The
   * request hangs and the attach never completes.
   *
   * So the upgrade request is issued here, with `Content-Length: 0`: no byte
   * precedes the stream, stdin is clean from the first second.
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

      // Docker refuses the attach if the container does not exist: the answer
      // is then a real HTTP response, not an upgrade.
      request.on('response', (response) => {
        reject(
          new Error(
            `Attach refused by Docker (HTTP ${response.statusCode ?? 0}) for ${containerName}.`,
          ),
        );
      });

      request.end();
    });
  }

  /** Hopper-managed containers present on the host, by server UUID. */
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

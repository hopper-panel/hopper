import type { ServerConfiguration } from '@hopper/shared';
import type Dockerode from 'dockerode';
import { buildEnvironment, buildInvocation } from '../server/invocation.js';

/**
 * Traduction d'une configuration de serveur en conteneur Docker.
 *
 * Ce fichier concentre tout le durcissement. Les choix ci-dessous partent du
 * principe que **l'opérateur du serveur est hostile** : il peut téléverser
 * n'importe quel plugin et exécuter n'importe quelle commande dans sa console.
 * Ce qui l'empêche de sortir du conteneur, c'est uniquement ce qui est écrit ici.
 */

/** Période de référence du quota CPU des cgroups, en microsecondes. */
const CPU_PERIOD_US = 100_000;

/** Répertoire de travail à l'intérieur du conteneur. */
export const CONTAINER_WORKING_DIR = '/home/container';

/**
 * UID/GID du processus dans le conteneur.
 *
 * Aligné sur le propriétaire des fichiers côté hôte : sans cela, le serveur ne
 * pourrait pas écrire dans son propre volume, ou écrirait des fichiers que le
 * daemon ne saurait plus lire.
 */
export interface OwnershipOptions {
  uid: number;
  gid: number;
}

export interface ContainerBuildOptions {
  configuration: ServerConfiguration;
  /** Chemin du volume sur l'hôte. */
  volumePath: string;
  /** Réseau bridge dédié aux serveurs. */
  networkName: string;
  ownership: OwnershipOptions;
  timezone: string;
  /**
   * Appliquer le poids d'E/S. Voir `docker.blkioWeight` dans daemon.yml : sans
   * l'ordonnanceur BFQ, le noyau n'expose pas `io.weight` et le conteneur
   * refuse de démarrer.
   */
  enableBlkioWeight?: boolean;
}

export function containerNameFor(uuid: string): string {
  return `hopper-${uuid}`;
}

/**
 * Convertit un pourcentage de cœur en quota cgroup.
 * 200 % → deux cœurs pleins. 0 laisse le conteneur sans limite.
 */
export function cpuQuotaFor(cpuPercent: number): number | undefined {
  if (cpuPercent <= 0) {
    return undefined;
  }

  return Math.round((cpuPercent / 100) * CPU_PERIOD_US);
}

/**
 * Calcule `MemorySwap` au sens de Docker.
 *
 * Docker attend la somme mémoire + swap, alors que le panel raisonne en swap
 * additionnel — la confusion entre les deux est le grand classique du réglage
 * de conteneurs, et donne des serveurs qui swappent sans limite.
 *
 * @returns -1 pour un swap illimité, sinon `memory + swap`.
 */
export function memorySwapFor(memoryBytes: number, swapBytes: number): number | undefined {
  if (memoryBytes <= 0) {
    // Sans limite mémoire, une limite de swap n'a pas de sens pour Docker.
    return undefined;
  }

  if (swapBytes < 0) {
    return -1;
  }

  return memoryBytes + swapBytes;
}

/** Ports publiés sur l'hôte, en TCP et UDP. */
export function portBindingsFor(configuration: ServerConfiguration): {
  exposed: Record<string, Record<string, never>>;
  bindings: Record<string, { HostIp: string; HostPort: string }[]>;
} {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};

  const allocations = [configuration.allocations.default, ...configuration.allocations.additional];

  for (const allocation of allocations) {
    // UDP autant que TCP : la requête de statut Minecraft, le protocole Bedrock
    // et les plugins de chat vocal en dépendent.
    for (const protocol of ['tcp', 'udp'] as const) {
      const key = `${allocation.port}/${protocol}`;
      exposed[key] = {};
      bindings[key] = [{ HostIp: allocation.ip, HostPort: String(allocation.port) }];
    }
  }

  return { exposed, bindings };
}

/**
 * Construit les options de création d'un conteneur de serveur.
 *
 * @throws {InvocationError} si la commande de démarrage est inexploitable.
 */
export function buildContainerOptions(
  options: ContainerBuildOptions,
): Dockerode.ContainerCreateOptions {
  const { configuration, volumePath, networkName, ownership, timezone, enableBlkioWeight } =
    options;

  const invocation = buildInvocation(configuration.invocation, {
    environment: configuration.environment,
    memoryMib: Math.floor(configuration.build.memoryBytes / (1024 * 1024)),
    ip: configuration.allocations.default.ip,
    port: configuration.allocations.default.port,
  });

  const { exposed, bindings } = portBindingsFor(configuration);

  return {
    name: containerNameFor(configuration.uuid),
    Image: configuration.container.image,
    // Un tableau, jamais une chaîne : Docker exécuterait une chaîne via
    // `/bin/sh -c`, ce qui réintroduirait exactement l'interprétation shell que
    // `buildInvocation` s'emploie à éviter.
    Cmd: invocation.argv,
    Env: [
      ...buildEnvironment({
        environment: configuration.environment,
        memoryMib: Math.floor(configuration.build.memoryBytes / (1024 * 1024)),
        ip: configuration.allocations.default.ip,
        port: configuration.allocations.default.port,
      }),
      `TZ=${timezone}`,
    ],
    WorkingDir: CONTAINER_WORKING_DIR,
    User: `${ownership.uid}:${ownership.gid}`,

    // TTY : la console est un flux unique et `stop` peut être écrit sur stdin.
    // Sans TTY, Docker multiplexe stdout/stderr avec un en-tête de 8 octets
    // qu'il faudrait démultiplexer, pour aucun gain.
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,

    Labels: {
      'io.hopper.managed': 'true',
      'io.hopper.server': configuration.uuid,
    },

    ExposedPorts: exposed,

    HostConfig: {
      Binds: [`${volumePath}:${CONTAINER_WORKING_DIR}:rw`],
      PortBindings: bindings,
      NetworkMode: networkName,

      // --- Limites de ressources -------------------------------------------
      Memory: configuration.build.memoryBytes || undefined,
      MemorySwap: memorySwapFor(configuration.build.memoryBytes, configuration.build.swapBytes),
      // Une réservation égale à la limite évite que le noyau ne réclame la
      // mémoire du serveur sous pression, ce qui provoquerait des à-coups.
      MemoryReservation: configuration.build.memoryBytes || undefined,
      CpuPeriod: configuration.build.cpuPercent > 0 ? CPU_PERIOD_US : undefined,
      CpuQuota: cpuQuotaFor(configuration.build.cpuPercent),
      CpusetCpus: configuration.build.cpuSet || undefined,
      BlkioWeight: enableBlkioWeight ? configuration.build.ioWeight : undefined,
      PidsLimit: configuration.build.pidsLimit,
      OomKillDisable: configuration.build.oomKillDisabled,

      // --- Durcissement -----------------------------------------------------
      Privileged: false,
      // Le serveur n'a besoin d'aucune capability : il écoute sur un port
      // au-dessus de 1024 et n'écrit que dans son volume.
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      // Empêche un processus du conteneur de voir ou de signaler les processus
      // de l'hôte et des autres serveurs.
      UsernsMode: '',
      ReadonlyRootfs: false,
      Tmpfs: {
        // /tmp en mémoire, borné : un serveur qui remplit /tmp ne doit pas
        // saturer le disque de l'hôte, en dehors de son propre volume.
        '/tmp': 'rw,exec,nosuid,size=128m',
      },

      // Un serveur qui plante en boucle ne doit pas redémarrer indéfiniment
      // sans que personne ne le sache : c'est le daemon qui décide.
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },

      LogConfig: {
        // La console vient du flux d'attache, pas des journaux Docker : les
        // laisser grossir remplirait /var/lib/docker pour rien.
        Type: 'json-file',
        Config: { 'max-size': '5m', 'max-file': '1' },
      },
    },
  };
}

import type { ServerConfiguration } from '@hopper/shared';
import type Dockerode from 'dockerode';
import { buildEnvironment, buildInvocation } from '../server/invocation.js';

/**
 * Translating a server configuration into a Docker container.
 *
 * This file concentrates all the hardening. The choices below assume the
 * **server's operator is hostile**: they can upload any plugin and run any
 * command in their console. What stops them from leaving the container is only
 * what is written here.
 */

/**
 * Reference period of the cgroup CPU quota, in microseconds.
 *
 * Exported because the installer bounds its own containers with the same
 * `cpuQuotaFor`: a quota computed against one period and applied against another
 * silently means something other than the percentage the operator asked for.
 */
export const CPU_PERIOD_US = 100_000;

/** Working directory inside the container. */
export const CONTAINER_WORKING_DIR = '/home/container';

/**
 * UID/GID of the process inside the container.
 *
 * Aligned with the file owner on the host side: without that, the server could
 * not write into its own volume, or would write files the daemon could no
 * longer read.
 */
export interface OwnershipOptions {
  uid: number;
  gid: number;
}

export interface ContainerBuildOptions {
  configuration: ServerConfiguration;
  /** Path of the volume on the host. */
  volumePath: string;
  /** Bridge network dedicated to the servers. */
  networkName: string;
  ownership: OwnershipOptions;
  timezone: string;
  /**
   * Apply the I/O weight. See `docker.blkioWeight` in daemon.yml: without the
   * BFQ scheduler the kernel does not expose `io.weight` and the container
   * refuses to start.
   */
  enableBlkioWeight?: boolean;
  /**
   * Where anything the operator has to know about the command that came out of
   * the template goes — today, an argument that vanished because every variable
   * in it was empty. The daemon points this at the server's console.
   *
   * Optional because there is not always somewhere to write: a caller that
   * omits it loses a warning, never a refusal. What cannot be survived — an
   * unknown variable, an unclosed quote — is thrown rather than reported here.
   */
  onWarning?: (message: string) => void;
}

export function containerNameFor(uuid: string): string {
  return `hopper-${uuid}`;
}

/**
 * Converts a percentage of a core into a cgroup quota.
 * 200% → two full cores. 0 leaves the container unlimited.
 */
export function cpuQuotaFor(cpuPercent: number): number | undefined {
  if (cpuPercent <= 0) {
    return undefined;
  }

  return Math.round((cpuPercent / 100) * CPU_PERIOD_US);
}

/**
 * Computes `MemorySwap` in Docker's sense.
 *
 * Docker expects memory + swap, whereas the panel thinks in additional swap —
 * confusing the two is the classic container-tuning mistake, and it produces
 * servers that swap without limit.
 *
 * @returns -1 for unlimited swap, otherwise `memory + swap`.
 */
export function memorySwapFor(memoryBytes: number, swapBytes: number): number | undefined {
  if (memoryBytes <= 0) {
    // With no memory limit, a swap limit makes no sense to Docker.
    return undefined;
  }

  if (swapBytes < 0) {
    return -1;
  }

  return memoryBytes + swapBytes;
}

/** Ports published on the host, in TCP and UDP. */
export function portBindingsFor(configuration: ServerConfiguration): {
  exposed: Record<string, Record<string, never>>;
  bindings: Record<string, { HostIp: string; HostPort: string }[]>;
} {
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};

  const allocations = [configuration.allocations.default, ...configuration.allocations.additional];

  for (const allocation of allocations) {
    // UDP as much as TCP: the Minecraft status query, the Bedrock protocol and
    // voice-chat plugins all depend on it.
    for (const protocol of ['tcp', 'udp'] as const) {
      const key = `${allocation.port}/${protocol}`;
      exposed[key] = {};
      bindings[key] = [{ HostIp: allocation.ip, HostPort: String(allocation.port) }];
    }
  }

  return { exposed, bindings };
}

/**
 * Builds the creation options for a server container.
 *
 * @throws {InvocationError} if the startup command is unusable.
 */
export function buildContainerOptions(
  options: ContainerBuildOptions,
): Dockerode.ContainerCreateOptions {
  const {
    configuration,
    volumePath,
    networkName,
    ownership,
    timezone,
    enableBlkioWeight,
    onWarning,
  } = options;

  // One context for the command and the environment, where there used to be
  // two identical literals. They describe the same server to the same
  // substituter, and two copies are two chances for the container to be told
  // one port and the command another.
  const invocationContext = {
    environment: configuration.environment,
    memoryMib: Math.floor(configuration.build.memoryBytes / (1024 * 1024)),
    allocations: configuration.allocations,
  };

  const invocation = buildInvocation(configuration.invocation, invocationContext);

  for (const dropped of invocation.droppedArguments) {
    // The argv that runs is one argument shorter than the template's, and only
    // the operator can tell whether the empty variable was the intention. Said
    // here rather than swallowed: an unresolved variable is never allowed to
    // change the command in silence, and this is the one shape of it that must
    // still be allowed to start (see the drop rule in `buildInvocation`).
    onWarning?.(
      `The startup argument ${dropped} was dropped: every variable in it is empty. ` +
        'If the flag before it expected a value, it has not got one.',
    );
  }

  const { exposed, bindings } = portBindingsFor(configuration);

  return {
    name: containerNameFor(configuration.uuid),
    Image: configuration.container.image,
    // An array, never a string: Docker would run a string through `/bin/sh -c`,
    // which would reintroduce exactly the shell interpretation
    // `buildInvocation` works to avoid.
    Cmd: invocation.argv,
    Env: [...buildEnvironment(invocationContext), `TZ=${timezone}`],
    WorkingDir: CONTAINER_WORKING_DIR,
    User: `${ownership.uid}:${ownership.gid}`,

    // TTY: the console is a single stream and `stop` can be written to stdin.
    // Without a TTY, Docker multiplexes stdout/stderr with an 8-byte header
    // that would have to be demultiplexed, for no gain.
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

      // --- Resource limits -------------------------------------------------
      Memory: configuration.build.memoryBytes || undefined,
      MemorySwap: memorySwapFor(configuration.build.memoryBytes, configuration.build.swapBytes),
      // A reservation equal to the limit stops the kernel from reclaiming the
      // server's memory under pressure, which would cause stutters.
      MemoryReservation: configuration.build.memoryBytes || undefined,
      CpuPeriod: configuration.build.cpuPercent > 0 ? CPU_PERIOD_US : undefined,
      CpuQuota: cpuQuotaFor(configuration.build.cpuPercent),
      CpusetCpus: configuration.build.cpuSet || undefined,
      BlkioWeight: enableBlkioWeight ? configuration.build.ioWeight : undefined,
      PidsLimit: configuration.build.pidsLimit,
      OomKillDisable: configuration.build.oomKillDisabled,

      // Docker runs its own tini as PID 1. Without it the JVM takes that role,
      // and a PID 1 does not adopt orphans: every subprocess a plugin spawns
      // and abandons stays a zombie, consuming a slot until `PidsLimit` is
      // reached and the server can no longer create a thread. It also relays
      // signals, which is what makes a clean stop work.
      //
      // This used to come from a tini baked into an image built here. Asking
      // Docker for the same binary removes the need for that image entirely.
      Init: true,

      // --- Hardening --------------------------------------------------------
      Privileged: false,
      // The server needs no capability: it listens on a port above 1024 and
      // only writes into its volume.
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      // Stops a process in the container from seeing or signalling the host's
      // processes and those of the other servers.
      UsernsMode: '',
      ReadonlyRootfs: false,
      Tmpfs: {
        // /tmp in memory, bounded: a server that fills /tmp must not saturate
        // the host's disk, outside its own volume.
        '/tmp': 'rw,exec,nosuid,size=128m',
      },

      // A server crashing in a loop must not restart forever with nobody the
      // wiser: the daemon is what decides.
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },

      LogConfig: {
        // The console comes from the attach stream, not from Docker's logs:
        // letting them grow would fill /var/lib/docker for nothing.
        Type: 'json-file',
        Config: { 'max-size': '5m', 'max-file': '1' },
      },
    },
  };
}

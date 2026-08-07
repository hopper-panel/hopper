import { serverConfigurationSchema, type ServerConfiguration } from '@hopper/shared';
import type Dockerode from 'dockerode';
import { describe, expect, it } from 'vitest';
import {
  installContainerName,
  installCreateOptions,
  installHostConfig,
  reclaimCreateOptions,
  reclaimHostConfig,
} from './installer.js';

const GIB = 1024 ** 3;

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const VOLUME = `/var/lib/hopper/volumes/${UUID}`;
const SCRIPTS = `/tmp/hopper/install-${UUID}`;

function makeBuild(overrides: Record<string, unknown> = {}): ServerConfiguration['build'] {
  return serverConfigurationSchema.parse({
    uuid: UUID,
    meta: { name: 'Survival' },
    invocation: 'java -jar server.jar',
    allocations: { default: { ip: '0.0.0.0', port: 25565 } },
    build: {
      memoryBytes: 4 * GIB,
      swapBytes: 0,
      cpuPercent: 200,
      diskBytes: 10 * GIB,
      ...overrides,
    },
    container: { image: 'eclipse-temurin:21-jre-noble' },
    stop: { type: 'command', value: 'stop' },
  }).build;
}

const BUILD = makeBuild();

/** `LogConfig.Config` is typed `any` by dockerode; closed back here. */
function logSizeOf(config: Dockerode.HostConfig): string | undefined {
  const logConfig = config.LogConfig as { Config?: Record<string, string> } | undefined;
  return logConfig?.Config?.['max-size'];
}

/**
 * Capabilities Docker grants by default and that neither container has any use
 * for. `MKNOD` is the one with teeth: both containers have the volume mounted
 * read-write, and the daemon streams files out of that volume as root for the
 * file manager's download route — a block device planted there answers with the
 * host's raw disk.
 *
 * `AUDIT_WRITE` is the one that costs something, and it is on the list on
 * purpose. It is what `su` needs to record a uid switch — without it PAM's audit
 * call returns EPERM and `su` refuses the session — so an install script that
 * calls `su` fails here. The log it would be writing into is the *host's*: the
 * audit subsystem is not namespaced, and a container whose environment a
 * server's user edits has no business filling the record an operator reads to
 * work out what happened on the node.
 */
const FORBIDDEN_CAPABILITIES = [
  'MKNOD',
  'NET_RAW',
  'SETFCAP',
  'SETPCAP',
  'SYS_CHROOT',
  'AUDIT_WRITE',
  'NET_BIND_SERVICE',
];

/**
 * `KILL` is the one capability the two containers differ on. The install script
 * runs `apt-get`, whose download workers run as `_apt`, and root cannot signal
 * across a uid boundary without it; a `chown -R` signals nobody at all.
 */
const RECLAIM_FORBIDDEN_CAPABILITIES = [...FORBIDDEN_CAPABILITIES, 'KILL'];

/**
 * Minimal server configuration, for the create-options assertions.
 *
 * Only the fields those functions read are filled in; the cast keeps the
 * fixture to the point rather than restating a schema that lives in
 * `@hopper/shared`.
 */
const CONFIGURATION = {
  uuid: '11111111-2222-3333-4444-555555555555',
  build: { memoryBytes: 4 * 1024 * 1024 * 1024, swapBytes: 0, cpuPercent: 200, pidsLimit: 512 },
} as unknown as Parameters<typeof installCreateOptions>[0]['configuration'];

describe('installHostConfig', () => {
  const config = installHostConfig({
    volumePath: VOLUME,
    scriptDirectory: SCRIPTS,
    networkName: 'hopper0',
    build: BUILD,
  });

  it('names the container predictably', () => {
    expect(installContainerName(UUID)).toBe(`hopper-install-${UUID}`);
  });

  it('mounts the volume read-write and the script read-only', () => {
    expect(config.Binds).toEqual([`${VOLUME}:/mnt/server:rw`, `${SCRIPTS}:/mnt/install:ro`]);
  });

  it('joins the dedicated network, which the download needs', () => {
    expect(config.NetworkMode).toBe('hopper0');
  });

  describe('hardening', () => {
    it('is never privileged', () => {
      expect(config.Privileged).toBe(false);
    });

    // Dropping the default set and adding back is not the same as dropping a
    // few names: the first states the whole set, the second inherits whatever
    // Docker decides to grant by default in a future version.
    it('drops the default capability set', () => {
      expect(config.CapDrop).toEqual(['ALL']);
    });

    // An install script is a package manager running as root over a tree owned
    // by the server's uid, which is exactly the work capabilities gate. These
    // seven are what `dpkg`, `tar -p` and `apt-get` exercise; dropping any of
    // them breaks installs rather than attacks. `KILL` is the least obvious:
    // apt's download workers run as `_apt` and root cannot signal another uid
    // without it, so apt cannot cut off a mirror that stopped answering.
    it('keeps only what a package manager needs', () => {
      expect(config.CapAdd).toEqual([
        'CHOWN',
        'DAC_OVERRIDE',
        'FOWNER',
        'FSETID',
        'KILL',
        'SETGID',
        'SETUID',
      ]);
    });

    it.each(FORBIDDEN_CAPABILITIES)(
      'keeps nothing that reaches outside the volume: %s',
      (capability) => {
        expect(config.CapAdd).not.toContain(capability);
      },
    );

    // The environment of this container is built from the template variables,
    // which a server's user edits. A setuid binary the script is talked into
    // leaving in the volume must not be a way back up.
    it('forbids acquiring new privileges', () => {
      expect(config.SecurityOpt).toContain('no-new-privileges');
    });

    it('never mounts the Docker socket', () => {
      expect((config.Binds ?? []).some((bind) => bind.includes('docker.sock'))).toBe(false);
    });

    it('does not let Docker restart the container on its own', () => {
      expect(config.RestartPolicy?.Name).toBe('no');
    });

    it('bounds the Docker logs', () => {
      expect(logSizeOf(config)).toBe('5m');
    });
  });

  // A shell as PID 1 does not act on SIGTERM while it waits on a child: without
  // tini a stuck install waits out the whole stop timeout before dying.
  it('asks Docker for an init process', () => {
    expect(config.Init).toBe(true);
  });

  describe('resource limits', () => {
    it('caps resident memory at what the server itself is entitled to', () => {
      expect(config.Memory).toBe(4 * GIB);
    });

    // `MemorySwap` is memory *plus* swap in Docker's sense, so twice the limit
    // is "as much swap again as memory" — what Docker grants when the field is
    // left unset, which is what this container had before it was tightened. An
    // installer JVM, a modpack coming out of a tarball or a Gradle build peaks
    // far above the server's steady budget; with `swapBytes` at 0 on nearly
    // every plan, passing the server's own figure straight through kills the
    // install at exactly `Memory` and reports an unexplained code 137.
    it('gives the install swap headroom the running server does not get', () => {
      expect(config.MemorySwap).toBe(8 * GIB);
    });

    it('keeps the swap an operator granted when it beats the floor', () => {
      const generous = installHostConfig({
        volumePath: VOLUME,
        scriptDirectory: SCRIPTS,
        networkName: 'hopper0',
        build: makeBuild({ swapBytes: 8 * GIB }),
      });

      expect(generous.MemorySwap).toBe(12 * GIB);
    });

    // -1 is Docker's "unlimited swap". A floor has nothing to raise there, and
    // turning it into a number would put a ceiling on a server the operator
    // deliberately left without one.
    it('leaves unlimited swap unlimited', () => {
      const unbounded = installHostConfig({
        volumePath: VOLUME,
        scriptDirectory: SCRIPTS,
        networkName: 'hopper0',
        build: makeBuild({ swapBytes: -1 }),
      });

      expect(unbounded.MemorySwap).toBe(-1);
    });

    it('installs at the server CPU when that is already more than a core', () => {
      expect(config.CpuQuota).toBe(200_000);
      expect(config.CpuPeriod).toBe(100_000);
    });

    // An install runs once for a few minutes, so a whole core costs the node
    // nothing it notices. Charging a 25%-of-a-core plan its entitlement instead
    // quadruples a modpack install, with the server parked in `installing` and
    // no progress shown to whoever is waiting on it.
    it('lifts a small plan to a full core for the duration', () => {
      const small = installHostConfig({
        volumePath: VOLUME,
        scriptDirectory: SCRIPTS,
        networkName: 'hopper0',
        build: makeBuild({ cpuPercent: 25 }),
      });

      expect(small.CpuQuota).toBe(100_000);
      expect(small.CpuPeriod).toBe(100_000);
    });

    // Not `build.pidsLimit`: an operator who trimmed the server's fork budget
    // did not mean to forbid an unpacking that runs `xargs -P`.
    it('bounds the number of processes whatever the server is allowed', () => {
      expect(config.PidsLimit).toBe(512);

      const trimmed = installHostConfig({
        volumePath: VOLUME,
        scriptDirectory: SCRIPTS,
        networkName: 'hopper0',
        build: makeBuild({ pidsLimit: 32 }),
      });

      expect(trimmed.PidsLimit).toBe(512);
    });

    // 0 means unlimited on both figures, and neither floor may read it as a
    // small number to be raised: a server the operator left uncapped would come
    // out of here pinned to one core and, with `Memory` unset, carrying a swap
    // limit Docker refuses outright.
    it('omits the limits the server does not set', () => {
      const unlimited = installHostConfig({
        volumePath: VOLUME,
        scriptDirectory: SCRIPTS,
        networkName: 'hopper0',
        build: makeBuild({ memoryBytes: 0, cpuPercent: 0 }),
      });

      expect(unlimited.Memory).toBeUndefined();
      expect(unlimited.MemorySwap).toBeUndefined();
      expect(unlimited.CpuQuota).toBeUndefined();
      expect(unlimited.CpuPeriod).toBeUndefined();
      expect(unlimited.PidsLimit).toBe(512);
    });
  });

  // The server container gets a 128 MiB RAM-backed /tmp so it cannot fill the
  // host's disk. Applying that here would break every egg that stages a modpack
  // download in /tmp, and the layer is discarded seconds later in any case.
  it('leaves /tmp on the container layer, unlike the server container', () => {
    expect(config.Tmpfs).toBeUndefined();
  });
});

describe('reclaimHostConfig', () => {
  const config = reclaimHostConfig({ volumePath: VOLUME, build: BUILD });

  it('mounts the volume and nothing else', () => {
    expect(config.Binds).toEqual([`${VOLUME}:/mnt/server:rw`]);
  });

  it('takes the container off the network', () => {
    expect(config.NetworkMode).toBe('none');
  });

  describe('hardening', () => {
    it('is never privileged', () => {
      expect(config.Privileged).toBe(false);
    });

    // This container exists to run `chown -R`. `CapDrop: ALL` alone would break
    // the one thing it is for, so the set is narrowed rather than emptied.
    it('keeps what a recursive chown needs, and only that', () => {
      expect(config.CapDrop).toEqual(['ALL']);
      expect(config.CapAdd).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
    });

    it.each(RECLAIM_FORBIDDEN_CAPABILITIES)(
      'keeps nothing that reaches outside the volume: %s',
      (capability) => {
        expect(config.CapAdd).not.toContain(capability);
      },
    );

    it('forbids acquiring new privileges', () => {
      expect(config.SecurityOpt).toContain('no-new-privileges');
    });

    it('never mounts the Docker socket', () => {
      expect((config.Binds ?? []).some((bind) => bind.includes('docker.sock'))).toBe(false);
    });

    it('does not let Docker restart the container on its own', () => {
      expect(config.RestartPolicy?.Name).toBe('no');
    });

    // A refused `chown -R` prints one line per file: on a modpack that is a
    // million lines into /var/lib/docker for logs nobody reads.
    it('bounds the Docker logs', () => {
      expect(logSizeOf(config)).toBe('5m');
    });

    it('asks Docker for an init process', () => {
      expect(config.Init).toBe(true);
    });
  });

  describe('resource limits', () => {
    it('applies the memory and CPU the server itself is entitled to', () => {
      expect(config.Memory).toBe(4 * GIB);
      expect(config.CpuQuota).toBe(200_000);
      expect(config.CpuPeriod).toBe(100_000);
    });

    // `MemorySwap` equal to `Memory` is how Docker is told "no swap": a chown
    // that has to swap is a chown that is not going to finish. The install
    // container is given headroom above its limit precisely because an installer
    // JVM does peak; this one has no peak to allow for, so the strict rule
    // stands here and only here.
    it('forbids swap outright', () => {
      expect(config.MemorySwap).toBe(config.Memory);
    });

    it('bounds the number of processes to what one command needs', () => {
      expect(config.PidsLimit).toBe(64);
    });

    it('omits the limits the server does not set', () => {
      const unlimited = reclaimHostConfig({
        volumePath: VOLUME,
        build: makeBuild({ memoryBytes: 0, cpuPercent: 0 }),
      });

      expect(unlimited.Memory).toBeUndefined();
      expect(unlimited.MemorySwap).toBeUndefined();
      expect(unlimited.CpuQuota).toBeUndefined();
      expect(unlimited.PidsLimit).toBe(64);
    });
  });
});

/**
 * `User` is the one property whose loss would break every install on a node,
 * and it cannot be asserted on a `HostConfig`: Docker carries it on the
 * *Config*, so `installHostConfig` and `reclaimHostConfig` never had a slot for
 * it and a test looking there passes whatever the code does.
 *
 * These two cover the objects `createContainer` is actually given.
 */
describe('container create options', () => {
  it('runs the installation as root, like the install script needs', () => {
    const options = installCreateOptions({
      configuration: CONFIGURATION,
      install: { containerImage: 'ghcr.io/pterodactyl/installers:debian', entrypoint: 'bash' },
      environment: ['MINECRAFT_VERSION=1.21.4'],
      volumePath: VOLUME,
      scriptDirectory: SCRIPTS,
      networkName: 'hopper0',
    });

    expect(options.User).toBeUndefined();
    expect(options.HostConfig?.CapAdd).toContain('CHOWN');
  });

  it('runs the ownership reclaim as root, which a chown to another uid requires', () => {
    const options = reclaimCreateOptions({
      image: 'ghcr.io/pterodactyl/yolks:java_21',
      volumePath: VOLUME,
      ownership: { uid: 988, gid: 988 },
      build: makeBuild(),
    });

    expect(options.User).toBeUndefined();
    expect(options.Cmd).toEqual(['chown', '-R', '988:988', '/mnt/server']);
  });
});

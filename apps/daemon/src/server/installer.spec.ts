import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverConfigurationSchema, type ServerConfiguration } from '@hopper/shared';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerUnansweredError } from '../docker/client.js';
import type { DockerClient } from '../docker/client.js';
import {
  activitySamplePeriod,
  ActivityWatchdog,
  ContainerActivityProbe,
  describeDuration,
  describeStall,
  diskRefusal,
  dockerDeadline,
  installContainerName,
  installCreateOptions,
  installHostConfig,
  reclaimCreateOptions,
  reclaimHostConfig,
  runInstallation,
  INSTALL_FREE_SPACE_FLOOR_BYTES,
} from './installer.js';
import type * as DiskUsage from './disk-usage.js';
import type { DockerStats } from './stats.js';

/**
 * What Docker sends for a container that exists and is doing nothing.
 *
 * Present and constant, not empty. An empty body means the host keeps no
 * such counter at all, which `activityCounters` answers `null` to — so a
 * fake that sent one could never represent a container standing still, and
 * a stall could never be observed.
 */
const IDLE_COUNTERS: DockerStats = { cpu_stats: { cpu_usage: { total_usage: 0 } } };

/**
 * The one answer no real filesystem can be asked for.
 *
 * `freeSpaceBytes` returns `null` for a filesystem Node cannot describe, and the
 * preflight's response to that — install anyway, and say so — is a decision
 * about a case that cannot be arranged on the machine running these tests. Every
 * other test in this file goes through to the real thing, which is why this is a
 * hook rather than a mock: the disk assertions below measure real directories on
 * a real disk, and a fake `statfs` would quietly stop them proving anything.
 */
const disk = vi.hoisted(() => ({
  freeSpaceBytes: null as ((path: string) => Promise<number | null>) | null,
}));

vi.mock('./disk-usage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DiskUsage>();

  return {
    ...actual,
    freeSpaceBytes: (path: string) =>
      disk.freeSpaceBytes === null ? actual.freeSpaceBytes(path) : disk.freeSpaceBytes(path),
  };
});

afterEach(() => {
  disk.freeSpaceBytes = null;
});

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

  // A 512 MiB tmpfs was mounted on /tmp for one release, meant to stop a server
  // owner filling the node's disk through the URL variable an install script
  // reads. It could not: `WorkingDir` is /mnt/server, a bind mount with no quota
  // of any kind, so the same script fills the node by downloading there instead.
  // What the ceiling did reach was `curl -o /tmp/pack.zip && unzip` — the shape
  // half the catalogue is written in — and, because tmpfs pages are charged to
  // the container's own memory cgroup, a small plan's install turned into an
  // unexplained code 137. It is not coming back by accident.
  describe('the scratch directory', () => {
    it('imposes no ceiling on /tmp it cannot also impose on the volume', () => {
      expect(config.Tmpfs).toBeUndefined();
      expect(Object.hasOwn(config, 'Tmpfs')).toBe(false);
    });
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

/**
 * The deadline is on **inactivity**, not on duration and not on output.
 *
 * A forty-gigabyte download pulling bytes down a wire is alive; a container that
 * has moved no traffic, touched no disk, burned no CPU and printed nothing for a
 * quarter of an hour is not. A cap on total duration cannot tell those apart —
 * high enough for a real Steam depot it never fires, low enough to be useful it
 * kills working installs.
 *
 * Nor can a cap on *output*, which is the correction these tests exist to pin
 * down: every script in this repository's own catalogue downloads with
 * `curl -sSL`, and `-s` suppresses the progress meter, so a working transfer is
 * indistinguishable from a dead one by output alone. The window is therefore
 * pushed back by output **or** by the container's counters, and the tests below
 * prove both directions of both.
 */
describe('ActivityWatchdog', () => {
  const WINDOW_MS = 60_000;

  /** Only what the watchdog touches, so the clock cannot affect anything else. */
  const useClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  };

  it('never fires while something keeps happening, however long the install takes', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => expect.unreachable());
    watchdog.arm();

    // Ten minutes of installing, in a window sized for one. A download that is
    // working is not one to give up on, whatever the total comes to.
    for (let sign = 0; sign < 10; sign += 1) {
      vi.advanceTimersByTime(WINDOW_MS - 1_000);
      watchdog.noteActivity();
    }

    expect(watchdog.expiry).toBeNull();
  });

  it('fires once nothing has happened for the window', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => undefined);
    watchdog.arm();

    vi.advanceTimersByTime(30_000);
    watchdog.noteActivity();
    watchdog.noteObservation();
    vi.advanceTimersByTime(WINDOW_MS);

    // The console says how long nothing happened, not merely that something
    // timed out: 60s of stillness out of 90s of installing is a different story
    // from 60s out of 60s, and the operator is the one who has to tell them
    // apart.
    expect(watchdog.expiry).toEqual({
      idleMs: WINDOW_MS,
      elapsedMs: 90_000,
      sawActivity: true,
      observed: true,
    });
  });

  /**
   * Looking at the container is not the same as the container doing something,
   * and reading a successful sample as a sign of life would switch this deadline
   * off: the probe polls four times a window at the very least, so every window
   * would be pushed back by the act of measuring it.
   */
  it('is not pushed back by a sample that merely came back', () => {
    useClock();

    let expiries = 0;
    const watchdog = new ActivityWatchdog(WINDOW_MS, () => {
      expiries += 1;
    });

    watchdog.arm();

    // Four looks across the window, each one seeing a container that has not
    // moved. It still fires on time.
    for (let look = 0; look < 4; look += 1) {
      vi.advanceTimersByTime(WINDOW_MS / 4);
      watchdog.noteObservation();
    }

    expect(expiries).toBe(1);
    expect(watchdog.expiry).toMatchObject({ observed: true, idleMs: WINDOW_MS });
  });

  /**
   * The distinction the ownership reclaim depends on entirely, since the probe
   * is its only witness: a window in which every `stats` request failed is not
   * evidence that the container stood still, and the verdict has to be able to
   * say so.
   */
  it('reports a window it could not see into as one it could not see into', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => undefined);
    watchdog.arm();
    vi.advanceTimersByTime(WINDOW_MS);

    expect(watchdog.expiry).toMatchObject({ observed: false });
  });

  /**
   * Evidence does not carry over a window. A container watched perfectly well
   * for an hour and then lost sight of for the window that expired is one this
   * daemon cannot vouch for, and saying otherwise would put the operator back to
   * looking at their install script.
   */
  it('does not carry evidence from an earlier window into the one that expired', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => undefined);
    watchdog.arm();

    watchdog.noteObservation();
    vi.advanceTimersByTime(30_000);
    // Movement starts a fresh window, and nothing has been seen in it.
    watchdog.noteActivity();

    vi.advanceTimersByTime(WINDOW_MS);

    expect(watchdog.expiry).toMatchObject({ sawActivity: true, observed: false });
  });

  it('says so when the installation never did anything at all', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => undefined);
    watchdog.arm();
    vi.advanceTimersByTime(WINDOW_MS);

    expect(watchdog.expiry).toMatchObject({ sawActivity: false, idleMs: WINDOW_MS });
  });

  // A container being torn down produces both kinds of signal: the shell's dying
  // words, and the traffic of its own removal. Neither must read as a reprieve
  // for an installation whose verdict has already been passed and reported.
  it('cannot be revived by anything arriving after it gave up', () => {
    useClock();

    let expiries = 0;
    const watchdog = new ActivityWatchdog(WINDOW_MS, () => {
      expiries += 1;
    });

    watchdog.arm();
    vi.advanceTimersByTime(WINDOW_MS);

    watchdog.noteActivity();
    vi.advanceTimersByTime(WINDOW_MS * 10);

    expect(expiries).toBe(1);
    expect(watchdog.expiry).not.toBeNull();
  });

  it('stops counting once the installation has ended', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => expect.unreachable());
    watchdog.arm();
    watchdog.disarm();

    vi.advanceTimersByTime(WINDOW_MS * 10);

    expect(watchdog.expiry).toBeNull();
  });

  /**
   * And it stays stood down, which is a separate guarantee from never having
   * fired.
   *
   * A deadline that stood down is one whose subject has finished, and the
   * installation's own does exactly that before the ownership reclaim begins.
   * Output keeps arriving across that line — a container's last words reach an
   * attach stream that is still open, and Docker flushes what it buffered — so a
   * `noteActivity` that re-armed on them would put the deadline back up over a
   * container that had already exited, to fire in the middle of the `chown -R`
   * after it and announce that a finished installation was being given up on.
   */
  it('is not put back up by a sign of life arriving after it stood down', () => {
    useClock();

    const watchdog = new ActivityWatchdog(WINDOW_MS, () => expect.unreachable());
    watchdog.arm();
    watchdog.disarm();
    watchdog.noteActivity();

    vi.advanceTimersByTime(WINDOW_MS * 10);

    expect(watchdog.expiry).toBeNull();
  });

  it('puts a duration on the console in the units an operator reads', () => {
    expect(describeDuration(45_000)).toBe('45s');
    expect(describeDuration(1_800_000)).toBe('30m 0s');
    expect(describeDuration(4_320_000)).toBe('1h 12m');
  });

  // "Timed out" invites the reply "it was downloading, your window is too
  // short". The three things being measured, named, do not — and network
  // traffic is deliberately not among them, so the console must not claim it.
  it('names what it measured, so the verdict can be argued with', () => {
    const lines = describeStall(
      { idleMs: WINDOW_MS, elapsedMs: 90_000, sawActivity: true, observed: true },
      WINDOW_MS,
    ).join('\n');

    expect(lines).toContain('no output, no CPU, no disk I/O');
    expect(lines).not.toContain('network');
    expect(lines).toContain('installInactivityTimeoutMs');
  });

  /**
   * And it refuses to name figures nobody read.
   *
   * A window in which not one counter sample came back leaves this daemon with
   * no evidence of anything: printing "no CPU, no disk I/O" would be asserting
   * two numbers it never obtained, and it sends the operator to their install
   * script when the thing that needs looking at is the Docker daemon on the
   * node.
   */
  it("blames this node's Docker when it could not read the counters at all", () => {
    const lines = describeStall(
      { idleMs: WINDOW_MS, elapsedMs: 90_000, sawActivity: true, observed: false },
      WINDOW_MS,
    ).join('\n');

    expect(lines).not.toContain('no output, no CPU, no disk I/O');
    expect(lines).toContain('has not reported the install container');
    expect(lines).toContain('may well have been running perfectly');
  });
});

/**
 * Reading the container's counters, which is the half that makes the deadline
 * survive contact with a real install script.
 */
describe('ContainerActivityProbe', () => {
  const useClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A container whose counters are whatever the test queues up next. */
  function sampler(samples: DockerStats[]) {
    const taken: number[] = [];

    return {
      taken,
      sample: (): Promise<DockerStats> => {
        const index = Math.min(taken.length, samples.length - 1);
        taken.push(index);
        return Promise.resolve(samples[index]!);
      },
    };
  }

  const withCpu = (nanos: number): DockerStats => ({
    cpu_stats: { cpu_usage: { total_usage: nanos } },
  });

  /**
   * What the deadline is told, counted the way the deadline distinguishes it.
   *
   * `reports` is every sample that came back — the probe's answer to "could you
   * look" — and `movements` the subset that had moved. A failed sample shows up
   * as neither, which is the distinction the ownership reclaim rests on.
   */
  function counting() {
    const counts = { reports: 0, movements: 0 };

    return {
      counts,
      onSample: (moved: boolean): void => {
        counts.reports += 1;

        if (moved) {
          counts.movements += 1;
        }
      },
    };
  }

  it('reports a container whose CPU counter has moved', async () => {
    useClock();

    const seen = counting();
    const feed = sampler([withCpu(1_000), withCpu(2_000)]);
    const probe = new ContainerActivityProbe(feed.sample, seen.onSample, 5_000);

    probe.start();
    // The baseline is taken at once; only the second sample can show movement.
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.counts.movements).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.counts.movements).toBe(1);

    probe.stop();
  });

  /**
   * A container running nothing and writing nothing is the whole case: a
   * repeated sample must never look like progress, or the deadline it feeds
   * would never fire on anything.
   *
   * Counted rather than asserted from inside the callback, and that is the
   * correction. This test used to pass `expect.unreachable()` as the callback,
   * which the probe called inside a `try` with an empty `catch`, from a `poll`
   * nobody awaited: the failure was swallowed twice over and the test could not
   * fail however wrong the code became.
   *
   * Every one of those samples is still *reported*, and that is the second half
   * of the guarantee: the deadline has to know it was looked at, or it cannot
   * tell this container from one Docker refuses to describe.
   */
  it('reports nothing while every counter stands still', async () => {
    useClock();

    const seen = counting();
    const probe = new ContainerActivityProbe(
      sampler([withCpu(1_000)]).sample,
      seen.onSample,
      5_000,
    );

    probe.start();
    await vi.advanceTimersByTimeAsync(60_000);
    probe.stop();

    expect(seen.counts.movements).toBe(0);
    expect(seen.counts.reports).toBeGreaterThan(0);
  });

  // Each of the two covers a way of being busy the other misses: a download
  // whose writes are still in the page cache has touched no disk, and a copy
  // waiting on a slow one spends almost none of its time on a CPU.
  it.each<[string, DockerStats]>([
    ['CPU', { cpu_stats: { cpu_usage: { total_usage: 5 } } }],
    ['block I/O', { blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 8 }] } }],
  ])('reports movement on %s alone', async (_name, moved) => {
    useClock();

    const seen = counting();
    // The baseline has to be readable: an empty body means "this host keeps no
    // such counter", so there would be nothing for the second sample to differ
    // from and the movement could not be seen.
    const feed = sampler([IDLE_COUNTERS, moved]);
    const probe = new ContainerActivityProbe(feed.sample, seen.onSample, 5_000);

    probe.start();
    await vi.advanceTimersByTimeAsync(5_000);
    probe.stop();

    expect(seen.counts.movements).toBe(1);
  });

  /**
   * The counter that is deliberately not read, at the level that reads them.
   *
   * `rx_bytes` climbing on its own is a container being flooded the bridge's
   * broadcast ARP, or a socket sending keepalives to a mirror that stopped
   * answering. Neither is work, and treating either as a sign of life is what
   * kept a stalled install alive for ever on a busy node.
   */
  it('reports nothing for a container whose only movement is on the wire', async () => {
    useClock();

    let received = 0;
    const seen = counting();
    const probe = new ContainerActivityProbe(
      () =>
        Promise.resolve({ networks: { eth0: { rx_bytes: (received += 9_000), tx_bytes: 60 } } }),
      seen.onSample,
      5_000,
    );

    probe.start();
    await vi.advanceTimersByTimeAsync(60_000);
    probe.stop();

    expect(seen.counts.movements).toBe(0);
  });

  /**
   * A Docker that will not answer must not be able to keep an install alive.
   * Treating a failed sample as a sign of life would reintroduce the unbounded
   * wait from the other side — a wedged daemon would be the thing holding the
   * deadline open.
   *
   * **Nor is it evidence the container stood still**, which is the other half and
   * the one the ownership reclaim depends on: nothing at all is reported, so a
   * deadline whose only witness is this probe knows it was blind rather than
   * believing it watched an idle container.
   */
  it('says nothing at all about a sample it could not take', async () => {
    useClock();

    const seen = counting();
    const probe = new ContainerActivityProbe(
      () => Promise.reject(new Error('Docker is not answering')),
      seen.onSample,
      5_000,
    );

    probe.start();
    await vi.advanceTimersByTimeAsync(60_000);
    probe.stop();

    expect(seen.counts).toEqual({ reports: 0, movements: 0 });
  });

  /**
   * And it keeps sampling across one.
   *
   * A `stats` request Docker never answered used to leave this loop awaiting a
   * promise that never settled: nothing was rescheduled, and one hiccup blinded
   * the deadline for the rest of the installation. Every request `DockerClient`
   * makes is bounded now, so a hung sample comes back as a rejection — and this
   * pins the behaviour on that side of the boundary, that a rejection costs one
   * sample and not the whole loop.
   */
  it('carries on sampling after one that failed', async () => {
    useClock();

    let attempts = 0;
    const seen = counting();
    const probe = new ContainerActivityProbe(
      () => {
        attempts += 1;
        return attempts === 2
          ? Promise.reject(new Error('Docker did not answer'))
          : Promise.resolve(withCpu(attempts * 1_000));
      },
      seen.onSample,
      5_000,
    );

    probe.start();
    await vi.advanceTimersByTimeAsync(15_000);
    probe.stop();

    expect(attempts).toBe(4);
    // The baseline, the failure, and the two after it: three reports, and the
    // last two moved.
    expect(seen.counts).toEqual({ reports: 3, movements: 2 });
  });

  /**
   * The tolerance covers the **sample**, and stops there.
   *
   * Docker refusing to answer is this node's business and is swallowed on
   * purpose. A movement callback that throws is a defect in this daemon, and one
   * `catch` around both hid it completely — which is how the two tests above
   * came to be written as `expect.unreachable()` callbacks that could not fail
   * however wrong the probe became. Widening that `catch` back over the callback
   * is a one-line change that restores exactly the old silence, so it is pinned
   * here rather than left to the comment.
   *
   * Driven a poll at a time, because that is where the guarantee lives: the
   * probe is not started, so nothing is rescheduled and the escape is the
   * returned promise rather than an unhandled rejection landing wherever the
   * runner happens to notice it.
   */
  it('lets a movement callback that throws escape, instead of swallowing it', async () => {
    const feed = sampler([withCpu(1_000), withCpu(2_000)]);
    const probe = new ContainerActivityProbe(
      feed.sample,
      (moved) => {
        if (moved) {
          throw new Error('noteActivity is broken');
        }
      },
      5_000,
    );

    const poll = (probe as unknown as { poll: () => Promise<void> }).poll.bind(probe);

    // The baseline can never report movement, so this callback stays quiet.
    await expect(poll()).resolves.toBeUndefined();

    await expect(poll()).rejects.toThrow('noteActivity is broken');
  });

  /**
   * Each sample is a round trip to the Docker socket, on a node that may be
   * running an installation for every server on it. A second `start` opening a
   * second sampling loop would double that for the life of the installation —
   * and `stop` only ever cancels the timer it can see, so the surplus loop would
   * outlive the container it was watching.
   */
  it('does not open a second sampling loop when started twice', async () => {
    useClock();

    const feed = sampler([withCpu(1), withCpu(2), withCpu(3)]);
    const probe = new ContainerActivityProbe(feed.sample, () => undefined, 5_000);

    probe.start();
    probe.start();
    await vi.advanceTimersByTimeAsync(5_000);
    probe.stop();

    // One baseline and one sample, not two of each.
    expect(feed.taken.length).toBe(2);
  });

  it('stops sampling when told to', async () => {
    useClock();

    const feed = sampler([withCpu(1), withCpu(2), withCpu(3)]);
    const probe = new ContainerActivityProbe(feed.sample, () => undefined, 5_000);

    probe.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const taken = feed.taken.length;
    probe.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(feed.taken.length).toBe(taken);
  });

  /**
   * The period is a poll, so it has a resolution; the window is a deadline, so
   * it has a meaning. A template naming a window comparable to the default
   * period would otherwise be a coin toss on whether a sample landed inside it.
   */
  it('samples often enough for whatever window a template chooses', () => {
    expect(activitySamplePeriod(15 * 60_000)).toBe(15_000);
    expect(activitySamplePeriod(20_000)).toBe(5_000);
    // The shortest window the guarantee still holds for: four seconds, sampled
    // every one, so three samples after the baseline land inside it.
    expect(activitySamplePeriod(4_000)).toBe(1_000);
  });

  /**
   * Below four seconds the floor wins and the guarantee does not hold, which is
   * a decision rather than an oversight — the comment on `activitySamplePeriod`
   * used to claim both at once.
   *
   * A two-second window would need a poll every half second: one round trip to
   * the Docker socket twice a second, per installation, on a node that may be
   * running one for every server on it — to measure something no install can be
   * judged on anyway. A container that pauses for two seconds is a container
   * between two syscalls, and a deadline that fires on that fires on healthy
   * work whatever the sampling rate. So the polling stays affordable and the
   * window is the thing that is wrong.
   */
  it('will not poll faster than its floor for a window nothing could measure', () => {
    expect(activitySamplePeriod(2_000)).toBe(1_000);
    expect(activitySamplePeriod(1)).toBe(1_000);
  });
});

/**
 * The bound on **Docker answering**, as opposed to the one on the container
 * working.
 *
 * One of these objects bounds several calls in a row — a teardown and then the
 * removal after it; a reclaim's create, its start and its own removal — so it
 * has to survive having fired. That is what the first version could not do: it
 * built one rejected promise for the whole of its life, and a promise that has
 * rejected stays rejected, so after the deadline had fired once every later race
 * against it was lost the instant it started. A single wedge anywhere in an
 * installation then reported a perfectly healthy Docker as an unanswering one,
 * for every bounded call that came after.
 */
describe('dockerDeadline', () => {
  const TIMEOUT_MS = 60_000;

  const useClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  };

  /** A Docker that has taken the request and gone quiet. */
  const unanswered = (): Promise<string> => new Promise<string>(() => undefined);

  /** A Docker that answers, eventually. */
  const answersIn = (ms: number): Promise<string> =>
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('answered'), ms);
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire before it is armed, however long the call takes', async () => {
    useClock();

    const deadline = dockerDeadline(TIMEOUT_MS, 'Docker did not answer.');
    let rejection: unknown = null;
    deadline.reached.catch((error: unknown) => (rejection = error));

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10);

    expect(rejection).toBeNull();
  });

  it('stops bounding a call that came back', async () => {
    useClock();

    const deadline = dockerDeadline(TIMEOUT_MS, 'Docker did not answer.');
    let rejection: unknown = null;
    deadline.reached.catch((error: unknown) => (rejection = error));

    deadline.arm();
    deadline.disarm();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 10);

    expect(rejection).toBeNull();
  });

  /**
   * The whole sequence a single-use deadline gets wrong: arm, expire, disarm,
   * arm again — and the call under the second arming has to be allowed to
   * succeed.
   */
  it('bounds a second call after a first one has expired', async () => {
    useClock();

    const deadline = dockerDeadline(TIMEOUT_MS, 'Docker did not answer.');

    // The expectation is attached before the clock moves, here and below,
    // because a rejection nobody is listening to yet is one Node reports as
    // unhandled — an error in the run that says nothing about the code.
    deadline.arm();
    const first = expect(Promise.race([unanswered(), deadline.reached])).rejects.toThrow(
      /Docker did not answer/,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await first;
    deadline.disarm();

    // The next call, against a Docker that answers in a second. Held over the
    // spent promise this loses its race before Docker has said anything at all,
    // and a node that is working is reported as one that has stopped.
    //
    // A call that answers *later* rather than one already resolved, because
    // `Promise.race` settles in subscription order among promises that are
    // already settled: an immediate answer would win against a rejected deadline
    // whatever this function did, and the test would prove nothing.
    deadline.arm();
    const second = expect(Promise.race([answersIn(1_000), deadline.reached])).resolves.toBe(
      'answered',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    deadline.disarm();

    // And still a deadline afterwards, rather than one that has quietly stopped
    // being able to fire.
    deadline.arm();
    const third = expect(Promise.race([unanswered(), deadline.reached])).rejects.toThrow(
      /Docker did not answer/,
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await third;
  });

  /**
   * Each call gets the whole window rather than whatever the last one left of
   * it. Arming used to return early while a timer was pending, so a teardown
   * armed at the stall and a removal armed a minute later shared one clock — and
   * the removal's bound could be anything from the full window down to nothing.
   */
  it('gives each call its own clock', async () => {
    useClock();

    const deadline = dockerDeadline(TIMEOUT_MS, 'Docker did not answer.');

    deadline.arm();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1_000);

    // A second call, armed with a second left on the first arming's clock.
    deadline.arm();
    const second = Promise.race([unanswered(), deadline.reached]);
    let rejection: unknown = null;
    second.catch((error: unknown) => (rejection = error));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(rejection).toBeNull();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(second).rejects.toThrow(/Docker did not answer/);
  });
});

/**
 * There is no disk check anywhere in the daemon until this one.
 *
 * A depot larger than the node's free space fills the host disk, and that takes
 * down every server on the machine — one of the standard ways to brick a node.
 */
describe('the disk preflight', () => {
  const GIB_BYTES = 1024 ** 3;

  const refusalFor = (options: {
    freeBytes: number;
    reclaimableBytes?: number;
    declaredBytes?: number;
  }) =>
    diskRefusal({
      freeBytes: options.freeBytes,
      reclaimableBytes: options.reclaimableBytes ?? 0,
      declaredBytes: options.declaredBytes,
      path: VOLUME,
    });

  it('says nothing when there is room', () => {
    expect(refusalFor({ freeBytes: 80 * GIB_BYTES, declaredBytes: 40 * GIB_BYTES })).toBeNull();
  });

  it('lets a template that says nothing install on any node with headroom', () => {
    expect(refusalFor({ freeBytes: INSTALL_FREE_SPACE_FLOOR_BYTES })).toBeNull();
  });

  // "Not enough disk space" leaves an operator to guess whether they need to
  // free a gigabyte or forty, on which node, and off which filesystem.
  it('names both figures and the filesystem they were read from', () => {
    const refusal = refusalFor({
      freeBytes: 8 * GIB_BYTES,
      declaredBytes: 40 * GIB_BYTES,
    })?.lines.join('\n');

    expect(refusal).toContain('8 GiB free on the filesystem holding');
    expect(refusal).toContain('40 GiB needed');
    expect(refusal).toContain(VOLUME);
    expect(refusal).toContain('nothing has been changed');
  });

  /**
   * The half of the answer that is easy to leave out. `statfs` was given the
   * volume's path, so what it measured is the filesystem the volume lives on —
   * and an install script that stages its download in `/tmp` writes to the
   * container's own layer, under Docker's storage, which is a *different*
   * filesystem on every node whose operator has split the two.
   *
   * Docker's data root is deliberately not measured beside it: it is
   * configurable and this daemon is not told where it is, and a refusal naming a
   * figure read off the wrong disk is worse than one naming no figure at all.
   */
  it.each([
    ['the floor', { freeBytes: 100 * 1024 * 1024 }],
    ['a declared figure', { freeBytes: 8 * GIB_BYTES, declaredBytes: 40 * GIB_BYTES }],
  ])(
    'says which filesystem it measured, and what it did not, when refusing on %s',
    (_name, options) => {
      const refusal = refusalFor(options)?.lines.join('\n');

      expect(refusal).toContain(`The only filesystem measured is the one holding ${VOLUME}`);
      expect(refusal).toContain('has not been checked');
    },
  );

  it('explains the floor when no template named a figure', () => {
    const refusal = refusalFor({ freeBytes: 100 * 1024 * 1024 })?.lines.join('\n');

    expect(refusal).toContain('every server on it');
    expect(refusal).toContain('1 GiB needed');
  });

  /**
   * The attribution, which is the thing a refusal cannot get wrong. A template
   * asking for less than the floor is refused *by the floor*, and saying "the
   * figure comes from the template" there credits it with a number it never
   * named — while suppressing the one sentence explaining where the number an
   * operator is being asked to satisfy really came from.
   */
  it('never credits a template with the floor it did not ask for', () => {
    const refusal = refusalFor({
      freeBytes: 100 * 1024 * 1024,
      declaredBytes: 200 * 1024 * 1024,
    })?.lines.join('\n');

    expect(refusal).not.toContain('comes from the template');
    expect(refusal).toContain('whatever it is installing');
  });

  /**
   * `build.diskBytes` is the obvious candidate and it is deliberately not an
   * input here — the function cannot even see it. It is what the operator sells
   * this server, not what its installation writes: a 50 GiB Minecraft plan that
   * will use 900 MiB would start refusing to install on a node with 20 GiB free,
   * which is every deliberately oversubscribed node in existence. The panel has
   * already weighed that number once, at creation, against the node's declared
   * capacity and the overallocation the operator chose.
   */
  it('takes no notice of the server disk quota', () => {
    expect(refusalFor({ freeBytes: 20 * GIB_BYTES })).toBeNull();
  });

  /**
   * A reinstall writes over what is already there, so those bytes count towards
   * the requirement rather than against it. Demanding the whole figure as *free*
   * space is how a 40 GiB Palworld server becomes impossible to reinstall on the
   * node it is already installed on — a certain failure, traded for a possible
   * one.
   */
  describe('a reinstall over a volume that is already full of the game', () => {
    it('counts what the volume holds towards the requirement', () => {
      expect(
        refusalFor({
          freeBytes: 5 * GIB_BYTES,
          reclaimableBytes: 40 * GIB_BYTES,
          declaredBytes: 40 * GIB_BYTES,
        }),
      ).toBeNull();
    });

    // Where the shortfall is real, both halves of the sum are on the console:
    // "45 GiB available" on a node with 5 GiB free is a figure nobody would
    // believe without being told where the rest of it came from.
    it('shows its working when the sum still falls short', () => {
      const refusal = refusalFor({
        freeBytes: 5 * GIB_BYTES,
        reclaimableBytes: 10 * GIB_BYTES,
        declaredBytes: 40 * GIB_BYTES,
      })?.lines.join('\n');

      expect(refusal).toContain('5 GiB free');
      expect(refusal).toContain('10 GiB');
      expect(refusal).toContain('writes over');
    });

    // The floor is the one figure the volume's contents cannot buy off. Those
    // bytes are released as the new ones are written, file by file, so there is
    // no moment at which the machine has them spare — and a node with nothing
    // left is a node with nothing left whatever this one volume holds.
    it('cannot buy its way under the floor with them', () => {
      expect(
        refusalFor({
          freeBytes: 100 * 1024 * 1024,
          reclaimableBytes: 500 * GIB_BYTES,
          declaredBytes: 40 * GIB_BYTES,
        }),
      ).not.toBeNull();
    });
  });
});

/**
 * The deadline and the preflight, wired to the thing they guard.
 *
 * Docker is faked; the filesystem is not, because the preflight has to measure a
 * real one.
 */
describe('runInstallation', () => {
  const WINDOW_MS = 60_000;
  const workspaces: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function workspace(): Promise<{ volumePath: string; tmpPath: string }> {
    const root = await mkdtemp(join(tmpdir(), 'hopper-install-'));
    workspaces.push(root);

    return { volumePath: join(root, 'volume'), tmpPath: join(root, 'tmp') };
  }

  function installable(install: Record<string, unknown> = {}): ServerConfiguration {
    return serverConfigurationSchema.parse({
      uuid: UUID,
      meta: { name: 'Survival' },
      invocation: 'java -jar server.jar',
      allocations: { default: { ip: '0.0.0.0', port: 25565 } },
      build: { memoryBytes: 4 * GIB, swapBytes: 0, cpuPercent: 200, diskBytes: 10 * GIB },
      container: { image: 'eclipse-temurin:21-jre-noble' },
      stop: { type: 'command', value: 'stop' },
      install: {
        containerImage: 'debian:bookworm-slim',
        entrypoint: '/bin/bash',
        script: 'echo installing',
        ...install,
      },
    });
  }

  /**
   * How one of the fake's containers behaves.
   *
   * `stop` settles the wait with 137, as a real one does: the deadline firing
   * has to be what ends the wait, or the test would prove nothing about a
   * container being taken down. `wedged` takes that away — `stop`, `remove` and
   * `wait` all stop answering together, which is what a broken overlay mount
   * looks like from here.
   *
   * **A Docker that has stopped answering is presented the way `DockerClient`
   * presents one, which is as a rejection rather than as a hang.** That is not a
   * convenience: it is the boundary this file is on the far side of. Every
   * request the client makes carries its own deadline — see `boundEveryRequest`
   * — so an install container's `create`, `attach`, `start`, `stop` or `remove`
   * that Docker ignores comes back to `runInstallation` as a
   * {@link DockerUnansweredError} a minute later, and never as a promise that
   * does not settle. The one call that really does hang is `wait`, because the
   * client deliberately leaves it unbounded, and every `wedged` container below
   * hangs on exactly that one. Whether the bound itself works is
   * `client.spec.ts`'s question, asked of a real socket that never answers.
   */
  interface FakeContainer {
    wedged?: boolean;
    /**
     * A container Docker will not report the counters of, while answering
     * everything else — the one input the ownership reclaim's deadline has.
     */
    blind?: boolean;
    failStart?: boolean;
    /**
     * A container that runs and exits perfectly well, and whose removal the
     * node's Docker then refuses to answer — a wedged layer on an installation
     * that otherwise worked.
     */
    unremovable?: boolean;
    /**
     * A container Docker has already reaped: the removal answers 404, which is
     * a race lost rather than a failure.
     */
    gone?: boolean;
    /** A wait that comes back without a `StatusCode` at all. */
    exitsWithNothing?: boolean;
    /**
     * A wait Docker answers with an error of its own — an API version that
     * refuses the request, a proxy that mangles the body. Nothing to do with
     * any deadline: none has fired, and the container may be running still.
     */
    waitRefused?: boolean;
    counters?: () => DockerStats;
    /**
     * The round trip this node's Docker takes and never answers, for the three
     * that are Docker answering rather than a container working.
     */
    unanswered?: 'create' | 'attach' | 'start';
    /**
     * How long Docker takes to acknowledge the start, for the tests about what
     * is covered while it thinks about it. Undefined is the ordinary case: an
     * answer in the same turn.
     */
    startsAfterMs?: number;
    /**
     * The code it exits with the moment it is started, or `null` for one the
     * test settles itself.
     */
    exitsWith?: number | null;
  }

  /** How the fake's containers are named in the messages a wedged Docker sends. */

  const SUBJECT = 'a-container';

  /**
   * A request this node's Docker takes and never answers, as `DockerClient`
   * presents one.
   *
   * A rejection naming the endpoint, on the client's own deadline — never a
   * promise that fails to settle, which is the shape this daemon no longer
   * produces for anything but `container.wait()`.
   */
  const unanswered = (request: string): Promise<never> =>
    Promise.reject(
      new DockerUnansweredError(
        `Docker did not answer ${request} within 60s. This node's Docker is not answering: the ` +
          'request has been abandoned, and anything it had already begun may still be happening ' +
          'on this node.',
      ),
    );

  function makeContainer(behaviour: FakeContainer, stream: EventEmitter) {
    const calls = {
      stops: 0,
      removes: 0,
      samples: 0,
      grace: [] as unknown[],
      /** Every `wait`, with the options it was given — the cancellation among them. */
      waits: [] as ({ abortSignal?: AbortSignal } | undefined)[],
    };

    let settle: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
    });

    let announceStart: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });

    let announceAttach: () => void = () => undefined;
    const attached = new Promise<void>((resolve) => {
      announceAttach = resolve;
    });

    /**
     * What the container does once Docker says it is running.
     *
     * Deliberately not when it is *asked* to run: a start request Docker has not
     * answered yet is a container that has not done anything, which is the whole
     * subject of the ordering test below.
     */
    const running = (): void => {
      if (behaviour.exitsWith !== null && behaviour.exitsWith !== undefined) {
        settle(behaviour.exitsWith);
      }
    };

    const container = {
      attach: () => {
        announceAttach();
        return behaviour.unanswered === 'attach'
          ? unanswered(`POST /containers/${SUBJECT}/attach`)
          : Promise.resolve(stream);
      },
      start: () => {
        announceStart();

        if (behaviour.unanswered === 'start') {
          return unanswered(`POST /containers/${SUBJECT}/start`);
        }

        if (behaviour.failStart) {
          return Promise.reject(new Error('driver failed programming external connectivity'));
        }

        if (behaviour.startsAfterMs === undefined) {
          running();
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          setTimeout(() => {
            running();
            resolve();
          }, behaviour.startsAfterMs);
        });
      },
      // The one call the client leaves unbounded, so the one that can really
      // hang: a wedged container's wait never settles. The options are kept
      // because the cancellation is in them — a real `wait` this daemon walks
      // away from without aborting is a socket to the Docker daemon that nothing
      // will ever close, and the fake cannot show that by hanging.
      wait: (waitOptions?: { abortSignal?: AbortSignal }) => {
        calls.waits.push(waitOptions);

        if (behaviour.waitRefused) {
          return Promise.reject(
            new Error('(HTTP code 400) bad parameter - condition next-exit is not supported'),
          );
        }

        return exited.then((StatusCode) => (behaviour.exitsWithNothing ? {} : { StatusCode }));
      },
      stats: () => {
        calls.samples += 1;

        // `blind` and `wedged` are separate on purpose: a broken overlay mount
        // stops `stop`, `remove` and `wait` while `stats` answers perfectly, and
        // the verdicts differ on exactly that.
        return behaviour.blind
          ? unanswered(`GET /containers/${SUBJECT}/stats`)
          : // A container standing still still *reports*: the default is a
            // counter that is present and constant, which is what a real
            // Docker sends for an idle container. An empty body would mean
            // something else entirely — a host that keeps no such counter —
            // and `activityCounters` answers `null` to it, so a stall would
            // never be observed and the deadline would never fire.
            Promise.resolve(behaviour.counters?.() ?? IDLE_COUNTERS);
      },
      stop: (stopOptions?: unknown) => {
        calls.stops += 1;
        calls.grace.push(stopOptions);

        if (behaviour.wedged) {
          return unanswered(`POST /containers/${SUBJECT}/stop`);
        }

        settle(137);
        return Promise.resolve();
      },
      remove: () => {
        calls.removes += 1;

        if (behaviour.gone) {
          // Docker's own shape for it, `statusCode` and all, because that field
          // is what `failureOf` reads to tell a lost race from a failure.
          return Promise.reject(
            Object.assign(new Error('(HTTP code 404) no such container'), { statusCode: 404 }),
          );
        }

        if (calls.removes > 1) {
          // **What a second `DELETE` for one container really gets**, and the
          // reason the fake answers this rather than shrugging. A forced removal
          // of a container carrying a modpack's layer takes real time on a real
          // node, so a second request arriving behind it finds the first still
          // running and is refused — and 409 is a code `failureOf` does not
          // excuse, so it reaches the console as "it is still on this node"
          // about a container that at that moment is being removed. Every
          // stalled installation printed that line. A fake that accepted the
          // duplicate quietly is how it went unnoticed.
          return Promise.reject(
            Object.assign(
              new Error(
                `(HTTP code 409) conflict - removal of container ${SUBJECT} is already in progress`,
              ),
              { statusCode: 409 },
            ),
          );
        }

        return behaviour.wedged || behaviour.unremovable
          ? unanswered(`DELETE /containers/${SUBJECT}`)
          : Promise.resolve();
      },
    };

    return { container, calls, started, attached, settle: (code: number) => settle(code) };
  }

  /**
   * A Docker whose containers do exactly what the test tells them to.
   *
   * **Two** of them, because a successful installation runs two: the install
   * container, and the `chown -R` that takes ownership of what it wrote. They
   * are separate handles with separate call counts on purpose — one of the
   * defects pinned down below is the install's deadline still counting while
   * the second one runs, which a single shared container could not show.
   *
   * The reclaim exits 0 the moment it is started unless a test says otherwise,
   * so every test that is not about it can ignore it entirely.
   */
  function fakeDocker(
    options: FakeContainer & {
      /**
       * The ownership reclaim's container: `never-created` for a Docker that
       * takes the request and never answers, `refused` for one that answers with
       * an error.
       */
      reclaim?: FakeContainer | 'never-created' | 'refused';
    } = {},
  ) {
    const created: Dockerode.ContainerCreateOptions[] = [];

    /** Whether the attach stream was closed, which no test could otherwise see. */
    const attachment = { destroyed: false };
    const stream = Object.assign(new EventEmitter(), {
      destroy: () => {
        attachment.destroyed = true;
      },
    });

    let announceRequest: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });

    const install = makeContainer({ ...options, exitsWith: null }, stream);
    const reclaim = makeContainer(
      { exitsWith: 0, ...(typeof options.reclaim === 'string' ? {} : options.reclaim) },
      stream,
    );

    const queue = [install.container, reclaim.container];

    const docker = {
      pullImage: () => Promise.resolve(),
      api: {
        createContainer: (createOptions: Dockerode.ContainerCreateOptions) => {
          created.push(createOptions);

          if (created.length === 1) {
            announceRequest();

            if (options.unanswered === 'create') {
              return unanswered('POST /containers/create');
            }
          }

          if (created.length > 1) {
            if (options.reclaim === 'never-created') {
              return unanswered('POST /containers/create');
            }

            if (options.reclaim === 'refused') {
              return Promise.reject(new Error('no such image: ghcr.io/pterodactyl/yolks:java_21'));
            }
          }

          const next = queue.shift();

          if (!next) {
            throw new Error('the fake was asked for a third container');
          }

          return Promise.resolve(next);
        },
        getContainer: () => ({
          remove: () => Promise.reject(new Error('no such container')),
        }),
      },
    } as unknown as DockerClient;

    return {
      docker,
      created,
      stream,
      attachment,
      calls: install.calls,
      requested,
      attached: install.attached,
      started: install.started,
      settle: install.settle,
      reclaim,
    };
  }

  it('stops and removes an install container that has stopped doing anything', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    await expect(running).rejects.toThrow(/did nothing for 1m 0s and was stopped/);

    // A deadline that gave up on *waiting* while leaving the container
    // downloading would be worse than no deadline at all.
    expect(fake.calls.stops).toBe(1);
    expect(fake.calls.removes).toBeGreaterThanOrEqual(1);

    expect(lines.join('\n')).toContain('done nothing at all');
    expect(lines.join('\n')).toContain('installInactivityTimeoutMs');

    // One container: the ownership reclaim belongs to an installation that
    // succeeded.
    expect(fake.created).toHaveLength(1);
  });

  /**
   * **One removal, not two.**
   *
   * Two paths lead to the same `DELETE` here — `abandonContainer`, from the
   * timer that gave up, and the ordinary teardown, the moment the wait came back
   * — and for a while both took it. Docker refuses the loser of that race with
   * 409 "removal already in progress", which `failureOf` does not excuse, so
   * *every* stalled installation ended with a line saying the install container
   * was still on the node, printed in the same breath as Docker was removing it.
   *
   * That is the worst kind of console line there is: it is not wrong about
   * anything an operator can check later, it is wrong at the moment they read
   * it, and the lesson they take from it is to stop believing the ones beside it
   * — including "Docker would not stop the install container", which is how they
   * would learn a modpack is still downloading into a volume nobody is watching.
   *
   * Excusing the 409 instead was the other way to silence it, and it was the
   * wrong one: 409 is also what Docker answers when it refuses a removal for a
   * reason worth printing, so excusing the code would have bought quiet on this
   * path by going quiet on those too. The duplicate request is what was wrong,
   * so the duplicate request is what went.
   */
  it('removes an install container it gave up on exactly once', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    await expect(running).rejects.toThrow(/did nothing/);

    expect(fake.calls.removes).toBe(1);

    // And nothing on the console about a removal that failed, because none did.
    expect(lines.join('\n')).not.toContain('would not remove');
  });

  /**
   * The socket the teardown used to walk away from.
   *
   * `container.wait()` is the one request `boundEveryRequest` deliberately
   * leaves unbounded — it answers when the container ends, which for a *server*
   * is its whole life — so when the teardown deadline wins the race, the wait it
   * beat is abandoned and there is nothing else in the process that would ever
   * close it. One socket to the Docker daemon per stalled installation, held
   * until hopperd restarts, on the node that is by hypothesis already in
   * trouble: exactly the leak the client's own deadline aborts its requests to
   * avoid, arrived at through the one call the client cannot cover.
   *
   * What the daemon controls is the cancellation, which is what is asserted
   * here. That `docker-modem` really tears the socket down when it is given one
   * is asked of a real socket in `client.spec.ts`.
   */
  it('closes the wait a teardown deadline walked away from', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ wedged: true });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;

    // The activity deadline gives up on a container that will never report an
    // exit, and asks for a teardown a wedged Docker will not answer either.
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    expect(fake.calls.waits).toHaveLength(1);
    const [waiting] = fake.calls.waits;

    // Not yet: the teardown deadline is a real window, and the container may
    // still report an exit inside it.
    expect(waiting?.abortSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_001);

    await expect(running).rejects.toThrow(/did not take the install container down/);

    expect(waiting?.abortSignal?.aborted).toBe(true);
  });

  /**
   * The attach stream on a path where nothing else would close it.
   *
   * Docker holds this socket open for as long as anybody is on the end of it,
   * and removing the container is what would normally close it — which on a
   * wedged node is exactly the thing that did not happen. So the daemon closes
   * it itself, from the `finally` that unwinds everything else this function
   * armed.
   */
  it('closes the attach stream even when the container is never removed', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ wedged: true });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;
    expect(fake.attachment.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
    await vi.advanceTimersByTimeAsync(60_001);

    await expect(running).rejects.toThrow(/did not take the install container down/);

    expect(fake.attachment.destroyed).toBe(true);
  });

  /**
   * A container's last words, on the path that throws before it can print them.
   *
   * Install scripts do not announce their failures in whole lines. `curl` writes
   * `curl: (28) Operation timed out` with no trailing newline and the shell then
   * hangs on whatever came next, so what the daemon is holding when the deadline
   * fires is a partial line the {@link LineAssembler} is still waiting on. It is
   * flushed from a `finally` for that reason: on this path the function is
   * leaving through a throw, and the half-line it is holding is usually the only
   * statement of why anything went wrong at all.
   */
  it('prints what the container was part-way through saying when it gave up', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ wedged: true });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;

    // No newline: the assembler holds this and emits nothing.
    fake.stream.emit('data', Buffer.from('curl: (28) Operation timed out after 300000 ms'));
    expect(lines.join('\n')).not.toContain('curl: (28)');

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
    await vi.advanceTimersByTimeAsync(60_001);

    await expect(running).rejects.toThrow(/did not take the install container down/);

    expect(lines.join('\n')).toContain('curl: (28) Operation timed out');
  });

  /**
   * Nothing left ticking over a server whose installation is over.
   *
   * Three things are armed while an installation runs — the activity deadline,
   * the counter probe and the teardown deadline — and each is stood down where
   * it is finished with, which leaves the `finally` at the bottom covering the
   * paths that never reach those lines. The teardown deadline is the one with no
   * other symptom: it is armed from a timer, its rejection is already handled
   * where it is created, and an arming left outstanding therefore produces
   * nothing an assertion about output or exit codes could ever see. What it
   * produces is a timer per stalled installation on a node running dozens.
   */
  it('leaves nothing armed once a stalled installation is over', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;

    // The deadline fires, the stop settles the wait, and the teardown deadline
    // it armed a moment earlier is now an arming nobody is racing.
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    await expect(running).rejects.toThrow(/did nothing/);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('never gives up on an installation that is still printing', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;

    // Five windows' worth of downloading, and **not one complete line**: this is
    // a carriage-return progress bar, which is how SteamCMD reports a depot. A
    // deadline pushed back by assembled console lines rather than by the stream
    // would see complete silence here and kill the download it exists to
    // protect.
    for (let chunk = 0; chunk < 5; chunk += 1) {
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1_000);
      fake.stream.emit('data', Buffer.from('\rUpdate state (0x61) downloading, progress: 41.62'));
    }

    expect(fake.calls.stops).toBe(0);

    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });
    expect(fake.calls.stops).toBe(0);
  });

  /**
   * The premise this whole guard nearly got wrong, proved end to end.
   *
   * Every install script in this repository downloads with `curl -sSL`, and `-s`
   * suppresses the progress meter: a 2 GiB modpack on a slow uplink prints
   * **nothing** from the first byte to the last. A deadline fed by output alone
   * would kill it, and the window would then be exactly the total-duration cap
   * the design set out to avoid, applied to the one step that legitimately takes
   * hours.
   */
  it('never gives up on a silent download whose container is doing the work', async () => {
    const { volumePath, tmpPath } = await workspace();

    let burned = 0;
    let written = 0;
    const fake = fakeDocker({
      // What a transfer looks like from the cgroup: every segment taken off the
      // socket and put on a disk is CPU time charged to this container, and the
      // writes reach the device eventually.
      counters: () => ({
        cpu_stats: { cpu_usage: { total_usage: (burned += 30_000_000) } },
        blkio_stats: {
          io_service_bytes_recursive: [{ op: 'write', value: (written += 4_000_000) }],
        },
      }),
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;

    // Ten windows of downloading and not one byte of output.
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 10);

    expect(fake.calls.stops).toBe(0);
    expect(fake.calls.samples).toBeGreaterThan(1);

    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });
  });

  /**
   * And the other direction, which is what stops the counters from being a way
   * of never firing: a container whose cgroup counters are frozen is not alive
   * merely because its interface is still taking frames off the bridge.
   *
   * The rising `rx_bytes` is the point of the test. Every server on a node
   * shares one bridge, a Linux bridge floods broadcast ARP to every port on it,
   * and a `curl` still holding a socket to a mirror that went silent keeps
   * sending TCP keepalives — so that counter climbs for a container that has
   * stopped dead. While it was watched, this deadline never fired on a busy
   * node: the original bug survived in the guard written to close it, on exactly
   * the nodes where it cost the most.
   */
  it('gives up on frozen cgroup counters however busy the interface looks', async () => {
    const { volumePath, tmpPath } = await workspace();

    let noise = 0;
    const fake = fakeDocker({
      counters: () => ({
        cpu_stats: { cpu_usage: { total_usage: 5_000 } },
        blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 8_192 }] },
        networks: { eth0: { rx_bytes: (noise += 1_500), tx_bytes: 120 } },
      }),
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    await expect(running).rejects.toThrow(/did nothing/);
    expect(fake.calls.stops).toBe(1);
  });

  /**
   * The hang the deadline moved rather than removed.
   *
   * A wedged overlay mount makes `stop` fail, `remove` fail and
   * `container.wait()` never return, all at once — so the daemon gave up on the
   * install and then blocked for ever on the teardown, in the code written to
   * stop it blocking for ever. A Docker that will not answer has to produce a
   * failure, and one that names itself: the container may well still be running.
   */
  it('fails rather than hangs when Docker will not take the container down', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ wedged: true });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    expect(fake.calls.stops).toBe(1);

    // Still waiting, because the teardown deadline has not come round yet: the
    // bound is a real one and not merely an immediate give-up.
    await vi.advanceTimersByTimeAsync(30_000);

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(running).rejects.toThrow(/Docker did not take the install container down/);

    // And on the console, where the operator is already watching, rather than
    // only in a status the panel renders afterwards. The container may well
    // still be running on the node, which is not something to leave unsaid.
    expect(lines.join('\n')).toContain('may still be running on it');
  });

  /**
   * The three round trips the rest of the guard cannot cover, once the bound
   * over them has moved to where every bound now lives.
   *
   * Creating the container, attaching to its output and starting it are Docker
   * answering, not a container working, and nothing armed in this file could
   * unblock one: the activity deadline gives up by stopping and removing a
   * container, and there is no container to stop until `createContainer` has
   * come back. `DockerClient` bounds them along with every other request, so
   * what is left to prove here is the half that is this file's own — that the
   * failure fails the installation, and that it is said where whoever asked for
   * it is already watching rather than only in the status the panel renders
   * afterwards. `install()` holds the server's operation queue while it waits,
   * so a failure that arrived only in hopperd's log would leave the operator
   * with a spinner and no reason for it.
   */
  it.each([
    ['create', 'requested', /\/containers\/create/],
    ['attach', 'attached', /\/attach/],
    ['start', 'started', /\/start/],
  ] as const)(
    'fails and says so when Docker will not answer the %s',
    async (call, signal, expected) => {
      const { volumePath, tmpPath } = await workspace();
      const fake = fakeDocker({ unanswered: call });
      const lines: string[] = [];

      const running = runInstallation(fake.docker, {
        configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
        volumePath,
        tmpPath,
        ownership: { uid: 988, gid: 988 },
        networkName: 'hopper0',
        onOutput: (line) => lines.push(line),
      });

      // The request reached the fake, which is what says the real filesystem
      // work before it is done.
      await fake[signal];

      await expect(running).rejects.toThrow(expected);

      expect(lines.join('\n')).toContain("This node's Docker is not answering");
      expect(lines.join('\n')).toMatch(expected);
    },
  );

  /**
   * The daemon's tmp, on the two failures that happen before anything owns the
   * cleanup.
   *
   * The script is written into `tmp/install-<uuid>` before the container is
   * created, and the `finally` that removes it again only covers the block
   * `createContainer` and `attach` sit *above*. So a Docker that refuses either
   * of them — which is a Docker in trouble, and therefore a Docker that is about
   * to be asked again — leaves that directory behind, and nothing ever comes
   * back for it. Every retry against a wedged node leaves another, on the
   * filesystem the node's own installations write into.
   */
  it.each([
    ['create', 'requested'],
    ['attach', 'attached'],
  ] as const)(
    'leaves nothing in the daemon tmp when Docker refuses the %s',
    async (call, signal) => {
      const { volumePath, tmpPath } = await workspace();
      const fake = fakeDocker({ unanswered: call });

      const running = runInstallation(fake.docker, {
        configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
        volumePath,
        tmpPath,
        ownership: { uid: 988, gid: 988 },
        networkName: 'hopper0',
        onOutput: () => undefined,
      });

      await fake[signal];
      await expect(running).rejects.toThrow(DockerUnansweredError);

      // Not a vacuous assertion, and that is why it is written against the parent:
      // `tmpPath` exists at all only because the daemon created `install-<uuid>`
      // underneath it, so a `readdir` that succeeds and finds nothing is the one
      // reading that means the script directory was made and then cleared away.
      await expect(readdir(tmpPath)).resolves.toEqual([]);
    },
  );

  /**
   * The ordering of the two lines this guard turns on, pinned down.
   *
   * The deadline is armed **before** the container is told to run, so that a
   * container is covered from the moment the request left rather than from
   * whenever Docker got round to acknowledging it. Armed the other way round, a
   * Docker taking half an hour over a start would hand the container that comes
   * out of it a fresh window it has done nothing to earn — and the stretch
   * nobody was watching is precisely the one where a node in trouble is at its
   * slowest.
   *
   * The verdict is the one for a window nobody could see into, and that is right
   * rather than incidental: there are no counters to read from a container
   * Docker has not acknowledged the start of, so this daemon really has been
   * unable to tell whether anything was happening — which is exactly what the
   * message says.
   */
  it('covers the container from the moment it was told to run', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ startsAfterMs: 30_000 });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: 20_000 }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;

    // One window, entirely inside the stretch where Docker has the start request
    // and has not answered it. Armed after the start, nothing has happened here
    // at all.
    await vi.advanceTimersByTimeAsync(20_001);

    expect(fake.calls.stops).toBe(1);
    expect(lines.join('\n')).toContain('Giving up on it');

    // Docker gets round to the start eventually, over a container the deadline
    // has already given up on.
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(running).rejects.toThrow(/could not be watched at all/);
    expect(lines.join('\n')).toContain('once in the last 20s');
  });

  /**
   * The deadline is armed before the container is started, so that one which
   * comes up and does nothing is covered from the moment it was told to run.
   * That leaves one hole to close: a `start` that fails outright must disarm it
   * again, or a quarter of an hour later a server whose installation failed at
   * once gets three console lines about standing still and a teardown of a
   * container that never ran.
   */
  it('disarms the deadline when the container never started', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ failStart: true });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await expect(running).rejects.toThrow(/external connectivity/);

    await vi.advanceTimersByTimeAsync(WINDOW_MS * 10);

    expect(fake.calls.stops).toBe(0);
    expect(lines).toEqual([]);
  });

  /**
   * The same bound on the ordinary path, where nothing has gone wrong until the
   * very last round trip.
   *
   * A `remove` that never returns wedges the server's operation queue exactly as
   * thoroughly after an installation that worked as after one that hung, and
   * there is nothing armed at this point to notice: the activity deadline stood
   * down when the container ended, which is the line above this one. The
   * installation itself is not failed over it — the script ran and the files are
   * there — but the container is still on the node, holding the name this
   * server's next installation will ask for, so it is said out loud.
   */
  it('does not hang when Docker will not remove a container that installed fine', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ unremovable: true });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await vi.advanceTimersByTimeAsync(60_001);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain('Docker would not remove the install container');
    expect(lines.join('\n')).toContain('safe to remove by hand');
  });

  /**
   * The successful installation that announced it was being given up on.
   *
   * The deadline used to stay armed across the ownership reclaim, and **nothing
   * there can push it back**: the install container has been removed by then, so
   * `stats` on it answers 404 and the probe contributes nothing, and its attach
   * stream is closed, so no output arrives either. A `chown -R` over a modpack
   * that outlives the window therefore printed "Giving up on it: the install
   * container is being stopped and removed" over a container that had exited 0
   * minutes earlier — and then returned `{ successful: true }`.
   */
  it('does not give up on an installation whose ownership reclaim outlives the window', async () => {
    const { volumePath, tmpPath } = await workspace();

    let walked = 0;
    const fake = fakeDocker({
      reclaim: {
        exitsWith: null,
        // A `chown -R` over a full volume is slow and never still: a syscall per
        // entry is CPU time on every one of them.
        counters: () => ({ cpu_stats: { cpu_usage: { total_usage: (walked += 5_000_000) } } }),
      },
    });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);
    await fake.reclaim.started;

    // The install container's last words, arriving after its wait returned —
    // which happens, because the attach stream is still open and Docker flushes
    // what it had buffered. The deadline stood down when the container ended,
    // and this must not put it back up: it would then be watching the reclaim
    // without a single thing able to push it back.
    fake.stream.emit('data', Buffer.from('installation complete\n'));

    // Five windows of chowning, which is a real modpack on a real disk.
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 5);

    fake.reclaim.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).not.toContain('Giving up on it');
    expect(fake.calls.stops).toBe(0);
  });

  /**
   * The reclaim is the statement immediately after the one this whole change set
   * exists to guard, and it was the identical construct: a bare `waitForExit`
   * with no deadline over it. `install()` is enqueued on the server's operation
   * queue, so a `chown` that never returns wedges that queue **for ever** — no
   * start, no stop, no reinstall for that server until hopperd is restarted.
   *
   * Bounded the same way and for the same reason: a `chown -R` moves CPU and
   * block I/O continuously, so one that has moved neither for a whole window is
   * not slow, it is stuck.
   */
  it('gives up on an ownership reclaim that has stopped moving', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({
      reclaim: {
        exitsWith: null,
        counters: () => ({ cpu_stats: { cpu_usage: { total_usage: 7 } } }),
      },
    });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);
    await fake.reclaim.started;

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    // The installation itself is not thrown away over it: the script ran, the
    // files are there, and an hour's download is not worth discarding over a
    // partial ownership walk. What the operator gets is the consequence, named.
    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(fake.reclaim.calls.stops).toBe(1);
    expect(lines.join('\n')).toContain('stood still');
    expect(lines.join('\n')).toContain('may not be able to write into its volume');

    // Removed once, like the install container: this path had the same pair of
    // concurrent `DELETE`s, and the 409 Docker answered the loser reached the
    // console as a claim that a container still had this server's volume
    // mounted — the one sentence in this message an operator would act on.
    expect(fake.reclaim.calls.removes).toBe(1);
    expect(lines.join('\n')).not.toContain('would not remove');
  });

  /**
   * And the round trips around it, which the activity deadline says nothing
   * about: `createContainer` is Docker answering, not a container working, and
   * it comes back from the client as a failure rather than as a hang.
   *
   * Given up on as a *reclaim*, though, and not as an installation — which is
   * the half the code and the comment used to disagree about. By this point the
   * install script has exited 0 and the files are on the disk: failing over the
   * owner on them puts the server in `install_failed`, whose only way out is a
   * reinstall that downloads the lot again against the same unanswering Docker.
   * Nothing is recovered and an hour is thrown away.
   */
  it('reports rather than fails when Docker will not create the reclaim container', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ reclaim: 'never-created' });
    const lines: string[] = [];

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain("This node's Docker is not answering");
    expect(lines.join('\n')).toContain('may not be able to write into its volume');
  });

  /**
   * The reclaim on a node whose Docker gives up entirely, which is where the one
   * call the client cannot bound has to be caught by this file.
   *
   * A wedged layer makes `stop`, `remove` and `wait` all stop answering at once.
   * The first two come back from the client as failures, said on the console.
   * The third does not come back at all — `container.wait()` is deliberately
   * unbounded, because it is how the daemon learns a container ended — so the
   * activity deadline gives up on the `chown`, asks for a teardown, and then has
   * to give up on the wait as well or hold this server's operation queue for
   * ever behind a container that will never report an exit.
   *
   * Two failures reach the operator and they are different failures, which is
   * why neither is allowed to overwrite the other: why the `chown` did not
   * happen, and that a container with this server's volume mounted is still on
   * the node.
   */
  it('bounds the wait a teardown left behind, and says both failures', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({
      reclaim: {
        exitsWith: null,
        wedged: true,
        counters: () => ({ cpu_stats: { cpu_usage: { total_usage: 11 } } }),
      },
    });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);
    await fake.reclaim.started;

    // The chown stands still for a window, so the deadline gives up on it and
    // asks for a teardown the client reports as unanswered on the spot.
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
    expect(fake.reclaim.calls.stops).toBe(1);
    expect(lines.join('\n')).toContain('would not stop the ownership reclaim container');

    // The wait is still outstanding: the bound over it is a real window and not
    // an immediate give-up on a container that may yet report an exit.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines.join('\n')).not.toContain('may not be able to write into its volume');

    await vi.advanceTimersByTimeAsync(30_001);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain('did not answer about the ownership reclaim container');
    expect(lines.join('\n')).toContain('would not remove the ownership reclaim container');
    expect(lines.join('\n')).toContain('may not be able to write into its volume');

    // And the wait that lost the race is closed rather than abandoned. It is
    // outstanding against a container Docker will not answer about at all, and
    // `wait` is the one request the client deliberately does not bound, so
    // nothing else in this process would ever release its socket.
    expect(fake.reclaim.calls.waits[0]?.abortSignal?.aborted).toBe(true);
  });

  /**
   * The ownership reclaim's deadline has exactly one witness — there is no
   * attach stream on a `chown -R` — so a `stats` request Docker will not answer
   * is the difference between watching an idle container and watching nothing at
   * all.
   *
   * It is still given up on, and the argument is the asymmetry rather than any
   * evidence: a reclaim nobody can watch would hold this server's every later
   * action, while giving up on one costs a console line over an installation
   * that succeeds either way. What must not happen is the verdict claiming the
   * `chown` stood still, which sends the operator to their volume when the thing
   * to look at is the Docker daemon on the node.
   */
  it("names this node's Docker when it could not watch the reclaim at all", async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ reclaim: { exitsWith: null, blind: true } });
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);
    await fake.reclaim.started;

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain('no way to tell whether');
    expect(lines.join('\n')).not.toContain('stood still');
    expect(lines.join('\n')).toContain('may not be able to write into its volume');
  });

  /**
   * The verdict the docstring has always claimed, on the case it was written
   * about: a `chown` that ran and refused.
   *
   * Reported and forgiven. The files are on the disk and their owner may be
   * wrong, which is a reinstall away from being fixed and an hour of downloading
   * away from being worth failing over.
   */
  it('reports a chown that exited non-zero without failing the installation', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ reclaim: { exitsWith: 1 } });
    const lines: string[] = [];

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain('Taking ownership of the files failed (code 1)');
  });

  /**
   * The same verdict for a Docker that answers the reclaim with an error rather
   * than with silence, which is the case the deadline never sees.
   *
   * This is the one that used to escape: a refused `createContainer` threw
   * straight out of the reclaim and failed an installation that had finished,
   * while a `chown` exiting non-zero — the same outcome for the volume — was
   * reported and forgiven. The rule is now the one the docstring always claimed:
   * no reclaim failure fails an installation whose files are already in place.
   */
  it('does not throw away a finished installation when Docker refuses the reclaim', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ reclaim: 'refused' });
    const lines: string[] = [];

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain('no such image');
    expect(lines.join('\n')).toContain('may not be able to write into its volume');
  });

  /**
   * The grace period a container the deadline gave up on is given to go down.
   *
   * `stop` sends SIGTERM, waits, and only then sends SIGKILL, and the seconds in
   * between are what lets a script that traps the signal unlink its half-written
   * archive — a 12 GiB modpack tarball left in the volume is a node's free space
   * gone until somebody notices. The figure is stated in a comment on
   * `abandonContainer` and was passed by a line nothing checked, so dropping the
   * argument altogether — which turns the graceful stop into whatever Docker's
   * default happens to be — changed no test.
   */
  it('gives a container it has given up on time to unlink what it was writing', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();
    const lines: string[] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);

    await expect(running).rejects.toThrow(/did nothing/);

    expect(fake.calls.grace).toEqual([{ t: 10 }]);
  });

  /**
   * The two ways of not failing that Docker spells as errors.
   *
   * A container can exit and be reaped between the deadline firing and the
   * `stop` reaching the socket, and Docker then answers 304 "already stopped" or
   * 404 "already gone". Both are races this daemon genuinely loses, neither is
   * worth a line on anybody's console, and printing one would teach an operator
   * to ignore the lines beside it that do matter.
   */
  it('says nothing about a container that had already gone', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ gone: true });
    const lines: string[] = [];

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).not.toContain('would not remove');
  });

  /**
   * A wait that comes back without a status code.
   *
   * `Container.wait()` is typed `any`, and the daemon reads `StatusCode` out of
   * whatever arrives. A Docker that answers the wait with something else — an
   * API version that renames the field, a proxy that rewrites the body — leaves
   * that read `undefined`, and the choice recorded in `waitForExit` is that not
   * knowing counts as a failure. The alternative is a server marked READY over
   * an installation whose outcome nobody established, with no container behind
   * it and no reinstall offered.
   */
  it('treats a wait that named no exit code as a failed installation', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ exitsWithNothing: true });
    const lines: string[] = [];

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toEqual({ successful: false, exitCode: -1 });

    // And no ownership reclaim: there is nothing to hand over when the install
    // may not have run.
    expect(fake.created).toHaveLength(1);
  });

  /**
   * A wait that failed on its own account, rather than because this daemon tore
   * its container down.
   *
   * The two are the same rejection from here and they mean opposite things. When
   * the deadline has fired, a wait that rejects is reporting the teardown the
   * daemon asked for — "no such container", after its own `remove` — and the
   * reason worth telling anybody is the stall, not that; so it is swallowed and
   * the stall verdict is thrown instead. When no deadline has fired, the same
   * rejection is Docker refusing to say how an installation ended, and swallowing
   * *that* returns `{ successful: false, exitCode: -1 }`: a server left in
   * `install_failed` reading "code -1", over a container that may still be
   * running, with nothing anywhere naming what went wrong.
   */
  it('fails an installation whose wait Docker answered with an error', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker({ waitRefused: true });

    const running = runInstallation(fake.docker, {
      configuration: installable({ inactivityTimeoutMs: WINDOW_MS }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;

    await expect(running).rejects.toThrow(/bad parameter/);
  });

  it('refuses a shortfall before any container exists', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();
    const lines: string[] = [];

    // A petabyte: no node passes this, and the test needs no mocked filesystem
    // to prove the refusal.
    await expect(
      runInstallation(fake.docker, {
        configuration: installable({ requiredDiskBytes: 1024 ** 5 }),
        volumePath,
        tmpPath,
        ownership: { uid: 988, gid: 988 },
        networkName: 'hopper0',
        onOutput: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/Not enough disk space/);

    // Refused before the image was pulled and before anything was created:
    // a preflight that runs after a pull has already spent the disk it was
    // checking for.
    expect(fake.created).toEqual([]);
    expect(lines.join('\n')).toContain('1 PiB needed');
  });

  /**
   * That the volume is really walked, and its size really reaches the decision.
   *
   * The arithmetic is proved against {@link diskRefusal} above, where both
   * figures can be chosen; what cannot be arranged on a real filesystem is a
   * free-space figure, so what is proved here is the wiring — a declared figure
   * short of free space makes the daemon measure the volume, and what it
   * measures is what the operator is shown.
   */
  it('measures what the volume already holds before refusing a reinstall', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();
    const lines: string[] = [];

    await mkdir(volumePath, { recursive: true });
    await writeFile(join(volumePath, 'world.mca'), Buffer.alloc(4096));

    await expect(
      runInstallation(fake.docker, {
        configuration: installable({ requiredDiskBytes: 1024 ** 5 }),
        volumePath,
        tmpPath,
        ownership: { uid: 988, gid: 988 },
        networkName: 'hopper0',
        onOutput: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/Not enough disk space/);

    expect(lines.join('\n')).toContain('4 KiB this server');
    expect(lines.join('\n')).toContain('writes over');
  });

  /**
   * **Not knowing is not a refusal**, which is the whole of what the preflight
   * does with a filesystem it cannot measure.
   *
   * `statfs` fails on filesystems Node cannot describe — a network mount, an
   * exotic union filesystem, a path that has just gone — and `freeSpaceBytes`
   * answers `null` rather than throwing precisely so this decision is made here
   * and made once. Refusing on it would take every server on such a node out of
   * service, permanently and silently, over a check that has established
   * nothing: no shortfall was measured, and the node may have terabytes free.
   * That is a far larger failure than the one the guard exists to prevent, and
   * it is unrecoverable from the panel, because a Reinstall runs the same check.
   *
   * Said out loud all the same. An installation that skipped its disk check is a
   * surprising thing to have happened in silence, and on the day the node does
   * fill up this line is the only record that nobody looked.
   */
  it('installs anyway, and says so, when the free space cannot be read', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();
    const lines: string[] = [];

    // What `statfs` on a filesystem Node cannot describe comes back as.
    disk.freeSpaceBytes = () => Promise.resolve(null);

    const running = runInstallation(fake.docker, {
      // A template that declares a figure, so there is a requirement here that
      // is genuinely going unchecked rather than one that was never asked.
      configuration: installable({ requiredDiskBytes: 40 * GIB }),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: (line) => lines.push(line),
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });

    expect(lines.join('\n')).toContain('Could not read the free space');
    expect(lines.join('\n')).toContain('installing anyway');
    // And no refusal wording, which is what a throw would have produced.
    expect(lines.join('\n')).not.toContain('Not enough disk space');
  });

  it('installs as it always has when the template declares neither guard', async () => {
    const { volumePath, tmpPath } = await workspace();
    const fake = fakeDocker();

    const running = runInstallation(fake.docker, {
      configuration: installable(),
      volumePath,
      tmpPath,
      ownership: { uid: 988, gid: 988 },
      networkName: 'hopper0',
      onOutput: () => undefined,
    });

    await fake.started;
    fake.settle(0);

    await expect(running).resolves.toMatchObject({ successful: true, exitCode: 0 });
  });
});

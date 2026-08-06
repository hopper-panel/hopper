import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ServerConfiguration } from '@hopper/shared';
import type Dockerode from 'dockerode';
import type { DockerClient } from '../docker/client.js';
import { CPU_PERIOD_US, cpuQuotaFor, memorySwapFor } from '../docker/container-config.js';
import { LineAssembler } from './console-buffer.js';
import { buildEnvironment } from './invocation.js';

/**
 * Running a server's install script.
 *
 * Installation runs in a **throwaway** container, separate from the server's:
 * the script needs `curl`, `jq`, sometimes a full JDK, things that have no
 * business in a runtime image one would like minimal.
 *
 * Unlike the server container, this one runs as root — an install script often
 * begins with `apt-get install`, and it writes into a volume whose files belong
 * to the server's uid. The consequence — root-owned files in the volume — is
 * corrected right after by {@link reclaimOwnership}.
 *
 * Root is where the resemblance to a trusted process stops. The *script* comes
 * from a template written by an administrator; the *values it reads* do not.
 * `configuration.environment` carries the template variables, and a server's
 * user edits every variable the template marked editable from the startup page,
 * under the `startup.update` permission alone. Those values are handed to this
 * container as its `Env` (see the `buildEnvironment` call below) and an install
 * script reads them back as `$SERVER_JARFILE`, almost always unquoted.
 *
 * This used to be written down the other way round — that the install container
 * "accepts no input from a server's user" — and Docker's whole default
 * capability set was granted on the strength of it. It is recorded here because
 * the mistake is an easy one to make twice: the script being trusted says
 * nothing about what the script is told to do.
 */

/** Where the server's volume is mounted during installation. */
const SERVER_MOUNT = '/mnt/server';
/** Where the script is mounted, read-only. */
const SCRIPT_MOUNT = '/mnt/install';

export interface InstallationOptions {
  configuration: ServerConfiguration;
  volumePath: string;
  /** The daemon's temporary directory, where the script is dropped. */
  tmpPath: string;
  ownership: { uid: number; gid: number };
  networkName: string;
  onOutput: (line: string) => void;
}

export interface InstallationResult {
  successful: boolean;
  exitCode: number;
}

export class InstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationError';
  }
}

export function installContainerName(uuid: string): string {
  return `hopper-install-${uuid}`;
}

/**
 * Processes an install script may hold at once.
 *
 * Deliberately not `build.pidsLimit`: that figure sizes the *server*, and an
 * operator who trimmed it for a small Minecraft instance did not mean to forbid
 * an unpacking that runs `xargs -P` or a Gradle build. What matters here is that
 * the number exists at all — without it a fork bomb in an install script takes
 * the host's pid table with it, and the host runs every other server on the node.
 */
const INSTALL_PIDS_LIMIT = 512;

/**
 * The capabilities an install script cannot work without.
 *
 * Docker hands fourteen capabilities to any container that does not say
 * otherwise, and this one used to take all of them. Dropping the lot outright is
 * not an option either: an install script is a package manager and an archive
 * extraction running as root over a tree owned by somebody else, which is
 * precisely the work capabilities exist to gate. So the default set is dropped
 * and these seven are handed back:
 *
 *  - `CHOWN` — `dpkg` sets the owner of every file it unpacks, and eggs run
 *    `chown` on the volume themselves. Without it the first package fails.
 *  - `DAC_OVERRIDE` — a *reinstall* runs over a volume whose files belong to the
 *    server's uid. Root without this capability is subject to the same
 *    permission bits as anybody else and cannot write into them.
 *  - `FOWNER` — the same tree, for the operations that check ownership rather
 *    than permission: `chmod`, `utime`, what `tar -p` restores.
 *  - `FSETID` — stops the setgid bit `dpkg` puts on some directories from being
 *    cleared as the file is written. Its absence breaks nothing loudly, which is
 *    what makes it worth keeping.
 *  - `KILL` — a signal from root to a process of *another* uid is refused like
 *    anybody else's without this capability, and `apt-get` runs its download
 *    workers as `_apt`. Apt signals those workers when a mirror stops answering
 *    mid-transfer, so without it a dead mirror turns an install that would have
 *    failed into one that hangs. The container has its own pid namespace: what
 *    is granted here is the right to signal the script's own descendants.
 *  - `SETUID` / `SETGID` — `apt-get` drops to `_apt` to fetch and parse what a
 *    mirror sends back, and Debian maintainer scripts switch user through
 *    `runuser`, `setpriv` or `start-stop-daemon --chuid`. Apt warns rather than
 *    failing when it cannot drop, but its fallback is to do that parsing as
 *    root, which is the sandbox these two pay for; the maintainer scripts fail
 *    outright.
 *
 * `su` is the deliberate casualty, and it is worth being exact about why. This
 * list used to justify SETUID/SETGID partly by "maintainer scripts call `su`",
 * which the set does not in fact deliver: `AUDIT_WRITE` sits in Docker's default
 * set precisely so that `su` and `login` can record the switch, PAM's audit call
 * returns EPERM without it, and Debian's util-linux `su` turns that into
 * `cannot open session: Permission denied`. The refusal comes at the audit call,
 * before any uid changes, so SETUID sits unused and `su` fails no matter what
 * else is granted beside it. Dropping `AUDIT_WRITE` is dropping `su`.
 *
 * That is the trade being made, and it is made knowingly. The audit subsystem is
 * not namespaced: a record written from in here lands in the host's audit log,
 * which is where an operator goes to reconstruct what happened on the node.
 * Handing a container whose environment a server's user edits the means to forge
 * and flood that log, in exchange for a `su` that has `runuser` and `setpriv` as
 * working substitutes, is the wrong side of it.
 *
 * What is gone matters more than what stays. `MKNOD` let a script create a
 * device node **inside the volume**: the daemon streams files out of that volume
 * as root for the file manager's download route, so a block device planted there
 * is the host's raw disk on the other end of an HTTP request. `NET_RAW` gave it
 * packet capture and forged frames on a bridge shared with every other server on
 * the node. `SETFCAP` let it write file capabilities onto a binary it leaves
 * behind. None of the three has any part in unpacking a jar.
 */
const INSTALL_CAPABILITIES = [
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETGID',
  'SETUID',
];

/**
 * Memory *plus* swap the install container may use, in Docker's sense.
 *
 * Before the hardening this container set `Memory` and left `MemorySwap` unset,
 * which is Docker's documented "as much swap again as memory" case: a 1 GiB
 * server installed with 1 GiB of RAM and 1 GiB of swap behind it. Handing
 * `memorySwapFor` the server's own figures took that away, because `swapBytes`
 * is 0 on very nearly every plan and `memory + 0` is how Docker spells "no swap
 * at all". An install peaks far above the server it is preparing — a
 * Forge/NeoForge installer JVM, a modpack coming out of a tarball, a Gradle or
 * pip build in a parkervcp egg — so on any node that has swap the effect was
 * installs dying at exactly `memoryBytes` and surfacing as `Installation failed
 * (code 137)`, with nothing in the console pointing at memory.
 *
 * A floor rather than `MemorySwap: -1`. Unlimited swap lets a single install
 * pull the node's entire swap device into use, and that device is shared with
 * every other server on the machine: the failure would move out of the container
 * and onto the host, which is the one outcome these limits exist to prevent.
 * Twice the memory limit is bounded, and it is precisely the behaviour that was
 * known to work here for as long as the installer has existed.
 *
 * A floor and not a replacement: an operator who granted a server more swap than
 * its memory keeps every byte of it, and a server whose swap is deliberately
 * unlimited still installs with unlimited swap.
 */
const INSTALL_SWAP_FLOOR_FACTOR = 2;

function installMemorySwap(build: ServerConfiguration['build']): number | undefined {
  const configured = memorySwapFor(build.memoryBytes, build.swapBytes);

  // `undefined` is a server with no memory limit and `-1` one with unbounded
  // swap. Neither is a number a floor can raise, and forcing one on either would
  // invent a ceiling the operator did not ask for.
  if (configured === undefined || configured < 0) {
    return configured;
  }

  return Math.max(configured, build.memoryBytes * INSTALL_SWAP_FLOOR_FACTOR);
}

/**
 * The least CPU an install is run with, as a percentage of one core.
 *
 * The install container was unbounded before the hardening and now inherits the
 * server's `cpuPercent`, which reads as fair and is not: on a 25%-of-a-core plan
 * it multiplies a modpack install by four, with the server parked in
 * `installing` and no progress shown to whoever is waiting on it. The steady
 * entitlement is a promise about a process that runs for weeks; an install runs
 * once, for minutes, and one core for that long is a cost the node does not
 * notice.
 *
 * The floor only ever raises: a server entitled to four cores installs with
 * four. `cpuPercent` 0 means unlimited and is left alone — applying a floor to
 * it would turn "no limit" into a one-core one, which is the opposite of what
 * the number says.
 */
const INSTALL_CPU_FLOOR_PERCENT = 100;

function installCpuPercent(build: ServerConfiguration['build']): number {
  if (build.cpuPercent <= 0) {
    return 0;
  }

  return Math.max(build.cpuPercent, INSTALL_CPU_FLOOR_PERCENT);
}

/**
 * Host configuration of the install container.
 *
 * Two deliberate departures from the server container's hardening, both because
 * the container is a different animal:
 *
 *  - **no `User`**: the whole point of this container is to run as root. Pinning
 *    it to the server's unprivileged uid would leave every `apt-get` and every
 *    write into a root-owned directory failing.
 *  - **no tmpfs on `/tmp`**: the server gets 128 MiB of RAM-backed `/tmp` so it
 *    cannot fill the host's disk. Applying that here would break the many eggs
 *    that stage a download in `/tmp` before moving it into the volume — a modpack
 *    is routinely larger than the whole tmpfs. The container's own layer is
 *    thrown away seconds later, and `nosuid` on a throwaway filesystem gains
 *    nothing against a process that is already root.
 */
/**
 * Everything `createContainer` is given for the installation.
 *
 * Split out for the same reason as {@link reclaimCreateOptions}: `User` belongs
 * to Docker's *Config* rather than its `HostConfig`, so it can only be pinned
 * on this object. Setting it here would run every `apt-get` in every install
 * script as an unprivileged user, and they would all fail.
 */
export function installCreateOptions(options: {
  configuration: ServerConfiguration;
  install: { containerImage: string; entrypoint: string };
  environment: string[];
  volumePath: string;
  scriptDirectory: string;
  networkName: string;
}): Dockerode.ContainerCreateOptions {
  const { configuration, install } = options;

  return {
    name: installContainerName(configuration.uuid),
    Image: install.containerImage,
    // An array, not a string: the interpreter declared by the template gets the
    // script's path, with no extra shell layer.
    Cmd: [install.entrypoint, `${SCRIPT_MOUNT}/install.sh`],
    Env: [
      ...options.environment,
      `SERVER_MEMORY=${Math.floor(configuration.build.memoryBytes / 1048576)}`,
    ],
    WorkingDir: SERVER_MOUNT,
    Tty: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      'io.hopper.managed': 'true',
      'io.hopper.install': configuration.uuid,
    },
    HostConfig: installHostConfig({
      volumePath: options.volumePath,
      scriptDirectory: options.scriptDirectory,
      networkName: options.networkName,
      build: configuration.build,
    }),
  };
}

export function installHostConfig(options: {
  volumePath: string;
  scriptDirectory: string;
  networkName: string;
  build: ServerConfiguration['build'];
}): Dockerode.HostConfig {
  const { volumePath, scriptDirectory, networkName, build } = options;
  const cpuPercent = installCpuPercent(build);

  return {
    Binds: [`${volumePath}:${SERVER_MOUNT}:rw`, `${scriptDirectory}:${SCRIPT_MOUNT}:ro`],
    NetworkMode: networkName,

    // --- Resource limits -----------------------------------------------------
    // The server's own entitlement, applied to the container that fills its
    // volume: a script downloading a 12 GiB modpack must not take more of the
    // machine than the server it is installing is allowed to. Resident memory is
    // the one figure taken at face value; the two below are the entitlement
    // widened, each for its own reason.
    Memory: build.memoryBytes || undefined,
    MemorySwap: installMemorySwap(build),
    CpuPeriod: cpuPercent > 0 ? CPU_PERIOD_US : undefined,
    CpuQuota: cpuQuotaFor(cpuPercent),
    PidsLimit: INSTALL_PIDS_LIMIT,

    // A shell as PID 1 does not act on SIGTERM while it waits on a child, so a
    // plain `docker stop` on a stuck install waits out the timeout and then
    // kills it. tini forwards the signal to the process group instead, and reaps
    // what a long install double-forks and abandons before those slots eat into
    // `PidsLimit`.
    Init: true,

    // --- Hardening -----------------------------------------------------------
    // Installation downloads: it needs the network, but no more privilege than
    // that.
    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: INSTALL_CAPABILITIES,
    // Nothing the script runs may gain more than the capabilities listed above —
    // in particular, a setuid binary it drops in the volume stays inert.
    SecurityOpt: ['no-new-privileges'],

    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
  };
}

/**
 * Starts the installation and waits for it to finish.
 *
 * @throws {InstallationError} if the template describes no installation, or if
 *   Docker refuses to create the container.
 */
export async function runInstallation(
  docker: DockerClient,
  options: InstallationOptions,
): Promise<InstallationResult> {
  const { configuration, volumePath, tmpPath, ownership, networkName, onOutput } = options;
  const install = configuration.install;

  if (!install || install.script.trim() === '') {
    throw new InstallationError('This template describes no install script.');
  }

  const scriptDirectory = join(tmpPath, `install-${configuration.uuid}`);

  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(volumePath, { recursive: true });

  // Template scripts are written on Linux; a CRLF slipped in by a Windows
  // editor would produce `/bin/bash^M: bad interpreter`, a message nobody ever
  // connects back to line endings.
  await writeFile(join(scriptDirectory, 'install.sh'), install.script.replace(/\r\n/g, '\n'), {
    mode: 0o755,
  });

  await docker.pullImage(install.containerImage, onOutput);
  await removeIfExists(docker, installContainerName(configuration.uuid));

  const environment = buildEnvironment({
    environment: configuration.environment,
    memoryMib: Math.floor(configuration.build.memoryBytes / (1024 * 1024)),
    ip: configuration.allocations.default.ip,
    port: configuration.allocations.default.port,
  });

  const container = await docker.api.createContainer(
    installCreateOptions({
      configuration,
      install,
      environment,
      volumePath,
      scriptDirectory,
      networkName,
    }),
  );

  const stream = (await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  })) as unknown as Duplex;

  const assembler = new LineAssembler();
  stream.on('data', (chunk: Buffer) => {
    assembler.push(chunk.toString('utf8')).forEach(onOutput);
  });

  await container.start();

  const exitCode = await waitForExit(container);
  assembler.flush().forEach(onOutput);

  await container.remove({ force: true }).catch(() => undefined);
  await rm(scriptDirectory, { recursive: true, force: true });

  if (exitCode === 0) {
    // The script ran as root: without taking ownership back, the server —
    // which runs as UID 988 — could not write into any of the files just
    // installed, and would fail on its first start with an incomprehensible
    // permission error.
    await reclaimOwnership(docker, {
      image: install.containerImage,
      volumePath,
      ownership,
      build: configuration.build,
      onOutput,
    });
  }

  return { successful: exitCode === 0, exitCode };
}

/**
 * Waits for a container to finish and returns its exit code.
 *
 * `Container.wait()` is typed `any` by dockerode: the typing is closed back
 * here rather than letting that value circulate. A missing code becomes -1,
 * which will be treated as a failure — the right default when in doubt.
 */
async function waitForExit(container: { wait: () => Promise<unknown> }): Promise<number> {
  const result = (await container.wait()) as { StatusCode?: unknown };
  return typeof result?.StatusCode === 'number' ? result.StatusCode : -1;
}

/**
 * `chown -R` needs three of Docker's fourteen capabilities, and no more.
 *
 * The container exists to run one command over a tree it does not own, so this
 * is the one place where dropping everything would break the very thing being
 * asked for:
 *
 *  - `CHOWN` is the operation. Nothing else in this list matters without it.
 *  - `DAC_OVERRIDE` is what lets the walk enter a directory the server's own
 *    process left at mode 0700. One such directory — a plugin's data folder is
 *    enough — and a recursive chown without it stops there.
 *  - `FOWNER` is kept alongside them without a demonstrated need. `chown(2)`
 *    itself is covered by `CHOWN`, but the walk is `busybox chown` on an Alpine
 *    image and GNU coreutils on a Debian one, and the price of guessing wrong is
 *    a server whose files it cannot write — a failure that surfaces hours later
 *    as a plugin unable to save its configuration, with nothing pointing back to
 *    here.
 *
 * Everything else goes, and the two that mattered are the same two the install
 * container loses: `MKNOD`, because this container has the volume mounted
 * read-write as well, and `NET_RAW`, which is moot under `NetworkMode: 'none'`
 * but should not depend on that staying true.
 */
const RECLAIM_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'];

/**
 * Processes the reclaim needs: the `chown` itself, tini above it, and room to
 * spare. A number this small is not a resource policy — it is the shortest
 * possible statement that nothing else is expected to run in here.
 */
const RECLAIM_PIDS_LIMIT = 64;

/**
 * Host configuration of the ownership-reclaiming container.
 *
 * No `User` here either, for the same reason as the install container: handing
 * the files to uid 988 is something only root can do.
 */
/**
 * Everything `createContainer` is given for the ownership reclaim.
 *
 * Split out from the call so a test can assert on it, and `User` is the reason.
 * `User` lives on Docker's *Config*, not its `HostConfig`, so a test that
 * inspects only the host configuration can never see it — and asserting its
 * absence there passes whatever the code does. What has to be pinned is this
 * object: a later hardening pass that copies the server container's
 * `User: uid:gid` across would make `chown -R` refuse every file it walks, and
 * the failure surfaces hours later as a plugin that cannot save its config.
 */
export function reclaimCreateOptions(options: {
  image: string;
  volumePath: string;
  ownership: { uid: number; gid: number };
  build: ServerConfiguration['build'];
}): Dockerode.ContainerCreateOptions {
  return {
    Image: options.image,
    Cmd: ['chown', '-R', `${options.ownership.uid}:${options.ownership.gid}`, SERVER_MOUNT],
    HostConfig: reclaimHostConfig({ volumePath: options.volumePath, build: options.build }),
  };
}

export function reclaimHostConfig(options: {
  volumePath: string;
  build: ServerConfiguration['build'];
}): Dockerode.HostConfig {
  const { volumePath, build } = options;

  return {
    Binds: [`${volumePath}:${SERVER_MOUNT}:rw`],
    // No network: this step only fixes permissions.
    NetworkMode: 'none',

    // The server's own allowance. A `chown -R` uses a fraction of what the
    // server it is preparing will, so a limit low enough to trouble the walk
    // would describe a server too small to start.
    Memory: build.memoryBytes || undefined,
    // Equal to `Memory`, which is how Docker is told "no swap at all". The
    // install container is given swap headroom because an installer JVM or a
    // Gradle build genuinely peaks above the server's steady budget; a `chown`
    // has no peak to speak of, so swap here would only ever be the symptom of
    // something that is not going to finish. Failing fast prints the warning
    // below instead of thrashing the host's disk.
    MemorySwap: build.memoryBytes || undefined,
    CpuPeriod: build.cpuPercent > 0 ? CPU_PERIOD_US : undefined,
    CpuQuota: cpuQuotaFor(build.cpuPercent),
    PidsLimit: RECLAIM_PIDS_LIMIT,

    // Without tini the `chown` is PID 1, and PID 1 ignores a signal it has no
    // handler for: an operator stopping this container by hand would wait out
    // the timeout for nothing.
    Init: true,

    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: RECLAIM_CAPABILITIES,
    SecurityOpt: ['no-new-privileges'],

    RestartPolicy: { Name: 'no' },
    // A `chown -R` that is refused prints one line per file. On a modpack that
    // is a million lines into `/var/lib/docker` for a container nobody reads the
    // logs of — the console output comes from the message below.
    LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
  };
}

async function reclaimOwnership(
  docker: DockerClient,
  options: {
    image: string;
    volumePath: string;
    ownership: { uid: number; gid: number };
    build: ServerConfiguration['build'];
    onOutput: (line: string) => void;
  },
): Promise<void> {
  const container = await docker.api.createContainer(reclaimCreateOptions(options));

  await container.start();
  const exitCode = await waitForExit(container);
  await container.remove({ force: true }).catch(() => undefined);

  if (exitCode !== 0) {
    options.onOutput(
      `[Hopper] Taking ownership of the files failed (code ${exitCode}). The server may not be able to write into its volume.`,
    );
  }
}

async function removeIfExists(docker: DockerClient, name: string): Promise<void> {
  try {
    await docker.api.getContainer(name).remove({ force: true });
  } catch {
    // Absent: that is the normal case.
  }
}

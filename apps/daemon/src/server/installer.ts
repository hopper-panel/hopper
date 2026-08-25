import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ServerConfiguration } from '@hopper/shared';
import type Dockerode from 'dockerode';
import { DOCKER_ANSWER_TIMEOUT_MS, DockerUnansweredError } from '../docker/client.js';
import type { DockerClient } from '../docker/client.js';
import { CPU_PERIOD_US, cpuQuotaFor, memorySwapFor } from '../docker/container-config.js';
import { DockerFrameReader } from '../docker/stream-frames.js';
import { LineAssembler, type ConsoleLine } from './console-buffer.js';
import { directorySize, formatBytes, freeSpaceBytes } from './disk-usage.js';
import { buildEnvironment } from './invocation.js';
import {
  activityCounters,
  countersMoved,
  type ActivityCounters,
  type DockerStats,
} from './stats.js';

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
  /**
   * Where a line of the installation goes.
   *
   * Takes either shape on purpose. Hopper's own remarks are plain strings and
   * stand on a line of their own, which is every call in this file but one; the
   * container's output arrives as {@link ConsoleLine} because a progress bar
   * redrawing itself is one row of a terminal and the console buffer is the only
   * thing that can act on that. Widening the parameter rather than wrapping the
   * strings keeps the distinction to the one place that has it to make — and the
   * helpers below that are handed this callback go on declaring the narrower
   * `(line: string) => void` they actually use.
   */
  onOutput: (line: string | ConsoleLine) => void;
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
 * `su` was written here as the deliberate casualty of dropping `AUDIT_WRITE`,
 * and that was wrong. The reasoning read well — `AUDIT_WRITE` is in Docker's
 * default set so `su` and `login` can record the switch, PAM makes that call,
 * and it returns EPERM without the capability — but it was never run. It has
 * been now: a container with exactly this set (`CapEff 00000000000000fb`) runs
 * `su steam -c …` and `su - steam -c id` and both exit 0, on a Debian `su` that
 * `ldd` confirms is linked against `libaudit.so.1`. PAM logs the failed audit
 * call and carries on; it is not fatal. Two independent runs agree, and 0 of the
 * 104 SteamCMD install scripts in the public egg corpus use `su` anyway.
 *
 * One case stays unmeasured: both runs were on a kernel with the audit subsystem
 * compiled in and nothing collecting (`/proc/self/loginuid` reads -1). A host
 * running `auditd` may well refuse, and that is the host an operator is most
 * likely to have. So nothing changes here — `runuser` and `setpriv` remain what
 * this project's own scripts use, on the narrower ground that they depend on
 * nothing about the host rather than that `su` cannot work.
 *
 * The trade `AUDIT_WRITE` is actually being dropped for is still worth making,
 * and it is not about `su` at all. The audit subsystem is not namespaced: a
 * record written from in here lands in the host's audit log, which is where an
 * operator goes to reconstruct what happened on the node. Handing a container
 * whose environment a server's user edits the means to forge and flood that log
 * buys nothing an install needs.
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

    /**
     * **No tty, and this is the line that decides whether Steam installs at
     * all.**
     *
     * A tty here read as a convenience: it is what a terminal gives, so
     * progress bars redraw and colours arrive, and the attach stream is plain
     * text instead of Docker's framing. SteamCMD refuses to work through one.
     * `+app_update 4020 validate`, run in a container built exactly like this
     * one, answers
     *
     *   Connecting anonymously to Steam Public...OK
     *   Waiting for user info...OK
     *   ERROR! Failed to install app '4020' (Missing configuration)
     *
     * and exits 8 before a byte of depot. The same container without the tty
     * downloads all 6.87 GB. Measured eight times on one machine, interleaved
     * so that neither time nor a Steam outage can explain it: with a tty it
     * failed seven times out of seven, without one it worked three times out of
     * three. `TERM` is not the variable — an empty `TERM` with a tty still
     * fails, and `TERM=xterm` without one still works — and no redirection
     * inside the script escapes it: stdin from /dev/null, stdout down a pipe,
     * `setsid` to drop the controlling terminal, all still refused.
     *
     * That is not one game. 104 of the 274 published eggs read for this
     * catalogue install from SteamCMD, so a tty here is a wall in front of
     * every one of them, and the message on the wall names neither the panel
     * nor the terminal.
     *
     * What it costs is that the attach stream is now multiplexed —
     * {@link DockerFrameReader} is the eight bytes of header this adds — and
     * that programs which check for a terminal print their plain output. On an
     * install log, that second one is a gain: `apt-get` stops redrawing.
     *
     * It is not the whole of that failure, and the Source templates say so:
     * with no tty at all, a cold SteamCMD still refuses its first call now and
     * then, and the next one works. This line takes down a wall; the retry in
     * the install script handles what is left standing.
     */
    Tty: false,
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

    // **No `Tmpfs` for `/tmp`, deliberately.** A 512 MiB RAM disk was mounted
    // here for one release, on the argument that an install script reads its
    // download URL out of a variable the server's own user edits and so could
    // point an unbounded write at `/var/lib/docker`. The argument does not
    // survive reading the rest of this function: `WorkingDir` is `/mnt/server`,
    // a bind mount of the volume, and nothing enforces a quota on it —
    // `build.diskBytes` is this daemon's own accounting, applied to the file
    // manager and to SFTP, never to the kernel. The same script can `curl` two
    // hundred gigabytes straight into the volume and fill the node exactly as
    // before, so the tmpfs closed nothing.
    //
    // What it did close was the commonest egg shape there is —
    // `curl -o /tmp/pack.zip … && unzip /tmp/pack.zip -d /mnt/server` — which
    // worked on the container layer and then met a ceiling no template could
    // declare and no operator could raise short of editing the install script.
    // And because tmpfs pages are charged to the cgroup that dirties them, on a
    // small plan it competed with the installer's own heap in the same `Memory`
    // limit set above: a working install turned into an unexplained code 137.
    //
    // A real ceiling is a node-provisioning job — an XFS project quota, or a
    // loopback image per volume — and it does not exist yet. `StorageOpt` is not
    // it either: Docker refuses it on overlay2 unless the backing filesystem is
    // XFS mounted with `pquota`, so on the ext4 root most nodes run it turns
    // every installation on the node into a container that cannot be created.
    // The free-space preflight `runInstallation` performs before creating this
    // container is a check, not an enforcement, and is documented as one.

    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
  };
}

// ---------------------------------------------------------------------------
// The inactivity deadline
// ---------------------------------------------------------------------------

/**
 * How long an installation may do nothing at all before this daemon gives up on
 * it, when its template names no figure of its own.
 *
 * A quarter of an hour, and the number is chosen to be *ignored* by anything
 * that works rather than to be tight. What it exists for is a mirror that
 * accepts the connection and then stops answering, which until now left the
 * server in `installing` for ever because `container.wait()` was waited on with
 * no bound at all.
 *
 * The figure is what it is because of what is being measured, and the two were
 * settled together. This deadline was first written on **silence**, with half an
 * hour behind it on the argument that no real install prints nothing for that
 * long. The argument is false for this repository's own catalogue: every
 * bundled script downloads with `curl -sSL` — see `packages/templates`, and the
 * same idiom in the overwhelming majority of Pterodactyl eggs — and `-s`
 * suppresses the progress meter, so the transfer emits not one byte from start
 * to finish. A window on silence would therefore have been a *total-duration*
 * cap, the very thing the design rejected, applied to the one step that
 * legitimately takes hours: a 2 GiB modpack on a slow uplink is a working
 * install it would have killed.
 *
 * So what is watched is what the container **does** — its output, but also the
 * CPU the kernel charges it and the blocks it reads and writes, both counted
 * against its own cgroup and nobody else's. A container pulling a depot down a
 * wire is alive whether or not it says so: taking those bytes off the socket and
 * putting them on a disk is work, and work is CPU time. One doing none of those
 * three things is not slow, it is finished. Fifteen minutes of that is a very
 * long time; the old thirty were padding for a silent-but-working download that
 * now proves itself by the work it is doing.
 *
 * What is *not* watched is the container's network counters, and
 * {@link ActivityCounters} records why at length: they count frames an interface
 * accepted rather than work this container did, so on a node whose bridge floods
 * ARP to every port they climb for a container that has stopped dead — which
 * would leave this deadline never firing on exactly the busy nodes where an
 * install that never ends does the most damage.
 *
 * A template that knows better says so — see `install.inactivityTimeoutMs`.
 * This is the figure for the entire existing catalogue, every imported
 * Pterodactyl egg, and everything else that has never had a deadline and must
 * not start failing because one now exists.
 *
 * The deadline lives in this process and dies with it, deliberately. An
 * installation the daemon was restarted out of is settled by
 * `resolveOrphanedInstall` on the way back up — reported as failed, with its
 * container removed — and is not resumed or re-adopted: nothing here could adopt
 * the output stream of a container started by a process that no longer exists,
 * so a "resumed" install would be one nobody is watching, which is the state
 * this whole file exists to make impossible.
 */
export const INSTALL_INACTIVITY_DEFAULT_MS = 15 * 60_000;

/** How long the container is given to go down once the deadline has fired. */
const INSTALL_ABANDON_GRACE_SECONDS = 10;

export interface StallReport {
  /** How long the container had done nothing when the deadline fired. */
  idleMs: number;
  /** How long the installation had been running by then. */
  elapsedMs: number;
  /** False when the installation never did anything at all, from the start. */
  sawActivity: boolean;
  /**
   * Whether the container's counters could be read at all during the window
   * that expired.
   *
   * The difference between "it did nothing" and "nobody could see whether it
   * did anything", and the verdicts say which. False means every sample in the
   * window failed — a Docker that stopped answering about this container — and
   * a deadline that fires on that has no evidence the container was idle. It
   * gives up all the same, because a container nobody can watch cannot be
   * allowed to hold a server's operation queue for ever, but it names this
   * node's Docker rather than accusing a script that may have been working
   * perfectly.
   */
  observed: boolean;
}

/**
 * A deadline on **inactivity**.
 *
 * Armed when the install container is about to run and pushed back by every sign
 * of life it gives, so that an installation which is working is never killed
 * however long it takes, and one that has stopped is given up on however little
 * it has done.
 *
 * Two things push it back, and the second is the one that matters. Output is the
 * obvious signal, and it is taken from the raw stream rather than from assembled
 * console lines. {@link LineAssembler} does turn each refresh of a
 * carriage-return progress bar into a line of its own, so the difference is no
 * longer the whole of a download against nothing — but it is still the
 * difference that decides this. A line is only ever produced by a terminator,
 * and one frame slow enough to straddle the window produces none: a depot
 * download on a failing uplink writes `progress: 41.62 (…)` and then spends four
 * minutes on the next figure, which is bytes arriving the whole time and not one
 * complete line. A deadline counting lines would kill it. But most install
 * scripts do not print during a transfer at all — `curl -sSL` is the universal
 * idiom and `-s` means exactly that — so the second signal is the container's
 * own counters, fed in by {@link ContainerActivityProbe}.
 *
 * The clock is injectable for the tests, which need to prove both directions —
 * an install that is doing something is not killed, one that has stopped is —
 * and cannot do that in real time against a window measured in minutes.
 */
export class ActivityWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private lastActiveAt = 0;
  private sawActivity = false;
  /** Whether a counter sample has succeeded since the current window began. */
  private observed = false;
  private report: StallReport | null = null;

  constructor(
    private readonly windowMs: number,
    private readonly onExpiry: (report: StallReport) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What the deadline saw when it fired, or `null` while it has not. */
  get expiry(): StallReport | null {
    return this.report;
  }

  arm(): void {
    this.startedAt = this.now();
    this.lastActiveAt = this.startedAt;
    this.schedule();
  }

  /**
   * Called for every byte the installation produces and every counter of its
   * container that has moved.
   */
  noteActivity(): void {
    // Nothing to push back once the verdict has been passed: the container is
    // already being torn down, and the dying words and last few cycles of its
    // own teardown must not look like a reprieve.
    //
    // Two conditions keep it down and either alone would do it — this one, and
    // the null timer the re-arm below is conditional on. The overlap is kept on
    // purpose because the two are guarding different things: this one answers
    // "has the verdict been passed", and the timer answers "is anybody still
    // watching", which is also false for a deadline that merely stood down. The
    // installation's own stands down while the ownership reclaim runs, and
    // output keeps arriving across that line.
    if (this.report !== null) {
      return;
    }

    this.sawActivity = true;
    this.lastActiveAt = this.now();

    if (this.timer !== null) {
      this.schedule();
    }
  }

  /**
   * Called for every counter sample that came back, whether or not it moved.
   *
   * Deliberately **not** a sign of life: a container whose counters read exactly
   * as they did fifteen seconds ago is standing still, and pushing the deadline
   * back for having successfully looked at it would switch the deadline off. All
   * this records is that the deadline has a witness — that when it fires, it is
   * firing on stillness it saw rather than on a Docker it could not ask.
   */
  noteObservation(): void {
    if (this.report !== null) {
      return;
    }

    this.observed = true;
  }

  disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * A timeout re-armed on every sign of life, rather than an interval that polls
   * a timestamp: the deadline then means exactly what it says instead of the
   * window plus up to one polling period, and an installation that is doing
   * nothing is not woken up for.
   */
  private schedule(): void {
    this.disarm();

    // A fresh window has seen nothing yet. Evidence does not carry over: what
    // the verdict has to be able to say is whether *this* window — the one that
    // ended in silence — was one anybody could see into.
    this.observed = false;

    this.timer = setTimeout(() => this.expire(), this.windowMs);
    // This timer must never be the reason hopperd stays alive. A daemon being
    // shut down mid-install has already stopped caring about the deadline.
    this.timer.unref();
  }

  private expire(): void {
    // The other half of the pair described in `noteActivity`: a fired timer is
    // no longer a timer, and leaving the handle here would let a sign of life
    // arriving during the teardown re-arm a deadline that has already spoken.
    this.timer = null;

    const at = this.now();

    this.report = {
      idleMs: at - this.lastActiveAt,
      elapsedMs: at - this.startedAt,
      sawActivity: this.sawActivity,
      observed: this.observed,
    };

    this.onExpiry(this.report);
  }
}

/**
 * How often the install container's counters are read, at most.
 *
 * Fifteen seconds, and the reason it can be this lazy without ever mistaking a
 * working container for a dead one is that {@link ActivityCounters} are
 * cumulative. They only grow, so a difference between two samples is work that
 * happened *somewhere* between them, whenever they were taken: a poll cannot
 * miss activity, only learn of it late. Sampling rarely therefore costs
 * promptness, never correctness — which is what makes the cost side worth
 * minimising. Each sample is one round trip to the Docker socket, and this
 * daemon may be running several installations at once on a node that is also
 * running every server on it.
 *
 * Fifteen seconds is two orders of magnitude below the default window, so a live
 * container gets some sixty chances to prove itself before the deadline. A
 * container that is genuinely wedged trips it at the window exactly: a poll that
 * hangs or fails resets nothing, so nothing about the sampling can *delay* the
 * verdict.
 *
 * The one case the period could get wrong is a window short enough to be
 * comparable to it — a template naming thirty seconds would otherwise be a coin
 * toss on whether a sample landed inside it. So the period is also capped at a
 * quarter of the window, which gives a container three chances to show movement
 * inside one — the first sample is a baseline and can never show any — for every
 * window of {@link ACTIVITY_SAMPLE_FLOOR_MS} × {@link ACTIVITY_SAMPLES_PER_WINDOW}
 * or more.
 *
 * **Below four seconds the floor wins, and the guarantee does not hold.** That
 * is the deliberate answer rather than an oversight, and the two sentences used
 * to be written here as though both were true at once. A window of two seconds
 * would need a poll every half-second — one round trip to the Docker socket
 * twice a second, per installation, on a node that may be running one for every
 * server on it — to measure something no install can be judged on anyway: a
 * container that pauses for two seconds is a container between two syscalls, and
 * a deadline that fires on that will fire on healthy work whatever the sampling
 * rate. So the floor is kept and the window is the thing that is wrong. A
 * template naming one this short is asking for a guard that cannot be built; the
 * schema permits it because a positive integer is what the field is, and the
 * daemon polls at its floor and lets the deadline mean what it can.
 */
const ACTIVITY_SAMPLE_PERIOD_MS = 15_000;
const ACTIVITY_SAMPLES_PER_WINDOW = 4;
const ACTIVITY_SAMPLE_FLOOR_MS = 1_000;

export function activitySamplePeriod(windowMs: number): number {
  return Math.max(
    ACTIVITY_SAMPLE_FLOOR_MS,
    Math.min(ACTIVITY_SAMPLE_PERIOD_MS, Math.floor(windowMs / ACTIVITY_SAMPLES_PER_WINDOW)),
  );
}

/**
 * Reads a container's counters on a period and reports when any of them moved.
 *
 * This is the half of the deadline that makes it a deadline on *work* rather
 * than on chatter, and it is the half without which the whole guard would kill
 * the installations it exists to protect — see
 * {@link INSTALL_INACTIVITY_DEFAULT_MS} for why silence proves nothing here.
 *
 * The first sample establishes a baseline and can never report movement: these
 * counters are cumulative over the container's whole life, so a non-zero first
 * reading says only that something happened at some point, possibly before
 * anybody was watching.
 *
 * **A sample that fails is neither activity nor stillness, and the callback says
 * which it was.** Docker refusing says nothing about what the container is
 * doing, and treating it as a sign of life would hand a wedged Docker the power
 * to keep an install alive for ever — the failure mode this file exists to
 * close, arrived at from the other side. But it is not evidence of idleness
 * either, and reporting it as such is how a deadline whose only witness is this
 * probe — the ownership reclaim has no output stream — comes to give up on a
 * `chown` that was working perfectly. So `onSample` is called only for a sample
 * that came back, and it is told whether the counters moved; a failure is
 * reported by saying nothing at all, which the deadline reads as having been
 * unable to look.
 *
 * A failure is otherwise swallowed rather than surfaced: it is not the install's
 * fault and not the operator's problem, and the sampling carries straight on.
 * That carrying-on is worth its own sentence, because it used not to: a `stats`
 * request Docker never answered left this loop awaiting a promise that never
 * settled, so nothing was ever rescheduled and one hiccup blinded the deadline
 * for the rest of the installation. Every request `DockerClient` makes is now
 * bounded, so a hung sample comes back as a rejection and the next one goes out
 * a period later.
 *
 * The **sampling** is what that tolerance covers, and nothing else. What the
 * callback then does is not this class's business and is deliberately outside
 * the `catch` — see `poll` below.
 *
 * Each poll is scheduled only once the previous one has come back, so a slow
 * Docker cannot queue up requests behind itself; the period is a gap between
 * polls, not a rate.
 */
export class ContainerActivityProbe {
  private timer: NodeJS.Timeout | null = null;
  private previous: ActivityCounters | null = null;
  private running = false;

  constructor(
    private readonly sample: () => Promise<DockerStats>,
    private readonly onSample: (moved: boolean) => void,
    private readonly periodMs: number,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    // The baseline is taken straight away rather than one period in, so the
    // first sample that *could* show movement is one period away and not two.
    void this.poll();
  }

  stop(): void {
    this.running = false;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    this.timer = null;

    /** `null` for a sample that never came back, so nothing is reported. */
    let moved: boolean | null = null;

    try {
      const counters = activityCounters(await this.sample());
      const previous = this.previous;

      // A sample whose counters the host does not keep leaves `previous` alone
      // and reports nothing — the same answer as a sample that never came back,
      // because it carries the same amount of information. Overwriting
      // `previous` with it would also discard the last reading that did mean
      // something.
      if (counters !== null) {
        this.previous = counters;
        moved = previous !== null && countersMoved(previous, counters);
      }
    } catch {
      // See above: not knowing is neither a sign of life nor a sign of death,
      // and the deadline is told nothing rather than told something false.
    }

    try {
      // Reported from **outside** the `catch` above, and the placement is the
      // point rather than tidiness. A sample Docker would not give us and a
      // callback that threw are different events with different owners — the
      // first is this node's Docker and is deliberately tolerated, the second is
      // a bug in this daemon — and one `catch` around both hid the second
      // completely. It hid it in the tests too: the two that prove this probe
      // reports *nothing* passed an `expect.unreachable()` as the callback, so
      // they could not fail however wrong the code became.
      //
      // Nothing catches it here either. The callback feeds the deadline, which
      // cannot throw; one that could would have a defect worth crashing on
      // rather than a condition worth surviving.
      if (moved !== null) {
        this.onSample(moved);
      }
    } finally {
      // Rescheduled from a `finally`, so that a callback which threw takes this
      // daemon down loudly rather than stopping the sampling quietly. A probe
      // that simply gave up here would leave the deadline with nothing left to
      // push it back, and it would kill a working installation one window later
      // for a reason nobody could see.
      if (this.running) {
        this.timer = setTimeout(() => void this.poll(), this.periodMs);
        // Like the deadline's own timer, never a reason for hopperd to stay up.
        this.timer.unref();
      }
    }
  }
}

/**
 * A duration as an operator reads it.
 *
 * "1800000ms" in a console line is a number nobody converts in their head
 * before deciding whether it was long enough to be worth believing.
 */
export function describeDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * What the console is told when the deadline fires.
 *
 * The three things are listed by name, every time, because the operator reading
 * this has to be able to disbelieve it. "Timed out" invites the reply "it was
 * downloading, your timeout is too short"; "no output, no CPU, no disk I/O" does
 * not, and it also tells anybody sizing `installInactivityTimeoutMs` what the
 * figure is actually measuring.
 *
 * Unless there was nothing to name, which is the branch below. A window in which
 * not one counter sample came back is a window in which this daemon could not
 * see the container at all, and "no CPU, no disk I/O" would then be a claim
 * about figures nobody read. The installation is still stopped — a container
 * nobody can watch cannot be left holding a server's operation queue — but the
 * lines say so, and they point at this node's Docker rather than at a script
 * that may have been working perfectly. The distinction is worth the branch
 * because it decides where the operator looks next.
 */
export function describeStall(report: StallReport, windowMs: number): string[] {
  if (!report.observed) {
    return [
      `[Hopper] This node's Docker has not reported the install container's counters once in the ` +
        `last ${describeDuration(report.idleMs)}, and the container has printed nothing either: ` +
        'there is no way to tell from here whether this installation is working.',
      '[Hopper] Giving up on it: the install container is being stopped and removed.',
      "[Hopper] This is this node's Docker rather than the installation — the script may well " +
        'have been running perfectly. Check that the Docker daemon on this node is healthy ' +
        'before reinstalling, because the same thing will happen again.',
    ];
  }

  const idle = report.sawActivity
    ? `This installation has done nothing for ${describeDuration(report.idleMs)} — no output, no ` +
      `CPU, no disk I/O — having run for ${describeDuration(report.elapsedMs)}.`
    : `This installation has done nothing at all in the ${describeDuration(report.elapsedMs)} ` +
      'since it started: no output, no CPU, no disk I/O.';

  return [
    `[Hopper] ${idle}`,
    '[Hopper] Giving up on it: the install container is being stopped and removed.',
    '[Hopper] A download that is still running burns CPU on every packet it takes off the socket, ' +
      'even when it prints nothing, so this one is not running. If this installation genuinely ' +
      `stands still for longer than ${describeDuration(windowMs)} — a script that sleeps while it ` +
      'waits on something — its template has to say so through installInactivityTimeoutMs.',
  ];
}

// ---------------------------------------------------------------------------
// The disk preflight
// ---------------------------------------------------------------------------

/**
 * Free space no installation may start below, whatever it is installing.
 *
 * The floor exists because the interesting figure — how much this particular
 * install is about to write — is knowable for a Steam depot and unknowable for a
 * Minecraft server whose modpack URL is a variable. A template that knows
 * declares `install.requiredDiskBytes`; everything else gets this, and this has
 * one job: stop an installation from finishing off a node that is already nearly
 * full. A gigabyte is far too little for a modpack and far more than a Paper jar
 * needs, which is exactly the point — it refuses only where the *next* write of
 * any size is the one that takes the machine down, and it cannot refuse a
 * template that installs happily today on a node with room on it.
 */
export const INSTALL_FREE_SPACE_FLOOR_BYTES = 1024 ** 3;

/** What is refused, and why, in the two forms each is needed in. */
export interface DiskRefusal {
  /** What the console is told, at length. */
  lines: string[];
  /** The one line the {@link InstallationError} carries. */
  reason: string;
}

/**
 * Which filesystem the figures came off, and — the useful half — which one they
 * did not.
 *
 * `statfs` answers for the filesystem the path it was given lives on, and names
 * nothing else. That is one filesystem out of the two an installation writes to:
 * the volume is bind-mounted from here, but a script that stages its download in
 * `/tmp` — `curl -o /tmp/pack.zip … && unzip`, the commonest egg shape there is —
 * writes to the container's own layer, which lives under Docker's data root on
 * whatever filesystem *that* is. On most nodes they are the same filesystem and
 * this sentence costs a line; on a node where an operator deliberately gave the
 * volumes a disk of their own, it is the difference between freeing space on the
 * right disk and freeing it on the wrong one.
 *
 * Docker's data root is deliberately not measured alongside. It is configurable
 * — `data-root` in `daemon.json` — and this daemon is not told where it is, so
 * checking it would mean guessing at `/var/lib/docker` and reporting a figure for
 * a filesystem that may have nothing to do with the one Docker uses. A refusal
 * naming a number that is wrong is worse than one naming a number that is
 * missing.
 */
function measuredOn(path: string): string {
  return (
    `[Hopper] The only filesystem measured is the one holding ${path}. An install script that ` +
    "stages its download in /tmp writes to the container's own layer instead, on whatever " +
    "filesystem carries Docker's storage — where those are separate mounts on this node, that " +
    'one has not been checked.'
  );
}

/**
 * Whether there is room, and what to say when there is not.
 *
 * Pure, so the refusal's wording is testable without a full filesystem. A
 * shortfall is refused rather than warned about: filling a node's disk is not
 * this server's failure to have — `/var/lib/docker`, the other servers' volumes
 * and the daemon's own logs are on that filesystem, and every server on the
 * machine goes down together. The numbers are named because "not enough disk
 * space" leaves an operator to guess whether they need to free a gigabyte or
 * forty.
 *
 * **Two questions, answered against two different quantities**, and a refusal
 * has to say which of them it failed. They were one question with one number
 * once — the declared figure raised to the floor — and that was wrong twice
 * over, so both halves are spelled out here.
 *
 * The **floor** is measured against free space alone. A node that is nearly full
 * is nearly full whatever this one volume happens to hold, and the bytes an
 * install is going to overwrite are not available in advance: they are released
 * as the new ones are written, file by file, so there is no moment at which the
 * machine has them spare. Crediting them here would let an installation start on
 * a node with nothing left.
 *
 * The **declared figure** is measured against free space *plus what the volume
 * already holds*, because nothing wipes that volume first — a reinstall writes
 * over what is there. Demanding the whole requirement as free space is how a
 * 40 GiB Palworld server becomes impossible to reinstall on the node it is
 * already installed on, which is a certain failure traded away for a possible
 * one. The trade is not free and is worth naming: a script that wrote 40 GiB
 * *beside* the 40 GiB already there, rather than over it, would be let through
 * and would fill the node. Install scripts replace what they installed — that is
 * what an install script is — which is what makes the assumption the right way
 * round rather than merely the convenient one.
 *
 * `build.diskBytes` is in neither, and its absence is the other decision worth
 * recording. It is the obvious candidate — the server's own disk limit, sitting
 * right there in the configuration — and it answers a different question: what
 * the operator is willing to *sell* this server, not what its installation is
 * about to write. A 50 GiB Minecraft plan that will use 900 MiB would refuse to
 * install on a node with 20 GiB free, which is every deliberately oversubscribed
 * node in existence; and the panel has already weighed that number once, at
 * creation, against the node's declared capacity and the overallocation
 * percentage the operator chose. Re-deciding it here would overrule an operator
 * on their own machine, in the one code path they cannot see. It would not even
 * bound what gets written — nothing enforces `diskBytes` during an installation,
 * the quota being this daemon's own accounting over the file manager and SFTP —
 * and `diskBytes` 0 means unlimited, which as a *requirement* reads either as
 * "needs everything" or "needs nothing".
 *
 * Both questions are asked of **one** filesystem — the one the volume lives on —
 * and every refusal says so out loud rather than leaving it to be inferred from a
 * path. See {@link measuredOn} for what that leaves unmeasured and why it stays
 * unmeasured.
 */
export function diskRefusal(options: {
  freeBytes: number;
  /** What the volume already holds, and a reinstall therefore writes over. */
  reclaimableBytes: number;
  /** What the template says it downloads, or `undefined` if it did not say. */
  declaredBytes: number | undefined;
  path: string;
}): DiskRefusal | null {
  const { freeBytes, reclaimableBytes, declaredBytes, path } = options;

  const tail =
    '[Hopper] Nothing has been started and nothing has been changed. Free space on this node, ' +
    'or create the server on another one.';

  if (freeBytes < INSTALL_FREE_SPACE_FLOOR_BYTES) {
    return {
      lines: [
        `[Hopper] Not enough disk space to install: ${formatBytes(freeBytes)} free on the ` +
          `filesystem holding ${path}, ${formatBytes(INSTALL_FREE_SPACE_FLOOR_BYTES)} needed.`,
        `[Hopper] Hopper refuses any installation with less than ` +
          `${formatBytes(INSTALL_FREE_SPACE_FLOOR_BYTES)} free, whatever it is installing and ` +
          'whatever this volume already holds: an install that fills a node takes down every ' +
          'server on it, not just this one.',
        measuredOn(path),
        tail,
      ],
      reason:
        `Not enough disk space on this node: ${formatBytes(freeBytes)} free, ` +
        `${formatBytes(INSTALL_FREE_SPACE_FLOOR_BYTES)} needed.`,
    };
  }

  if (declaredBytes === undefined || freeBytes + reclaimableBytes >= declaredBytes) {
    return null;
  }

  // Named separately from the total, because "37 GiB available" on a node with
  // 5 GiB free is a figure nobody would believe without being told where the
  // rest of it comes from.
  const held =
    reclaimableBytes > 0
      ? `${formatBytes(freeBytes)} free on the filesystem holding ${path}, plus ` +
        `${formatBytes(reclaimableBytes)} this server's volume already holds and the ` +
        'installation writes over'
      : `${formatBytes(freeBytes)} free on the filesystem holding ${path}`;

  return {
    lines: [
      `[Hopper] Not enough disk space to install: ${held}, ${formatBytes(declaredBytes)} needed.`,
      '[Hopper] The figure comes from the template, which knows what it downloads.',
      measuredOn(path),
      tail,
    ],
    reason:
      `Not enough disk space on this node: ${formatBytes(freeBytes + reclaimableBytes)} ` +
      `available, ${formatBytes(declaredBytes)} needed.`,
  };
}

/**
 * Starts the installation and waits for it to finish.
 *
 * @throws {InstallationError} if the template describes no installation, if the
 *   node has not the disk space for it, if the installation stands still for
 *   longer than its deadline, or if Docker will not take the container down
 *   afterwards.
 * @throws {DockerUnansweredError} if Docker takes any of the requests this makes
 *   — creating the install container, attaching to its output, starting it,
 *   removing it — and does not answer within its own window. Thrown by
 *   `DockerClient` rather than by anything here, which is the point: see
 *   `boundEveryRequest`.
 *
 * Deliberately neither for a failed ownership reclaim, which is reported and
 * never fatal — see {@link reclaimOwnership}, and `docs/security.md` for the
 * other two failures that are reported without failing an installation.
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

  await mkdir(volumePath, { recursive: true });

  // Before the image is pulled and long before anything runs: a preflight that
  // refuses after downloading a container image has already spent the disk it
  // was checking for. The volume itself is the path measured, not the daemon's
  // root — `system.dataDirectory` can sit on a different disk from
  // `system.rootDirectory`, and an operator who gave one server its own mount
  // deserves to have that mount checked rather than the one Hopper happens to
  // be installed on. It exists by now, which is why the mkdir above moved up.
  await assertDiskSpace({ install, volumePath, onOutput });

  await mkdir(scriptDirectory, { recursive: true });

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
    allocations: configuration.allocations,
  });

  /**
   * Puts a Docker that has stopped answering where whoever asked for this
   * installation is already looking.
   *
   * **It reports; it does not bound.** Every request `DockerClient` makes is
   * bounded at the client — see `boundEveryRequest` there for why the rule lives
   * in one place rather than at each of these call sites, which is what it used
   * to do — so by the time anything arrives here the deadline has already been
   * kept. What is left is a question of audience: the throw becomes a single
   * `Installation failed:` line after the fact, while `onOutput` goes onto the
   * install log the panel is streaming, among the lines that stopped arriving.
   *
   * Only a Docker that went quiet, deliberately. Every other way these calls can
   * fail — an image that will not pull, a name already taken — already reaches
   * the operator through the failure the installation reports, and echoing those
   * here would print them twice.
   */
  const announcing = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error: unknown) {
      if (error instanceof DockerUnansweredError) {
        onOutput(`[Hopper] ${error.message}`);
      }

      throw error;
    }
  };

  let container: Dockerode.Container;
  let stream: Duplex;

  try {
    container = await announcing(
      docker.api.createContainer(
        installCreateOptions({
          configuration,
          install,
          environment,
          volumePath,
          scriptDirectory,
          networkName,
        }),
      ),
    );

    stream = (await announcing(
      container.attach({ stream: true, stdout: true, stderr: true }),
    )) as unknown as Duplex;
  } catch (error: unknown) {
    // The script directory is removed by the `finally` at the bottom of this
    // function, and neither of these two failures has entered its `try` yet.
    // Without this, every installation a wedged Docker refused would leave a
    // directory in the daemon's tmp that nothing ever comes back for.
    await rm(scriptDirectory, { recursive: true, force: true });
    throw error;
  }

  const windowMs = install.inactivityTimeoutMs ?? INSTALL_INACTIVITY_DEFAULT_MS;
  const teardown = dockerDeadline(
    DOCKER_ANSWER_TIMEOUT_MS,
    `Docker did not take the install container down within ` +
      `${describeDuration(DOCKER_ANSWER_TIMEOUT_MS)}. This node's Docker is not answering; the ` +
      'container may still be running on it.',
  );

  /**
   * The teardown `abandonContainer` is carrying out, once the deadline has asked
   * for one.
   *
   * Held on to for one reason: the removal near the bottom of this function has
   * to be able to wait for a removal that is already under way rather than start
   * a second one. Both used to run — that one the moment the wait came back,
   * this one from a timer — so on **every** stall the install container was sent
   * two concurrent `DELETE`s, and Docker refuses the loser with 409 "removal
   * already in progress". {@link failureOf} does not excuse a 409, and should
   * not: 409 is also how Docker refuses a removal for reasons worth printing. So
   * what the console said, on every stall, was that the container was still on
   * the node — in the same breath as Docker was removing it. A line reporting a
   * failure that did not happen is precisely what teaches an operator to stop
   * reading the lines that did.
   *
   * It starts as a promise that has already settled so that this is one variable
   * rather than a promise beside a flag. Nothing ever awaits that first value:
   * the only path that awaits this is the one where the deadline fired, and the
   * deadline firing is the only thing that assigns it.
   */
  let abandoning: Promise<void> = Promise.resolve();

  const watchdog = new ActivityWatchdog(windowMs, (report) => {
    describeStall(report, windowMs).forEach(onOutput);
    // Armed before the teardown is asked for, not after: the wait below is the
    // thing this bounds, and it is blocked from this instant on a container that
    // may never end. `stop` and `remove` need nothing from here — every request
    // `DockerClient` makes carries its own deadline.
    teardown.arm();
    // Not awaited *here*, because this runs from a timer and there is nobody to
    // await it. What the teardown produces is the thing the wait below is
    // blocked on — the container ending — and every way it can fail is reported
    // from inside.
    abandoning = abandonContainer(container, onOutput, 'install container');
  });

  // A second signal, and the one that does the work. See
  // `INSTALL_INACTIVITY_DEFAULT_MS`: the scripts in this repository download
  // with `curl -sSL`, which prints nothing at all for the duration of a
  // transfer, so a deadline fed only by the stream below would give a 2 GiB
  // modpack the whole window to finish in.
  //
  // `one-shot` because this wants the counters as they stand, not a rate: with
  // `stream: false` alone Docker holds the request open for a collection cycle
  // to fill in `precpu_stats`, which is a field nothing here reads.
  const probe = new ContainerActivityProbe(
    () => container.stats({ stream: false, 'one-shot': true }),
    (moved) => {
      // Every sample that came back is a witness, whether or not it moved: the
      // verdict has to be able to distinguish a container that stood still from
      // one nobody could look at. Only movement pushes the deadline back.
      watchdog.noteObservation();

      if (moved) {
        watchdog.noteActivity();
      }
    },
    activitySamplePeriod(windowMs),
  );

  const assembler = new LineAssembler();
  // The container has no tty, so what arrives is framed rather than plain — see
  // `Tty: false` in `installCreateOptions`, which is there because SteamCMD
  // will not install through a terminal.
  const frames = new DockerFrameReader();
  stream.on('data', (chunk: Buffer) => {
    // Before the assembly, and this ordering is the feature: bytes are the
    // evidence the container is alive, and a line is only ever the evidence that
    // one of them was a terminator. A depot download whose uplink has gone bad
    // spends minutes writing a single frame of its progress bar — see
    // {@link ActivityWatchdog} — and that is a stream of chunks with no completed
    // line in it, which a deadline pushed back by lines would kill while it was
    // working.
    watchdog.noteActivity();

    for (const line of assembler.push(frames.push(chunk))) {
      onOutput(line);
    }
  });

  // Armed before the start rather than after it, and the ordering is the whole
  // of what this line buys: a container is covered from the moment it was told
  // to run, which includes the stretch while Docker is still thinking about the
  // request. Armed after, a `start` that took ten minutes to be acknowledged
  // would hand the container that comes out of it a fresh window it has done
  // nothing to earn. How long Docker itself may take over that request is a
  // different question with a different figure, asked one line below. The probe
  // goes the other way round: there are no counters to read from a container
  // that has not been started.
  watchdog.arm();

  /**
   * Closes the wait below when anything but the wait ends the race.
   *
   * Losing that race abandons a `container.wait()` that is still outstanding,
   * and `wait` is the one request `boundEveryRequest` deliberately does not
   * bound — so without this, nothing in the process would ever close it. One
   * socket to the Docker daemon per stalled installation, held until hopperd is
   * restarted, on precisely the node that is already in trouble.
   */
  const abandonedWait = new AbortController();

  try {
    await announcing(container.start());
    probe.start();

    let exitCode: number;

    try {
      // Unbounded on the left, and that is the design: an installation proving
      // itself alive may take hours. Bounded on the right from the moment the
      // deadline fires, because `stop`, `remove` and `wait` all fail together on
      // a wedged overlay mount, and waiting for that one out is the daemon
      // hanging in the code written to stop it hanging.
      exitCode = await Promise.race([
        waitForExit(container, abandonedWait.signal),
        teardown.reached,
      ]);
    } catch (error: unknown) {
      // A Docker that will not answer at all is this node's failure and is
      // reported as one. Folding it into an exit code would describe a container
      // that is very possibly still running as an installation that merely
      // failed, and the operator would never go looking for it.
      //
      // Said on the install console as well as thrown, because the two land in
      // different places: the throw becomes one `Installation failed:` line
      // after the fact, while this appears where the operator is already
      // watching, among the lines that stopped arriving.
      if (error instanceof InstallationError || error instanceof DockerUnansweredError) {
        onOutput(`[Hopper] ${error.message}`);
        throw error;
      }

      // A wait that failed because the deadline tore its container down is not a
      // Docker fault, and reporting it as one would bury the reason under
      // "no such container".
      if (watchdog.expiry === null) {
        throw error;
      }

      exitCode = -1;
    } finally {
      // In the `finally` so that a container's last words reach the console even
      // when this is on its way out through a throw: they are usually the reason.
      assembler.flush().forEach(onOutput);
      // Whichever side won, nothing here reads the wait's answer any more. On
      // the side where the wait lost it is still open against a container that
      // may never end, and this is the only thing left that could close it; on
      // the side where it won there is no request to abort and this costs a
      // function call.
      abandonedWait.abort();
    }

    // Stood down **here**, the moment the container has finished, rather than
    // left to the `finally` at the bottom. What follows this line is the
    // ownership reclaim, which runs a second container for as long as a
    // `chown -R` over a full volume takes — and across it nothing could push
    // this deadline back: the install container is about to be removed, so its
    // `stats` call answers 404 and the probe contributes nothing, and its attach
    // stream is closed, so no output arrives either. Left armed, it fired in the
    // middle of a **successful** installation, printed "Giving up on it: the
    // install container is being stopped and removed" over a container that had
    // already exited 0, and then returned `{ successful: true }`. The reclaim
    // brings a deadline of its own; see {@link reclaimOwnership}.
    watchdog.disarm();
    probe.stop();

    // **Removed once, whichever path got here.** A deadline that fired means
    // `abandonContainer` is already removing this container, so this waits for
    // that removal instead of sending a second `DELETE` after it — see
    // `abandoning` above for what the second one used to print. Waited on rather
    // than merely skipped, because the removal that is happening reports its own
    // failure, and that report belongs on the console before this installation
    // is over rather than after it.
    //
    // On every other path the removal is this line, bounded by the client like
    // every other question put to Docker and no longer raced here: a `remove`
    // that never returns wedges the server's operation queue exactly as
    // thoroughly after an installation that worked as after one that hung.
    if (watchdog.expiry !== null) {
      await abandoning;
    } else {
      const leftBehind = await failureOf(container.remove({ force: true }));

      if (leftBehind !== null) {
        // Said rather than swallowed, which it used to be. The container holds a
        // name this server's next installation will ask for, and the layer of a
        // modpack it just unpacked; nobody comes back for it, and the operator
        // finds out at the next reinstall if they are told nothing now.
        onOutput(
          `[Hopper] Docker would not remove the install container: ${leftBehind}. It is still on ` +
            'this node — `docker ps -a` on the node will say, and it is safe to remove by hand.',
        );
      }
    }

    const expiry = watchdog.expiry;

    if (expiry !== null) {
      // Thrown rather than returned as a failed exit code, so the console says
      // what happened instead of `Installation failed (code 137)` — a code the
      // deadline produced itself, from a kill nobody but this daemon asked for.
      // The state the server lands in is the same either way: `install_failed`,
      // reported to the panel, with a Reinstall to retry from.
      //
      // What the reason names is not the same, and the operator acts on it. A
      // deadline that fired without a single counter sample coming back saw
      // nothing at all: saying the installation did nothing would send somebody
      // looking at their install script when the thing to look at is the Docker
      // daemon that stopped reporting on the container.
      throw new InstallationError(
        expiry.observed
          ? `The installation did nothing for ${describeDuration(expiry.idleMs)} and was stopped.`
          : `This installation could not be watched at all — this node's Docker reported no ` +
              'counters for its container and the container printed nothing — so it was stopped ' +
              `after ${describeDuration(expiry.idleMs)}.`,
      );
    }

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
        windowMs,
      });
    }

    return { successful: exitCode === 0, exitCode };
  } finally {
    // Everything armed above is unwound here on the paths that do not reach the
    // lines that unwind it themselves — a `container.start()` that throws used to
    // leave the deadline armed on a container that never ran, producing an
    // `abandonInstall` and three console lines a quarter of an hour after the
    // failure, and the script directory behind it in the daemon's tmp with
    // nothing that would ever come back for it. All three of these are
    // idempotent, so the ordinary path standing them down early costs nothing
    // here.
    watchdog.disarm();
    probe.stop();
    teardown.disarm();
    // Docker keeps this socket open as long as anybody holds it, and on the
    // paths where the container is never removed nobody else would close it.
    stream.destroy();
    await rm(scriptDirectory, { recursive: true, force: true });
  }
}

/**
 * Waits for a container to finish and returns its exit code.
 *
 * `Container.wait()` is typed `any` by dockerode: the typing is closed back
 * here rather than letting that value circulate. A missing code becomes -1,
 * which will be treated as a failure — the right default when in doubt.
 *
 * **The signal is required rather than optional, and that is the point of it.**
 * Both callers race this against a deadline, and both used to abandon the loser
 * without cancelling it. `wait` is the one request `boundEveryRequest` leaves
 * unbounded — it answers when the container ends, which for a *server* is its
 * whole life — so an abandoned one is a socket to the Docker daemon that nothing
 * in this process will ever close again. Making the parameter mandatory is what
 * stops a third caller being written that quietly leaks another.
 *
 * `docker-modem` forwards `abortSignal` to `http.request` as `signal`, and
 * strips it back out of the query string, so this reaches the socket without
 * reaching the URL.
 */
async function waitForExit(
  container: { wait: (options: { abortSignal: AbortSignal }) => Promise<unknown> },
  abandoned: AbortSignal,
): Promise<number> {
  const result = (await container.wait({ abortSignal: abandoned })) as { StatusCode?: unknown };
  return typeof result?.StatusCode === 'number' ? result.StatusCode : -1;
}

/**
 * Takes down a container the deadline has given up on.
 *
 * The stopping is the point. A deadline that gave up on *waiting* while leaving
 * the container downloading would be worse than no deadline at all: the server
 * would sit in `install_failed` — a state the panel refuses every action in —
 * while the thing it was installing carried on writing into its volume and
 * pulling on the node's network, with nothing left watching it and nothing left
 * that would ever remove it.
 *
 * `stop` first, so a script that traps SIGTERM gets to unlink its half-written
 * archive, and so `wait` returns an exit code rather than a rejection. Then a
 * forced removal regardless of how that went: `stop` fails on a Docker that has
 * stopped answering, and that is precisely the case where leaving the container
 * behind matters most.
 *
 * Both calls come back either way. Neither is raced here, because both are
 * requests to Docker and `DockerClient` bounds every one of those — a `stop` that
 * would once have hung this function for the life of the daemon now rejects after
 * a minute and is reported on the line below it. The grace period is added to
 * that minute rather than eaten out of it, so the SIGTERM really does get its
 * {@link INSTALL_ABANDON_GRACE_SECONDS}.
 *
 * Both failures are *said*, which they were not. Swallowing them silently is
 * defensible for the control flow — there is nothing this function could do
 * differently — and indefensible for the operator, because the outcome it hides
 * is a container still running on their node, writing into a volume whose server
 * now reads `install_failed`. A wedged overlay mount produces exactly that, and
 * it produces it in the same breath as the hang {@link runInstallation} bounds
 * separately: these two lines are how anyone finds out which of the two happened.
 *
 * **This is the only removal on the path it runs on, and both callers keep the
 * promise it returns so that it stays that way.** They each have an ordinary
 * teardown of their own that removes the container once the wait has come back,
 * and for a while both fired: two concurrent `DELETE`s for one container, of
 * which Docker refuses the second with 409 "removal already in progress" — a
 * code {@link failureOf} does not excuse, and rightly, because 409 is also how
 * Docker refuses removals for reasons worth printing. So the duplicate request
 * is gone rather than the complaint about it, and what the console says about
 * the removal is now what happened to the one removal there was.
 *
 * `subject` names the container in both lines because there are two of them now
 * — the installation's and the ownership reclaim's — and "the container may
 * still be running" is a sentence an operator has to be able to act on.
 */
async function abandonContainer(
  container: Dockerode.Container,
  onOutput: (line: string) => void,
  subject: string,
): Promise<void> {
  const stopFailure = await failureOf(container.stop({ t: INSTALL_ABANDON_GRACE_SECONDS }));

  if (stopFailure !== null) {
    onOutput(`[Hopper] Docker would not stop the ${subject}: ${stopFailure}`);
  }

  const removeFailure = await failureOf(container.remove({ force: true }));

  if (removeFailure !== null) {
    onOutput(
      `[Hopper] Docker would not remove the ${subject} either: ${removeFailure}. It may ` +
        'still be running on this node — `docker ps` on the node will say, and it is safe to ' +
        'remove by hand.',
    );
  }
}

/**
 * How a teardown failed, or `null` if it did not — including the two ways of not
 * failing that Docker spells as errors.
 *
 * 304 is "already stopped" and 404 is "already gone", and both are races this
 * function will genuinely lose: the container can exit of its own accord in the
 * moment between the deadline firing and the `stop` reaching the socket. Neither
 * is worth a line on somebody's console, and printing one would teach an
 * operator to ignore the two lines above that do matter.
 */
async function failureOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error: unknown) {
    const status = (error as { statusCode?: unknown } | null)?.statusCode;

    if (status === 304 || status === 404) {
      return null;
    }

    return error instanceof Error ? error.message : String(error);
  }
}

export interface DockerDeadline {
  /**
   * Rejects once {@link arm} has been called and the timeout has passed.
   *
   * **Read afresh for every race, never held across one.** A deadline that has
   * fired is spent, and the next {@link arm} puts a new promise here; a caller
   * holding the old one is holding a promise that has already rejected, which
   * would settle its race the instant it started whatever Docker did.
   */
  readonly reached: Promise<never>;
  arm(): void;
  disarm(): void;
}

/** One arming's promise, and the handle that rejects it. */
interface DeadlineAttempt {
  promise: Promise<never>;
  fail: (error: Error) => void;
  /** True once {@link fail} has been called: this attempt cannot be reused. */
  spent: boolean;
}

/**
 * A deadline for the one call `DockerClient` deliberately leaves unbounded.
 *
 * **There is exactly one thing this is still for**, and the shrinking is the
 * point. Every request to Docker is now bounded once, at the client — see
 * `boundEveryRequest` — so create, attach, start, stop, remove and the rest need
 * nothing here and no longer have it. What the client cannot bound is
 * `container.wait()`: it answers when the container ends, which for an
 * installation may be hours and for a server is its whole life, and a timeout on
 * it would report every long-running server as a crash.
 *
 * That leaves one gap, which is this: the moment this daemon has *decided* to
 * kill a container, the wait stops being a wait for work and becomes a wait for
 * a teardown. A wedged overlay mount makes `stop` fail, `remove` fail and `wait`
 * never return, all at once — so without this the daemon hangs in precisely the
 * code written to stop it hanging. Both callers therefore arm this only from
 * the instant their activity deadline has given up.
 *
 * `message` is given in full by the caller because it is read by an operator on
 * a console: it has to name which container and which question, and only the
 * caller knows.
 *
 * **Reusable, and it was not.** One deadline object still bounds two waits in a
 * row on the reclaim's path, and the first version of this built one rejected
 * promise for the whole of its life. A rejected promise stays rejected: once the
 * deadline had fired once, `arm` hung a fresh timer over a promise that had
 * already settled, and every later `Promise.race` against `reached` lost
 * immediately, on a Docker that was answering perfectly. So a single wedge
 * anywhere in an installation poisoned every bounded call that came after it,
 * and the failure it invented was a Docker fault reported against a healthy
 * node. Each arming therefore gets an attempt of its own, and a spent one is
 * replaced rather than re-used.
 *
 * `arm` restarts the clock even when a timer is already pending, for the same
 * reason: what it promises is *this* call the whole window, not whatever an
 * earlier arming happened to leave of it.
 */
export function dockerDeadline(timeoutMs: number, message: string): DockerDeadline {
  let timer: NodeJS.Timeout | null = null;
  let attempt: DeadlineAttempt | null = null;

  /** The deadline as it stands, replaced once it has rejected. */
  const live = (): DeadlineAttempt => {
    if (attempt !== null && !attempt.spent) {
      return attempt;
    }

    let fail: (error: Error) => void = () => undefined;
    const promise = new Promise<never>((_, reject) => {
      fail = reject;
    });

    // Handled the moment it exists, and only then raced. Nothing may reach this
    // promise before a caller starts racing it, and a rejection with no handler
    // attached is a process Node takes down — turning a bounded teardown into a
    // daemon that dies, which is worse than the hang it replaces.
    promise.catch(() => undefined);

    attempt = { promise, fail, spent: false };
    return attempt;
  };

  return {
    get reached(): Promise<never> {
      return live().promise;
    },
    arm(): void {
      const current = live();

      if (timer !== null) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = null;
        // Marked before it rejects, so that the next read of `reached` — which
        // may well come from the very handler this rejection is about to run —
        // gets an attempt that can still be lost rather than one already lost.
        current.spent = true;
        current.fail(new InstallationError(message));
      }, timeoutMs);
      timer.unref();
    },
    disarm(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** An error as the console lines below want it. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses an installation the node has not got the room for.
 *
 * The check is the daemon's and not the panel's because only the node knows what
 * is left on its own disk: the panel accounts for what it has *promised*, which
 * is a different number and deliberately allowed to exceed the machine.
 *
 * Not knowing is not a refusal. `statfs` can fail on a filesystem Node cannot
 * describe, and refusing every installation on such a node would be a far larger
 * failure than the one being guarded against — so it says so on the console and
 * carries on, which leaves an operator something to search for if the disk does
 * fill.
 *
 * The volume is measured only when the measurement can change the answer, and
 * that is a deliberate piece of miserliness rather than a micro-optimisation.
 * {@link directorySize} walks every file under the mount: on the modpack this
 * guard exists for that is tens of thousands of `lstat` calls and takes seconds,
 * paid before the operator sees a single line of their install. It is only ever
 * the difference between refusing and allowing when free space alone is already
 * short of what the template declared — so a first install onto an empty volume,
 * and every install with room to spare, never pays it at all.
 */
async function assertDiskSpace(options: {
  install: { requiredDiskBytes?: number };
  volumePath: string;
  onOutput: (line: string) => void;
}): Promise<void> {
  const { install, volumePath, onOutput } = options;

  const freeBytes = await freeSpaceBytes(volumePath);

  if (freeBytes === null) {
    onOutput(
      `[Hopper] Could not read the free space on the filesystem holding ${volumePath}: ` +
        'installing anyway, without the usual check that this node has room for it.',
    );
    return;
  }

  const declaredBytes = install.requiredDiskBytes;
  const shortOfDeclared = declaredBytes !== undefined && freeBytes < declaredBytes;
  const reclaimableBytes = shortOfDeclared ? await directorySize(volumePath) : 0;

  const refusal = diskRefusal({ freeBytes, reclaimableBytes, declaredBytes, path: volumePath });

  if (refusal === null) {
    // An installation allowed through on space that is not free yet is a
    // surprising thing to have happened silently, and the day it turns out to
    // have been the wrong call this line is the only record of the decision.
    if (shortOfDeclared) {
      onOutput(
        `[Hopper] Only ${formatBytes(freeBytes)} free on the filesystem holding ${volumePath}, ` +
          `but this server's volume already holds ${formatBytes(reclaimableBytes)} that this ` +
          'installation writes over. Carrying on.',
      );
    }

    return;
  }

  refusal.lines.forEach(onOutput);

  throw new InstallationError(refusal.reason);
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

/** How the reclaim container is named on the console, in both its failures. */
const RECLAIM_SUBJECT = 'ownership reclaim container';

/**
 * Hands the installed files back to the server's uid, under a deadline.
 *
 * **Bounded in every direction, which it was not.** This is the statement
 * immediately after the one the whole inactivity deadline exists to guard, and
 * until now it was the identical construct being eliminated: `createContainer`,
 * `start()`, a bare `waitForExit(container)` and `remove()`, not one of them with
 * a deadline of any kind. It matters more here than almost anywhere, because
 * `install()` is enqueued on the server's operation queue — so a `chown -R` that
 * never returns takes that queue with it **for ever**: no start, no stop, no
 * reinstall for that server until hopperd is restarted, and nothing in the panel
 * to say why.
 *
 * Three of those four are now bounded by nothing written here at all: they are
 * requests to Docker, and `DockerClient` bounds every request it makes. What is
 * left for this function to arrange is the fourth — the wait for the `chown` to
 * finish — and a `chown -R` is exactly the shape the activity deadline suits. It
 * is slow over a modpack — hundreds of thousands of entries — but it is never
 * *still*: it walks the tree with a syscall per entry, which is CPU time on every
 * one of them and block I/O on every directory that has to come off the disk. So
 * it proves itself alive the same way an installation does, and a total-duration
 * cap would have to be sized for the largest volume on the node, which is the
 * mistake {@link INSTALL_INACTIVITY_DEFAULT_MS} was written to avoid.
 *
 * It is given the installation's own window. A template that says its install may
 * stand still for an hour is describing this node's disks as much as its mirrors,
 * and one figure an operator can reason about beats a second one they never knew
 * they had.
 *
 * **The counters are this deadline's only witness, and that is why a failed
 * sample is not stillness.** There is no attach stream on this container — a
 * `chown -R` prints nothing until it fails, and a verbose one would print a
 * million lines — so unlike the installation's, this deadline has no second
 * signal to fall back on. A `stats` request that Docker will not answer therefore
 * used to look exactly like a `chown` that had stopped, and gave up on a healthy
 * one. Two things changed. A sample that *hangs* no longer blinds the probe for
 * good, because the client bounds it and the next one goes out a period later, so
 * a hiccup now costs nothing at all. And a window in which no sample at all came
 * back is reported as what it is — see {@link StallReport.observed}.
 *
 * The container is still given up on in that case, and the argument for it is the
 * asymmetry rather than any evidence: a reclaim nobody can watch would otherwise
 * hold this server's operation queue for ever, while giving up on one costs a
 * console line and files that may still belong to root, over an installation that
 * succeeds either way. What changes is that the operator is told this node's
 * Docker went quiet rather than told a `chown` stood still, because only one of
 * those two sends them to the right place.
 *
 * **A reclaim that fails does not fail the installation, however it failed.**
 * That is this function's contract and not a property of how it happens to be
 * written: it returns nothing and cannot throw, which is why the work sits in
 * {@link attemptReclaim} — a function whose failures are a return value.
 *
 * It was already so for a `chown` that exited non-zero and for one that stood
 * still. It now holds for the third case too, which used to throw and take a
 * finished installation down with it: a Docker that will not create the
 * container, will not start it, or stops answering in the middle of it. The
 * inconsistency was worth removing on its own — the same node-level fault failed
 * the installation if it landed on `createContainer` and did not if it landed on
 * the wait — but the direction it was resolved in is the deliberate part.
 *
 * By the time this runs the install script has exited 0: the files are on the
 * disk, the download that took an hour is spent, and the only thing missing from
 * them is an owner. Failing the installation over that puts the server in
 * `install_failed`, a state the panel refuses every action in, and the only way
 * out of it is a Reinstall that downloads the lot again — against a Docker that
 * is, by hypothesis, not answering and will refuse that too. Nothing is
 * recovered and an hour is thrown away. Reporting it instead costs one console
 * line and leaves the files where they are, ready for the same repair to be run
 * again when the node is healthy.
 *
 * What that trades away is worth naming: a server marked installed whose volume
 * may still belong to root, which surfaces later as a process unable to write
 * its own configuration. The line at the end is the only warning of it, which is
 * why it names that consequence rather than the Docker call that produced it.
 */
async function reclaimOwnership(
  docker: DockerClient,
  options: {
    image: string;
    volumePath: string;
    ownership: { uid: number; gid: number };
    build: ServerConfiguration['build'];
    onOutput: (line: string) => void;
    /** The window the installation itself was given. */
    windowMs: number;
  },
): Promise<void> {
  const failure = await attemptReclaim(docker, options);

  if (failure !== null) {
    options.onOutput(
      `[Hopper] Taking ownership of the files failed (${failure}). The server may not be able to ` +
        'write into its volume.',
    );
  }
}

/**
 * The reclaim itself, reporting how it failed instead of throwing.
 *
 * `Promise<string | null>` rather than `Promise<void>` is the whole point: the
 * verdict {@link reclaimOwnership} documents is enforced by the signature, so a
 * later hand adding a fourth Docker call here cannot fail an installation whose
 * files are already in place without first changing this return type.
 */
async function attemptReclaim(
  docker: DockerClient,
  options: {
    image: string;
    volumePath: string;
    ownership: { uid: number; gid: number };
    build: ServerConfiguration['build'];
    onOutput: (line: string) => void;
    /** The window the installation itself was given. */
    windowMs: number;
  },
): Promise<string | null> {
  const { onOutput, windowMs } = options;

  // The one call in here the client cannot bound: `container.wait()` answers when
  // the chown ends, and this is armed only once the activity deadline has decided
  // it never will. See {@link dockerDeadline}.
  const deadline = dockerDeadline(
    DOCKER_ANSWER_TIMEOUT_MS,
    `Docker did not answer about the ${RECLAIM_SUBJECT} within ` +
      `${describeDuration(DOCKER_ANSWER_TIMEOUT_MS)}. This node's Docker is not answering.`,
  );

  /** What went wrong, in the shape the one message above wants. */
  let failure: string | null = null;
  let created: Dockerode.Container | null = null;

  try {
    // Nothing raced here any more. Both are requests to Docker, and every request
    // `DockerClient` makes carries its own deadline — a Docker that takes the
    // create and goes quiet rejects on its own after a minute, with a message
    // that names the endpoint.
    created = await docker.api.createContainer(reclaimCreateOptions(options));

    await created.start();
  } catch (error: unknown) {
    failure = messageOf(error);
  }

  // A `const` because the closures below capture it, and because it is the one
  // question that decides what is left to do: nothing was created, so there is
  // nothing to watch, nothing to wait on and nothing to remove.
  const container = created;

  if (container === null) {
    return failure;
  }

  if (failure !== null) {
    // Created but never started. The chown has not run and cannot, so the wait
    // below would block on a container that will never exit — but the container
    // is on the node and is removed like any other.
    return await removeReclaimContainer(container, onOutput, failure);
  }

  /** The teardown the deadline asked for; see {@link runInstallation} for why. */
  let abandoning: Promise<void> = Promise.resolve();

  const watchdog = new ActivityWatchdog(windowMs, (report) => {
    onOutput(
      report.observed
        ? `[Hopper] Taking ownership of the files has done nothing for ` +
            `${describeDuration(report.idleMs)} — no CPU, no disk I/O. Giving up on it: the ` +
            `${RECLAIM_SUBJECT} is being stopped and removed.`
        : `[Hopper] This node's Docker has not reported the ${RECLAIM_SUBJECT}'s counters once ` +
            `in the last ${describeDuration(report.idleMs)}, so there is no way to tell whether ` +
            'taking ownership of the files is working. Giving up on it: the container is being ' +
            'stopped and removed, because one nobody can watch cannot be left holding this ' +
            "server's every later action.",
    );
    deadline.arm();
    abandoning = abandonContainer(container, onOutput, RECLAIM_SUBJECT);
  });

  const probe = new ContainerActivityProbe(
    () => container.stats({ stream: false, 'one-shot': true }),
    (moved) => {
      // The only witness this deadline has: see the note on
      // {@link reclaimOwnership} for why a sample that never came back must not
      // be read as a `chown` standing still.
      watchdog.noteObservation();

      if (moved) {
        watchdog.noteActivity();
      }
    },
    activitySamplePeriod(windowMs),
  );

  watchdog.arm();
  probe.start();

  const stalled = (report: StallReport): string =>
    report.observed
      ? `it stood still for ${describeDuration(report.idleMs)} and was stopped`
      : `its counters could not be read at all, so it was stopped after ` +
        `${describeDuration(report.idleMs)} with no way to tell whether it was working`;

  /** As in {@link runInstallation}: the wait that loses this race is closed. */
  const abandonedWait = new AbortController();

  try {
    const exitCode = await Promise.race([
      waitForExit(container, abandonedWait.signal),
      deadline.reached,
    ]);

    // The deadline is read before the exit code, because on that path the code
    // is one this daemon produced itself: the container was killed, and
    // reporting 137 would describe the symptom rather than the decision.
    if (watchdog.expiry !== null) {
      failure = stalled(watchdog.expiry);
    } else if (exitCode !== 0) {
      failure = `code ${exitCode}`;
    }
  } catch (error: unknown) {
    if (error instanceof InstallationError || error instanceof DockerUnansweredError) {
      // A Docker that has stopped answering is named as such even when the
      // deadline gave up first: "it stood still" describes the chown, and the
      // operator's problem is one layer below that.
      failure = error.message;
    } else if (watchdog.expiry !== null) {
      failure = stalled(watchdog.expiry);
    } else {
      failure = messageOf(error);
    }
  } finally {
    watchdog.disarm();
    probe.stop();
    // The deadline is only ever armed by the watchdog above, and a `chown` that
    // finished a second later leaves that arming outstanding. Harmless — its
    // rejection is handled where it is created — but a timer nobody is waiting
    // on is a thing to explain later rather than a thing to leave.
    deadline.disarm();
    abandonedWait.abort();
  }

  // Removed once, exactly as in {@link runInstallation}: where the deadline gave
  // up, `abandonContainer` is already removing this container and this waits for
  // that removal rather than racing a second one against it. The docstring on
  // `removeReclaimContainer` used to claim Docker answered 404 on this path; it
  // answers 409, so every stalled reclaim ended on a console line saying a
  // container still had this server's volume mounted when it did not.
  if (watchdog.expiry !== null) {
    await abandoning;
    return failure;
  }

  return await removeReclaimContainer(container, onOutput, failure);
}

/**
 * Removes the reclaim container and passes the verdict through untouched.
 *
 * Bounded like every other request, by the client, so there is nothing to arm
 * here. Never called on the path where the activity deadline gave up:
 * `abandonContainer` owns the removal there, and its caller waits on that one
 * rather than sending a second `DELETE` for Docker to refuse.
 *
 * A removal that fails does not become the reclaim's verdict: it is a second,
 * separate thing to tell the operator — the container has the server's volume
 * mounted — and overwriting `failure` with it would lose the reason the chown
 * did not happen.
 */
async function removeReclaimContainer(
  container: Dockerode.Container,
  onOutput: (line: string) => void,
  failure: string | null,
): Promise<string | null> {
  const leftBehind = await failureOf(container.remove({ force: true }));

  if (leftBehind !== null) {
    onOutput(
      `[Hopper] Docker would not remove the ${RECLAIM_SUBJECT}: ${leftBehind}. It has the ` +
        "server's volume mounted, so it is worth clearing by hand before the server starts.",
    );
  }

  return failure;
}

/**
 * Clears a container this server's previous installation left behind.
 *
 * The failure swallowed here is nearly always "no such container", which is the
 * normal case and the reason there is a `catch` at all. A Docker that will not
 * answer lands here too and is swallowed with it — deliberately, because there is
 * nothing useful to say at this point that the `createContainer` two lines later
 * will not say better and with the operator's attention. It is not lost either:
 * `DockerClient` logs every request it abandons, on the node, with the endpoint.
 */
async function removeIfExists(docker: DockerClient, name: string): Promise<void> {
  try {
    await docker.api.getContainer(name).remove({ force: true });
  } catch {
    // Absent: that is the normal case.
  }
}

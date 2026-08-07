import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONSOLE_BUFFER_LINES } from '@hopper/shared';
import type {
  PowerAction,
  ResourceUsage,
  ServerConfiguration,
  ServerState,
  StatusReport,
  StopConfiguration,
} from '@hopper/shared';
import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import type { DockerClient } from '../docker/client.js';
import { buildContainerOptions, containerNameFor } from '../docker/container-config.js';
import type { DiskQuota } from '../fs/jailed-filesystem.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { JailedFilesystem } from '../fs/jailed-filesystem.js';
import { applyConfigFiles } from './config-writer.js';
import { announcesReady, resolveReadiness, type ResolvedReadiness } from './readiness.js';
import { RconError, rconDeliver, rconExecute } from './rcon.js';
import { describeRconFailure, dialHost, rconPassword, resolveRconTarget } from './rcon-target.js';
import { installContainerName } from './installer.js';
import { ConsoleBuffer, LineAssembler } from './console-buffer.js';
import { InvocationError, substitute } from './invocation.js';
import { directorySize } from './disk-usage.js';
import { runInstallation } from './installer.js';
import { buildResourceUsage, emptyUsage, type DockerStats } from './stats.js';

/** Minimum delay between two walks of the volume, in milliseconds. */
const DISK_MEASURE_INTERVAL_MS = 60_000;

/**
 * Marks what came back over RCON, so it cannot be mistaken for the server's own
 * output.
 *
 * Distinct from `[Hopper]` because the two are different things: that prefix is
 * the daemon talking *about* the server, this one is the server talking, on a
 * channel with no other way onto the console. Unmarked, an answer would appear
 * among the container's log lines as though the server had printed it — and on
 * these games the server prints nothing, so the console would show output whose
 * timing and origin nobody could account for.
 */
const RCON_CONSOLE_PREFIX = '[RCON]';

/**
 * A duration as the operator reads it, for the console.
 *
 * Readiness deadlines are configured in milliseconds because that is what the
 * waits are written in, and "600000ms" in a console line is a number nobody
 * converts in their head before deciding whether it was long enough.
 */
function seconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)}s`;
}

export interface ServerInstanceEvents {
  state: (state: ServerState) => void;
  console: (line: string) => void;
  stats: (usage: ResourceUsage) => void;
  install_started: () => void;
  install_output: (line: string) => void;
  install_completed: (successful: boolean) => void;
}

/**
 * Typed events.
 *
 * `EventEmitter` accepts any event name with any arguments: a typo in
 * `on('stat', …)` would compile and the dashboard would stay empty without an
 * error. This overload makes the server's events checkable.
 *
 * Declaration/class merging is the only way to get there with `EventEmitter`;
 * it is safe here because the interface only narrows methods already present on
 * the base class.
 */
/* eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging */
export declare interface ServerInstance {
  on<K extends keyof ServerInstanceEvents>(event: K, listener: ServerInstanceEvents[K]): this;
  off<K extends keyof ServerInstanceEvents>(event: K, listener: ServerInstanceEvents[K]): this;
  emit<K extends keyof ServerInstanceEvents>(
    event: K,
    ...args: Parameters<ServerInstanceEvents[K]>
  ): boolean;
}

export interface ServerInstanceOptions {
  configuration: ServerConfiguration;
  docker: DockerClient;
  logger: Logger;
  volumesRoot: string;
  networkName: string;
  ownership: { uid: number; gid: number };
  timezone: string;
  enableBlkioWeight: boolean;
  /** Temporary directory, where the install script is dropped. */
  tmpPath: string;
  panel: PanelClient;
}

/**
 * A Minecraft server, as the daemon sees it.
 *
 * Holds the state, the container, the console stream and the resource samples.
 * All the sequencing logic (do not start twice, wait for the stop before
 * recreating) lives here rather than in the HTTP routes: the WebSocket, the
 * scheduler and the API all have to go through the same guards.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the event overload above
export class ServerInstance extends EventEmitter {
  private state: ServerState = 'offline';
  private readonly console = new ConsoleBuffer();
  private readonly assembler = new LineAssembler();

  private stream: Duplex | null = null;
  private statsStream: NodeJS.ReadableStream | null = null;
  private startedAt: number | null = null;

  /** Last measurement of the volume, and when it was taken. */
  private diskBytes = 0;
  private diskMeasuredAt = 0;
  private diskWalk: Promise<unknown> | null = null;

  /**
   * Serialises power actions.
   *
   * Two quick clicks on "Restart" would otherwise launch two concurrent
   * sequences, one recreating the container while the other stops it.
   */
  private operation: Promise<unknown> = Promise.resolve();

  private readiness: ResolvedReadiness;

  /**
   * Set when this daemon gave up on a start and stopped the server itself.
   *
   * Read by the exit handler, which would otherwise report the stop that
   * follows as a perfectly ordinary one — the container went down cleanly,
   * after all — and hide the failure that caused it behind a "server stopped"
   * notification.
   */
  private abandonedStart = false;

  /**
   * The start attempt in flight, aborted the moment the server leaves
   * `starting` — however it leaves.
   *
   * A readiness wait belongs to the attempt that armed it and to nothing else.
   * Without that ownership a wait outlives its attempt: the container dies
   * fifty milliseconds into a four-hundred-millisecond deadline, the operator
   * starts the server again, and the timer armed by the dead attempt fires
   * into the live one and stops a server that was starting perfectly well.
   * Every abandoned wait also left its `state` listener behind, so a server
   * restarted often enough accumulated one per crashed start.
   */
  private startAttempt: AbortController | null = null;

  constructor(private options: ServerInstanceOptions) {
    super();
    this.readiness = this.resolvedReadiness();
  }

  get uuid(): string {
    return this.options.configuration.uuid;
  }

  get configuration(): ServerConfiguration {
    return this.options.configuration;
  }

  /**
   * Disk allowance, as the file manager and SFTP enforce it.
   *
   * `usedBytes` is the last periodic measurement, not a live walk — see
   * `DiskQuota`. Read through a function so a jail built for one request keeps
   * seeing the figure move.
   */
  get diskQuota(): DiskQuota {
    return { usedBytes: this.diskBytes, limitBytes: this.options.configuration.build.diskBytes };
  }

  get currentState(): ServerState {
    return this.state;
  }

  get volumePath(): string {
    return join(this.options.volumesRoot, this.uuid);
  }

  /**
   * Sample for a stopped server, for a client that just connected.
   *
   * A stopped server emits no statistics — the page would stay without figures,
   * including for disk space, which is very much still occupied.
   */
  get idleUsage(): ResourceUsage {
    this.refreshDiskUsage();
    return emptyUsage(this.state, this.diskBytes);
  }

  private get logger(): Logger {
    return this.options.logger;
  }

  updateConfiguration(configuration: ServerConfiguration): void {
    this.options = { ...this.options, configuration };

    // Re-resolved, not carried over. The strategy was compiled once in the
    // constructor, so until now a readiness the operator had just corrected in
    // the panel did nothing until hopperd was restarted — the daemon went on
    // watching for the old pattern with the old deadline. That was merely a
    // server that hung for longer than it should while `readiness` could only
    // hang one; it now stops the server when a deadline the operator has
    // already fixed expires, which is a correction that makes things worse
    // until the process is bounced.
    this.readiness = this.resolvedReadiness();
  }

  /**
   * Compiles the readiness strategy of the configuration currently held.
   *
   * A function rather than an inline expression in the two places that need
   * it, so the pattern-warning callback cannot drift between the start of a
   * server's life and a configuration sync in the middle of it.
   */
  private resolvedReadiness(): ResolvedReadiness {
    return resolveReadiness(this.options.configuration, (pattern, error) =>
      this.logger.warn(
        { server: this.uuid, pattern, err: error },
        'Invalid readiness pattern: it is ignored, the others still apply',
      ),
    );
  }

  consoleSnapshot(): string[] {
    return this.console.snapshot();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private setState(state: ServerState): void {
    if (this.state === state) {
      return;
    }

    this.logger.debug({ server: this.uuid, from: this.state, to: state }, 'State change');
    this.state = state;

    if (state === 'running' && this.startedAt === null) {
      this.startedAt = Date.now();
      this.reportStatus({ state: 'running', at: this.startedAt, expected: true, oomKilled: false });
    } else if (state === 'offline') {
      this.startedAt = null;
    }

    this.emit('state', state);

    // Leaving `starting` ends the attempt, whichever way it left: promoted,
    // crashed, stopped by the operator. Everything the attempt armed comes
    // down with it — the deadline timer and the `state` listener behind it —
    // so nothing it left running can reach into the next attempt. After the
    // emit, so a wait watching for `running` still gets to see the transition
    // it was waiting for before its signal is pulled.
    if (state !== 'starting') {
      this.startAttempt?.abort();
      this.startAttempt = null;
    }
  }

  /** A line emitted by Hopper, distinct from the server's own output. */
  private emitDaemonLine(message: string): void {
    this.emitConsoleLine(`[Hopper] ${message}`);
  }

  /**
   * Puts a line on the console, whoever it came from.
   *
   * Buffered *and* emitted, which is the half worth naming: a line only emitted
   * reaches the consoles that happen to be open at that instant and nobody
   * else. A scheduled task runs at four in the morning with nobody watching,
   * and whether it worked has to still be readable at nine.
   */
  private emitConsoleLine(line: string): void {
    this.console.push(line);
    this.emit('console', line);
  }

  private handleOutput(chunk: Buffer | string): void {
    const lines = this.assembler.push(chunk.toString('utf8'));

    for (const line of lines) {
      this.console.push(line);
      this.emit('console', line);

      // The `starting` → `running` switch happens here: it is the server itself
      // that announces it accepts connections.
      if (this.state === 'starting' && announcesReady(this.readiness, line)) {
        this.setState('running');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Container
  // -------------------------------------------------------------------------

  private container(): Dockerode.Container {
    return this.options.docker.api.getContainer(containerNameFor(this.uuid));
  }

  async containerExists(): Promise<boolean> {
    try {
      await this.container().inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates the container, removing the old one if needed.
   * The volume is never touched: that is where the server's data lives.
   */
  async createContainer(): Promise<void> {
    await mkdir(this.volumePath, { recursive: true });

    if (await this.containerExists()) {
      this.logger.debug({ server: this.uuid }, 'Removing the previous container');
      await this.container()
        .remove({ force: true })
        .catch((error: unknown) => {
          this.logger.warn({ server: this.uuid, err: error }, 'Container removal failed');
        });
    }

    const options = buildContainerOptions({
      configuration: this.options.configuration,
      volumePath: this.volumePath,
      networkName: this.options.networkName,
      ownership: this.options.ownership,
      timezone: this.options.timezone,
      enableBlkioWeight: this.options.enableBlkioWeight,
      // An argument the template wrote and the built command has not got. It
      // goes where the operator is already looking when a server behaves oddly
      // on a port or a flag they configured — the console — because nothing
      // else would ever tell them the argv is not the one they are reading.
      onWarning: (message) => this.emitDaemonLine(message),
    });

    await this.options.docker.pullImage(this.options.configuration.container.image, (line) =>
      this.emitDaemonLine(line),
    );

    await this.options.docker.api.createContainer(options);
    this.logger.info({ server: this.uuid }, 'Container created');
  }

  /**
   * Attaches to the container's input/output stream.
   *
   * Done before `start()`: attaching afterwards would lose the first lines,
   * startup errors among them — precisely the ones worth seeing.
   */
  /**
   * Settles an installation whose daemon died underneath it.
   *
   * An install runs inside a promise chain held by this process. Restart the
   * daemon halfway — an update does exactly that — and the chain dies with it:
   * nobody reports success, nobody reports failure, and the panel keeps the
   * row at INSTALLING for ever. Seen twice on real hardware in one evening,
   * both times during a panel update.
   *
   * The evidence outlives the process. A finished installation removes its
   * container, so one still lying around is an installation that never got to
   * finish, and its exit code is the verdict nobody delivered.
   *
   * Reported as a failure whatever the code says. A zero here means the script
   * ran, not that the daemon finished the work that follows it — the container
   * still had to be built and the ownership reclaimed, and neither happened.
   * Calling that a success would hand the operator a READY server with no
   * container behind it, which is worse than asking them to press Reinstall.
   */
  private async resolveOrphanedInstall(): Promise<boolean> {
    const name = installContainerName(this.uuid);

    let exitCode: number;

    try {
      const info = await this.options.docker.api.getContainer(name).inspect();

      if (info.State.Running) {
        // Still going, started by a daemon that is gone. Nothing here can
        // adopt its output, so it is stopped rather than left to finish into a
        // volume nobody is watching.
        this.logger.warn({ server: this.uuid }, 'Installation still running from a dead daemon');
      }

      exitCode = info.State.ExitCode;
    } catch {
      // No leftover container: the normal case by far.
      return false;
    }

    this.logger.warn(
      { server: this.uuid, exitCode },
      'Installation interrupted by a daemon restart: reporting it as failed',
    );

    await this.options.docker.api
      .getContainer(name)
      .remove({ force: true })
      .catch(() => undefined);

    this.setState('install_failed');
    await this.reportInstall(false);

    return true;
  }

  /**
   * Fills the console buffer from what the container has already printed.
   *
   * Attaching streams what a container says next, never what it has said. So
   * after hopperd restarts — an update, a crash, a reboot — the buffer starts
   * empty, and an operator opening the console of a server that has been up for
   * an hour sees a blank rectangle. A quiet Minecraft server can stay blank for
   * hours, which reads as a broken console rather than a silent one.
   *
   * Docker still has the output; it is only this process that forgot. Bounded
   * to the buffer's own size, because a server running for weeks has a log
   * measured in hundreds of megabytes and none of it belongs in memory.
   *
   * Best effort throughout. A console missing its history is a nuisance; a
   * daemon that refuses to adopt a running server because it could not read a
   * log file is an outage.
   */
  private async primeConsoleFromLogs(): Promise<void> {
    try {
      const logs = await this.container().logs({
        stdout: true,
        stderr: true,
        follow: false,
        tail: CONSOLE_BUFFER_LINES,
      });

      // `follow: false` resolves with the whole body. The containers run with a
      // TTY, so the bytes are the terminal's own output — no stream
      // multiplexing to unpick.
      const text = Buffer.isBuffer(logs) ? logs.toString('utf8') : String(logs);

      // Its own assembler: this text ends mid-line as often as not, and the
      // live one is about to receive the container's next byte. Sharing it
      // would glue the tail of the history onto the head of the new output.
      const assembler = new LineAssembler();
      const lines = [...assembler.push(text), ...assembler.flush()];

      for (const line of lines) {
        this.console.push(line);
      }

      // Nothing is emitted to connected clients: there are none yet. A client
      // that connects afterwards receives this buffer as its snapshot, which is
      // the path that was always meant to carry the history.
      this.logger.debug(
        { server: this.uuid, lines: lines.length },
        'Console history recovered from the container',
      );
    } catch (error: unknown) {
      this.logger.warn(
        { server: this.uuid, err: error },
        'Could not recover the console history: the console will start empty',
      );
    }
  }

  /**
   * Applies the template's `configFiles` to the volume.
   *
   * Never fatal. A server that starts with a stale port is a server someone can
   * fix; a server that refuses to start because a comment in its YAML confused
   * a rewriter is a server nobody can fix from the panel. Both outcomes are
   * said on the console, because the operator is the one who has to notice.
   */
  private async writeConfigFiles(): Promise<void> {
    const files = this.options.configuration.configFiles;

    if (files.length === 0) {
      return;
    }

    const jail = new JailedFilesystem({
      root: this.volumePath,
      denylist: this.options.configuration.fileDenylist,
      quota: () => this.diskQuota,
      // `chown` does not exist on Windows, where development happens — and
      // where there is no container to own the files anyway.
      ownership: process.platform === 'win32' ? undefined : this.options.ownership,
    });

    const context = {
      environment: this.options.configuration.environment,
      memoryMib: Math.floor(this.options.configuration.build.memoryBytes / (1024 * 1024)),
      // The named ports travel here too, so a `configFiles` replacement can
      // write the port an operator named into the server's own configuration —
      // the same variables the startup command reads, resolved the same way.
      allocations: this.options.configuration.allocations,
    };

    const unresolved = new Set<string>();

    try {
      const reports = await applyConfigFiles(jail, files, (input) => {
        // Collected, never fatal. A value written here is a line in the
        // server's own configuration, not an argument to its process: an empty
        // one leaves a stale port in `server.properties`, which somebody can
        // see and fix, whereas refusing the start over it would leave nobody
        // able to fix anything. But it is not left silent either — an empty
        // `{{server.allocations.rcon.port}}` writes `rcon.port=` and the server
        // then listens somewhere nobody expects.
        const { value, missing } = substitute(input, context);
        missing.forEach((name) => unresolved.add(name));

        return value;
      });

      if (unresolved.size > 0) {
        this.emitDaemonLine(
          `The configuration files name ${[...unresolved].map((name) => `{{${name}}}`).join(', ')}, which this server has not got: those values were written empty.`,
        );
      }

      for (const report of reports) {
        if (report.skipped) {
          this.logger.debug(
            { server: this.uuid, file: report.file, reason: report.skipped },
            'Configuration file left alone',
          );

          // Silent for a file that simply is not there yet — that is the
          // normal state before the first install — and loud for anything
          // else, because the rest means the operator's file could not be read.
          if (report.skipped !== 'file not present') {
            this.emitDaemonLine(`Could not update ${report.file}: ${report.skipped}`);
          }

          continue;
        }

        if (report.changed > 0) {
          this.emitDaemonLine(`Updated ${report.file}`);
        }
      }
    } catch (error: unknown) {
      this.logger.error({ server: this.uuid, err: error }, 'Configuration rewrite failed');
      this.emitDaemonLine(
        `Could not update the configuration files: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Tells the panel how the install ended.
   *
   * Never throws. The verdict is worth an entry in the log if it cannot be
   * delivered, but a report that fails must not turn a successful install into
   * a failed one — nor stop a failed install from being recorded as failed.
   */
  private async reportInstall(successful: boolean): Promise<void> {
    try {
      await this.options.panel.reportInstall(this.uuid, successful);
    } catch (error: unknown) {
      this.logger.error(
        { server: this.uuid, successful, err: error },
        'Install report failed: the panel still believes this server is installing',
      );
    }
  }

  /**
   * Knocks on the server's port until something answers.
   *
   * For workloads that announce nothing on their console. Deliberately a plain
   * connect and close: what is being asked is whether anything is listening,
   * and a daemon that spoke each game's query protocol to find out would be a
   * daemon that has to know what game it runs.
   *
   * Only ever promotes the attempt it was armed for. A server that stopped,
   * crashed or was restarted while this was waiting must not be dragged back
   * to `running` — nor stopped — by a check belonging to a start that is over.
   */
  private async waitForPort(attempt: AbortController): Promise<void> {
    const readiness = this.readiness;

    if (readiness.type !== 'port') {
      return;
    }

    // Whichever port the strategy named, resolved when the strategy was — not
    // the primary one, which is only what an unnamed strategy resolves to. A
    // role that matched nothing never reaches here: it came back `unsupported`
    // and the start took that branch instead.
    const { ip, port } = readiness;

    // The grace period runs *before* the clock starts, not against it. The two
    // fields read as separate quantities — one is how long to leave the process
    // alone, the other how long to keep knocking — and nothing cross-validates
    // them, so a template declaring `delayMs: 60000, timeoutMs: 30000` would
    // otherwise sleep past its own deadline, never open a single socket, and
    // fail the start with a message about a connection that was never
    // attempted.
    if (readiness.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, readiness.delayMs));
    }

    // No declared deadline means the wait is open-ended, as every wait was
    // before deadlines existed: the loop then ends only when the attempt does.
    const deadline = readiness.timeoutMs === null ? Infinity : Date.now() + readiness.timeoutMs;

    while (!attempt.signal.aborted && Date.now() < deadline) {
      if (await this.portAccepts(dialHost(ip), port)) {
        if (!attempt.signal.aborted) {
          this.setState('running');
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (readiness.timeoutMs === null) {
      return;
    }

    this.failStart(
      attempt,
      `Nothing accepted a connection on port ${port} within ${seconds(readiness.timeoutMs)}.`,
    );
  }

  /**
   * Logs in over RCON until the server accepts, which is the truest readiness
   * signal there is: a server answers only once it is serving.
   *
   * A refused password, or a variable holding no password at all, is not "not
   * ready yet": it will be just as refused in two seconds and in ten minutes.
   * Both fail the start on the spot rather than making somebody wait out a
   * deadline for an answer that was already in.
   */
  private async waitForRcon(attempt: AbortController): Promise<void> {
    const readiness = this.readiness;

    if (readiness.type !== 'rcon') {
      return;
    }

    // The same lookup the stop transport makes, and deliberately not a second
    // one: a readiness check that logs in and a stop that cannot would be two
    // components disagreeing about where this server's password lives, with
    // neither message saying they were meant to agree.
    const secret = rconPassword(this.options.configuration.environment, readiness.secretVariable);

    if ('refusal' in secret) {
      this.failStart(attempt, `This server's readiness check cannot run: ${secret.refusal}.`);
      return;
    }

    // The RCON port when the strategy named one, the primary port otherwise —
    // and this is the case names were built for: RCON almost never listens on
    // the game's own port, so before this the handshake went to the game and
    // failed until the deadline stopped a healthy server.
    const { ip, port } = readiness;
    const host = dialHost(ip);
    const password = secret.password;
    // Open-ended when the template declared no deadline: see `waitForPort`.
    const deadline = readiness.timeoutMs === null ? Infinity : Date.now() + readiness.timeoutMs;

    while (!attempt.signal.aborted && Date.now() < deadline) {
      try {
        await rconExecute({ host, port, password });

        if (!attempt.signal.aborted) {
          this.setState('running');
        }

        return;
      } catch (error: unknown) {
        if (error instanceof RconError && error.message.includes('refused the password')) {
          this.failStart(
            attempt,
            'RCON refused the password: this server cannot be checked for readiness.',
          );
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (readiness.timeoutMs === null) {
      return;
    }

    this.failStart(
      attempt,
      `The server never answered on RCON within ${seconds(readiness.timeoutMs)}.`,
    );
  }

  /**
   * Waits for the console to say the words, and gives up if it never does.
   *
   * The promotion itself happens in `handleOutput`, line by line; all this does
   * is put a bound on how long the daemon believes a start that never
   * announced itself. Armed only when the template asked for one — a
   * configuration carrying the deprecated `startupDetection`, or a `log`
   * strategy naming no deadline, waits for ever exactly as it did before this
   * existed.
   */
  private async waitForLog(attempt: AbortController): Promise<void> {
    const readiness = this.readiness;

    if (readiness.type !== 'log' || readiness.timeoutMs === null) {
      return;
    }

    if (await this.waitForState('running', readiness.timeoutMs, attempt.signal)) {
      return;
    }

    // The wait can also end because the attempt did — the container died, the
    // operator stopped it. Only a genuine expiry gets to fail a start, and
    // only the start this deadline was armed for: without the signal, a wait
    // whose server had crashed went on ticking and fired its verdict into
    // whatever attempt happened to be in `starting` when it did.
    if (attempt.signal.aborted) {
      return;
    }

    this.failStart(
      attempt,
      `The server printed nothing matching its startup pattern within ${seconds(readiness.timeoutMs)}.`,
    );
  }

  /**
   * Abandons a start that never became ready.
   *
   * All three waits can end without an answer: the pattern never printed,
   * nothing ever accepted a connection, RCON never let us in. Each of them used
   * to say so on the console and leave the state at `starting`, where it stayed
   * until somebody happened to look — a permanent spinner in the panel over a
   * server that was either dead or perfectly fine, with nothing to tell the two
   * apart and no state change to notify anybody about.
   *
   * So a start is failed the way an installation is failed: the server ends in
   * a state the panel shows, and the panel is told the stop was nobody's idea,
   * which is what turns it into a notification rather than a line in a console
   * nobody has open.
   *
   * The container is stopped rather than left running behind that verdict. A
   * server the panel reports as down while it is quietly taking players is the
   * worse of the two lies, and the deadline is the template's own: reaching it
   * means the operator asked to be told, on this workload, after this long.
   */
  private failStart(attempt: AbortController, reason: string): void {
    // The attempt is what this verdict applies to, and an aborted one means
    // the wait was overtaken — the server was promoted by another signal, the
    // operator stopped it, or the process died on its own and the exit handler
    // has already had its say. The state alone would not tell: a server
    // started again since is back in `starting`, and stopping it here would
    // punish the new attempt for the previous one's silence.
    if (attempt.signal.aborted || this.state !== 'starting') {
      return;
    }

    this.abandonedStart = true;

    this.emitDaemonLine(reason);
    this.emitDaemonLine('Giving up on this start: the server is being stopped.');
    this.logger.warn({ server: this.uuid, reason }, 'Start abandoned: readiness never confirmed');

    // Queued rather than run here: this wait is a background promise nobody
    // awaits, and stopping outside the queue would let it cross a restart the
    // operator asked for in the meantime.
    void this.enqueue(async () => {
      // Re-checked inside the queue, which this may have spent seconds waiting
      // in: whatever ran before it may already have resolved the start, or
      // ended this attempt and begun another one that must not be stopped by
      // a verdict passed on its predecessor.
      if (attempt.signal.aborted || this.state !== 'starting') {
        return;
      }

      await this.doStop();
    }).catch((error: unknown) => {
      // The stop itself failed: no console stream to write to, Docker refusing
      // the signal. Killing is the only thing left that moves the state out of
      // `stopping`, and leaving it stuck there would be the same hang under a
      // different name.
      this.logger.error(
        { server: this.uuid, err: error },
        'Could not stop an abandoned start: killing it instead',
      );

      return this.doKill().catch(() => undefined);
    });
  }

  private portAccepts(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host, port, timeout: 2000 });
      const settle = (accepted: boolean) => {
        socket.destroy();
        resolve(accepted);
      };

      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.once('timeout', () => settle(false));
    });
  }

  private async attach(): Promise<void> {
    if (this.stream) {
      return;
    }

    // Hand-rolled attach rather than dockerode's `container.attach()`: see the
    // comment on `DockerClient.attachToContainer`, which explains why the
    // library's version injects its own options into stdin.
    //
    // The handshake is bounded and the stream that comes out of it is not, which
    // is the distinction that matters here: this daemon adopts running servers
    // when it starts, and a quiet server prints nothing for hours. See
    // `boundEveryRequest` for why no deadline anywhere reaches an open stream.
    const stream = await this.options.docker.attachToContainer(containerNameFor(this.uuid));

    stream.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    stream.on('error', (error: Error) => {
      this.logger.warn({ server: this.uuid, err: error }, 'Console stream interrupted');
    });
    stream.on('end', () => {
      this.assembler.flush().forEach((line) => {
        this.console.push(line);
        this.emit('console', line);
      });
      this.stream = null;

      // The end of the stream signals the process stopped, including a crash
      // nobody asked for. Docker is then queried for the cause: a server that
      // disappears without explanation is the worst case for whoever runs it.
      const wasStopping = this.state === 'stopping';

      void this.explainExit(wasStopping).then((exit) => {
        this.reportStatus({
          state: 'offline',
          at: Date.now(),
          // A requested stop, or a `/stop` typed by a player — code 0 — is
          // expected. Everything else is not, and deserves to be reported.
          //
          // A start this daemon gave up on is never expected, however cleanly
          // the process then went down: the stop was Hopper's decision, taken
          // because the server never became ready, and reporting it as an
          // ordinary one would bury the only notification saying so.
          expected: !this.abandonedStart && (wasStopping || exit.exitCode === 0),
          exitCode: exit.exitCode,
          oomKilled: exit.oomKilled,
          // Named, because `expected: false` alone puts this stop under the
          // panel's one hardcoded sentence — "the process stopped on its own"
          // — beside the exit code of the SIGTERM this daemon had just sent.
          // The operator was being told to investigate a crash that never
          // happened, by the one notification meant to save them the search.
          ...(this.abandonedStart ? { cause: 'readiness_failed' as const } : {}),
        });
      });

      this.setState('offline');
      this.stopStatsStream();
    });

    this.stream = stream;
  }

  /**
   * Explains in the console why the process stopped.
   *
   * The case that matters is running out of memory: the kernel kills the
   * process without warning, the server logs stop mid-sentence, and nothing
   * says what happened. The operator concludes their plugin crashed and spends
   * hours looking in the wrong place.
   */
  private async explainExit(
    wasStopping: boolean,
  ): Promise<{ oomKilled: boolean; exitCode: number | undefined }> {
    let info: Awaited<ReturnType<Dockerode.Container['inspect']>> | null = null;

    try {
      info = await this.container().inspect();
    } catch {
      // Container already removed: nothing to explain.
    }

    if (info?.State.OOMKilled) {
      const limitMib = Math.floor(this.options.configuration.build.memoryBytes / (1024 * 1024));

      this.emitDaemonLine(
        `The server was killed by the kernel for running out of memory (limit: ${limitMib} MiB).`,
      );
      // Says nothing about what the server runs. This line reaches the console
      // of every workload the daemon hosts, and a Factorio operator told to
      // check their Minecraft version has been handed a false lead by the one
      // message that was supposed to save them from looking in the wrong place.
      this.emitDaemonLine(
        'Raise the memory allocated to this server: what it is running needs more than this limit.',
      );

      this.logger.warn(
        { server: this.uuid, limitMib },
        'Server killed by the kernel for running out of memory',
      );
      return { oomKilled: true, exitCode: info.State.ExitCode };
    }

    const code = info?.State.ExitCode;

    if (wasStopping) {
      return { oomKilled: false, exitCode: code };
    }

    this.emitDaemonLine(
      code === undefined || code === 0
        ? 'The server process stopped.'
        : `The server process stopped (code ${code}).`,
    );

    return { oomKilled: false, exitCode: code };
  }

  /**
   * Reports a state change to the panel.
   *
   * Without waiting or retrying: this information feeds outgoing notifications,
   * and a momentarily unreachable panel must neither delay nor prevent anything
   * on this machine.
   */
  private reportStatus(report: StatusReport): void {
    void this.options.panel.reportStatus(this.uuid, report).catch((error: unknown) => {
      this.logger.debug({ server: this.uuid, err: error }, 'Status report not delivered');
    });
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  private async startStatsStream(): Promise<void> {
    if (this.statsStream) {
      return;
    }

    // Bounded up to the response and not past it, like the console stream above:
    // Docker sends a sample a second while the container runs and stops sending
    // the moment it does not, and a deadline over the stream itself would take
    // the statistics of every idle server offline on a timer.
    const stream = await this.container().stats({ stream: true });
    const assembler = new LineAssembler();

    stream.on('data', (chunk: Buffer) => {
      // Docker sends one JSON object per line; an object can be split across
      // two packets, hence the reassembly.
      for (const line of assembler.push(chunk.toString('utf8'))) {
        if (line.trim() === '') {
          continue;
        }

        try {
          const stats = JSON.parse(line) as DockerStats;
          this.refreshDiskUsage();
          this.emit(
            'stats',
            buildResourceUsage(stats, {
              state: this.state,
              startedAt: this.startedAt,
              diskBytes: this.diskBytes,
            }),
          );
        } catch {
          // A line truncated by the stream closing has no reason to make noise.
        }
      }
    });

    stream.on('error', () => this.stopStatsStream());
    stream.on('end', () => {
      this.statsStream = null;
    });

    this.statsStream = stream;
  }

  private stopStatsStream(): void {
    // The stats stream is a `ReadableStream` with no declared `destroy`, even
    // though the Node implementation provides one: without it, the HTTP
    // connection to Docker would stay open after every server stop.
    const stream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = this.statsStream;
    stream?.destroy?.();
    this.statsStream = null;
    this.emit('stats', emptyUsage(this.state, this.diskBytes));
  }

  /**
   * Updates the size of the volume, at most once per interval.
   *
   * Docker does not measure the space taken by a mount: the tree has to be
   * walked. On a modded server it holds tens of thousands of files — doing it
   * on every stats sample, that is once a second, would keep the disk busy
   * permanently for a figure that moves by a few megabytes a minute.
   *
   * The measurement does not block emission: the current sample carries the
   * previous value, and the next one will carry the new one.
   */
  private refreshDiskUsage(): void {
    if (this.diskWalk !== null || Date.now() - this.diskMeasuredAt < DISK_MEASURE_INTERVAL_MS) {
      return;
    }

    this.diskWalk = directorySize(this.volumePath)
      .then((bytes) => {
        this.diskBytes = bytes;
      })
      .catch(() => {
        // Volume missing or unreadable: keep the last known value rather than
        // announce an empty disk.
      })
      .finally(() => {
        // The timestamp is set at the **end**: on a huge volume the measurement
        // can take longer than the interval, and counting from the start would
        // chain walks without respite.
        this.diskMeasuredAt = Date.now();
        this.diskWalk = null;
      });
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /**
   * Installs the server, then creates its runtime container.
   *
   * Queued like a power action: a reinstall requested during a start has to
   * wait, not overwrite the files under the feet of a JVM reading them.
   */
  async install(startOnCompletion: boolean): Promise<void> {
    // Whether the reinstall got far enough to have changed anything.
    //
    // Read by the catch at the end, which otherwise reports every failure as an
    // installation that failed — including one that never began.
    let began = false;

    return this.enqueue(async () => {
      // A running server has to be stopped first: reinstalling under a live
      // process is guaranteed to corrupt something.
      //
      // A refused stop aborts the reinstall before anything is touched, and it
      // does so *without* moving the server out of the state it is in. Letting
      // the refusal escape into the catch below would set `install_failed` on a
      // server whose container is still up and serving players — and the panel
      // refuses every power action in that state, including the Kill the
      // daemon's own refusal line has just told the operator to use. That is a
      // server nobody can touch from the interface, produced by a safety check
      // doing its job.
      if (this.state === 'running' || this.state === 'starting') {
        try {
          await this.doStop();
        } catch (error) {
          this.emitDaemonLine(
            'Reinstallation cancelled: the server could not be stopped, and nothing has been changed.',
          );
          throw error;
        }
      }

      began = true;
      this.setState('installing');
      this.console.clear();
      this.emit('install_started');
      this.emitDaemonLine('Installing the server…');

      let successful = false;

      try {
        const result = await runInstallation(this.options.docker, {
          configuration: this.options.configuration,
          volumePath: this.volumePath,
          tmpPath: this.options.tmpPath,
          ownership: this.options.ownership,
          networkName: this.options.networkName,
          onOutput: (line) => {
            this.console.push(line);
            this.emit('console', line);
            this.emit('install_output', line);
          },
        });

        successful = result.successful;

        if (!successful) {
          this.emitDaemonLine(`Installation failed (code ${result.exitCode}).`);
        }
      } catch (error: unknown) {
        this.logger.error({ server: this.uuid, err: error }, 'Installation failed');
        this.emitDaemonLine(
          `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      this.emit('install_completed', successful);
      this.setState(successful ? 'offline' : 'install_failed');

      if (!successful) {
        // Reported on the way out, not only on the way through. This used to
        // return here, and the only `reportInstall(false)` sat in an outer
        // `.catch` that the inner one above made unreachable — so a server
        // whose install script failed stayed INSTALLING in the panel for ever,
        // with no reinstall route to retry from.
        await this.reportInstall(false);
        return;
      }

      this.emitDaemonLine('Installation finished. Preparing the container…');
      await this.createContainer();

      // Reported to the panel before starting: this is what moves the server
      // from INSTALLING to READY in the interface. A failed report must not
      // prevent the server from starting.
      await this.reportInstall(true);

      if (startOnCompletion) {
        await this.doStart();
      }
    }).catch(async (error: unknown) => {
      // Anything that escaped the block above — the container could not be
      // built, the image could not be pulled. The panel still has to be told,
      // or the row stays INSTALLING.
      //
      // A startup command naming something that does not resolve is said out
      // loud here as well as on the start path, and it is the install that
      // needs it more: the script has just run to completion, every line of it
      // scrolled past, and the failure arrives after the only output the
      // operator was watching. Without this the install log ends on a success
      // and the server lands in `install_failed` with nothing anywhere saying
      // which variable was wrong — the message names the port to create or the
      // variable to declare, and it would have gone only to hopperd's log.
      if (error instanceof InvocationError) {
        this.emitDaemonLine(error.message);
        this.emit('install_output', error.message);
      }

      // A reinstall that never began leaves the server exactly where it was.
      // Reporting it as a failed installation would be a lie with teeth: the
      // panel refuses every power action in `install_failed`, so a server that
      // is up and serving players becomes one nobody can stop from the
      // interface — over a stop that was refused precisely to avoid touching
      // it. The caller still gets the rejection, and the console still carries
      // the reason.
      if (!began) {
        throw error;
      }

      this.setState('install_failed');
      await this.reportInstall(false);
      throw error;
    });
  }

  // -------------------------------------------------------------------------
  // Power actions
  // -------------------------------------------------------------------------

  /** Queues an action so it never crosses another. */
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    // The chain must not break on a failure, otherwise every later action would
    // be rejected with the previous one's error.
    this.operation = next.catch(() => undefined);
    return next;
  }

  async power(action: PowerAction): Promise<void> {
    return this.enqueue(async () => {
      switch (action) {
        case 'start':
          return this.doStart();
        case 'stop':
          return this.doStop();
        case 'restart':
          await this.doStop();
          return this.doStart();
        case 'kill':
          return this.doKill();
      }
    });
  }

  private async doStart(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      this.emitDaemonLine('The server is already started.');
      return;
    }

    if (this.options.configuration.suspended) {
      throw new Error('This server is suspended.');
    }

    // A fresh attempt: the verdict on the previous one must not colour how this
    // one's eventual stop is reported.
    this.abandonedStart = false;

    // Opened before the state moves, so that everything armed below belongs to
    // this attempt and dies with it. `setState` ends an attempt on the way out
    // of `starting`, so there is nothing here to inherit — the abort is belt
    // and braces against a path that forgot to leave the state behind it.
    this.startAttempt?.abort();
    const attempt = new AbortController();
    this.startAttempt = attempt;

    this.setState('starting');
    this.console.clear();
    this.emitDaemonLine('Starting the server…');

    // Before the container, because the container publishes the allocated port
    // on both sides: a server whose own configuration still names another one
    // is unreachable, and the panel would show it as running at an address
    // nobody can connect to.
    await this.writeConfigFiles();

    if (this.options.configuration.container.requiresRebuild || !(await this.containerExists())) {
      this.emitDaemonLine('Building the container…');

      try {
        await this.createContainer();
      } catch (error: unknown) {
        // A command that cannot be built is a start that ends here: nothing was
        // created, nothing will ever exit, and no wait has been armed. The
        // state moved to `starting` a few lines ago, and leaving it there is
        // the spinner-for-ever this daemon spent PR #59 getting rid of — a
        // server the panel shows as starting, with the reason for the refusal
        // only in hopperd's log, on the machine the operator has no shell on.
        //
        // Only this error, deliberately. Every other way `createContainer` can
        // fail — an image that will not pull, a Docker that says no — leaves
        // the same spinner and always has; that is a hole worth closing, but
        // not by widening this catch until it swallows failures whose meaning
        // nobody here has established.
        if (error instanceof InvocationError) {
          this.emitDaemonLine(error.message);
          this.setState('offline');
        }

        // Rethrown either way: the caller asked for a start and did not get
        // one, and a `power` call that waits has to hear about it.
        throw error;
      }
    }

    await this.attach();
    await this.container().start();
    await this.startStatsStream();

    // Exhaustive on purpose: a strategy nobody handles here is a server left in
    // `starting` with nothing running that could ever move it out.
    switch (this.readiness.type) {
      case 'unsupported': {
        // The strategy is still refused — nothing here probes a UDP port. What
        // changed is what refusing costs: this branch used to print a line and
        // leave the state at `starting` for ever, so the server ran, took
        // players, and the panel showed a spinner over it until somebody
        // stopped it. Calling it running is the wrong answer, but it is the
        // wrong answer the operator can see, work with and fix.
        this.emitDaemonLine(
          `This node cannot run this server's readiness check (${this.readiness.reason}).`,
        );
        this.emitDaemonLine(
          'It is being called running now that its container is up, which may be well before it can actually be played on.',
        );
        this.logger.warn(
          { server: this.uuid, reason: this.readiness.reason },
          'Unsupported readiness strategy: the server is called running as soon as its container is up',
        );

        this.setState('running');
        break;
      }

      case 'immediate':
        // Nothing announces itself here, so the container running is the only
        // signal there is — and now it is a choice somebody made rather than a
        // silent default.
        this.setState('running');
        break;

      case 'port':
        this.emitDaemonLine('Waiting for the server to accept connections…');
        void this.waitForPort(attempt);
        break;

      case 'rcon':
        this.emitDaemonLine('Waiting for the server to answer on RCON…');
        void this.waitForRcon(attempt);
        break;

      case 'log':
        // Nothing is announced on the console for this one: the promotion
        // happens in `handleOutput`, and every Minecraft server on every
        // existing installation goes through here. All this arms is the
        // deadline, and only if the template asked for one.
        void this.waitForLog(attempt);
        break;
    }
  }

  /**
   * Clean stop.
   *
   * Sends the template's stop command — down standard input for a Bukkit
   * server, over RCON for a game that reads none — and lets the server save its
   * worlds. An immediate SIGKILL would corrupt map regions.
   */
  private async doStop(): Promise<void> {
    if (this.state === 'offline') {
      return;
    }

    const { stop, stopTimeoutSeconds } = this.options.configuration;

    // RCON delivers *before* the state moves, where the other two deliver
    // after, and that is not tidiness — it is what lets this path refuse.
    // `stopping` is a state only the container can leave, so entering it and
    // then failing to say anything to the server would park the panel on a
    // spinner over a server that is running perfectly well and has been told
    // nothing. Everything that can fail happens while the server is still
    // `running`, and a refusal leaves it exactly there.
    if (stop.type === 'rcon') {
      await this.sendStopOverRcon(stop);
    }

    this.setState('stopping');

    if (stop.type === 'command') {
      this.emitDaemonLine(`Stopping (command "${stop.value}")…`);
      await this.sendCommand(stop.value);
    } else if (stop.type === 'signal') {
      this.emitDaemonLine(`Stopping (signal ${stop.value})…`);
      await this.container().kill({ signal: stop.value });
    }

    const stopped = await this.waitForState('offline', stopTimeoutSeconds * 1000);

    if (!stopped) {
      this.emitDaemonLine(
        `The server did not answer within ${stopTimeoutSeconds}s: killing it. Data loss is possible.`,
      );
      await this.doKill();
    }
  }

  /**
   * Stops the server by sending its own shutdown command over RCON.
   *
   * For the games this transport exists for — Rust, ARK, Palworld, most Source
   * servers — this is the only channel that ends in a save. They read no
   * standard input, so a `command` stop goes into a pipe nobody holds; and a
   * signal is a request the game may handle, ignore, or handle by exiting
   * without writing its world.
   *
   * **A stop that cannot be delivered refuses instead of falling through to the
   * SIGKILL.** That is the decision in this method, and it goes against what
   * every other stop here does, so here is the argument.
   *
   * The existing behaviour — wait `stopTimeoutSeconds`, then kill — is right
   * for a command that was *delivered*. It went down a pipe the process is
   * reading, and a process that then does not exit is one choosing not to; the
   * deadline is the operator's declared patience with that.
   *
   * Every failure that refuses below is a failure to *deliver*, and the four of
   * them are all there are: the role names no port, the variable is empty,
   * nothing accepts a connection, the password is refused. In each the game has
   * been told nothing whatsoever. It is running exactly as it was a second
   * earlier, with its world in memory and no save in progress. So the choice is
   * not "graceful or forceful" — it is between killing a process that was never
   * asked to stop and leaving it alone.
   *
   * Killing it loses everything since the last autosave, which on a game whose
   * save is written on shutdown is the whole session, and it buys nothing: the
   * operator asked for a stopped server and would get a damaged one. Refusing
   * loses nothing at all. The server keeps serving players, the console names
   * the variable or the port to fix, and the stop works on the next attempt.
   *
   * And the forceful answer already exists, one button away and clearly
   * labelled: Kill. An operator who needs the process down now can say so
   * knowing what it costs. What this refuses is to make that the automatic
   * consequence of a mistyped variable name, taken on their behalf, silently.
   *
   * **The line is delivery and not acknowledgement**, and that distinction is
   * the whole of `rconDeliver`. A server that has just executed `quit` answers
   * nothing, closes the socket mid-hangup, or goes quiet until the five-second
   * timeout — those are not three ways of failing, they are the three ordinary
   * shapes of success. Reading them as "the command never left" refused a stop
   * that had in fact been delivered: the game went down because it had been
   * told to, while this method reported that nothing had happened, so nothing
   * waited for the exit, no SIGKILL was armed, `power('restart')` never
   * restarted and `install` marked a server that was going down INSTALL_FAILED.
   *
   * Once the command is on the wire the wait and the SIGKILL after it apply
   * exactly as they do for a stdin command. At that point the server has been
   * asked, is presumably saving, and the deadline is the template's own.
   *
   * Two callers inherit the refusal, and both are better for it. `failStart` is
   * the exception that still kills: it catches a stop that threw and kills
   * instead, because a start being abandoned has nothing worth saving — the
   * server never became ready — and leaving it in `stopping` would be the hang
   * that whole mechanism exists to end. `install` is the other, and there the
   * refusal is the point: a reinstall that cannot stop the server cleanly must
   * not go on to overwrite the files under a live process, which is the only
   * reason it stops the server first.
   */
  private async sendStopOverRcon(
    stop: Extract<StopConfiguration, { type: 'rcon' }>,
  ): Promise<void> {
    const target = resolveRconTarget(this.options.configuration, stop);

    if ('refusal' in target) {
      throw this.rconStopRefused(target.refusal);
    }

    this.emitDaemonLine(`Stopping (RCON "${stop.command}")…`);

    try {
      await rconDeliver(
        { host: target.host, port: target.port, password: target.password },
        stop.command,
        // Late by construction — the stop has already been delivered by the
        // time anything can come back — and worth carrying anyway: a server
        // that has something to say about being shut down says it once, to
        // whoever happens to be watching the console.
        (body) => this.emitRconResponse(body),
      );
    } catch (error: unknown) {
      // A refused password is worth telling apart from an unreachable port, and
      // the console path draws the same distinction in the same words — see
      // `describeRconFailure`.
      throw this.rconStopRefused(describeRconFailure(error, target, stop.secretVariable));
    }
  }

  /**
   * Says why the stop was refused, and returns the error to throw.
   *
   * Returns rather than throws so the caller writes `throw this.…()`: a method
   * that throws in the middle of another one reads as a side effect, and the
   * one thing every caller here needs to be obvious is that nothing after it
   * runs.
   *
   * Two lines, because the first alone leaves the important half unsaid. An
   * operator who reads "RCON refused the password" and nothing else has no way
   * to know whether their server is now down, saving, or untouched — and the
   * answer decides whether they reach for the Kill button.
   *
   * **And the console is not enough.** Both lines are for somebody watching,
   * and the caller that most needs this is the one nobody watches: a nightly
   * schedule with a `stop` step runs at four in the morning, the HTTP request
   * behind it was acknowledged before this ran, and the throw below dies in a
   * log line on the node. The run was then recorded as having succeeded, over a
   * server that is still up and still taking players. So the refusal is also
   * reported to the panel, through the same channel a start abandoned for
   * readiness uses — the only difference being that this one names a state the
   * server never left.
   */
  private rconStopRefused(reason: string): Error {
    const message = `This server could not be stopped over RCON: ${reason}.`;

    this.emitDaemonLine(message);
    this.emitDaemonLine(
      'It is still running and nothing has been killed. Fix that and stop it again — or use Kill, which cuts the process without letting it save.',
    );
    this.logger.warn(
      { server: this.uuid, reason },
      'RCON stop refused: the server is left running',
    );

    this.reportStatus({
      // Where the server actually is, which for every refusal is where it was
      // before the stop was ordered. Reporting `offline` or `stopping` here
      // would be inventing a transition to carry a message, and the panel would
      // then be wrong about the one thing it uses these reports for.
      state: this.state,
      at: Date.now(),
      // Nobody asked for this outcome. The field decides whether a report is
      // routine, and a stop that did not happen is not.
      expected: false,
      oomKilled: false,
      cause: 'stop_refused',
    });

    return new Error(message);
  }

  private async doKill(): Promise<void> {
    this.emitDaemonLine('Killing the container.');

    await this.container()
      .kill({ signal: 'SIGKILL' })
      .catch((error: unknown) => {
        this.logger.debug({ server: this.uuid, err: error }, 'Container already stopped');
      });

    this.setState('offline');
    this.stopStatsStream();
  }

  /**
   * Waits for a state, or times out. Returns `false` on timeout.
   *
   * `signal` is how a caller says the wait has an owner: aborting it settles
   * the promise and, far more importantly, takes down both the timer and the
   * `state` listener. Neither used to be released on any path except the two
   * the wait itself controlled, so a wait whose start died another way left a
   * live timer holding a verdict, and a listener on the emitter for as long as
   * the server existed.
   */
  private waitForState(
    target: ServerState,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.state === target) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const settle = (reached: boolean): void => {
        clearTimeout(timer);
        this.off('state', listener);
        signal?.removeEventListener('abort', onAbort);
        resolve(reached);
      };

      const timer = setTimeout(() => settle(false), timeoutMs);
      const listener = (state: ServerState): void => {
        if (state === target) {
          settle(true);
        }
      };
      const onAbort = (): void => settle(false);

      this.on('state', listener);
      signal?.addEventListener('abort', onAbort, { once: true });

      // A signal already aborted never fires, so the listener above would wait
      // out the full deadline for an owner that is gone.
      if (signal?.aborted) {
        settle(false);
      }
    });
  }

  /**
   * Sends a command to the server, over whichever channel it actually reads.
   *
   * Standard input for a Bukkit server; RCON for a server whose template
   * declared an RCON **stop**. That declaration is the evidence, and it is
   * deliberately not joined by a second field saying the same thing: a template
   * reaches for that stop transport for exactly one reason — the game reads
   * nothing on standard input — and the field already carries the port and the
   * name of the variable holding the password. A separate `commandTransport`
   * would repeat all three, and the day the copies drifted the symptom would be
   * a server that stops perfectly and a console that reaches nobody, with
   * nothing anywhere saying the two were meant to match.
   *
   * **What this did to those servers before is the failure the multi-game work
   * is built around.** The command went down the attach stream into a pty
   * nobody reads, the write succeeded because a write to a socket succeeds, and
   * every caller was told it had worked. A scheduled task running `save-all`
   * and announcing a restart was a no-op the panel recorded as having run.
   *
   * The stdin branch below is untouched, down to the order of its guards: every
   * server on every existing installation goes through it. A write there is
   * still not proof of a read — nothing on a pipe ever is — but it is a pipe
   * chosen by a template that says the game reads it, and those games echo what
   * they were told into a log the console already carries. What this removes is
   * not the uncertainty of stdin; it is the servers that were on stdin while
   * having no reader at all.
   */
  async sendCommand(command: string): Promise<void> {
    const { stop } = this.options.configuration;

    if (stop.type === 'rcon') {
      await this.sendCommandOverRcon(stop, command);
      return;
    }

    if (!this.stream) {
      throw new Error('The server is not started.');
    }

    const sanitized = command.replace(/[\r\n]+/g, ' ').trim();

    if (sanitized === '') {
      return;
    }

    // The newline is added here and the command is stripped of its own: a value
    // containing `\n` would otherwise send several commands at once, which
    // would bypass line-by-line audit logging.
    await new Promise<void>((resolve, reject) => {
      this.stream!.write(`${sanitized}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Sends one command over RCON, and puts the answer where the operator is.
   *
   * **The answer is half the reason this exists.** stdin returns nothing —
   * whatever the server has to say arrives later on its log, if it says
   * anything — so every caller of `sendCommand` was written for a channel with
   * no reply, and dropping RCON's would be worse than the silence it replaces:
   * an operator would type `list`, be told nothing, and still have no way to
   * tell a console that works from the one that has been quietly discarding
   * their commands.
   *
   * It goes on the console rather than back down whatever asked, because only
   * one of the callers has anywhere to put a reply. A WebSocket session does; a
   * scheduled task arriving over HTTP does not, so answering the asker alone
   * would discard every answer to a command nobody was there to type — which is
   * precisely the run nobody is checking. The console is also where a stdin
   * command's answer already lands, for everybody watching rather than only for
   * whoever typed it, so this shows the same thing to the same people as before
   * and widens no permission: these lines ride the `console` event that already
   * carries every byte the server prints.
   *
   * **Every failure to deliver throws**, and that is the point of the method.
   * The role names no port, the variable is empty, the password is refused,
   * nothing accepts the connection: in all four the server has been told
   * nothing at all, and reporting success would be the silent no-op this whole
   * change exists to remove.
   */
  private async sendCommandOverRcon(
    stop: Extract<StopConfiguration, { type: 'rcon' }>,
    command: string,
  ): Promise<void> {
    // The same guard as the stdin path, in the same words. The stream exists
    // exactly while the container is attached, so this keeps one answer to "is
    // there a server to talk to" rather than deriving a second from the state
    // machine — and it beats letting the connection fail with a message about
    // an unreachable port when the truth is that nothing is running.
    if (!this.stream) {
      throw new Error('The server is not started.');
    }

    const sanitized = command.replace(/[\r\n]+/g, ' ').trim();

    if (sanitized === '') {
      return;
    }

    const target = resolveRconTarget(this.options.configuration, stop);

    if ('refusal' in target) {
      throw this.commandUndelivered(sanitized, target.refusal);
    }

    // Delivered, not answered — the same line the stop transport draws, for the
    // same reason. `rconExecute` waits for a reply and calls its absence a
    // failure, which is right for a readiness check and wrong here: plenty of
    // commands answer with nothing, and a server told to `quit` or `save` from
    // the console closes the socket or simply says nothing before the fixed
    // five-second window elapses. Reporting that as "was not delivered" is
    // false in the direction that matters, because a scheduled task would
    // record a failure for a command the server ran — and an operator retrying
    // it would run it twice.
    //
    // A reply that does arrive still reaches the console through `onResponse`;
    // it just is not what decides whether the command left.
    //
    // The echo goes first, so the console reads in the order things happened —
    // the command, then whatever came back, then a refusal if one did. It is
    // echoed at all because on this transport the server logs nothing of its
    // own: without it an operator watches their commands vanish as they type
    // them, and a scheduled task's commands appear nowhere.
    this.emitConsoleLine(`${RCON_CONSOLE_PREFIX} > ${sanitized}`);

    try {
      await rconDeliver(
        { host: target.host, port: target.port, password: target.password },
        sanitized,
        (body) => this.emitRconResponse(body),
      );
    } catch (error: unknown) {
      throw this.commandUndelivered(
        sanitized,
        describeRconFailure(error, target, stop.secretVariable),
      );
    }
  }

  /**
   * Puts whatever the server said on the console, if it said anything.
   *
   * Silence gets no line of its own. It used to earn an `(accepted, no output)`
   * back when an answer was what proved the command had arrived — but delivery
   * is what proves that now, and most shutdown and save commands acknowledge
   * with nothing at all, so the note would appear under almost everything and
   * mean almost nothing. The echo above the answer is what tells an operator
   * their command went; this only carries a reply that exists.
   *
   * The body is reassembled through `LineAssembler` rather than split on
   * newlines, so a multi-line answer gets the same line discipline and the same
   * per-line truncation as the container's output. An RCON body is untrusted
   * server output like any other: one arbitrarily long line is exactly what
   * that cap is for.
   */
  private emitRconResponse(response: string): void {
    if (response.trim() === '') {
      return;
    }

    const assembler = new LineAssembler();

    for (const line of [...assembler.push(response), ...assembler.flush()]) {
      this.emitConsoleLine(`${RCON_CONSOLE_PREFIX} ${line}`);
    }
  }

  /**
   * Says a command never reached the server, and returns the error to throw.
   *
   * Returns rather than throws, as `rconStopRefused` does and for the same
   * reason: the caller writes `throw this.…()`, so nothing after it can be read
   * as still running.
   *
   * Both halves are load-bearing and they are for different people. The console
   * lines are for the operator who is looking; the throw is for the one who is
   * not — it is what turns an undelivered command into an HTTP failure, and an
   * HTTP failure into a named entry in the schedule's audit record. A nightly
   * `save-all` that reached nobody has to end up somewhere a person will
   * eventually read, and a console line at four in the morning is not that.
   */
  private commandUndelivered(command: string, reason: string): Error {
    const message = `The command "${command}" was not delivered: ${reason}.`;

    this.emitDaemonLine(message);
    this.emitDaemonLine(
      'This server takes its commands over RCON, because it reads nothing on standard input. It has not run this one.',
    );
    this.logger.warn({ server: this.uuid, command, reason }, 'Console command not delivered');

    return new Error(message);
  }

  // -------------------------------------------------------------------------

  /** Detaches the streams without touching the container. */
  detach(): void {
    this.stream?.destroy();
    this.stream = null;
    this.stopStatsStream();
  }

  /** Removes the container. The volume is handled by the caller. */
  async destroyContainer(): Promise<void> {
    this.detach();

    if (await this.containerExists()) {
      await this.container().remove({ force: true, v: false });
    }

    this.setState('offline');
  }

  /**
   * Aligns the internal state with the container's reality.
   * Called when the daemon starts: servers keep running across a hopperd
   * restart, and they have to be found again.
   */
  async reconcile(): Promise<void> {
    // Settled here and nowhere else: what follows would find no container and
    // call the server offline, quietly overwriting the verdict.
    if (await this.resolveOrphanedInstall()) {
      return;
    }

    try {
      const info = await this.container().inspect();

      if (info.State.Running) {
        this.logger.info({ server: this.uuid }, 'Server already running: reattaching');
        await this.primeConsoleFromLogs();
        await this.attach();
        await this.startStatsStream();
        this.startedAt = new Date(info.State.StartedAt).getTime();
        // The startup marker went by before we attached: all we can do is note
        // that the container is running.
        this.setState('running');
      } else {
        this.setState('offline');
      }
    } catch {
      this.setState(this.options.configuration.suspended ? 'suspended' : 'offline');
    }
  }
}

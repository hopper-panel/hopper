import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PowerAction,
  ResourceUsage,
  ServerConfiguration,
  ServerState,
  StatusReport,
} from '@hopper/shared';
import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import type { DockerClient } from '../docker/client.js';
import { buildContainerOptions, containerNameFor } from '../docker/container-config.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { ConsoleBuffer, LineAssembler } from './console-buffer.js';
import { directorySize } from './disk-usage.js';
import { runInstallation } from './installer.js';
import { buildResourceUsage, emptyUsage, type DockerStats } from './stats.js';

/** Minimum delay between two walks of the volume, in milliseconds. */
const DISK_MEASURE_INTERVAL_MS = 60_000;

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

  private readonly startupPattern: RegExp | null;

  constructor(private options: ServerInstanceOptions) {
    super();
    this.startupPattern = this.compileStartupPattern();
  }

  get uuid(): string {
    return this.options.configuration.uuid;
  }

  get configuration(): ServerConfiguration {
    return this.options.configuration;
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

  /**
   * A template regex is data, not code: it can be invalid. The server has to
   * stay usable in that case, even if it means going `running` as soon as the
   * container runs.
   */
  private compileStartupPattern(): RegExp | null {
    const source = this.options.configuration.startupDetection;

    if (!source) {
      return null;
    }

    try {
      return new RegExp(source);
    } catch (error: unknown) {
      this.logger.warn(
        { server: this.uuid, pattern: source, err: error },
        'Invalid startup detection expression: the server will go online as soon as the container starts',
      );
      return null;
    }
  }

  updateConfiguration(configuration: ServerConfiguration): void {
    this.options = { ...this.options, configuration };
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
  }

  /** A line emitted by Hopper, distinct from the server's own output. */
  private emitDaemonLine(message: string): void {
    const line = `[Hopper] ${message}`;
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
      if (this.state === 'starting' && this.startupPattern?.test(line)) {
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
  private async attach(): Promise<void> {
    if (this.stream) {
      return;
    }

    // Hand-rolled attach rather than dockerode's `container.attach()`: see the
    // comment on `DockerClient.attachToContainer`, which explains why the
    // library's version injects its own options into stdin.
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
          expected: wasStopping || exit.exitCode === 0,
          exitCode: exit.exitCode,
          oomKilled: exit.oomKilled,
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
      this.emitDaemonLine(
        'Raise the memory allocated to this server: the installed Minecraft version needs more.',
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
    return this.enqueue(async () => {
      // A running server has to be stopped first: reinstalling under a live
      // process is guaranteed to corrupt something.
      if (this.state === 'running' || this.state === 'starting') {
        await this.doStop();
      }

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
        return;
      }

      this.emitDaemonLine('Installation finished. Preparing the container…');
      await this.createContainer();

      // Reported to the panel before starting: this is what moves the server
      // from INSTALLING to READY in the interface. A failed report must not
      // prevent the server from starting.
      await this.options.panel
        .reportInstall(this.uuid, true)
        .catch((error: unknown) =>
          this.logger.error({ server: this.uuid, err: error }, 'Install report failed'),
        );

      if (startOnCompletion) {
        await this.doStart();
      }
    }).catch(async (error: unknown) => {
      await this.options.panel.reportInstall(this.uuid, false).catch(() => undefined);
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

    this.setState('starting');
    this.console.clear();
    this.emitDaemonLine('Starting the server…');

    if (this.options.configuration.container.requiresRebuild || !(await this.containerExists())) {
      this.emitDaemonLine('Building the container…');
      await this.createContainer();
    }

    await this.attach();
    await this.container().start();
    await this.startStatsStream();

    if (!this.startupPattern) {
      // With no startup marker, the running container is the only signal
      // available.
      this.setState('running');
    }
  }

  /**
   * Clean stop.
   *
   * Sends the template's stop command on stdin (`stop` for a Bukkit server) and
   * lets the server save its worlds. An immediate SIGKILL would corrupt map
   * regions.
   */
  private async doStop(): Promise<void> {
    if (this.state === 'offline') {
      return;
    }

    this.setState('stopping');

    const { stop, stopTimeoutSeconds } = this.options.configuration;

    if (stop.type === 'command') {
      this.emitDaemonLine(`Stopping (command "${stop.value}")…`);
      await this.sendCommand(stop.value);
    } else {
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

  /** Waits for a state, or times out. Returns `false` on timeout. */
  private waitForState(target: ServerState, timeoutMs: number): Promise<boolean> {
    if (this.state === target) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('state', listener);
        resolve(false);
      }, timeoutMs);

      const listener = (state: ServerState): void => {
        if (state === target) {
          clearTimeout(timer);
          this.off('state', listener);
          resolve(true);
        }
      };

      this.on('state', listener);
    });
  }

  /**
   * Writes a command on the server's standard input.
   *
   * The newline is added here and the command is stripped of its own: a value
   * containing `\n` would otherwise send several commands at once, which would
   * bypass line-by-line audit logging.
   */
  async sendCommand(command: string): Promise<void> {
    if (!this.stream) {
      throw new Error('The server is not started.');
    }

    const sanitized = command.replace(/[\r\n]+/g, ' ').trim();

    if (sanitized === '') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.stream!.write(`${sanitized}\n`, (error) => (error ? reject(error) : resolve()));
    });
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
    try {
      const info = await this.container().inspect();

      if (info.State.Running) {
        this.logger.info({ server: this.uuid }, 'Server already running: reattaching');
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

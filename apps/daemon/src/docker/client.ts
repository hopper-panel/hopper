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
 * How long a pull may send nothing at all before it is abandoned.
 *
 * Two minutes, and unlike the installation's own deadline this one really can be
 * measured on silence, because the thing being watched is Docker's progress
 * stream rather than a shell script. Docker reports every chunk of every layer:
 * a pull that is transferring at any speed whatsoever produces events several
 * times a second, and two minutes without one is a registry that has stopped
 * answering, not a slow link.
 *
 * Generous all the same, because the quiet stretches are real: extraction of a
 * large layer reports at intervals, and a registry under load can take a while
 * to answer the manifest request that opens the whole thing.
 */
export const PULL_STALL_TIMEOUT_MS = 120_000;

/**
 * How long Docker is given to answer one question about this node.
 *
 * A minute is far more than any of these need. Creating a container, inspecting
 * one, starting, killing, removing, listing images: a Docker that is answering
 * at all answers each of them in milliseconds. `stop` is the one that takes real
 * time, and it takes exactly the grace period the caller asked for — which is
 * why {@link dockerRequestTimeout} adds that grace on top of this rather than
 * hoping it fits inside.
 *
 * Anything still outstanding after sixty seconds is not slow, it is a Docker
 * that has stopped answering, and the honest thing to do with that is fail
 * loudly. The alternative is what this daemon used to do: `install()` runs on
 * the server's operation queue, so a single unbounded round trip there took that
 * queue with it for ever — no start, no stop, no reinstall for that server until
 * hopperd was restarted, and nothing in the panel to say why.
 */
export const DOCKER_ANSWER_TIMEOUT_MS = 60_000;

/**
 * A question Docker was asked and never answered.
 *
 * A type of its own rather than a plain `Error` because callers act on it: the
 * installer says it on the console it knows the operator is watching, and the
 * ownership reclaim reports a Docker fault rather than accusing a `chown` of
 * having stood still. Everything else treats it as the failure it is.
 */
export class DockerUnansweredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerUnansweredError';
  }
}

/**
 * One request, as docker-modem describes it to itself.
 *
 * Only the fields the rule below reads are declared. `abortSignal` is
 * docker-modem's own option — it forwards it to `http.request` as `signal` — and
 * is the one field written back rather than read.
 */
export interface DockerRequest {
  path?: string;
  method?: string;
  /** The query options dockerode built, `t` among them for `stop`. */
  options?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

type DialCallback = (error: unknown, result?: unknown) => void;
type Dial = (request: DockerRequest, callback: DialCallback) => void;

/**
 * The endpoints that answer when something happens rather than when asked.
 *
 * **`POST /containers/{id}/wait` is the whole list, and it has to be.** It is
 * how the daemon learns a container ended: Docker holds the request open until
 * it does, which for an installation may be hours and for a *server* is the
 * entire time it is up. Bounding it would report every long-running server as a
 * crash and every large install as a failure — the one regression worse than the
 * hangs this rule exists to end.
 *
 * The streams are not in this list and do not need to be, which is the property
 * that makes the rule safe rather than a lucky escape. See
 * {@link boundEveryRequest}: what is bounded is Docker answering, and an attach,
 * a `stats` stream or a pull's progress stream *is answered* the moment its
 * headers arrive. What flows down it afterwards — nothing at all, for hours, on
 * a quiet Minecraft server the daemon adopted at startup — passes no deadline of
 * any kind.
 */
const LONG_POLL_ENDPOINTS = [/^\/containers\/[^/]+\/wait$/];

/** `POST /images/create`, the request that opens a pull. */
const IMAGE_PULL_ENDPOINT = '/images/create';

/** The two endpoints whose duration the caller chooses, in seconds. */
const GRACE_ENDPOINTS = [/^\/containers\/[^/]+\/(stop|restart)$/];

/**
 * How long this request has, or `null` for one that is deliberately unbounded.
 *
 * Pure and exported so the rule can be read and tested as a rule, rather than
 * inferred from the behaviour of a socket.
 *
 * Three cases, and the default is the one that matters: **anything not named
 * here is bounded**. A Docker endpoint added to dockerode tomorrow, or one this
 * daemon starts calling tomorrow, lands on {@link DOCKER_ANSWER_TIMEOUT_MS}
 * without anybody remembering to arrange it.
 *
 *  - {@link LONG_POLL_ENDPOINTS} are unbounded, because they answer when
 *    something happens rather than when asked.
 *  - A pull's own request gets {@link PULL_STALL_TIMEOUT_MS}. Docker does not
 *    write the response headers until the registry has answered the manifest
 *    request behind them, so this bound is the *registry's* silence, not this
 *    node's — and this file already decided how long that may last. Bounding it
 *    at a minute instead would start failing pulls from a slow registry that the
 *    progress stream, one line later, is content to wait two minutes for.
 *  - `stop` and `restart` carry a grace period the caller chose: Docker sends
 *    SIGTERM, waits `t` seconds, then SIGKILL, and only then answers. The grace
 *    is added to the window rather than expected to fit inside it, so that a
 *    caller which one day asks for a five-minute stop is not reported as a
 *    Docker that stopped answering after sixty seconds of doing exactly what it
 *    was told.
 */
export function dockerRequestTimeout(request: DockerRequest): number | null {
  // Everything after the `?` is the query dockerode built; the endpoint is what
  // says which question this is.
  const endpoint = (request.path ?? '').split('?')[0] ?? '';

  if (LONG_POLL_ENDPOINTS.some((pattern) => pattern.test(endpoint))) {
    return null;
  }

  if (endpoint === IMAGE_PULL_ENDPOINT) {
    return PULL_STALL_TIMEOUT_MS;
  }

  return DOCKER_ANSWER_TIMEOUT_MS + gracePeriodMs(endpoint, request.options);
}

/** The seconds a `stop` or a `restart` was told to wait before it kills. */
function gracePeriodMs(endpoint: string, options: Record<string, unknown> | undefined): number {
  if (!GRACE_ENDPOINTS.some((pattern) => pattern.test(endpoint))) {
    return 0;
  }

  const grace = options?.['t'];

  // Docker's own default is ten seconds when the caller names none, and it is
  // added rather than assumed to be covered: the point of this function is that
  // no bound here is ever a guess about how long Docker was asked to take.
  return (typeof grace === 'number' && grace > 0 ? grace : 10) * 1000;
}

/**
 * Bounds every request this client makes, once, at the one place they all pass
 * through.
 *
 * **The rule is applied here and not at the call sites, and that is the whole
 * point of it.** Four successive reviews of the install path each found more
 * unbounded round trips than the last — `container.wait`, then the pull's
 * progress stream, then create/attach/start, then the ownership reclaim's four,
 * then `remove`, the activity probe's `stats`, `listImages` and the pull's own
 * request — and each was closed with a `Promise.race` of its own. That is not a
 * bug list, it is the wrong shape: a codebase with no rule offers every new call
 * a fresh chance to forget. A call added tomorrow is bounded now without its
 * author having to know this comment exists.
 *
 * **`modem.dial` is that place.** Dockerode is a thin layer of URL building over
 * docker-modem, and every one of its methods — on the client, on a container, on
 * an image, on a network — ends in exactly one `dial` per HTTP request. Wrapping
 * it covers the methods this daemon does not call yet, and covers a *composite*
 * like `docker.run()` correctly into the bargain: it bounds each of the requests
 * such a helper makes, where a wrapper over dockerode's own methods would have
 * bounded the whole of it and reported any container that ran for a minute as a
 * Docker fault.
 *
 * **What is bounded is Docker answering, never a stream.** The deadline covers
 * the gap between the request leaving and docker-modem calling back, and for a
 * streaming endpoint that callback comes with the response headers. So an attach
 * to a server's console, a `stats` stream and a pull's progress stream are each
 * bounded up to the moment Docker hands them over, and completely unbounded
 * afterwards. That matters more than anything else here: the daemon adopts
 * running servers when it starts and streams their console and their statistics,
 * and a quiet Minecraft server sends nothing down its console for hours by
 * construction. A bound that reached those streams would take every adopted
 * server's console and stats offline on a timer, which is a far worse failure
 * than the hangs being fixed.
 *
 * **This is why it is not Dockerode's own `timeout` option**, which was the
 * obvious candidate. That option — and an HTTP agent timeout, and anything else
 * built on `socket.setTimeout` — is an *inactivity* timeout on the socket, not a
 * bound on the answer. It cannot tell a request Docker is ignoring from a stream
 * Docker is deliberately holding open, so it would destroy exactly the three
 * streams above, and `container.wait()` with them. It is also one figure for
 * every request, with no way to say which ones are long-polls.
 *
 * **Losing the race abandons the call; it does not undo it.** The socket is
 * closed — that is what the abort signal buys, and it is why this does not leak
 * a connection per abandoned call — but a `createContainer` Docker was already
 * acting on may still leave a container on the node. That is the right way
 * round: one stray container an operator can see and `docker rm`, against a
 * server whose every action hangs for ever with nothing to look at.
 *
 * Exported so the rule can be tested against a real Docker socket that never
 * answers, and so the installer's tests can present a Docker that behaves as
 * this one makes it behave.
 */
export function boundEveryRequest(
  docker: Dockerode,
  options: {
    /** Overridden only by the tests, which cannot wait a minute to prove this. */
    timeoutFor?: (request: DockerRequest) => number | null;
    /** Told about every abandoned call, for the log on the node. */
    onAbandoned?: (message: string) => void;
  } = {},
): void {
  const timeoutFor = options.timeoutFor ?? dockerRequestTimeout;

  // The instance's own `dial`, not the prototype's: another Dockerode built
  // anywhere else in this process — a test, a library — must not inherit a rule
  // it never asked for.
  const modem = docker.modem as unknown as { dial: Dial };
  const dial = modem.dial.bind(modem);

  modem.dial = (request, callback) => {
    const timeoutMs = timeoutFor(request);

    if (timeoutMs === null) {
      dial(request, callback);
      return;
    }

    const abandon = new AbortController();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;

      const message = unanswered(request, timeoutMs);
      options.onAbandoned?.(message);

      // Closed rather than merely forgotten. Docker may still answer this in a
      // minute, and a socket nobody is reading from would otherwise stay open
      // for the life of the daemon — on a node where every call is timing out,
      // that is a file descriptor leak on top of an outage.
      abandon.abort();
      callback(new DockerUnansweredError(message));
    }, timeoutMs);

    // Never a reason for hopperd to stay alive: a daemon being shut down has
    // stopped caring how this call ends.
    timer.unref();

    dial(
      { ...request, abortSignal: alsoOn(request.abortSignal, abandon.signal) },
      (error, result) => {
        // The deadline has already answered for this call. Docker turning up late
        // — or the abort above surfacing as a request error — must not call back a
        // second time.
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        callback(error, result);
      },
    );
  };
}

/**
 * The caller's own cancellation, if it had one, and ours.
 *
 * Nothing in this daemon passes a signal today. It is combined rather than
 * overwritten so that the day something does, the deadline does not silently
 * stop applying to that one call.
 */
function alsoOn(caller: AbortSignal | undefined, ours: AbortSignal): AbortSignal {
  return caller === undefined ? ours : AbortSignal.any([caller, ours]);
}

/** What an abandoned call is called, on a console and in a log. */
function unanswered(request: DockerRequest, timeoutMs: number): string {
  const endpoint = (request.path ?? '').split('?')[0] ?? '';

  return (
    `Docker did not answer ${request.method ?? 'GET'} ${endpoint} within ` +
    `${Math.round(timeoutMs / 1000)}s. This node's Docker is not answering: the request has been ` +
    'abandoned, and anything it had already begun may still be happening on this node.'
  );
}

/**
 * Access to the host machine's Docker daemon.
 *
 * The Docker socket is equivalent to root access: it is handled by this module
 * only, and is never mounted into a server container.
 *
 * Every question this class or its callers ask Docker is bounded — see
 * {@link boundEveryRequest} for the rule, {@link LONG_POLL_ENDPOINTS} for the
 * one call deliberately left out of it, and {@link attachToContainer} for the
 * one request in this file the rule cannot reach.
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

    boundEveryRequest(this.docker, {
      // Logged as well as thrown, because several callers swallow the throw on
      // purpose — `containerExists` treats any failure as "no container",
      // `explainExit` gives up on explaining, `removeIfExists` expects to fail —
      // and a node whose Docker has stopped answering would otherwise show only
      // its consequences.
      onAbandoned: (message) => this.logger.warn({ socket: config.docker.socket }, message),
    });
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

      await this.followPull(stream, onProgress);
    } catch (error: unknown) {
      // Docker's "denied" says neither which image nor why. On an image absent
      // from a public registry it nearly always means it was never published —
      // a message naming the image saves the operator half an hour of
      // searching.
      // The detail stays in the message because that is what an operator
      // reads in the log, and the original is attached as `cause` because that
      // is what a stack trace needs to stay complete.
      throw new Error(
        `Could not download the image "${image}". Check that it exists and that this node can reach it. Detail: ${String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Consumes a pull's progress stream, and gives up on one that has stopped.
   *
   * The request that opens the pull is bounded like every other question put to
   * Docker; this bounds what comes down it afterwards, which no rule about
   * answering could. `followProgress` wrapped in a bare promise has no timeout
   * of any kind, and the shape of the failure is worth being exact about: a
   * registry that accepts the connection and then stops sending never ends the
   * stream, so the completion callback is never invoked and this promise never
   * settles. The caller — an installation — is then blocked on a line that
   * cannot return, which puts a server in `installing` for ever without any
   * deadline further down ever being armed. It is the same hang as an unbounded
   * `container.wait`, one line earlier.
   *
   * Bounded on the same principle as the installation itself: on **inactivity**,
   * not on duration. A pull that is receiving layers is alive however big the
   * image is, and a total-duration cap would break exactly the large images
   * worth pulling. Every progress event pushes the deadline back, and Docker
   * emits one per chunk of every layer — several a second on a transfer that is
   * moving at all — so this needs no counters of its own to tell a slow pull
   * from a dead one.
   *
   * The stream is destroyed on expiry rather than merely abandoned: the socket
   * to the registry would otherwise stay open for the life of the daemon, and
   * `followProgress` would still be holding a reference to it.
   */
  private followPull(
    stream: NodeJS.ReadableStream,
    onProgress?: (line: string) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const settle = (error: Error | null): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const extend = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }

        timer = setTimeout(() => {
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          settle(
            new Error(
              `the registry stopped sending after ${PULL_STALL_TIMEOUT_MS / 1000}s and the ` +
                'download was abandoned',
            ),
          );
        }, PULL_STALL_TIMEOUT_MS);
        // Never a reason for hopperd to stay alive: a daemon being shut down
        // mid-pull has stopped caring how the pull ends.
        timer.unref();
      };

      extend();

      this.docker.modem.followProgress(
        stream,
        // Destroying the stream above makes this fire again with an error of its
        // own; `settle` ignores it, so the console keeps the reason that came
        // first rather than "premature close".
        (error: Error | null) => settle(error),
        (event: { status?: string; progress?: string }) => {
          extend();

          if (onProgress && event.status) {
            onProgress(event.progress ? `${event.status} ${event.progress}` : event.status);
          }
        },
      );
    });
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
   *
   * **The one request in this file {@link boundEveryRequest} cannot reach**, for
   * exactly that reason: it never touches dockerode, so it carries its own bound
   * and this is it. The bound covers the handshake and nothing after it — the
   * timer is cleared the moment Docker upgrades the connection, and the console
   * stream it hands back is then as unbounded as every other stream here.
   *
   * Deliberately a timer of this file's own rather than `request.setTimeout`.
   * That sets an *inactivity* timeout on the socket, and the socket survives the
   * upgrade: a Minecraft server that says nothing for a minute would have had
   * its console torn down by the very guard meant to stop the daemon hanging.
   */
  attachToContainer(
    containerName: string,
    /** Overridden only by the tests, which cannot wait a minute to prove this. */
    timeoutMs: number = DOCKER_ANSWER_TIMEOUT_MS,
  ): Promise<Duplex> {
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

      const timer = setTimeout(() => {
        // Destroyed with the reason, so the `error` handler below rejects with
        // this rather than with the socket error the destruction produces.
        request.destroy(
          new DockerUnansweredError(
            `Docker did not answer the attach to ${containerName} within ` +
              `${Math.round(timeoutMs / 1000)}s. This node's Docker is not answering.`,
          ),
        );
      }, timeoutMs);

      timer.unref();

      request.on('upgrade', (_response, socket: Duplex) => {
        clearTimeout(timer);
        resolve(socket);
      });

      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      // Docker refuses the attach if the container does not exist: the answer
      // is then a real HTTP response, not an upgrade.
      request.on('response', (response) => {
        clearTimeout(timer);
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

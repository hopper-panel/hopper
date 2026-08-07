import type { Readable } from 'node:stream';
import {
  CONTRACT_VERSION,
  DAEMON_ROUTES,
  daemonErrorSchema,
  redactNodeToken,
  serverStatusResponseSchema,
  systemInformationSchema,
  type PowerAction,
  type ServerConfiguration,
  type ServerState,
  type SystemInformation,
} from '@hopper/shared';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';

/** Address of a daemon, resolved from the `Node` table. */
export interface NodeConnection {
  uuid: string;
  /** Base URL of the daemon, e.g. `https://node1.example.com:8443`. */
  url: string;
  /** Full token, `<id>.<secret>`. */
  token: string;
}

export type NodeHealth =
  | { reachable: true; system: SystemInformation; latencyMs: number }
  | { reachable: false; reason: string; latencyMs: number };

/**
 * Whether a node's daemon honours something the panel is about to rely on.
 *
 * Three answers and not two, because "no" and "cannot say" are different
 * refusals with different fixes: one is a node to upgrade, the other is a node
 * to get answering again. Callers phrase both themselves — what is being
 * refused, and what it would have cost to allow it, are theirs to know — and
 * this only settles the part every caller gets wrong the same way.
 */
export type CapabilityVerdict =
  | { honoured: true }
  | { honoured: false; reachable: true }
  | { honoured: false; reachable: false; reason: string };

/**
 * HTTP client towards a daemon.
 *
 * Every error is turned into a structured result rather than an exception: an
 * unreachable node is a normal state of the system, not a bug. The panel has to
 * keep serving the interface and show the node as offline.
 */
@Injectable()
export class NodeClientService {
  private readonly logger = new Logger(NodeClientService.name);

  /**
   * An unreachable daemon must not block a page from rendering.
   *
   * The value is adjustable from the administration: five seconds suit a node
   * on the same network, far less a machine on the other side of the world,
   * where the delay makes a responding machine look dead.
   */
  private static readonly DEFAULT_TIMEOUT_MS = 5000;

  constructor(private readonly settings: InstanceSettingsService) {}

  private async timeoutMs(): Promise<number> {
    // An unreadable setting must not prevent reaching a node: fall back to the
    // original value rather than propagate the error.
    return this.settings
      .all()
      .then((values) => values.nodeTimeoutMs)
      .catch(() => NodeClientService.DEFAULT_TIMEOUT_MS);
  }

  async fetchSystemInformation(node: NodeConnection): Promise<NodeHealth> {
    const startedAt = performance.now();
    const timeout = await this.timeoutMs();

    try {
      const response = await fetch(new URL(DAEMON_ROUTES.system, node.url), {
        headers: {
          authorization: `Bearer ${node.token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeout),
      });

      const latencyMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        this.logger.warn(
          `Node ${node.uuid} answered ${response.status} (token ${redactNodeToken(node.token)})`,
        );
        return {
          reachable: false,
          reason:
            response.status === 401
              ? 'Node token refused by the daemon.'
              : `The daemon answered ${response.status}.`,
          latencyMs,
        };
      }

      // A mismatch on the contract's major version means the panel and the
      // daemon no longer speak the same language: better to say so at once than
      // to let a server creation fail later.
      const remoteContract = response.headers.get('x-hopper-contract');
      if (remoteContract && remoteContract !== CONTRACT_VERSION) {
        return {
          reachable: false,
          reason: `Incompatible contract version: the daemon announces ${remoteContract}, the panel expects ${CONTRACT_VERSION}.`,
          latencyMs,
        };
      }

      const parsed = systemInformationSchema.safeParse(await response.json());
      if (!parsed.success) {
        return {
          reachable: false,
          reason: 'Unreadable answer from the daemon: its version is probably too old.',
          latencyMs,
        };
      }

      return { reachable: true, system: parsed.data, latencyMs };
    } catch (error: unknown) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `No answer from the daemon within ${timeout}ms.`
          : 'Could not connect to the daemon.';

      this.logger.warn(`Node ${node.uuid} unreachable: ${reason}`);
      return { reachable: false, reason, latencyMs };
    }
  }

  /**
   * Asks a node whether its daemon honours a capability, before relying on it.
   *
   * The whole point is that the payload cannot ask this question of itself. A
   * daemon too old for a field either strips it — Zod discards what a schema
   * does not know — or refuses the object outright, and neither outcome comes
   * back as a complaint the panel could show to whoever pressed the button. So
   * the panel asks first, and refuses the *write* rather than discovering the
   * skew at the first stop, on a machine nobody is watching.
   *
   * `CONTRACT_VERSION` is the alternative and it is not one: a node announcing
   * a different version is marked unreachable outright, so bumping it takes
   * every server on every node offline until the last daemon is upgraded.
   *
   * **Unreachable is a refusal too.** "It will probably be fine" is exactly the
   * guess these gates exist to remove, and none of the operations gated on this
   * is urgent enough to be worth it.
   */
  async honoursCapability(node: NodeConnection, capability: string): Promise<CapabilityVerdict> {
    const health = await this.fetchSystemInformation(node);

    if (!health.reachable) {
      return { honoured: false, reachable: false, reason: health.reason };
    }

    return health.system.capabilities.includes(capability)
      ? { honoured: true }
      : { honoured: false, reachable: true };
  }

  // -------------------------------------------------------------------------
  // Driving the servers
  // -------------------------------------------------------------------------

  /**
   * Creates the server on the daemon and starts its installation.
   * Unlike the health probes, a failure throws: creating a server in the
   * database without the daemon knowing would leave a phantom record.
   */
  async createServer(
    node: NodeConnection,
    configuration: ServerConfiguration,
    startOnCompletion: boolean,
  ): Promise<void> {
    await this.send(node, DAEMON_ROUTES.servers, 'POST', { configuration, startOnCompletion });
  }

  /** Passes an up-to-date configuration without touching the container. */
  async syncServer(node: NodeConnection, configuration: ServerConfiguration): Promise<void> {
    await this.send(node, DAEMON_ROUTES.serverSync(configuration.uuid), 'POST', configuration);
  }

  async powerServer(node: NodeConnection, uuid: string, action: PowerAction): Promise<void> {
    await this.send(node, DAEMON_ROUTES.serverPower(uuid), 'POST', { action, wait: false });
  }

  /** Sends commands to the server's console. */
  async sendCommands(node: NodeConnection, uuid: string, commands: string[]): Promise<void> {
    await this.send(node, DAEMON_ROUTES.serverCommands(uuid), 'POST', { commands });
  }

  /**
   * A server's current state, as the daemon sees it.
   *
   * Returns `null` if the node is unreachable or answers oddly: the caller —
   * the scheduler — has to be able to tell "the server is stopped" from "we do
   * not know", and not mistake the second for the first.
   */
  async fetchServerState(node: NodeConnection, uuid: string): Promise<ServerState | null> {
    const timeout = await this.timeoutMs();

    try {
      const response = await fetch(new URL(DAEMON_ROUTES.server(uuid), node.url), {
        headers: { authorization: `Bearer ${node.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        return null;
      }

      const parsed = serverStatusResponseSchema.safeParse(await response.json());

      return parsed.success ? parsed.data.state : null;
    } catch {
      return null;
    }
  }

  async deleteServer(node: NodeConnection, uuid: string, purgeVolume: boolean): Promise<void> {
    await this.send(node, DAEMON_ROUTES.server(uuid), 'DELETE', { purgeVolume });
  }

  /**
   * Relays a request to the daemon and returns its answer as is.
   *
   * Used by the file API: the panel decides *who* may do what, the daemon
   * decides *where* — it is the one holding the jail. Reimplementing path
   * validation panel-side would create two truths, and the one that drifted
   * would necessarily be the wrong one.
   *
   * The daemon's error bodies are passed through unrewritten: they are already
   * written to be read by a user, and hiding them would deprive that user of
   * the reason for the refusal.
   */
  async proxy(
    node: NodeConnection,
    path: string,
    options: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number },
  ): Promise<{ status: number; contentType: string | null; body: Buffer }> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method: options.method,
        headers: {
          authorization: `Bearer ${node.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Compressing a world of several gigabytes takes time; the request
        // must not expire before the daemon has finished.
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
    } catch (error: unknown) {
      this.logger.error(`Relay ${options.method} ${path} to ${node.uuid}: ${String(error)}`);
      throw new ServiceUnavailableException('The node is unreachable.');
    }

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  /**
   * Relays a daemon response **as a stream**, without holding it in memory.
   *
   * `proxy` accumulates the body in a `Buffer`, which suits a JSON response but
   * not a backup archive: a world of a few gigabytes would take the panel down
   * — and take it down for all its users, not only for the one downloading.
   *
   * No timeout is set: how long a download takes depends on the client's
   * bandwidth, and cutting after a fixed time would penalise precisely the slow
   * connections that need it most.
   */
  async stream(
    node: NodeConnection,
    path: string,
  ): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method: 'GET',
        headers: { authorization: `Bearer ${node.token}` },
      });
    } catch (error: unknown) {
      this.logger.error(`Streaming GET ${path} to ${node.uuid}: ${String(error)}`);
      throw new ServiceUnavailableException('The node is unreachable.');
    }

    return { status: response.status, headers: response.headers, body: response.body };
  }

  /**
   * Forwards a request body **as a stream** to the daemon.
   *
   * The counterpart of `stream` for uploads. The file is never held in memory
   * in the panel: the bytes received from the browser leave for the node as
   * they arrive. Without this, uploading a two-gigabyte modpack would take the
   * panel down for everyone.
   */
  async pipeTo(
    node: NodeConnection,
    path: string,
    body: Readable,
    contentLength: string | undefined,
  ): Promise<{ status: number; contentType: string | null; body: Buffer }> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${node.token}`,
          'content-type': 'application/octet-stream',
          ...(contentLength ? { 'content-length': contentLength } : {}),
        },
        body,
        // Required by `fetch` as soon as the body is a stream: the request
        // starts leaving before the response exists.
        duplex: 'half',
      });
    } catch (error: unknown) {
      this.logger.error(`Upload to ${node.uuid} on ${path}: ${String(error)}`);
      throw new ServiceUnavailableException('The node is unreachable.');
    }

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  private async send(
    node: NodeConnection,
    path: string,
    method: 'POST' | 'DELETE',
    body: unknown,
  ): Promise<void> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method,
        headers: {
          authorization: `Bearer ${node.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // More generous than the health probe: creating a server can involve
        // downloading a Docker image.
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error: unknown) {
      this.logger.error(
        `Call ${method} ${path} to node ${node.uuid} failed (token ${redactNodeToken(node.token)}): ${String(error)}`,
      );
      throw new ServiceUnavailableException(
        'The node is unreachable. The operation was not applied.',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Node ${node.uuid} answered ${response.status} on ${path}: ${detail}`);

      if (response.status === 401) {
        throw new ServiceUnavailableException(
          'Node token refused by the daemon. Regenerate it from the node page.',
        );
      }

      const explanation = daemonMessage(detail);

      throw new ServiceUnavailableException(
        `The daemon refused the operation (HTTP ${response.status})${explanation === null ? '.' : `: ${explanation}`}`,
      );
    }
  }
}

/**
 * The sentence the daemon wrote for whoever pressed the button, if it wrote
 * one.
 *
 * `proxy` above already passes the daemon's error bodies through unrewritten,
 * on the stated grounds that they are written to be read by a user and hiding
 * them deprives that user of the reason for the refusal. Exactly the same is
 * true here and it was not being done: every failure came back as "the daemon
 * refused the operation (HTTP 502)", which is then what a scheduled task's
 * audit record says about a command that never reached the server. The daemon
 * knew it was an unset password variable, or a port nobody has created; nothing
 * carried that across, so the one person who could fix it never learnt of it.
 *
 * The status is kept alongside rather than replaced by the message, because the
 * two answer different questions — whether the node refused or failed, and why
 * — and a daemon too old to send a structured body still has to say something.
 *
 * Only a body parsing as the daemon's own error shape is trusted. Anything else
 * is a reverse proxy's HTML error page or a truncated stream, and a status code
 * beats either of those pasted into a notification.
 */
function daemonMessage(body: string): string | null {
  try {
    const parsed = daemonErrorSchema.safeParse(JSON.parse(body));

    return parsed.success ? parsed.data.error.message : null;
  } catch {
    return null;
  }
}

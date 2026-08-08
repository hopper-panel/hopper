import {
  CONSOLE_TOKEN_RENEW_MARGIN_SECONDS,
  PERMISSIONS,
  WS_ERROR_CODES,
  clientMessageSchema,
  consoleTokenPayloadSchema,
  isActiveState,
  type Permission,
  type PowerAction,
  type ResourceUsage,
  type ServerMessage,
  type ServerState,
} from '@hopper/shared';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import type { WebSocket } from 'ws';
import type { DaemonConfig } from '../config/schema.js';
import type { Logger } from '../logger.js';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';

/**
 * Time the client is given to authenticate after the WebSocket opens.
 * A connection silent beyond that is closed: it consumes a file descriptor
 * without ever doing anything.
 */
const AUTH_TIMEOUT_MS = 10_000;

/** Window every quota below is measured over. */
const QUOTA_WINDOW_MS = 60_000;

/**
 * What one user may ask of one server, per minute, whatever the shape of their
 * client.
 *
 * Three separate allowances rather than one, because the three requests cost
 * the daemon wildly different amounts and share nothing but the socket they
 * arrive on. Keeping them apart also means a busy console can never leave an
 * operator unable to stop their server.
 */
const QUOTAS = {
  /** Console commands: one line handed to the server, over stdin or RCON. */
  command: 60,

  /**
   * Power actions. Far below the command quota on purpose: each one creates,
   * stops or destroys a container, which is the most expensive thing an
   * authorised session can ask for and the cheapest way to hurt a host. A
   * start/kill loop at console speed was, until this quota existed, free.
   */
  power: 10,

  /**
   * Console replays. A `request_logs` frame is a couple of dozen bytes and is
   * answered with up to `CONSOLE_BUFFER_LINES` separate JSON messages: the one
   * request in this protocol whose cost to the daemon bears no relation to its
   * cost to the sender.
   *
   * The snapshot sent on authentication is charged here too, which is why six
   * and not one: Hopper's own client spends one on every connection, and a
   * browser reconnecting across a flaky link may spend several in a minute
   * without anybody doing anything wrong. Charging the connect path is the
   * point of the bucket rather than an afterthought — left free, ten replays
   * cost ten sockets, which is the multiplication a per-user quota exists to
   * stop.
   */
  replay: 6,

  /**
   * `request_stats` has no quota, and that is a decision rather than an
   * omission. It is answered from a sample the session already holds — one
   * `send` of a fixed, small shape, with no reach into the server, Docker or
   * the buffer — so its cost to the daemon is the cost of the frame that asked
   * for it. The send-buffer ceiling below is what bounds a client that asks in
   * a loop and never reads the answers, and it bounds every message equally.
   */
} as const;

type QuotaBucket = keyof typeof QUOTAS;

/**
 * Outbound bytes the daemon will hold for one client before hanging up.
 *
 * Above anything legitimate and below anything ruinous. The largest thing the
 * daemon writes in one go is a buffer replay, and the buffer is bounded on both
 * axes — `CONSOLE_BUFFER_LINES` lines of at most `MAX_LINE_LENGTH` each, so
 * roughly four megabytes at its absolute worst and a few tens of kilobytes in
 * life. Twice that leaves a slow connection room to receive one while the
 * server is talking, and still refuses to grow a queue without end in the
 * memory of the process that owns every container on this host.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Permission required for each power action. */
const POWER_PERMISSIONS: Record<PowerAction, Permission> = {
  start: PERMISSIONS.CONTROL_START,
  stop: PERMISSIONS.CONTROL_STOP,
  restart: PERMISSIONS.CONTROL_RESTART,
  // Killing a server can corrupt a map: it is the stop permission, but the
  // gesture is deliberately distinct in the interface.
  kill: PERMISSIONS.CONTROL_STOP,
};

/**
 * Sliding-window quotas, shared by every console session on this daemon.
 *
 * The counters this replaces lived on the session object, one per socket, which
 * made them arithmetic rather than a limit: the same token opened as many
 * sockets as it liked and every one of them arrived with a fresh allowance. A
 * quota is worth exactly its key, so these hang off the identity the panel
 * signed and the holder cannot multiply — the user (`sub`) on one server.
 *
 * Not the token: the panel mints a fresh one, with a fresh `jti`, whenever the
 * browser asks, and renewal is an ordinary part of the protocol. Not the server
 * on its own either, tempting as that is when the server is the thing being
 * protected — a single allowance shared by everyone with access would let one
 * subuser spend it and leave the owner unable to type `stop`.
 */
class ConsoleQuotas {
  /** Timestamps of the uses still inside the window, per bucket and identity. */
  private readonly uses = new Map<string, number[]>();
  private sweptAt = Date.now();

  /**
   * Records one use and says whether it fell within the bucket's allowance.
   *
   * Sliding, and the word matters: the counter this replaces reset itself
   * wholesale once a window had elapsed since it started, so sixty commands
   * timed just before that boundary and sixty just after went through in a
   * fraction of a second — twice the advertised limit, precisely when someone
   * is trying.
   */
  consume(bucket: QuotaBucket, identity: string): boolean {
    const now = Date.now();
    this.sweep(now);

    const key = `${bucket}:${identity}`;
    const recent = (this.uses.get(key) ?? []).filter((at) => at > now - QUOTA_WINDOW_MS);

    // A refused use is not recorded. A client that keeps knocking while it is
    // over the limit recovers as its earlier uses age out, instead of
    // extending its own lockout by asking.
    if (recent.length >= QUOTAS[bucket]) {
      this.uses.set(key, recent);
      return false;
    }

    recent.push(now);
    this.uses.set(key, recent);
    return true;
  }

  /**
   * Drops keys with nothing left inside the window, at most once per window.
   *
   * Users and servers come and go, and their keys would otherwise accumulate
   * for the life of the process. Sweeping on every call would mean walking the
   * whole map sixty times a minute per console, for entries that cost a handful
   * of numbers each.
   */
  private sweep(now: number): void {
    if (now - this.sweptAt < QUOTA_WINDOW_MS) {
      return;
    }

    this.sweptAt = now;

    for (const [key, uses] of this.uses) {
      if (uses.every((at) => at <= now - QUOTA_WINDOW_MS)) {
        this.uses.delete(key);
      }
    }
  }
}

/**
 * WebSocket gateway for the console.
 *
 * The browser connects **straight to the daemon**, without going through the
 * panel. Authorisation rests entirely on a short-lived JWT signed by the panel
 * with this node's shared secret: the daemon verifies it on its own, with no
 * network call. That is what lets fifty open consoles cost the panel nothing.
 *
 * The accepted consequence: a permission revoked in the panel only takes effect
 * when the token is renewed, hence its deliberately short lifetime.
 */
export function registerConsoleGateway(
  app: FastifyInstance,
  manager: ServerManager,
  config: DaemonConfig,
  logger: Logger,
): void {
  // One registry for the whole daemon, deliberately outside the session: a
  // quota an attacker can reset by opening a second socket is not a quota.
  const quotas = new ConsoleQuotas();

  app.get('/api/servers/:uuid/ws', { websocket: true }, (socket, request) => {
    const { uuid } = request.params as { uuid: string };

    // The origin is checked before anything else: browsers do not apply the
    // same-origin policy to WebSockets, so it is up to the server to do it.
    // Without this check, any site visited by a signed-in user could open a
    // console onto their servers.
    const origin = request.headers.origin;
    if (origin && !config.api.allowedOrigins.includes(origin)) {
      logger.warn({ origin, server: uuid }, 'WebSocket connection refused: origin not allowed');
      socket.close(1008, 'Origin not allowed.');
      return;
    }

    new ConsoleSession(socket, uuid, manager, config, logger, quotas).start();
  });
}

class ConsoleSession {
  private permissions: Permission[] = [];
  private authenticated = false;
  private server: ServerInstance | null = null;

  /**
   * Identity the quotas are counted against: the user this token names, on this
   * server. Null exactly when the session holds no authority.
   */
  private quotaIdentity: string | null = null;

  private authTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;

  /**
   * Most recent resource sample seen on this connection, so `request_stats` can
   * answer with figures rather than with nothing.
   */
  private lastUsage: ResourceUsage | null = null;

  /** Whether the client has already been told its console output is withheld. */
  private hiddenConsoleAnnounced = false;

  private detachers: (() => void)[] = [];

  constructor(
    private readonly socket: WebSocket,
    private readonly serverUuid: string,
    private readonly manager: ServerManager,
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
    private readonly quotas: ConsoleQuotas,
  ) {}

  start(): void {
    this.authTimer = setTimeout(() => {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.UNAUTHENTICATED,
        message: 'No authentication supplied.',
      });
      this.hangUp(1008, 'No authentication supplied.');
    }, AUTH_TIMEOUT_MS);

    this.socket.on('message', (raw: Buffer) => {
      void this.handleMessage(raw);
    });

    this.socket.on('close', () => this.cleanup());
    this.socket.on('error', () => this.cleanup());
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }

    // A client that stops reading does not stop the daemon writing: `ws` queues
    // whatever will not fit down the socket, in the memory of the process that
    // owns every container on this host. A console this far behind is being
    // read by nobody, so it is hung up rather than buffered indefinitely.
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.logger.warn(
        { server: this.serverUuid, bufferedBytes: this.socket.bufferedAmount },
        'Console closed: the client is not reading its socket',
      );
      this.hangUp(1013, 'Client not reading.');
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  private async handleMessage(raw: Buffer): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.INVALID_MESSAGE,
        message: 'Unreadable message.',
      });
      return;
    }

    const message = clientMessageSchema.safeParse(parsed);

    if (!message.success) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.INVALID_MESSAGE,
        message: 'Message does not follow the protocol.',
      });
      return;
    }

    if (message.data.event === 'auth') {
      await this.authenticate(message.data.token);
      return;
    }

    // Any message other than `auth` before authentication is ignored: without
    // that, a client could send commands and authenticate afterwards. The same
    // gate catches a session whose token has expired under it, which is why
    // expiry clears the authority rather than merely closing the socket.
    if (!this.authenticated || !this.server) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.UNAUTHENTICATED,
        message: 'Authenticate before doing anything else.',
      });
      return;
    }

    switch (message.data.event) {
      case 'send_command':
        await this.handleCommand(message.data.command);
        break;
      case 'set_state':
        await this.handlePower(message.data.action);
        break;
      case 'request_logs':
        this.handleLogsRequest();
        break;
      case 'request_stats':
        this.handleStatsRequest();
        break;
    }
  }

  private async authenticate(token: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(token, Buffer.from(this.config.panel.jwtSecret, 'utf8'), {
        issuer: this.config.panel.url,
        audience: this.config.uuid,
        algorithms: ['HS256'],
      });

      const claims = consoleTokenPayloadSchema.safeParse(payload);

      if (!claims.success) {
        throw new Error('Token payload does not conform.');
      }

      // A token valid for another server must not open this one: this is the
      // check that stops a user from using their own server's token to read
      // somebody else's console.
      if (claims.data.serverUuid !== this.serverUuid) {
        throw new Error('The token does not concern this server.');
      }

      const server = this.manager.get(this.serverUuid);

      if (!server) {
        this.send({
          event: 'error',
          code: WS_ERROR_CODES.INTERNAL,
          message: 'Server unknown to this node.',
        });
        this.hangUp(1011, 'Unknown server.');
        return;
      }

      // An already-authenticated session authenticates again on every token
      // renewal, over the **same** connection. Replaying the full setup in that
      // case added a second set of listeners on the server without removing the
      // first: every console line then went out twice, then three times after
      // the next renewal, and so on. The symptom — a console that starts
      // duplicating everything after a few minutes — does not look like its
      // cause.
      const renewal = this.authenticated;

      this.clearAuthTimer();
      this.authenticated = true;
      this.permissions = claims.data.permissions;
      this.server = server;
      this.quotaIdentity = `${this.serverUuid}:${claims.data.sub}`;

      this.scheduleTokenTimers(claims.data.exp);

      if (!renewal) {
        this.attachToServer(server);
      }

      this.send({
        event: 'auth_success',
        permissions: this.permissions,
        expiresAt: claims.data.exp * 1000,
      });

      this.announceHiddenConsole();

      if (!renewal) {
        // Replaying the state and the console buffer only makes sense on the
        // first authentication: sending them again would show the client a
        // second copy of a history it never lost.
        this.send({ event: 'status', state: server.currentState });

        // A running server will send its own sample within the second; a
        // stopped one never will, and its page would stay empty of any figure —
        // including disk space, which it still occupies.
        if (!isActiveState(server.currentState)) {
          this.send({ event: 'stats', usage: server.idleUsage });
        }

        // Charged against the same allowance as an explicit `request_logs`,
        // and for the reason the allowance exists at all: a replay is up to
        // five hundred messages bought with one small frame. Leaving the
        // connect path free would have priced the quota at nothing — a client
        // that wants ten replays opens ten sockets, which is the multiplication
        // the per-user bucket was introduced to stop.
        //
        // A refusal here is silent, unlike `handleLogsRequest`: nobody asked
        // for this snapshot, and a client whose console opens without history
        // has already been told why by the permission notice or, failing that,
        // will get it on the next `request_logs`.
        if (this.consumeQuota('replay')) {
          this.sendConsoleSnapshot();
        }
      }
    } catch (error: unknown) {
      this.logger.debug({ server: this.serverUuid, err: error }, 'Console token refused');
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.INVALID_TOKEN,
        message: 'Invalid or expired token.',
      });
      // A refused **renewal** arrives on a session that is already authorised,
      // and the socket takes a handshake to shut: without this the token just
      // rejected would go on driving the server for as long as the peer
      // declined to answer the close frame.
      this.hangUp(1008, 'Invalid token.');
    }
  }

  /**
   * Tells the client its console output is being withheld.
   *
   * Without it the withholding is indistinguishable from a silent server: the
   * page shows an empty terminal and no reason for it, and the first person to
   * debug that goes looking at the game server. Said once per session, and
   * again if a renewal takes the permission away mid-console.
   */
  private announceHiddenConsole(): void {
    if (this.has(PERMISSIONS.CONTROL_CONSOLE)) {
      this.hiddenConsoleAnnounced = false;
      return;
    }

    if (this.hiddenConsoleAnnounced) {
      return;
    }

    this.hiddenConsoleAnnounced = true;
    this.send({
      event: 'daemon_message',
      message: `Console output is hidden: this session does not hold ${PERMISSIONS.CONTROL_CONSOLE}.`,
    });
  }

  /**
   * The token expires while the console is open. The client is warned ahead of
   * time so it can ask the panel for a new one, with no visible break.
   */
  private scheduleTokenTimers(expiresAtSeconds: number): void {
    this.clearTokenTimers();

    const remainingMs = expiresAtSeconds * 1000 - Date.now();
    const renewInMs = remainingMs - CONSOLE_TOKEN_RENEW_MARGIN_SECONDS * 1000;

    if (renewInMs > 0) {
      this.renewTimer = setTimeout(() => this.send({ event: 'token_expiring' }), renewInMs);
    }

    this.expiryTimer = setTimeout(
      () => {
        this.send({ event: 'token_expired' });
        this.logger.debug({ server: this.serverUuid }, 'Console session ended: token expired');
        this.hangUp(1008, 'Token expired.');
      },
      Math.max(0, remainingMs),
    );
  }

  /**
   * Subscribes the session to its server's events.
   *
   * What arrives here divides in two, and the division is the whole point.
   * State changes, resource samples and the start and finish of an installation
   * say **that** something happened: a subuser holding only the implicit
   * `websocket.connect` is meant to watch their server go up and down, and the
   * panel's header is built from exactly these. Console and installation output
   * say **what was said** — an operator pasting an RCON password, a plugin
   * printing its API key, an `op` that names the next administrator — and that
   * is the same thing the buffer replay has always held back. Streaming it live
   * to anyone who managed to authenticate, as this did, meant the replay gate
   * withheld five hundred lines of history and nothing at all of the present —
   * and the present is where the operator is typing.
   *
   * The permission is read when each line arrives rather than when the listener
   * is attached: renewal re-authenticates over the same connection, so a live
   * session's permissions change underneath these handlers, and the point of
   * the short token lifetime is that the change bites.
   */
  private attachToServer(server: ServerInstance): void {
    const onState = (state: ServerState): void => {
      // The last sample described a state the server has now left. Answering
      // `request_stats` from it would report the memory of a server that has
      // since stopped.
      this.lastUsage = null;
      this.send({ event: 'status', state });
    };

    const onConsole = (line: string): void => {
      if (this.has(PERMISSIONS.CONTROL_CONSOLE)) {
        this.send({ event: 'console_output', line });
      }
    };

    const onStats = (usage: ResourceUsage): void => {
      this.lastUsage = usage;
      this.send({ event: 'stats', usage });
    };

    const onInstallStarted = (): void => this.send({ event: 'install_started' });

    const onInstallOutput = (line: string): void => {
      if (this.has(PERMISSIONS.CONTROL_CONSOLE)) {
        this.send({ event: 'install_output', line });
      }
    };

    const onInstallCompleted = (successful: boolean): void =>
      this.send({ event: 'install_completed', successful });

    server.on('state', onState);
    server.on('console', onConsole);
    server.on('stats', onStats);
    server.on('install_started', onInstallStarted);
    server.on('install_output', onInstallOutput);
    server.on('install_completed', onInstallCompleted);

    this.detachers.push(() => {
      server.off('state', onState);
      server.off('console', onConsole);
      server.off('stats', onStats);
      server.off('install_started', onInstallStarted);
      server.off('install_output', onInstallOutput);
      server.off('install_completed', onInstallCompleted);
    });
  }

  /**
   * Replays the console buffer, silently doing nothing when the session may not
   * read it.
   *
   * Silent because this also runs on the connect path, where a session that
   * cannot see the console has already been told so by `announceHiddenConsole`
   * and does not need the same news as an error. A client that *asked* for the
   * replay is answered explicitly — see `handleLogsRequest`.
   */
  private sendConsoleSnapshot(): void {
    if (!this.server || !this.has(PERMISSIONS.CONTROL_CONSOLE)) {
      return;
    }

    for (const line of this.server.consoleSnapshot()) {
      this.send({ event: 'console_output', line });
    }
  }

  private has(permission: Permission): boolean {
    return this.permissions.includes(permission);
  }

  private deny(permission: Permission): void {
    this.send({
      event: 'error',
      code: WS_ERROR_CODES.FORBIDDEN,
      message: `Missing permission: ${permission}.`,
    });
  }

  private rateLimited(message: string): void {
    this.send({ event: 'error', code: WS_ERROR_CODES.RATE_LIMITED, message });
  }

  /**
   * Spends one unit of a quota.
   *
   * A session with no identity has no authority either — every caller sits
   * behind the authentication gate — so refusing is the honest reading of a
   * state that should not arise.
   */
  private consumeQuota(bucket: QuotaBucket): boolean {
    return this.quotaIdentity !== null && this.quotas.consume(bucket, this.quotaIdentity);
  }

  private async handleCommand(command: string): Promise<void> {
    if (!this.has(PERMISSIONS.CONTROL_CONSOLE)) {
      this.deny(PERMISSIONS.CONTROL_CONSOLE);
      return;
    }

    if (!this.consumeQuota('command')) {
      this.rateLimited('Too many commands sent. Wait a moment.');
      return;
    }

    try {
      await this.server!.sendCommand(command);
    } catch (error: unknown) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.SERVER_LOCKED,
        message: error instanceof Error ? error.message : 'Command refused.',
      });
    }
  }

  private async handlePower(action: PowerAction): Promise<void> {
    const required = POWER_PERMISSIONS[action];

    if (!this.has(required)) {
      this.deny(required);
      return;
    }

    if (!this.consumeQuota('power')) {
      this.rateLimited('Too many power actions. Wait a moment.');
      return;
    }

    try {
      await this.server!.power(action);
    } catch (error: unknown) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.SERVER_LOCKED,
        message: error instanceof Error ? error.message : 'Action refused.',
      });
    }
  }

  private handleLogsRequest(): void {
    if (!this.has(PERMISSIONS.CONTROL_CONSOLE)) {
      this.deny(PERMISSIONS.CONTROL_CONSOLE);
      return;
    }

    if (!this.consumeQuota('replay')) {
      this.rateLimited('Too many console replays requested. Wait a moment.');
      return;
    }

    this.sendConsoleSnapshot();
  }

  private handleStatsRequest(): void {
    // Answering a request for statistics with a `status` event was simply the
    // wrong reply: the client asked what the server is consuming and was told
    // what state it is in. `ResourceUsage` carries the state as well, so the
    // right event says everything the wrong one did.
    //
    // The last live sample, or the idle one when none has arrived — a stopped
    // server never emits, and its disk is occupied all the same.
    this.send({ event: 'stats', usage: this.lastUsage ?? this.server!.idleUsage });
  }

  /**
   * Ends the session: authority first, socket second.
   *
   * Closing a WebSocket is a handshake, not a switch. `ws` goes on delivering
   * frames until the peer answers the close frame or the thirty-second close
   * timer fires, and nothing obliges a peer to answer — a client that simply
   * stays quiet used to keep driving a root-privileged daemon on the strength
   * of a token already declared dead. Every close this session decides on goes
   * through here, so the authority is gone before the frame leaves and the
   * frame is only a courtesy. (The origin check closes its socket directly:
   * there is no session yet, and nothing to take away.)
   */
  private hangUp(code: number, reason: string): void {
    this.authenticated = false;
    this.permissions = [];
    this.server = null;
    this.quotaIdentity = null;
    this.clearTokenTimers();
    this.socket.close(code, reason);
  }

  private clearAuthTimer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private clearTokenTimers(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.renewTimer = null;
    this.expiryTimer = null;
  }

  private cleanup(): void {
    this.clearAuthTimer();
    this.clearTokenTimers();
    // Without this detachment, every closed console would leave a listener on
    // the instance: after a few hundred openings, Node warns about a leak and
    // the server broadcasts into the void.
    this.detachers.forEach((detach) => detach());
    this.detachers = [];
  }
}

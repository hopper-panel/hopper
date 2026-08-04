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

/** Commands per minute, per connection. */
const COMMAND_RATE_LIMIT = 60;
const COMMAND_RATE_WINDOW_MS = 60_000;

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
 * WebSocket gateway for the console.
 *
 * The browser connects **straight to the daemon**, without going through the
 * panel. Authorisation rests entirely on a short-lived JWT signed by the panel
 * with this node's shared secret: the daemon verifies it on its own, with no
 * network call. That is what lets fifty open consoles cost the panel nothing.
 *
 * The accepted consequence: a permission revoked in the panel only takes effect
 * when the token is renewed, hence its ten-minute lifetime.
 */
export function registerConsoleGateway(
  app: FastifyInstance,
  manager: ServerManager,
  config: DaemonConfig,
  logger: Logger,
): void {
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

    new ConsoleSession(socket, uuid, manager, config, logger).start();
  });
}

class ConsoleSession {
  private permissions: Permission[] = [];
  private authenticated = false;
  private server: ServerInstance | null = null;

  private authTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private renewTimer: NodeJS.Timeout | null = null;

  private commandCount = 0;
  private commandWindowStart = Date.now();

  private detachers: (() => void)[] = [];

  constructor(
    private readonly socket: WebSocket,
    private readonly serverUuid: string,
    private readonly manager: ServerManager,
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.authTimer = setTimeout(() => {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.UNAUTHENTICATED,
        message: 'No authentication supplied.',
      });
      this.socket.close(1008, 'No authentication supplied.');
    }, AUTH_TIMEOUT_MS);

    this.socket.on('message', (raw: Buffer) => {
      void this.handleMessage(raw);
    });

    this.socket.on('close', () => this.cleanup());
    this.socket.on('error', () => this.cleanup());
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
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
    // that, a client could send commands and authenticate afterwards.
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
        this.sendConsoleSnapshot();
        break;
      case 'request_stats':
        this.send({ event: 'status', state: this.server.currentState });
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
        this.socket.close(1011, 'Unknown server.');
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

      this.scheduleTokenTimers(claims.data.exp);

      if (!renewal) {
        this.attachToServer(server);
      }

      this.send({
        event: 'auth_success',
        permissions: this.permissions,
        expiresAt: claims.data.exp * 1000,
      });

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

        this.sendConsoleSnapshot();
      }
    } catch (error: unknown) {
      this.logger.debug({ server: this.serverUuid, err: error }, 'Console token refused');
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.INVALID_TOKEN,
        message: 'Invalid or expired token.',
      });
      this.socket.close(1008, 'Invalid token.');
    }
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
        this.socket.close(1008, 'Token expired.');
      },
      Math.max(0, remainingMs),
    );
  }

  private attachToServer(server: ServerInstance): void {
    const onState = (state: ServerState): void => this.send({ event: 'status', state });
    const onConsole = (line: string): void => this.send({ event: 'console_output', line });
    const onStats = (usage: ResourceUsage): void => this.send({ event: 'stats', usage });
    const onInstallStarted = (): void => this.send({ event: 'install_started' });
    const onInstallOutput = (line: string): void => this.send({ event: 'install_output', line });
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

  private async handleCommand(command: string): Promise<void> {
    if (!this.has(PERMISSIONS.CONTROL_CONSOLE)) {
      this.deny(PERMISSIONS.CONTROL_CONSOLE);
      return;
    }

    if (!this.consumeCommandQuota()) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.RATE_LIMITED,
        message: 'Too many commands sent. Wait a moment.',
      });
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

  /**
   * An open console must not be used to drown a server in commands.
   * The sliding window is local to the connection: that is enough here, since
   * the token itself is issued by the panel, which already limits its issuance.
   */
  private consumeCommandQuota(): boolean {
    const now = Date.now();

    if (now - this.commandWindowStart > COMMAND_RATE_WINDOW_MS) {
      this.commandWindowStart = now;
      this.commandCount = 0;
    }

    this.commandCount += 1;
    return this.commandCount <= COMMAND_RATE_LIMIT;
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

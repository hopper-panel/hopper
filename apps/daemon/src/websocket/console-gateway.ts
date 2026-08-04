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
 * Délai laissé au client pour s'authentifier après l'ouverture du WebSocket.
 * Une connexion muette au-delà est fermée : elle consomme un descripteur de
 * fichier sans jamais rien faire.
 */
const AUTH_TIMEOUT_MS = 10_000;

/** Commandes par minute et par connexion. */
const COMMAND_RATE_LIMIT = 60;
const COMMAND_RATE_WINDOW_MS = 60_000;

/** Actions de puissance requises pour chaque commande de contrôle. */
const POWER_PERMISSIONS: Record<PowerAction, Permission> = {
  start: PERMISSIONS.CONTROL_START,
  stop: PERMISSIONS.CONTROL_STOP,
  restart: PERMISSIONS.CONTROL_RESTART,
  // Tuer un serveur peut corrompre une map : c'est la permission d'arrêt, mais
  // le geste est volontairement distinct côté interface.
  kill: PERMISSIONS.CONTROL_STOP,
};

/**
 * Passerelle WebSocket de la console.
 *
 * Le navigateur se connecte **directement au daemon**, sans passer par le panel.
 * L'autorisation repose entièrement sur un JWT de courte durée signé par le
 * panel avec le secret partagé de ce node : le daemon le vérifie seul, sans
 * aucun appel réseau. C'est ce qui permet à cinquante consoles ouvertes de ne
 * rien coûter au panel.
 *
 * Conséquence assumée : une permission retirée dans le panel ne prend effet
 * qu'au renouvellement du jeton, d'où sa durée de vie de dix minutes.
 */
export function registerConsoleGateway(
  app: FastifyInstance,
  manager: ServerManager,
  config: DaemonConfig,
  logger: Logger,
): void {
  app.get('/api/servers/:uuid/ws', { websocket: true }, (socket, request) => {
    const { uuid } = request.params as { uuid: string };

    // L'origine est vérifiée avant toute chose : le navigateur n'applique pas la
    // politique de même origine aux WebSockets, c'est donc au serveur de le
    // faire. Sans ce contrôle, n'importe quel site visité par un utilisateur
    // connecté pourrait ouvrir une console vers ses serveurs.
    const origin = request.headers.origin;
    if (origin && !config.api.allowedOrigins.includes(origin)) {
      logger.warn({ origin, server: uuid }, 'Connexion WebSocket refusée : origine non autorisée');
      socket.close(1008, 'Origine non autorisée.');
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
        message: 'Authentification non fournie.',
      });
      this.socket.close(1008, 'Authentification non fournie.');
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
        message: 'Message illisible.',
      });
      return;
    }

    const message = clientMessageSchema.safeParse(parsed);

    if (!message.success) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.INVALID_MESSAGE,
        message: 'Message non conforme au protocole.',
      });
      return;
    }

    if (message.data.event === 'auth') {
      await this.authenticate(message.data.token);
      return;
    }

    // Tout message autre que `auth` avant authentification est ignoré : sans
    // cela, un client pourrait envoyer des commandes puis s'authentifier.
    if (!this.authenticated || !this.server) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.UNAUTHENTICATED,
        message: 'Authentifiez-vous avant toute autre action.',
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
        throw new Error('Charge utile du jeton non conforme.');
      }

      // Un jeton valide pour un autre serveur ne doit pas ouvrir celui-ci :
      // c'est la vérification qui empêche un utilisateur d'utiliser le jeton de
      // son propre serveur pour lire la console de quelqu'un d'autre.
      if (claims.data.serverUuid !== this.serverUuid) {
        throw new Error('Le jeton ne concerne pas ce serveur.');
      }

      const server = this.manager.get(this.serverUuid);

      if (!server) {
        this.send({
          event: 'error',
          code: WS_ERROR_CODES.INTERNAL,
          message: 'Serveur inconnu de ce node.',
        });
        this.socket.close(1011, 'Serveur inconnu.');
        return;
      }

      // Une session déjà authentifiée l'est de nouveau à chaque renouvellement
      // de jeton, sur la **même** connexion. Rejouer la mise en place complète
      // dans ce cas ajoutait un second jeu d'écouteurs sur le serveur sans
      // retirer le premier : chaque ligne de console partait alors deux fois,
      // puis trois après le renouvellement suivant, et ainsi de suite. Le
      // symptôme — une console qui se met à tout dupliquer au bout de quelques
      // minutes — ne ressemble pas à sa cause.
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
        // Le rappel de l'état et le tampon de console n'ont de sens qu'à la
        // première authentification : les renvoyer ferait afficher une seconde
        // copie de l'historique au client, qui n'a rien perdu entre-temps.
        this.send({ event: 'status', state: server.currentState });

        // Un serveur en marche enverra son propre relevé dans la seconde ; un
        // serveur à l'arrêt n'en enverra jamais, et sa page resterait vide de
        // tout chiffre — dont l'espace disque, qu'il occupe pourtant toujours.
        if (!isActiveState(server.currentState)) {
          this.send({ event: 'stats', usage: server.idleUsage });
        }

        this.sendConsoleSnapshot();
      }
    } catch (error: unknown) {
      this.logger.debug({ server: this.serverUuid, err: error }, 'Jeton de console refusé');
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.INVALID_TOKEN,
        message: 'Jeton invalide ou expiré.',
      });
      this.socket.close(1008, 'Jeton invalide.');
    }
  }

  /**
   * Le jeton expire pendant que la console est ouverte. On prévient le client
   * en avance pour qu'il en demande un nouveau au panel, sans coupure visible.
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
        this.socket.close(1008, 'Jeton expiré.');
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
      message: `Permission manquante : ${permission}.`,
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
        message: 'Trop de commandes envoyées. Patientez quelques instants.',
      });
      return;
    }

    try {
      await this.server!.sendCommand(command);
    } catch (error: unknown) {
      this.send({
        event: 'error',
        code: WS_ERROR_CODES.SERVER_LOCKED,
        message: error instanceof Error ? error.message : 'Commande refusée.',
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
        message: error instanceof Error ? error.message : 'Action refusée.',
      });
    }
  }

  /**
   * Une console ouverte ne doit pas servir à noyer un serveur de commandes.
   * La fenêtre glissante est locale à la connexion : c'est suffisant ici, le
   * jeton étant lui-même délivré par le panel qui limite déjà son émission.
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
    // Sans ce détachement, chaque console fermée laisserait un écouteur sur
    // l'instance : au bout de quelques centaines d'ouvertures, Node avertit
    // d'une fuite et le serveur diffuse dans le vide.
    this.detachers.forEach((detach) => detach());
    this.detachers = [];
  }
}

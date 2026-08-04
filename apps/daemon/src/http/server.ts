import { readFile } from 'node:fs/promises';
import websocket from '@fastify/websocket';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { LoadedConfig } from '../config/load.js';
import type { BackupManager } from '../backup/backup-manager.js';
import type { DockerClient } from '../docker/client.js';
import type { Logger } from '../logger.js';
import { registerBackupRoutes } from '../routes/backups.js';
import { registerFileRoutes } from '../routes/files.js';
import { registerServerRoutes } from '../routes/servers.js';
import { registerSystemRoutes } from '../routes/system.js';
import type { ServerManager } from '../server/server-manager.js';
import { registerConsoleGateway } from '../websocket/console-gateway.js';
import { DAEMON_VERSION } from '../version.js';
import { createNodeTokenGuard } from './auth.js';

/** Routes accessibles sans jeton de node. */
const PUBLIC_ROUTES = new Set(['/healthz']);

/**
 * Le WebSocket de console porte sa propre authentification, par JWT signé du
 * panel : le hook de jeton de node ne doit donc pas s'y appliquer. C'est la
 * seule route dans ce cas, et elle est identifiée par son suffixe.
 */
function isConsoleWebsocket(url: string): boolean {
  return /^\/api\/servers\/[^/]+\/ws$/.test(url.split('?')[0] ?? '');
}

export interface HttpServerDependencies {
  loaded: LoadedConfig;
  logger: Logger;
  docker: DockerClient;
  manager: ServerManager;
  backups: BackupManager;
}

export async function buildHttpServer(
  dependencies: HttpServerDependencies,
): Promise<FastifyInstance> {
  const { loaded, logger, docker, manager, backups } = dependencies;
  const { config } = loaded;

  const https = config.api.ssl.enabled
    ? {
        cert: await readFile(config.api.ssl.certificatePath!),
        key: await readFile(config.api.ssl.keyPath!),
      }
    : null;

  // Annoté en FastifyBaseLogger : passer directement le type Logger de pino
  // spécialiserait le générique de FastifyInstance et rendrait le type
  // incompatible avec celui attendu par les modules de routes.
  const baseLogger: FastifyBaseLogger = logger;

  const app = Fastify({
    loggerInstance: baseLogger,
    https,
    trustProxy: true,
    bodyLimit: config.api.uploadLimitBytes,
    // Les identifiants de requête apparaissent dans les réponses d'erreur : ils
    // sont ce qu'un opérateur cherche dans les journaux pour retrouver la trace.
    genReqId: () => crypto.randomUUID(),
    // En mode normal, une ligne par requête HTTP noierait les journaux : le
    // daemon reçoit un appel de statut par serveur et par minute. Les erreurs
    // continuent d'être journalisées par le gestionnaire dédié.
    // Fastify attend une instance de LogController, pas la classe.
    logController: new LogController({ disableRequestLogging: !config.debug }),
  });

  // Fastify refuse par défaut un type de contenu qu'il ne sait pas analyser :
  // l'envoi d'un fichier échouerait en 415 avant d'atteindre la route. Ce
  // parseur générique ne lit rien et laisse le flux intact, pour que l'envoi le
  // consomme lui-même — un fichier de plusieurs gigaoctets ne doit jamais être
  // assemblé en mémoire.
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  await app.register(websocket, {
    options: {
      // Une ligne de console dépasse rarement quelques kilooctets ; au-delà,
      // c'est un client qui tente de saturer la mémoire du daemon.
      maxPayload: 64 * 1024,
    },
  });

  const authenticateNode = createNodeTokenGuard(config);

  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?')[0] ?? '';

    if (PUBLIC_ROUTES.has(path) || isConsoleWebsocket(path)) {
      done();
      return;
    }

    if (!authenticateNode(request, reply)) {
      // La réponse 401 a déjà été envoyée : ne pas appeler done(), sinon Fastify
      // poursuit le cycle et tente d'écrire une seconde réponse.
      return;
    }

    done();
  });

  // Sonde de vitalité pour systemd et les orchestrateurs. Volontairement
  // muette : elle ne révèle ni version, ni configuration, ni état des serveurs.
  app.get('/healthz', (_request, reply) => reply.send({ status: 'ok' }));

  registerSystemRoutes(app, docker, manager);
  registerServerRoutes(app, manager);
  registerFileRoutes(app, manager, {
    uid: loaded.config.system.uid,
    gid: loaded.config.system.gid,
  });
  registerBackupRoutes(app, manager, backups);
  registerConsoleGateway(app, manager, config, logger);

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: 'Route inconnue.', requestId: request.id },
    }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'Erreur non gérée');
    }

    return reply.code(status).send({
      error: {
        code: status === 500 ? 'internal_error' : (error.code ?? 'request_error'),
        // Un 500 ne doit jamais renvoyer le message d'origine : il contient
        // parfois un chemin de fichier ou une portion de configuration.
        message: status === 500 ? 'Erreur interne du daemon.' : error.message,
        requestId: request.id,
      },
    });
  });

  logger.debug({ version: DAEMON_VERSION, ssl: config.api.ssl.enabled }, 'Serveur HTTP construit');

  return app;
}

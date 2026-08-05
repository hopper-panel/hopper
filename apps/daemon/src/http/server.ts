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

/** Routes reachable without a node token. */
const PUBLIC_ROUTES = new Set(['/healthz']);

/**
 * The console WebSocket carries its own authentication, by a JWT signed by the
 * panel: the node-token hook must therefore not apply to it. It is the only
 * route in that case, and it is identified by its suffix.
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

  // Annotated as FastifyBaseLogger: passing pino's Logger type directly would
  // specialise FastifyInstance's generic and make the type incompatible with
  // the one the route modules expect.
  const baseLogger: FastifyBaseLogger = logger;

  const app = Fastify({
    loggerInstance: baseLogger,
    https,
    trustProxy: true,
    bodyLimit: config.api.uploadLimitBytes,
    // Request identifiers appear in the error responses: they are what an
    // operator looks for in the logs to find the trace.
    genReqId: () => crypto.randomUUID(),
    // In normal mode, one line per HTTP request would drown the logs: the
    // daemon receives one status call per server per minute. Errors are still
    // logged by the dedicated handler.
    // Fastify expects an instance of LogController, not the class.
    logController: new LogController({ disableRequestLogging: !config.debug }),
  });

  // Fastify refuses by default a content type it cannot parse: a file upload
  // would fail with a 415 before reaching the route. This generic parser reads
  // nothing and leaves the stream intact, so the upload consumes it itself — a
  // file of several gigabytes must never be assembled in memory.
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  await app.register(websocket, {
    options: {
      // A console line rarely exceeds a few kilobytes; beyond that, it is a
      // client trying to saturate the daemon's memory.
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
      // The 401 has already been sent: do not call done(), or Fastify carries
      // on with the cycle and tries to write a second response.
      return;
    }

    done();
  });

  // Liveness probe for systemd and orchestrators. Deliberately mute: it
  // reveals neither version, nor configuration, nor the state of the servers.
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
      error: { code: 'not_found', message: 'Unknown route.', requestId: request.id },
    }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
    }

    return reply.code(status).send({
      error: {
        code: status === 500 ? 'internal_error' : (error.code ?? 'request_error'),
        // A 500 must never return the original message: it sometimes contains
        // a file path or a fragment of configuration.
        message: status === 500 ? 'Internal daemon error.' : error.message,
        requestId: request.id,
      },
    });
  });

  logger.debug({ version: DAEMON_VERSION, ssl: config.api.ssl.enabled }, 'HTTP server built');

  return app;
}

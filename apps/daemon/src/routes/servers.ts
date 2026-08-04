import {
  createServerRequestSchema,
  deleteServerRequestSchema,
  powerRequestSchema,
  sendCommandsRequestSchema,
  serverConfigurationSchema,
  type ServerStatusResponse,
} from '@hopper/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerManager } from '../server/server-manager.js';
import { emptyUsage } from '../server/stats.js';

/**
 * Routes the panel calls to drive the servers.
 *
 * All require the node token, checked by the global hook. None is reachable
 * from a browser: the console goes through the WebSocket, which has its own
 * authorisation model.
 */
export function registerServerRoutes(app: FastifyInstance, manager: ServerManager): void {
  app.post('/api/servers', async (request, reply) => {
    const body = createServerRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_body',
          message: body.error.issues.map((issue) => issue.path.join('.')).join(', '),
          requestId: request.id,
        },
      });
    }

    const server = manager.upsert(body.data.configuration);

    // Deliberately not awaited: installing a server takes from a few seconds to
    // several minutes — downloading a modpack, compiling BuildTools. Holding
    // the HTTP request open that long would make it expire at the proxy. The
    // panel follows progress over the WebSocket, and receives the final verdict
    // on `/api/remote/servers/:uuid/install`.
    void server.install(body.data.startOnCompletion).catch((error: unknown) => {
      request.log.error({ server: server.uuid, err: error }, 'Installation failed');
    });

    return reply.code(201).send({ uuid: server.uuid, state: server.currentState });
  });

  app.get('/api/servers/:uuid', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const server = manager.require(uuid);

    const response: ServerStatusResponse = {
      uuid: server.uuid,
      state: server.currentState,
      usage: emptyUsage(server.currentState),
      containerExists: await server.containerExists(),
    };

    return reply.send(response);
  });

  app.post('/api/servers/:uuid/power', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const body = powerRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Unknown action.', requestId: request.id },
      });
    }

    const server = manager.require(uuid);
    const action = server.power(body.data.action);

    // Without `wait`, receipt is acknowledged at once: stopping a Minecraft
    // server can take a minute, and leaving an HTTP request open that long
    // would make it expire at the proxy.
    if (body.data.wait) {
      await action;
    } else {
      void action.catch((error: unknown) => {
        request.log.error({ server: uuid, err: error }, 'Power action failed');
      });
    }

    return reply.code(202).send({ accepted: true, state: server.currentState });
  });

  app.post('/api/servers/:uuid/commands', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const body = sendCommandsRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Commandes invalides.', requestId: request.id },
      });
    }

    const server = manager.require(uuid);

    for (const command of body.data.commands) {
      await server.sendCommand(command);
    }

    return reply.code(204).send();
  });

  /**
   * Updates a server's configuration without restarting it.
   * Limit changes only take effect when the container is recreated, signalled
   * by `container.requiresRebuild`.
   */
  app.post('/api/servers/:uuid/sync', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const configuration = serverConfigurationSchema.safeParse(request.body);

    if (!configuration.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Invalid configuration.', requestId: request.id },
      });
    }

    if (configuration.data.uuid !== uuid) {
      return reply.code(400).send({
        error: {
          code: 'uuid_mismatch',
          message: 'The UUID in the body does not match the one in the URL.',
          requestId: request.id,
        },
      });
    }

    manager.upsert(configuration.data);
    return reply.code(204).send();
  });

  app.delete('/api/servers/:uuid', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const body = deleteServerRequestSchema.safeParse(request.body ?? {});

    await manager.remove(uuid, body.success ? body.data.purgeVolume : true);

    return reply.code(204).send();
  });
}

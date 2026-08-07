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

  /**
   * Runs the install script again over an existing server.
   *
   * The panel has posted here since reinstall existed and the route was never
   * registered, so every attempt answered 404 — which the interface reports as
   * "is the node reachable?". That left a server whose install had failed with
   * no way back: stuck INSTALLING or INSTALL_FAILED, and no button that worked.
   *
   * Not awaited, for the same reason as creation: an install runs for minutes
   * and the verdict arrives on `/api/remote/servers/:uuid/install`.
   */
  app.post('/api/servers/:uuid/reinstall', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const server = manager.require(uuid);

    void server.install(false).catch((error: unknown) => {
      request.log.error({ server: server.uuid, err: error }, 'Reinstallation failed');
    });

    return reply.code(202).send({ uuid: server.uuid, state: server.currentState });
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
      try {
        await server.sendCommand(command);
      } catch (error: unknown) {
        // Answered here rather than left to the global error handler, which
        // replaces the message of every 500 with "Internal daemon error." — on
        // purpose, because an unexpected 500 can carry a file path or a
        // fragment of configuration. This failure is not one of those: it is a
        // sentence written for the operator, naming the variable or the port
        // that has to change, and it is the only copy of that sentence the
        // panel will ever see. A scheduled task whose audit record reads "HTTP
        // 500" tells whoever finds it that something went wrong and nothing
        // whatsoever about what.
        //
        // 502 and not 500: the daemon did its part, and the thing that did not
        // answer is behind it.
        request.log.warn({ server: uuid, err: error }, 'Command not delivered');

        return reply.code(502).send({
          error: {
            code: 'command_undelivered',
            message: error instanceof Error ? error.message : 'The command was not delivered.',
            requestId: request.id,
          },
        });
      }
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

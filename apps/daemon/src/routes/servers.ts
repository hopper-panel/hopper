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
 * Routes appelées par le panel pour piloter les serveurs.
 *
 * Toutes exigent le jeton de node, vérifié par le hook global. Aucune n'est
 * accessible depuis un navigateur : la console passe par le WebSocket, qui a son
 * propre modèle d'autorisation.
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

    // Volontairement non attendu : installer un serveur prend de quelques
    // secondes à plusieurs minutes — téléchargement d'un modpack, compilation
    // de BuildTools. Tenir la requête HTTP ouverte pendant ce temps la ferait
    // expirer côté proxy. Le panel suit l'avancement par WebSocket, et reçoit
    // le verdict final sur `/api/remote/servers/:uuid/install`.
    void server.install(body.data.startOnCompletion).catch((error: unknown) => {
      request.log.error({ server: server.uuid, err: error }, 'Installation échouée');
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
        error: { code: 'invalid_body', message: 'Action inconnue.', requestId: request.id },
      });
    }

    const server = manager.require(uuid);
    const action = server.power(body.data.action);

    // Sans `wait`, on accuse réception tout de suite : l'arrêt d'un serveur
    // Minecraft peut prendre une minute, et laisser une requête HTTP ouverte
    // aussi longtemps la ferait expirer côté proxy.
    if (body.data.wait) {
      await action;
    } else {
      void action.catch((error: unknown) => {
        request.log.error({ server: uuid, err: error }, 'Action de puissance échouée');
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
   * Met à jour la configuration d'un serveur sans le redémarrer.
   * Les changements de limites ne prendront effet qu'à la recréation du
   * conteneur, signalée par `container.requiresRebuild`.
   */
  app.post('/api/servers/:uuid/sync', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const configuration = serverConfigurationSchema.safeParse(request.body);

    if (!configuration.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Configuration invalide.', requestId: request.id },
      });
    }

    if (configuration.data.uuid !== uuid) {
      return reply.code(400).send({
        error: {
          code: 'uuid_mismatch',
          message: "L'UUID du corps ne correspond pas à celui de l'URL.",
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

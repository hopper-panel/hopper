import { arch, cpus, platform, release, totalmem } from 'node:os';
import { CONTRACT_VERSION, type SystemInformation } from '@hopper/shared';
import type { FastifyInstance } from 'fastify';
import type { DockerClient } from '../docker/client.js';
import type { ServerManager } from '../server/server-manager.js';
import { DAEMON_VERSION } from '../version.js';

/**
 * Informations sur l'hôte, consultées par le panel pour afficher l'état d'un
 * node et vérifier la compatibilité des versions.
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  docker: DockerClient,
  manager: ServerManager,
): void {
  app.get('/api/system', async (_request, reply) => {
    // Docker peut être arrêté sans que le daemon le soit : dans ce cas le node
    // reste joignable et doit le dire, plutôt que de renvoyer une 500 qui
    // afficherait « node hors ligne » et masquerait la vraie cause.
    const dockerInfo = await docker
      .info()
      .catch(() => ({ version: '', storageDriver: '', cgroupVersion: '', runningContainers: 0 }));

    const info: SystemInformation = {
      version: DAEMON_VERSION,
      kernelVersion: release(),
      architecture: arch(),
      os: platform(),
      cpuCount: cpus().length,
      memoryTotalBytes: totalmem(),
      docker: dockerInfo,
    };

    return reply.header('x-hopper-contract', CONTRACT_VERSION).send(info);
  });

  /** Serveurs connus de ce node et leur état. Utile au diagnostic. */
  app.get('/api/servers', (_request, reply) =>
    reply.send({
      data: manager.list().map((server) => ({
        uuid: server.uuid,
        name: server.configuration.meta.name,
        state: server.currentState,
      })),
    }),
  );
}

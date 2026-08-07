import { arch, cpus, platform, release, totalmem } from 'node:os';
import { CONTRACT_VERSION, NODE_CAPABILITIES, type SystemInformation } from '@hopper/shared';
import type { FastifyInstance } from 'fastify';
import type { DockerClient } from '../docker/client.js';
import type { ServerManager } from '../server/server-manager.js';
import { DAEMON_VERSION } from '../version.js';

/**
 * Information about the host, read by the panel to display a node's state and
 * check version compatibility.
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  docker: DockerClient,
  manager: ServerManager,
): void {
  app.get('/api/system', async (_request, reply) => {
    // Docker can be stopped without the daemon being stopped: in that case the
    // node stays reachable and has to say so, rather than return a 500 that
    // would show "node offline" and hide the real cause.
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
      // What this build honours that an older one silently did not. The panel
      // gates operations on it rather than on the daemon's version string,
      // which says nothing about what was backported into it.
      capabilities: [NODE_CAPABILITIES.allocationRoles, NODE_CAPABILITIES.rconStop],
    };

    return reply.header('x-hopper-contract', CONTRACT_VERSION).send(info);
  });

  /** Servers this node knows and their state. Useful for diagnosis. */
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

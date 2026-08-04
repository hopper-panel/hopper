import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PANEL_VERSION } from '../../version.js';
import { AdminOnly } from '../auth/decorators.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';

/**
 * Vue d'ensemble de l'instance, pour l'accueil de l'administration.
 *
 * Les compteurs viennent de la base ; l'état des nodes, lui, est demandé aux
 * daemons. Un node déclaré n'est pas un node joignable, et c'est précisément ce
 * qu'un administrateur vient vérifier ici — afficher seulement « 2 nodes »
 * laisserait croire que tout va bien alors qu'aucun ne répond.
 */
@Controller('api/admin/overview')
@AdminOnly()
export class OverviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  @Get()
  async get() {
    const [servers, nodes, users, templates, backups, databases] = await Promise.all([
      this.prisma.server.count(),
      this.prisma.node.findMany({
        orderBy: { createdAt: 'asc' },
        select: { uuid: true, name: true, fqdn: true, _count: { select: { servers: true } } },
      }),
      this.prisma.user.count(),
      this.prisma.template.count(),
      this.prisma.backup.count(),
      this.prisma.database.count(),
    ]);

    // Sondés en parallèle : à la file, un node injoignable ferait attendre son
    // délai complet avant de passer au suivant, et la page mettrait dix
    // secondes à s'afficher pour deux machines.
    const health = await Promise.all(
      nodes.map(async (node) => {
        const connection = await this.nodes.getConnection(node.uuid).catch(() => null);

        if (!connection) {
          return { ...node, reachable: false as const, reason: 'Coordonnées illisibles.' };
        }

        const probe = await this.client.fetchSystemInformation(connection);

        return probe.reachable
          ? {
              uuid: node.uuid,
              name: node.name,
              fqdn: node.fqdn,
              servers: node._count.servers,
              reachable: true as const,
              version: probe.system.version,
              cpuCount: probe.system.cpuCount,
              memoryTotalBytes: probe.system.memoryTotalBytes,
              runningContainers: probe.system.docker.runningContainers,
              latencyMs: probe.latencyMs,
            }
          : {
              uuid: node.uuid,
              name: node.name,
              fqdn: node.fqdn,
              servers: node._count.servers,
              reachable: false as const,
              reason: probe.reason,
            };
      }),
    );

    return {
      version: PANEL_VERSION,
      counts: { servers, nodes: nodes.length, users, templates, backups, databases },
      nodes: health,
    };
  }
}

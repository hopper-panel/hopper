import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PANEL_VERSION } from '../../version.js';
import { AdminOnly } from '../auth/decorators.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';

/**
 * Overview of the instance, for the administration's home page.
 *
 * The counters come from the database; the nodes' state is asked of the
 * daemons. A declared node is not a reachable node, and that is exactly what an
 * administrator comes here to check — showing only "2 nodes" would suggest all
 * is well when neither answers.
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

    // Probed in parallel: one after another, an unreachable node would make the
    // next wait its full timeout, and the page would take ten seconds to render
    // for two machines.
    const health = await Promise.all(
      nodes.map(async (node) => {
        const connection = await this.nodes.getConnection(node.uuid).catch(() => null);

        if (!connection) {
          return { ...node, reachable: false as const, reason: 'Unreadable address.' };
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

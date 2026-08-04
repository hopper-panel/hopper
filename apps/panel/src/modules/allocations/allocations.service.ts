import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { ServerConfigurationService } from '../servers/server-configuration.service.js';

/**
 * Ports attribués à un serveur.
 *
 * Une allocation appartient au **node** et lui est prêtée : la retirer d'un
 * serveur la rend au pool, elle n'est jamais supprimée. C'est ce qui permet à
 * un administrateur de garder la maîtrise des ports ouverts sur sa machine,
 * pendant que l'utilisateur du serveur en dispose librement dans la limite
 * qu'on lui a fixée.
 *
 * Le port principal est celui injecté dans `server.properties` au démarrage :
 * en changer impose de renvoyer la configuration au daemon, faute de quoi le
 * panel afficherait un port et le serveur en écouterait un autre.
 */
@Injectable()
export class AllocationsService {
  private readonly logger = new Logger(AllocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configurations: ServerConfigurationService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const allocations = await this.prisma.allocation.findMany({
      where: { serverId: server.id },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
    });

    const available = await this.prisma.allocation.count({
      where: { nodeId: server.nodeId, serverId: null },
    });

    return {
      data: allocations.map((allocation) => ({
        id: allocation.id,
        ip: allocation.ip,
        port: allocation.port,
        alias: allocation.alias,
        primary: allocation.id === server.primaryAllocationId,
      })),
      meta: {
        limit: server.allocationLimit,
        used: allocations.length,
        /** Ports libres sur le node : sans eux, « ajouter » ne mène nulle part. */
        availableOnNode: available,
      },
    };
  }

  /** Change la note affichée à côté d'un port. */
  async setAlias(serverUuid: string, allocationId: number, alias: string | null) {
    const server = await this.requireServer(serverUuid);
    await this.requireAllocation(server.id, allocationId);

    const updated = await this.prisma.allocation.update({
      where: { id: allocationId },
      data: { alias: alias?.trim() ? alias.trim() : null },
    });

    return {
      id: updated.id,
      ip: updated.ip,
      port: updated.port,
      alias: updated.alias,
      primary: updated.id === server.primaryAllocationId,
    };
  }

  /**
   * Désigne le port principal.
   *
   * Prend effet au **prochain démarrage** : le port est écrit dans la
   * configuration du serveur, que le daemon applique au lancement. Le changer
   * sur un serveur en marche ne déplace pas son écoute, et le dire vaut mieux
   * que de laisser croire à une panne.
   */
  async setPrimary(serverUuid: string, allocationId: number) {
    const server = await this.requireServer(serverUuid);
    await this.requireAllocation(server.id, allocationId);

    if (server.primaryAllocationId === allocationId) {
      return { changed: false };
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { primaryAllocationId: allocationId },
    });

    await this.pushConfiguration(serverUuid, server.nodeId);

    return { changed: true };
  }

  /**
   * Attribue un port libre du node.
   *
   * Le choix est fait par le panel et non par l'utilisateur : lui laisser
   * désigner un port reviendrait à le laisser demander n'importe quel port de
   * la machine, dont ceux réservés à d'autres serveurs.
   */
  async add(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    if (server.allocationLimit <= 0) {
      throw new BadRequestException(
        "Ce serveur n'est pas autorisé à disposer de ports supplémentaires.",
      );
    }

    const used = await this.prisma.allocation.count({ where: { serverId: server.id } });

    if (used >= server.allocationLimit) {
      throw new ConflictException(
        `Ce serveur utilise déjà ses ${server.allocationLimit} port(s) autorisés.`,
      );
    }

    const free = await this.prisma.allocation.findFirst({
      where: { nodeId: server.nodeId, serverId: null },
      orderBy: [{ ip: 'asc' }, { port: 'asc' }],
    });

    if (!free) {
      throw new ConflictException(
        'Aucun port libre sur ce node. Un administrateur doit en ajouter à la machine.',
      );
    }

    // `updateMany` avec la condition `serverId: null` : deux demandes
    // simultanées ne peuvent pas se voir attribuer le même port, c'est la base
    // qui tranche.
    const claimed = await this.prisma.allocation.updateMany({
      where: { id: free.id, serverId: null },
      data: { serverId: server.id },
    });

    if (claimed.count === 0) {
      throw new ConflictException('Ce port vient d’être attribué ailleurs, réessayez.');
    }

    await this.pushConfiguration(serverUuid, server.nodeId);

    return { id: free.id, ip: free.ip, port: free.port, alias: free.alias, primary: false };
  }

  /** Rend un port au node. Le port principal ne peut pas être retiré. */
  async remove(serverUuid: string, allocationId: number): Promise<void> {
    const server = await this.requireServer(serverUuid);
    await this.requireAllocation(server.id, allocationId);

    if (server.primaryAllocationId === allocationId) {
      throw new ConflictException(
        'Le port principal ne peut pas être retiré. Désignez-en un autre auparavant.',
      );
    }

    await this.prisma.allocation.update({
      where: { id: allocationId },
      data: { serverId: null, alias: null },
    });

    await this.pushConfiguration(serverUuid, server.nodeId);
  }

  /**
   * Renvoie la configuration au daemon.
   *
   * Un échec n'annule pas le changement : il est enregistré en base, et le
   * daemon le récupérera à sa prochaine réconciliation. Refuser l'opération
   * parce que le node est momentanément injoignable laisserait le panel et la
   * machine durablement désaccordés.
   */
  private async pushConfiguration(serverUuid: string, nodeId: number): Promise<void> {
    try {
      const node = await this.prisma.node.findUniqueOrThrow({
        where: { id: nodeId },
        select: { uuid: true },
      });

      const configuration = await this.configurations.build(serverUuid);
      const connection = await this.nodes.getConnection(node.uuid);

      await this.client.syncServer(connection, configuration);
    } catch (error: unknown) {
      this.logger.warn(
        `Synchronisation du serveur ${serverUuid} impossible, elle sera rattrapée au prochain ` +
          `démarrage du daemon : ${String(error)}`,
      );
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({ where: { uuid } });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }

  private async requireAllocation(serverId: number, allocationId: number) {
    const allocation = await this.prisma.allocation.findFirst({
      where: { id: allocationId, serverId },
    });

    if (!allocation) {
      throw new NotFoundException("Ce port n'est pas attribué à ce serveur.");
    }

    return allocation;
  }
}

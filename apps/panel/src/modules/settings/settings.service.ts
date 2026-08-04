import { DAEMON_ROUTES } from '@hopper/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';

/**
 * Paramètres d'un serveur : accès SFTP, identifiants techniques, réinstallation.
 *
 * Le nom d'utilisateur SFTP est **composé ici** et non deviné par l'interface.
 * Son format — `<compte>.<8 premiers caractères de l'UUID>` — encode le serveur
 * visé, faute d'autre canal dans le protocole SFTP pour le transmettre. Le
 * reconstruire côté navigateur créerait une troisième copie de cette règle, à
 * côté de celle du daemon qui l'écrit et de celle du panel qui la relit ; la
 * copie qui dériverait ferait échouer des connexions sans que rien n'explique
 * pourquoi.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  /**
   * Longueur du préfixe d'UUID dans le nom d'utilisateur SFTP.
   * Doit rester égale à `SERVER_ID_LENGTH` du daemon.
   */
  private static readonly SERVER_ID_LENGTH = 8;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
  ) {}

  async get(serverUuid: string, username: string) {
    const server = await this.requireServer(serverUuid);

    return {
      uuid: server.uuid,
      name: server.name,
      description: server.description,
      node: { name: server.node.name, fqdn: server.node.fqdn },
      template: server.template.name,
      status: server.status,
      sftp: {
        address: `sftp://${server.node.fqdn}:${server.node.sftpPort}`,
        username: `${username}.${server.uuid.slice(0, SettingsService.SERVER_ID_LENGTH)}`,
      },
    };
  }

  /**
   * Relance le script d'installation du template.
   *
   * Le daemon arrête le serveur, rejoue l'installation et rapporte le verdict
   * comme lors d'une création. Selon le template, des fichiers peuvent être
   * écrasés — c'est pourquoi l'interface le dit avant de proposer le bouton.
   */
  async reinstall(serverUuid: string): Promise<void> {
    const server = await this.requireServer(serverUuid);

    // Réinstaller un serveur déjà en cours d'installation relancerait un second
    // conteneur d'installation sur le même volume : deux scripts écriraient les
    // mêmes fichiers en même temps.
    if (server.status === 'INSTALLING' || server.status === 'REINSTALLING') {
      throw new ConflictException('Une installation est déjà en cours sur ce serveur.');
    }

    const connection = await this.nodes.getConnection(server.node.uuid);

    // L'état passe à REINSTALLING **avant** l'appel : si le daemon accepte puis
    // que la réponse se perd, le serveur doit tout de même apparaître en cours
    // de réinstallation plutôt que prêt.
    await this.prisma.server.update({
      where: { id: server.id },
      data: { status: 'REINSTALLING' },
    });

    try {
      const response = await this.client.proxy(
        connection,
        DAEMON_ROUTES.serverReinstall(serverUuid),
        {
          method: 'POST',
          body: {},
          timeoutMs: 30_000,
        },
      );

      if (response.status >= 400) {
        throw new Error(`le node a répondu ${response.status}`);
      }
    } catch (error: unknown) {
      await this.prisma.server.update({
        where: { id: server.id },
        data: { status: 'READY' },
      });

      this.logger.error(`Réinstallation de ${serverUuid} refusée : ${String(error)}`);
      throw new ConflictException(
        "La réinstallation n'a pas pu être lancée. Le node est-il joignable ?",
      );
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({
      where: { uuid },
      include: {
        node: { select: { uuid: true, name: true, fqdn: true, sftpPort: true } },
        template: { select: { name: true } },
      },
    });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }
}

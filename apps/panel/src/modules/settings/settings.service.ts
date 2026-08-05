import { DAEMON_ROUTES } from '@hopper/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';

/**
 * A server's settings: SFTP access, technical identifiers, reinstallation.
 *
 * The SFTP username is **composed here** and not guessed by the interface. Its
 * format — `<account>.<first 8 characters of the UUID>` — encodes the target
 * server, for want of another channel in the SFTP protocol to carry it.
 * Rebuilding it browser-side would create a third copy of that rule, beside the
 * daemon's that writes it and the panel's that reads it back; whichever copy
 * drifted would fail connections with nothing to explain why.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  /**
   * Length of the UUID prefix in the SFTP username.
   * Has to stay equal to the daemon's `SERVER_ID_LENGTH`.
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
   * Runs the template's install script again.
   *
   * The daemon stops the server, replays the installation and reports the
   * verdict as it does on a creation. Depending on the template, files may be
   * overwritten — which is why the interface says so before offering the
   * button.
   */
  async reinstall(serverUuid: string): Promise<void> {
    const server = await this.requireServer(serverUuid);

    // Reinstalling a server already installing would launch a second install
    // container on the same volume: two scripts would write the same files at
    // the same time.
    if (server.status === 'INSTALLING' || server.status === 'REINSTALLING') {
      throw new ConflictException('An installation is already running on this server.');
    }

    const connection = await this.nodes.getConnection(server.node.uuid);

    // The state moves to REINSTALLING **before** the call: if the daemon
    // accepts and the response is then lost, the server still has to show as
    // reinstalling rather than ready.
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
        throw new Error(`the node answered ${response.status}`);
      }
    } catch (error: unknown) {
      await this.prisma.server.update({
        where: { id: server.id },
        data: { status: 'READY' },
      });

      this.logger.error(`Reinstall of ${serverUuid} refused: ${String(error)}`);
      throw new ConflictException('The reinstall could not be started. Is the node reachable?');
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
      throw new NotFoundException('Server not found.');
    }

    return server;
  }
}

import { CONSOLE_TOKEN_TTL_SECONDS, PERMISSIONS } from '@hopper/shared';
import { Controller, Get, Param } from '@nestjs/common';
import { TokenService } from '../auth/token.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import { NodesService } from '../nodes/nodes.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface ConsoleCredentials {
  /** URL WebSocket du daemon, à ouvrir directement depuis le navigateur. */
  socketUrl: string;
  token: string;
  /** Durée de vie du jeton, en secondes. */
  expiresIn: number;
}

/**
 * Délivre les identifiants de connexion à la console d'un serveur.
 *
 * Le panel ne relaie **pas** la console : il se contente de signer un jeton de
 * courte durée avec le secret partagé du node, et le navigateur ouvre ensuite
 * un WebSocket directement vers le daemon. C'est ce qui permet à cinquante
 * consoles ouvertes de ne rien coûter au panel, et ce qui rend la console
 * fluide même quand le panel est occupé.
 *
 * Le prix de ce choix : une permission retirée dans le panel ne prend effet
 * qu'au renouvellement du jeton, d'où sa durée de vie volontairement courte.
 */
@Controller('api/servers')
export class ConsoleController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly tokens: TokenService,
  ) {}

  @Get(':serverId/console')
  @RequireServerPermission(PERMISSIONS.WEBSOCKET_CONNECT)
  async credentials(
    @Param('serverId') serverId: string,
    @CurrentUser() user: RequestUser,
    @CurrentServer() server: RequestServer,
  ): Promise<ConsoleCredentials> {
    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
      select: { uuid: true, scheme: true, fqdn: true, port: true },
    });

    const jwtSecret = await this.nodes.getJwtSecret(server.nodeId);

    const token = await this.tokens.signConsoleToken({
      nodeUuid: node.uuid,
      nodeJwtSecret: jwtSecret,
      userUuid: user.uuid,
      serverUuid: serverId,
      // Les permissions sont figées dans le jeton : c'est ce qui permet au
      // daemon de décider seul, sans rappeler le panel à chaque message.
      permissions: server.permissions,
    });

    // wss:// dès que le node est en HTTPS. Un panel servi en HTTPS qui pointe
    // vers un daemon en ws:// verrait ses connexions bloquées par le navigateur
    // au titre du contenu mixte.
    const scheme = node.scheme === 'https' ? 'wss' : 'ws';

    return {
      socketUrl: `${scheme}://${node.fqdn}:${node.port}/api/servers/${serverId}/ws`,
      token,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
    };
  }
}

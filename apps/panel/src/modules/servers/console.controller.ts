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
  /** The daemon's WebSocket URL, to be opened straight from the browser. */
  socketUrl: string;
  token: string;
  /** Token lifetime, in seconds. */
  expiresIn: number;
}

/**
 * Issues the credentials to connect to a server's console.
 *
 * The panel does **not** relay the console: it merely signs a short-lived token
 * with the node's shared secret, and the browser then opens a WebSocket
 * straight to the daemon. That is what lets fifty open consoles cost the panel
 * nothing, and what keeps the console fluid even when the panel is busy.
 *
 * The price of that choice: a permission revoked in the panel only takes effect
 * when the token is renewed, hence its deliberately short lifetime.
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
      // The permissions are frozen into the token: that is what lets the
      // daemon decide on its own, without calling the panel on every message.
      permissions: server.permissions,
    });

    // wss:// as soon as the node is on HTTPS. A panel served over HTTPS
    // pointing at a ws:// daemon would have its connections blocked by the
    // browser as mixed content.
    const scheme = node.scheme === 'https' ? 'wss' : 'ws';

    return {
      socketUrl: `${scheme}://${node.fqdn}:${node.port}/api/servers/${serverId}/ws`,
      token,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
    };
  }
}

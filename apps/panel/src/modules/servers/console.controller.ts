import { CONSOLE_TOKEN_TTL_SECONDS, PERMISSIONS } from '@hopper/shared';
import { Controller, ForbiddenException, Get } from '@nestjs/common';
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
 * The price of that choice: the daemon cannot ask the panel anything about the
 * token it is holding. A revoked permission, a sign-out, a password change, a
 * suspension — none of them reach a console that is already open. They only
 * stop the *renewal*, which comes back through this route and is checked like
 * any other request. `CONSOLE_TOKEN_TTL_SECONDS` is therefore the whole of the
 * revocation delay, and the reason it is two minutes rather than ten.
 */
@Controller('api/servers')
export class ConsoleController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * The `:serverId` in the path is deliberately **not** a parameter of this
   * handler.
   *
   * `ServerPermissionGuard` has already looked that string up and put the row
   * it found on the request, so `server.uuid` is the uuid the database holds
   * rather than the spelling the caller used. Signing the caller's spelling is
   * what would let a request for `3F2504E0-…` produce a token and a socket URL
   * the daemon cannot match against a server it knows by `3f2504e0-…`: a
   * credential issued dead. Taking nothing from the caller here also means the
   * handler's whole input is guard-computed, which is the property the token's
   * permissions rest on.
   */
  @Get(':serverId/console')
  @RequireServerPermission(PERMISSIONS.WEBSOCKET_CONNECT)
  async credentials(
    @CurrentUser() user: RequestUser,
    @CurrentServer() server: RequestServer,
  ): Promise<ConsoleCredentials> {
    /**
     * An API key does not open a console. Refused here, first thing, and not
     * left to the scopes.
     *
     * A key's scope is decided from the HTTP verb — `scopeAllows` — and this
     * route is a `GET`, so a key scoped `read` walks straight through it. What
     * comes back is not a read: it is a token carrying whatever the resolver
     * computed for the account, `control.console` and `control.stop` included
     * for an owner, honoured by a daemon that has no idea a key was involved.
     * On a Minecraft server that is arbitrary command execution from a
     * credential whose whole promise was that it could not stop anything.
     *
     * Requiring `write` instead would only move the problem: a `write` key
     * would then hold a console token off-session, outside every revocation the
     * panel has, for as long as it kept renewing. So the answer is the one
     * `docs/api.md` has always given its readers — the console is for a
     * signed-in browser.
     */
    if (user.authenticatedBy === 'api-key') {
      throw new ForbiddenException(
        'The console cannot be opened with an API key: sign in to the panel.',
      );
    }

    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
      select: { uuid: true, scheme: true, fqdn: true, port: true },
    });

    const jwtSecret = await this.nodes.getJwtSecret(server.nodeId);

    const token = await this.tokens.signConsoleToken({
      nodeUuid: node.uuid,
      nodeJwtSecret: jwtSecret,
      userUuid: user.uuid,
      serverUuid: server.uuid,
      // The permissions are frozen into the token: that is what lets the
      // daemon decide on its own, without calling the panel on every message.
      permissions: server.permissions,
    });

    // wss:// as soon as the node is on HTTPS. A panel served over HTTPS
    // pointing at a ws:// daemon would have its connections blocked by the
    // browser as mixed content.
    const scheme = node.scheme === 'https' ? 'wss' : 'ws';

    return {
      // The same uuid the token names, for the same reason: the daemon refuses
      // a token whose `serverUuid` is not the server the socket was opened on.
      socketUrl: `${scheme}://${node.fqdn}:${node.port}/api/servers/${server.uuid}/ws`,
      token,
      expiresIn: CONSOLE_TOKEN_TTL_SECONDS,
    };
  }
}

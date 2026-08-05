import type { Permission } from '@hopper/shared';
import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_SERVER_PERMISSION_KEY } from '../decorators.js';
import type { AuthenticatedRequest } from '../request-user.js';
import { ServerPermissionResolver } from '../server-permission.resolver.js';

/**
 * Checks that a user holds the permissions required on the server designated by
 * the `:serverId` route parameter.
 *
 * Registered globally after `JwtAuthGuard`, but inert on routes that do not
 * carry `@RequireServerPermission(...)`.
 */
@Injectable()
export class ServerPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: ServerPermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      REQUIRED_SERVER_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new ForbiddenException('Authentification requise.');
    }

    const serverUuid = (request.params as Record<string, string | undefined>).serverId;
    if (!serverUuid) {
      throw new Error(
        '@RequireServerPermission needs a :serverId route parameter carrying the server UUID.',
      );
    }

    const access = await this.resolver.resolve(serverUuid, request.user);

    // 404 and not 403: answering "forbidden" on an existing server would allow
    // enumerating other users' servers by trial and error.
    if (!access) {
      throw new NotFoundException('Server not found.');
    }

    const missing = required.filter((permission) => !access.permissions.includes(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission on this server: ${missing.join(', ')}.`);
    }

    request.serverAccess = access;
    return true;
  }
}

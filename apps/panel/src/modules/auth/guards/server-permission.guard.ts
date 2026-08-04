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
 * Vérifie qu'un utilisateur possède les permissions requises sur le serveur
 * désigné par le paramètre de route `:serverId`.
 *
 * Enregistré globalement à la suite de `JwtAuthGuard`, mais inactif sur les
 * routes qui ne portent pas `@RequireServerPermission(...)`.
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
        "@RequireServerPermission exige un paramètre de route :serverId portant l'UUID du serveur.",
      );
    }

    const access = await this.resolver.resolve(serverUuid, request.user);

    // 404 et non 403 : répondre « interdit » sur un serveur existant permettrait
    // d'énumérer les serveurs des autres utilisateurs par essais successifs.
    if (!access) {
      throw new NotFoundException('Serveur introuvable.');
    }

    const missing = required.filter((permission) => !access.permissions.includes(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Permission manquante sur ce serveur : ${missing.join(', ')}.`);
    }

    request.serverAccess = access;
    return true;
  }
}

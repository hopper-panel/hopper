import type { Permission } from '@hopper/shared';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Utilisateur résolu par `JwtAuthGuard` et attaché à la requête. */
export interface RequestUser {
  id: number;
  uuid: string;
  username: string;
  email: string;
  role: 'ADMIN' | 'USER';
  sessionId: string;
}

/**
 * Serveur résolu par `ServerPermissionGuard`, avec les permissions effectives
 * de l'utilisateur *sur ce serveur*. Les contrôleurs lisent ces permissions
 * plutôt que de refaire la résolution propriétaire/admin/sous-utilisateur.
 */
export interface RequestServer {
  id: number;
  uuid: string;
  nodeId: number;
  permissions: Permission[];
  isOwner: boolean;
}

/**
 * Requête enrichie par les gardes.
 *
 * Le champ s'appelle `serverAccess` et non `server` : Fastify utilise déjà
 * `request.server` pour référencer l'instance Fastify elle-même, et l'écraser
 * casserait le typage de toute requête.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  user?: RequestUser;
  serverAccess?: RequestServer;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      // Ne peut arriver que si le décorateur est utilisé sur une route sans
      // JwtAuthGuard : c'est une erreur de programmation, pas d'exécution.
      throw new Error('CurrentUser utilisé sur une route non protégée par JwtAuthGuard.');
    }

    return request.user;
  },
);

export const CurrentServer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestServer => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.serverAccess) {
      throw new Error(
        'CurrentServer utilisé sur une route sans ServerPermissionGuard, ou sans paramètre :serverId.',
      );
    }

    return request.serverAccess;
  },
);

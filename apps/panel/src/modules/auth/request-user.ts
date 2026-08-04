import type { Permission } from '@hopper/shared';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** User resolved by `JwtAuthGuard` and attached to the request. */
export interface RequestUser {
  id: number;
  uuid: string;
  username: string;
  email: string;
  role: 'ADMIN' | 'USER';
  sessionId: string;
}

/**
 * Server resolved by `ServerPermissionGuard`, with the user's effective
 * permissions *on that server*. Controllers read these permissions rather than
 * redo the owner/admin/subuser resolution.
 */
export interface RequestServer {
  id: number;
  uuid: string;
  nodeId: number;
  permissions: Permission[];
  isOwner: boolean;
}

/**
 * Request enriched by the guards.
 *
 * The field is called `serverAccess` and not `server`: Fastify already uses
 * `request.server` to reference the Fastify instance itself, and overwriting it
 * would break the typing of every request.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  user?: RequestUser;
  serverAccess?: RequestServer;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      // Can only happen if the decorator is used on a route without
      // JwtAuthGuard: that is a programming error, not a runtime one.
      throw new Error('CurrentUser used on a route not protected by JwtAuthGuard.');
    }

    return request.user;
  },
);

export const CurrentServer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestServer => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.serverAccess) {
      throw new Error(
        'CurrentServer used on a route without ServerPermissionGuard, or without a :serverId parameter.',
      );
    }

    return request.serverAccess;
  },
);

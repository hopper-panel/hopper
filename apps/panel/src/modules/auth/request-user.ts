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
  /**
   * Which credential authenticated this request.
   *
   * Stated as a field of its own rather than read off the shape of
   * `sessionId`, which happens to be prefixed `api-key:` for one of the two.
   * A route that has to refuse API keys — the console does — must rest on
   * something a reader can find and a compiler can check, not on a string
   * whose format reads like a logging detail and could be changed by someone
   * improving the logs.
   *
   * Being required rather than optional is the point: a third way of
   * authenticating cannot be added without deciding what it is worth here.
   */
  authenticatedBy: 'session' | 'api-key';
}

/**
 * Application resolved by `JwtAuthGuard` on an `@ApplicationApi()` route.
 *
 * A field of its own rather than a `RequestUser` with invented values. An
 * application key answers for a piece of software, not a person: it has no
 * email to notify, no role to check, no session to revoke and no servers of its
 * own. Fabricating a user to carry it would have every existing route believe a
 * human was there — the audit log would name one, an ownership check would pass
 * or fail on one — which is exactly the confusion the separate identity exists
 * to prevent.
 */
export interface RequestApplication {
  id: number;
  uuid: string;
  /** What an operator called the integration: "Paymenter", "WHMCS". */
  name: string;
  /** Stored form, `resource:level` per entry. Decode it rather than parse it. */
  permissions: string[];
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
  /**
   * Set instead of `user` on the application API. Never both: the guard reaches
   * one branch or the other, and a route that reads the wrong field gets
   * `undefined` rather than a plausible-looking identity.
   */
  application?: RequestApplication;
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

export const CurrentApplication = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestApplication => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.application) {
      // Reachable only by using the decorator on a route that is not marked
      // `@ApplicationApi()`: a programming error, not a runtime one.
      throw new Error('CurrentApplication used on a route without @ApplicationApi().');
    }

    return request.application;
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

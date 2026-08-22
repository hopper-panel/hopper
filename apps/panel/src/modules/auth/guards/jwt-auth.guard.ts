import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { looksLikeApiKey, scopeAllows } from '../../api-keys/api-key.js';
import { ApiKeysService } from '../../api-keys/api-keys.service.js';
import { looksLikeApplicationKey } from '../../application/application-key.js';
import {
  permissionAllows,
  type ApplicationResource,
} from '../../application/application-permissions.js';
import { ApplicationKeysService } from '../../application/application-keys.service.js';
import {
  IS_APPLICATION_API_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_ROLE_KEY,
  UNGOVERNED_APPLICATION_ROUTE,
} from '../decorators.js';
import type { AuthenticatedRequest } from '../request-user.js';
import { TokenService } from '../token.service.js';

/**
 * Global authentication guard.
 *
 * Registered as `APP_GUARD`: every route is protected unless explicitly marked
 * `@Public()`. That is the reverse of the usual reflex, and it is deliberate —
 * on a panel that drives containers, forgetting a guard has to be impossible,
 * not merely unlikely.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
    private readonly applicationKeys: ApplicationKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentication required.');
    }

    // The metadata carries the resource this route is governed by, or the
    // sentinel for the one route no permission governs. Its presence is what
    // makes a route an application route at all.
    const governedBy = this.reflector.getAllAndOverride<string>(IS_APPLICATION_API_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isApplicationRoute = governedBy !== undefined;

    // An application key is recognised by its prefix, before anything is
    // parsed: a malformed `hpa_…` has to be refused as a bad application key
    // rather than fall through and be tried as a session token, which would
    // fail signature verification and say something misleading.
    if (looksLikeApplicationKey(token)) {
      if (!isApplicationRoute) {
        // Named plainly rather than answered with a generic 401. An integrator
        // who points their key at `/api/servers` because that is where the
        // documentation of *personal* keys sent them needs to read what is
        // wrong, and "invalid token" would send them looking at the key.
        throw new ForbiddenException(
          'An application key only opens /api/application. Use a personal API key for the rest.',
        );
      }

      return this.authenticateApplicationKey(request, token, governedBy);
    }

    // The other direction. Without this, a route of the application API would
    // also answer to an administrator's browser session — which sounds
    // harmless and is how an integration ends up half-built: driven from a
    // session that expires, or from a personal key that dies with its owner's
    // account, and discovering the difference on the day it stops.
    if (isApplicationRoute) {
      throw new UnauthorizedException(
        'This route is reached with an application key (hpa_…), created by an administrator.',
      );
    }

    // An API key is recognised by its prefix: mistaking it for a session token
    // would fail signature verification, with a misleading message.
    if (looksLikeApiKey(token)) {
      return this.authenticateApiKey(request, token, context);
    }

    const payload = await this.tokens.verifyAccessToken(token);
    if (!payload) {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    // The session is read back on every request: that is what lets a sign-out
    // or a suspension take effect before the access token expires, at the cost
    // of one indexed query.
    const session = await this.prisma.session.findFirst({
      where: { id: Number(payload.sid), revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        user: {
          select: {
            id: true,
            uuid: true,
            username: true,
            email: true,
            role: true,
            suspended: true,
          },
        },
      },
    });

    if (!session || session.user.uuid !== payload.sub) {
      throw new UnauthorizedException('Session revoked or expired.');
    }

    if (session.user.suspended) {
      throw new ForbiddenException('This account is suspended.');
    }

    request.user = {
      id: session.user.id,
      uuid: session.user.uuid,
      username: session.user.username,
      email: session.user.email,
      // The role comes from the database, not the token: promoting or
      // demoting a user has to take effect at once, without waiting for them to
      // reconnecte.
      role: session.user.role,
      sessionId: payload.sid,
      authenticatedBy: 'session',
    };

    const requiredRole = this.reflector.getAllAndOverride<string>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole === 'ADMIN' && request.user.role !== 'ADMIN') {
      throw new ForbiddenException('This action is for administrators only.');
    }

    return true;
  }

  /**
   * Authenticates a request carrying an application key.
   *
   * Shorter than its personal-key counterpart, and every missing check is a
   * check that has nowhere to happen: there is no account to find suspended,
   * no role to re-read, no session to see revoked. What is left is the key
   * itself — its secret, its expiry, its revocation, the address it came from
   * — and its scope.
   */
  private async authenticateApplicationKey(
    request: AuthenticatedRequest,
    token: string,
    governedBy: string,
  ): Promise<boolean> {
    const key = await this.applicationKeys.authenticate(token, request.ip);

    if (!key) {
      throw new UnauthorizedException('Application key invalid, expired or revoked.');
    }

    if (governedBy !== UNGOVERNED_APPLICATION_ROUTE) {
      const resource = governedBy as ApplicationResource;

      if (!permissionAllows(key.permissions, resource, request.method)) {
        // The resource is named, and the level asked for with it. "Insufficient
        // permissions" sends an integrator to re-read the whole matrix; this
        // sends them to one line of it.
        const needed = request.method === 'GET' ? 'read' : 'read & write';

        throw new ForbiddenException(`This key is not granted ${needed} on ${resource}.`);
      }
    }

    request.application = {
      id: key.id,
      uuid: key.uuid,
      name: key.name,
      permissions: key.permissions,
    };

    // `request.user` is deliberately left unset. Nothing downstream should be
    // able to mistake this for a person acting.
    return true;
  }

  /**
   * Authenticates a request carrying an API key.
   *
   * Two guardrails a session does not have: the key's **scope** — a read key
   * must not be able to stop a server — and the fact that it only opens the
   * administration if it was created for that. The account's role is checked on
   * top, so a demotion takes effect without having to revoke keys one by one.
   */
  private async authenticateApiKey(
    request: AuthenticatedRequest,
    token: string,
    context: ExecutionContext,
  ): Promise<boolean> {
    const key = await this.apiKeys.authenticate(token, request.ip);

    if (!key) {
      throw new UnauthorizedException('API key invalid, expired or revoked.');
    }

    // `request.url` carries the query string: only the path is compared.
    const path = request.url.split('?')[0] ?? '';

    if (!scopeAllows(key.scopes, request.method, path)) {
      throw new ForbiddenException(
        `This key does not have the necessary scope (${key.scopes.join(', ') || 'none'}).`,
      );
    }

    request.user = {
      id: key.user.id,
      uuid: key.user.uuid,
      username: key.user.username,
      email: key.user.email,
      role: key.user.role,
      // A key opens no session: there is nothing to revoke on the session
      // side, and the identifier tells the origin apart in the logs.
      sessionId: `api-key:${key.id}`,
      // Read by the console route, which refuses to mint a daemon credential
      // for a key: a key's scope is decided from the HTTP verb, and the console
      // is handed out by a GET.
      authenticatedBy: 'api-key',
    };

    const requiredRole = this.reflector.getAllAndOverride<string>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole === 'ADMIN' && key.user.role !== 'ADMIN') {
      throw new ForbiddenException('This action is for administrators only.');
    }

    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && value) {
        return value;
      }
    }

    // Falls back to the cookie, used by the web interface. An API key is never
    // there: it always presents itself in a header. Requests authenticated by
    // cookie are protected against CSRF by
    // `SameSite=Lax` and by the fact the API only accepts JSON.
    const cookie = request.cookies?.hopper_access;
    return cookie ?? null;
  }
}

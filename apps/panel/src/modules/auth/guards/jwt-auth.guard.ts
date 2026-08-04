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
import { IS_PUBLIC_KEY, REQUIRED_ROLE_KEY } from '../decorators.js';
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
      throw new UnauthorizedException('Authentification requise.');
    }

    // An API key is recognised by its prefix: mistaking it for a session token
    // would fail signature verification, with a message
    // trompeur.
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
      throw new ForbiddenException('Ce compte est suspendu.');
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

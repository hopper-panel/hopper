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
 * Garde global d'authentification.
 *
 * Enregistré en `APP_GUARD` : toute route est protégée sauf marquage `@Public()`
 * explicite. C'est l'inverse du réflexe habituel, et c'est délibéré — sur un
 * panel qui pilote des conteneurs, oublier un garde doit être impossible, pas
 * seulement improbable.
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

    // Une clé d'API se reconnaît à son préfixe : la confondre avec un jeton de
    // session la ferait échouer à la vérification de signature, avec un message
    // trompeur.
    if (looksLikeApiKey(token)) {
      return this.authenticateApiKey(request, token, context);
    }

    const payload = await this.tokens.verifyAccessToken(token);
    if (!payload) {
      throw new UnauthorizedException('Jeton invalide ou expiré.');
    }

    // La session est relue à chaque requête : c'est ce qui permet à une
    // déconnexion ou à une suspension de prendre effet avant l'expiration de
    // l'access token, au prix d'une requête indexée.
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
      throw new UnauthorizedException('Session révoquée ou expirée.');
    }

    if (session.user.suspended) {
      throw new ForbiddenException('Ce compte est suspendu.');
    }

    request.user = {
      id: session.user.id,
      uuid: session.user.uuid,
      username: session.user.username,
      email: session.user.email,
      // Le rôle vient de la base, pas du jeton : promouvoir ou rétrograder un
      // utilisateur doit prendre effet immédiatement, sans attendre qu'il se
      // reconnecte.
      role: session.user.role,
      sessionId: payload.sid,
    };

    const requiredRole = this.reflector.getAllAndOverride<string>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole === 'ADMIN' && request.user.role !== 'ADMIN') {
      throw new ForbiddenException('Cette action est réservée aux administrateurs.');
    }

    return true;
  }

  /**
   * Authentifie une requête portant une clé d'API.
   *
   * Deux garde-fous que la session n'a pas : la **portée** de la clé — une clé
   * de lecture ne doit pas pouvoir éteindre un serveur — et le fait qu'elle
   * n'ouvre l'administration que si elle a été créée pour cela. Le rôle du
   * compte est vérifié en plus, pour qu'une rétrogradation prenne effet sans
   * qu'on ait à révoquer les clés une à une.
   */
  private async authenticateApiKey(
    request: AuthenticatedRequest,
    token: string,
    context: ExecutionContext,
  ): Promise<boolean> {
    const key = await this.apiKeys.authenticate(token, request.ip);

    if (!key) {
      throw new UnauthorizedException('Clé d’API invalide, expirée ou révoquée.');
    }

    // `request.url` porte la chaîne de requête : on ne compare que le chemin.
    const path = request.url.split('?')[0] ?? '';

    if (!scopeAllows(key.scopes, request.method, path)) {
      throw new ForbiddenException(
        `Cette clé n’a pas la portée nécessaire (${key.scopes.join(', ') || 'aucune'}).`,
      );
    }

    request.user = {
      id: key.user.id,
      uuid: key.user.uuid,
      username: key.user.username,
      email: key.user.email,
      role: key.user.role,
      // Une clé n'ouvre pas de session : il n'y a rien à révoquer côté sessions,
      // et l'identifiant sert à distinguer l'origine dans les journaux.
      sessionId: `api-key:${key.id}`,
    };

    const requiredRole = this.reflector.getAllAndOverride<string>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole === 'ADMIN' && key.user.role !== 'ADMIN') {
      throw new ForbiddenException('Cette action est réservée aux administrateurs.');
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

    // Repli sur le cookie, utilisé par l'interface web. Une clé d'API ne s'y
    // trouve jamais : elle se présente toujours en en-tête. Les requêtes qui
    // s'authentifient par cookie sont protégées contre le CSRF par
    // `SameSite=Lax` et par le fait que l'API n'accepte que du JSON.
    const cookie = request.cookies?.hopper_access;
    return cookie ?? null;
  }
}

import { timingSafeEqual } from 'node:crypto';
import { extractBearerToken, parseNodeToken } from '@hopper/shared';
import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedRequest } from '../auth/request-user.js';

/** Node authentifié, attaché à la requête pour les contrôleurs `/api/remote/*`. */
export interface RequestNode {
  id: number;
  uuid: string;
  name: string;
}

export interface RemoteRequest extends AuthenticatedRequest {
  node?: RequestNode;
}

/**
 * Authentifie un daemon qui rappelle le panel.
 *
 * Les routes `/api/remote/*` ne sont jamais appelées par un navigateur : elles
 * exigent un jeton de node, jamais un cookie de session. Un utilisateur
 * connecté qui tenterait de les atteindre reçoit une 401 comme n'importe qui,
 * puisque seul le jeton compte ici.
 */
@Injectable()
export class RemoteNodeGuard implements CanActivate {
  private readonly logger = new Logger(RemoteNodeGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RemoteRequest>();

    const token = extractBearerToken(request.headers.authorization);
    const parsed = token ? parseNodeToken(token) : null;

    if (!parsed) {
      throw new UnauthorizedException('Jeton de node absent ou mal formé.');
    }

    // L'identifiant est public : il sert uniquement à retrouver la ligne sans
    // avoir à comparer le secret à toute la table.
    const node = await this.prisma.node.findUnique({
      where: { daemonTokenId: parsed.id },
      select: { id: true, uuid: true, name: true, daemonTokenEncrypted: true },
    });

    if (!node || !this.secretMatches(node.daemonTokenEncrypted, parsed.secret)) {
      this.logger.warn(`Authentification de node refusée depuis ${request.ip}`);
      // Message identique dans les deux cas : distinguer « identifiant inconnu »
      // de « secret erroné » permettrait d'énumérer les nodes.
      throw new UnauthorizedException('Jeton de node invalide.');
    }

    request.node = { id: node.id, uuid: node.uuid, name: node.name };
    return true;
  }

  private secretMatches(encrypted: string, candidate: string): boolean {
    let expected: string;

    try {
      expected = this.crypto.decrypt(encrypted);
    } catch (error: unknown) {
      // Arrive quand APP_SECRET a changé : les secrets stockés deviennent
      // illisibles. Le node doit alors être régénéré, et le dire clairement
      // vaut mieux qu'un refus silencieux.
      this.logger.error(
        `Secret de node indéchiffrable — APP_SECRET a-t-il changé ? ${String(error)}`,
      );
      return false;
    }

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(candidate, 'utf8');

    if (a.length !== b.length) {
      timingSafeEqual(a, a);
      return false;
    }

    return timingSafeEqual(a, b);
  }
}

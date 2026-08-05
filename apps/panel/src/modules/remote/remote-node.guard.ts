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

/** Authenticated node, attached to the request for the `/api/remote/*` controllers. */
export interface RequestNode {
  id: number;
  uuid: string;
  name: string;
}

export interface RemoteRequest extends AuthenticatedRequest {
  node?: RequestNode;
}

/**
 * Authenticates a daemon calling the panel back.
 *
 * The `/api/remote/*` routes are never called by a browser: they require a node
 * token, never a session cookie. A signed-in user trying to reach them receives
 * a 401 like anybody else, since only the token counts here.
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
      throw new UnauthorizedException('Node token absent or malformed.');
    }

    // The identifier is public: it only serves to find the row without having
    // to compare the secret against the whole table.
    const node = await this.prisma.node.findUnique({
      where: { daemonTokenId: parsed.id },
      select: { id: true, uuid: true, name: true, daemonTokenEncrypted: true },
    });

    if (!node || !this.secretMatches(node.daemonTokenEncrypted, parsed.secret)) {
      this.logger.warn(`Node authentication refused from ${request.ip}`);
      // The same message in both cases: telling "unknown identifier" from
      // "wrong secret" would allow enumerating the nodes.
      throw new UnauthorizedException('Invalid node token.');
    }

    request.node = { id: node.id, uuid: node.uuid, name: node.name };
    return true;
  }

  private secretMatches(encrypted: string, candidate: string): boolean {
    let expected: string;

    try {
      expected = this.crypto.decrypt(encrypted);
    } catch (error: unknown) {
      // Happens when APP_SECRET changed: the stored secrets become unreadable.
      // The node then has to be regenerated, and saying so plainly beats a
      // silent refusal.
      this.logger.error(
        `Node secret cannot be decrypted — did APP_SECRET change? ${String(error)}`,
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

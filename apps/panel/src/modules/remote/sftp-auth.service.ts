import {
  ALL_PERMISSIONS,
  sanitizePermissions,
  type SftpAuthRequest,
  type SftpAuthResponse,
} from '@hopper/shared';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';

/** Ten attempts per quarter of an hour, per IP. */
const SFTP_ATTEMPT_LIMIT = 10;
const SFTP_WINDOW_SECONDS = 15 * 60;

/**
 * Authenticating SFTP connections.
 *
 * The daemon knows neither the accounts nor the permissions: it forwards the
 * identifier / password pair and receives back the authorised server and the
 * permissions to apply.
 *
 * Rate limiting matters here as much as on the web sign-in — more, even: an
 * SFTP client retries automatically, and a script guessing passwords through
 * that channel leaves no trace in the browser's logs.
 */
@Injectable()
export class SftpAuthService {
  private readonly logger = new Logger(SftpAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
  ) {}

  async authenticate(request: SftpAuthRequest, nodeId: number): Promise<SftpAuthResponse> {
    await this.assertNotRateLimited(request.ip);

    const separator = request.username.lastIndexOf('.');

    if (separator <= 0) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const username = request.username.slice(0, separator);
    const serverIdPrefix = request.username.slice(separator + 1).toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });

    // The hash is verified even when no user was found: without that, a
    // non-existent account would answer far faster than a valid one.
    const valid = user
      ? await this.passwords.verify(user.passwordHash, request.password)
      : await this.passwords.verify(
          '$argon2id$v=19$m=19456,t=2,p=1$c2VsCg$aGFzaAo',
          request.password,
        );

    if (!user || !valid || user.suspended) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_FAILED,
        actorId: user?.id ?? null,
        ip: request.ip,
        metadata: { channel: 'sftp', username: request.username },
      });

      throw new UnauthorizedException('Invalid credentials.');
    }

    // The server has to belong to the node asking: a compromised node must not
    // be able to authenticate access to another node's servers.
    const server = await this.prisma.server.findFirst({
      where: { nodeId, uuid: { startsWith: serverIdPrefix } },
      select: {
        id: true,
        uuid: true,
        ownerId: true,
        status: true,
        subusers: { where: { userId: user.id }, select: { permissions: true } },
      },
    });

    if (!server) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (server.status === 'SUSPENDED') {
      throw new UnauthorizedException('This server is suspended.');
    }

    const isOwner = server.ownerId === user.id;
    const subuser = server.subusers[0];

    if (!isOwner && user.role !== 'ADMIN' && !subuser) {
      // The same message as a wrong password: telling the two apart would allow
      // enumerating the servers by their UUID prefix.
      throw new UnauthorizedException('Invalid credentials.');
    }

    const permissions =
      isOwner || user.role === 'ADMIN'
        ? [...ALL_PERMISSIONS]
        : sanitizePermissions(subuser?.permissions ?? []);

    await this.rateLimiter.reset(this.key(request.ip));

    this.logger.log(`SFTP sign-in by ${user.username} on server ${server.uuid}`);

    await this.audit.record({
      event: AUDIT_EVENTS.LOGIN_SUCCESS,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      metadata: { channel: 'sftp' },
    });

    return { serverUuid: server.uuid, userUuid: user.uuid, permissions };
  }

  private key(ip: string): string {
    return `sftp:auth:${ip}`;
  }

  private async assertNotRateLimited(ip: string): Promise<void> {
    const result = await this.rateLimiter.consume(
      this.key(ip),
      SFTP_ATTEMPT_LIMIT,
      SFTP_WINDOW_SECONDS,
    );

    if (!result.allowed) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_BLOCKED,
        ip,
        metadata: { channel: 'sftp', reason: 'rate-limited' },
      });

      throw new HttpException('Too many SFTP attempts.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

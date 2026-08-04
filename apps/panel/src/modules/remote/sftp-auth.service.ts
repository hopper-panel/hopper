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

/** Dix tentatives par quart d'heure et par IP. */
const SFTP_ATTEMPT_LIMIT = 10;
const SFTP_WINDOW_SECONDS = 15 * 60;

/**
 * Authentification des connexions SFTP.
 *
 * Le daemon ne connaît ni les comptes ni les permissions : il transmet le
 * couple identifiant / mot de passe et reçoit en retour le serveur autorisé et
 * les permissions à appliquer.
 *
 * La limitation de débit vaut ici autant que sur la connexion web — davantage
 * même : un client SFTP réessaie automatiquement, et un script qui devine des
 * mots de passe par ce canal ne laisse aucune trace dans les journaux du
 * navigateur.
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
      throw new UnauthorizedException('Identifiants incorrects.');
    }

    const username = request.username.slice(0, separator);
    const serverIdPrefix = request.username.slice(separator + 1).toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });

    // Le hash est vérifié même sans utilisateur trouvé : sans cela, un compte
    // inexistant répondrait bien plus vite qu'un compte valide.
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

      throw new UnauthorizedException('Identifiants incorrects.');
    }

    // Le serveur doit appartenir au node qui pose la question : un node
    // compromis ne doit pas pouvoir authentifier l'accès aux serveurs d'un
    // autre node.
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
      throw new UnauthorizedException('Identifiants incorrects.');
    }

    if (server.status === 'SUSPENDED') {
      throw new UnauthorizedException('Ce serveur est suspendu.');
    }

    const isOwner = server.ownerId === user.id;
    const subuser = server.subusers[0];

    if (!isOwner && user.role !== 'ADMIN' && !subuser) {
      // Message identique au mot de passe erroné : distinguer les deux
      // permettrait d'énumérer les serveurs par leur préfixe d'UUID.
      throw new UnauthorizedException('Identifiants incorrects.');
    }

    const permissions =
      isOwner || user.role === 'ADMIN'
        ? [...ALL_PERMISSIONS]
        : sanitizePermissions(subuser?.permissions ?? []);

    await this.rateLimiter.reset(this.key(request.ip));

    this.logger.log(`Connexion SFTP de ${user.username} sur le serveur ${server.uuid}`);

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

      throw new HttpException('Trop de tentatives SFTP.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

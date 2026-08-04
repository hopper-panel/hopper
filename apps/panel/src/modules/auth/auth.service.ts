import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { PasswordService } from './password.service.js';
import { REFRESH_TOKEN_TTL_SECONDS, TokenService, fingerprintOf } from './token.service.js';
import { TotpService } from './totp.service.js';

/** Cinq tentatives par quart d'heure, par IP et par identifiant visé. */
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface RequestContext {
  ip: string;
  userAgent?: string;
}

export interface AuthenticatedUser {
  uuid: string;
  username: string;
  email: string;
  role: 'ADMIN' | 'USER';
  twoFactorEnabled: boolean;
}

export type LoginResult =
  | { status: 'authenticated'; accessToken: string; refreshToken: string; user: AuthenticatedUser }
  | { status: 'two-factor-required' };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    private readonly crypto: CryptoService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Connexion
  // -------------------------------------------------------------------------

  async login(
    identifier: string,
    password: string,
    totpCode: string | undefined,
    context: RequestContext,
  ): Promise<LoginResult> {
    await this.assertNotRateLimited(identifier, context);

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier.toLowerCase() },
          // Le nom d'utilisateur est comparé sans tenir compte de la casse :
          // sans cela, « Julien » et « julien » seraient deux comptes distincts
          // pour l'utilisateur alors que la base les distingue déjà.
          { username: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });

    // Le hash est vérifié même sans utilisateur trouvé, contre une empreinte
    // factice : sans cela, un identifiant inexistant répondrait en 1 ms et un
    // identifiant valide en 50 ms, ce qui suffit à énumérer les comptes.
    const passwordValid = user
      ? await this.passwords.verify(user.passwordHash, password)
      : await this.burnPasswordVerification(password);

    if (!user || !passwordValid) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_FAILED,
        actorId: user?.id ?? null,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { identifier, reason: user ? 'bad-password' : 'unknown-user' },
      });
      throw new UnauthorizedException('Identifiants incorrects.');
    }

    if (user.suspended) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_BLOCKED,
        actorId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'suspended' },
      });
      throw new ForbiddenException('Ce compte est suspendu.');
    }

    if (user.totpConfirmed && user.totpSecret) {
      if (!totpCode) {
        // Répondre « code requis » confirme que le mot de passe était bon.
        // C'est le compromis habituel : l'alternative — un écran de code
        // toujours affiché, même pour un mot de passe faux — dégrade
        // l'expérience pour tout le monde. La limitation de débit ci-dessus est
        // ce qui rend l'information peu exploitable.
        return { status: 'two-factor-required' };
      }

      const accepted = await this.consumeSecondFactor(user, totpCode, context);
      if (!accepted) {
        await this.audit.record({
          event: AUDIT_EVENTS.TWO_FACTOR_FAILED,
          actorId: user.id,
          ip: context.ip,
          userAgent: context.userAgent,
        });
        throw new UnauthorizedException('Code de double authentification invalide.');
      }
    }

    await this.rateLimiter.reset(this.loginKey(identifier, context.ip));
    await this.upgradePasswordHashIfNeeded(user, password);

    const session = await this.createSession(user, context);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: context.ip },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.LOGIN_SUCCESS,
      actorId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      status: 'authenticated',
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: this.toAuthenticatedUser(user),
    };
  }

  // -------------------------------------------------------------------------
  // Rafraîchissement et révocation
  // -------------------------------------------------------------------------

  /**
   * Échange un refresh token contre un nouveau couple de jetons.
   *
   * La rotation est systématique et l'ancien jeton est conservé en base, révoqué.
   * Le présenter à nouveau signale qu'il a été volé : toute la famille de
   * sessions est alors révoquée, ce qui déconnecte aussi bien l'attaquant que
   * l'utilisateur légitime. C'est voulu — mieux vaut une reconnexion qu'une
   * session pillée en silence.
   */
  async refresh(
    refreshToken: string,
    context: RequestContext,
  ): Promise<{ accessToken: string; refreshToken: string; user: AuthenticatedUser }> {
    const tokenHash = this.crypto.hashToken(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException('Session inconnue ou expirée.');
    }

    if (session.revokedAt) {
      this.logger.warn(
        `Réutilisation d'un refresh token révoqué (utilisateur ${session.user.uuid}) : révocation de la famille ${session.family}`,
      );

      await this.prisma.session.updateMany({
        where: { family: session.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.audit.record({
        event: AUDIT_EVENTS.TOKEN_REUSE_DETECTED,
        actorId: session.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { family: session.family },
      });

      throw new UnauthorizedException('Session révoquée. Reconnectez-vous.');
    }

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expirée.');
    }

    if (session.user.suspended) {
      throw new ForbiddenException('Ce compte est suspendu.');
    }

    const rotated = await this.createSession(session.user, context, session.family);

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      user: this.toAuthenticatedUser(session.user),
    };
  }

  async logout(refreshToken: string, context: RequestContext): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.crypto.hashToken(refreshToken) },
    });

    if (!session) {
      // Déconnecter une session déjà absente est un succès : renvoyer une
      // erreur laisserait un client incapable de se remettre dans un état sain.
      return;
    }

    await this.prisma.session.updateMany({
      where: { family: session.family, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.LOGOUT,
      actorId: session.userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /** Révoque toutes les sessions d'un utilisateur. */
  async revokeAllSessions(userId: number): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Double authentification
  // -------------------------------------------------------------------------

  /**
   * Prépare l'activation de la 2FA : génère un secret et l'URI de provisioning.
   * Le secret est stocké mais `totpConfirmed` reste faux tant qu'un premier
   * code n'a pas été validé — sans quoi une application mal configurée
   * verrouillerait le compte.
   */
  async beginTwoFactorSetup(userId: number): Promise<{ secret: string; provisioningUri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (user.totpConfirmed) {
      throw new ForbiddenException('La double authentification est déjà active.');
    }

    const secret = this.totp.generateSecret();

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: this.crypto.encrypt(secret), totpConfirmed: false },
    });

    return {
      secret,
      provisioningUri: this.totp.buildProvisioningUri(secret, user.email),
    };
  }

  /** Valide le premier code et active la 2FA. Retourne les codes de récupération. */
  async confirmTwoFactorSetup(
    userId: number,
    code: string,
    context: RequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!user.totpSecret) {
      throw new ForbiddenException("Aucune activation de double authentification n'est en cours.");
    }

    if (!this.totp.verify(this.crypto.decrypt(user.totpSecret), code)) {
      throw new UnauthorizedException('Code invalide.');
    }

    const codes = Array.from({ length: 10 }, () => this.crypto.randomRecoveryCode());

    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({
        data: codes.map((code) => ({ userId, codeHash: this.crypto.hashToken(code) })),
      }),
      this.prisma.user.update({ where: { id: userId }, data: { totpConfirmed: true } }),
    ]);

    await this.audit.record({
      event: AUDIT_EVENTS.TWO_FACTOR_ENABLED,
      actorId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { recoveryCodes: codes };
  }

  /**
   * Désactive la 2FA. Le mot de passe est redemandé : sans cela, un attaquant
   * ayant volé une session vivante retirerait le second facteur sans effort.
   */
  async disableTwoFactor(userId: number, password: string, context: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Mot de passe incorrect.');
    }

    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpConfirmed: false },
      }),
    ]);

    await this.audit.record({
      event: AUDIT_EVENTS.TWO_FACTOR_DISABLED,
      actorId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  // -------------------------------------------------------------------------
  // Mot de passe
  // -------------------------------------------------------------------------

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Mot de passe actuel incorrect.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });

    // Un changement de mot de passe fait souvent suite à un soupçon de
    // compromission : toutes les autres sessions doivent tomber.
    await this.revokeAllSessions(userId);

    await this.audit.record({
      event: AUDIT_EVENTS.PASSWORD_CHANGED,
      actorId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /** État du compte, pour l'écran « Mon compte » et l'exigence de second facteur. */
  async describeAccount(userId: number): Promise<{ twoFactorEnabled: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpConfirmed: true },
    });

    return { twoFactorEnabled: user.totpConfirmed };
  }

  /**
   * Choix du mot de passe initial, depuis le lien reçu par courriel.
   *
   * Le jeton porte une empreinte du mot de passe en vigueur à son émission :
   * s'il a changé depuis — parce que le lien a déjà servi, ou qu'un
   * administrateur est passé par là — l'empreinte ne correspond plus et le lien
   * est refusé. C'est ce qui le rend à usage unique sans table de jetons.
   *
   * La limitation de débit s'applique comme à une connexion : le jeton est
   * signé, mais rien n'empêche d'essayer.
   */
  async setPasswordFromToken(
    token: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    const claims = await this.tokens.verifyPasswordSetup(token);

    if (!claims) {
      await this.penalizeSetupFailure(context);
      throw new UnauthorizedException('Ce lien est invalide ou a expiré.');
    }

    const user = await this.prisma.user.findUnique({ where: { uuid: claims.userUuid } });

    if (!user || fingerprintOf(user.passwordHash) !== claims.fingerprint) {
      await this.penalizeSetupFailure(context);
      throw new UnauthorizedException('Ce lien a déjà servi, ou a expiré.');
    }

    if (user.suspended) {
      throw new UnauthorizedException('Ce compte est suspendu.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });

    await this.revokeAllSessions(user.id);

    await this.audit.record({
      event: AUDIT_EVENTS.PASSWORD_CHANGED,
      actorId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { source: 'invitation' },
    });
  }

  // -------------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------------

  private loginKey(identifier: string, ip: string): string {
    return `auth:login:${ip}:${identifier.toLowerCase()}`;
  }

  /**
   * Décompte une tentative **ratée** de choix de mot de passe.
   *
   * Seuls les échecs comptent, à la différence de la connexion : un lien valide
   * est un jeton signé, il n'y a rien à deviner par force brute. Compter les
   * réussites bloquerait un bureau entier derrière une même adresse — cinq
   * comptes créés, et le sixième arriverait devant une porte close.
   */
  private async penalizeSetupFailure(context: RequestContext): Promise<void> {
    const result = await this.rateLimiter.consume(
      `password-setup:${context.ip}`,
      LOGIN_ATTEMPT_LIMIT,
      LOGIN_WINDOW_SECONDS,
    );

    if (!result.allowed) {
      throw new HttpException(
        `Trop de tentatives. Réessayez dans ${result.resetInSeconds} secondes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async assertNotRateLimited(identifier: string, context: RequestContext): Promise<void> {
    const result = await this.rateLimiter.consume(
      this.loginKey(identifier, context.ip),
      LOGIN_ATTEMPT_LIMIT,
      LOGIN_WINDOW_SECONDS,
    );

    if (!result.allowed) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_BLOCKED,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { identifier, reason: 'rate-limited' },
      });

      // Nest n'expose pas d'exception dédiée au 429.
      throw new HttpException(
        `Trop de tentatives. Réessayez dans ${result.resetInSeconds} secondes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Consomme du temps CPU équivalent à une vérification réelle, pour que le
   * temps de réponse ne trahisse pas l'inexistence d'un compte.
   */
  private async burnPasswordVerification(password: string): Promise<boolean> {
    await this.passwords.verify(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZC1zYWx0$hFtzE0aTQjR7VZKPVlPfzXLLbFmS0nSNBt1JxfJDCXo',
      password,
    );
    return false;
  }

  /** Accepte un code TOTP ou un code de récupération à usage unique. */
  private async consumeSecondFactor(
    user: User,
    code: string,
    context: RequestContext,
  ): Promise<boolean> {
    if (user.totpSecret && this.totp.verify(this.crypto.decrypt(user.totpSecret), code)) {
      return true;
    }

    const normalized = code.trim().toUpperCase();
    const recovery = await this.prisma.recoveryCode.findFirst({
      where: { userId: user.id, usedAt: null, codeHash: this.crypto.hashToken(normalized) },
    });

    if (!recovery) {
      return false;
    }

    // Marqué immédiatement : un code de récupération ne sert qu'une fois, même
    // si deux requêtes arrivent en parallèle (la clause `usedAt: null` du
    // updateMany fait office de verrou optimiste).
    const consumed = await this.prisma.recoveryCode.updateMany({
      where: { id: recovery.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (consumed.count === 0) {
      return false;
    }

    await this.audit.record({
      event: AUDIT_EVENTS.RECOVERY_CODE_USED,
      actorId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { remaining: await this.countUnusedRecoveryCodes(user.id) },
    });

    return true;
  }

  private async countUnusedRecoveryCodes(userId: number): Promise<number> {
    return this.prisma.recoveryCode.count({ where: { userId, usedAt: null } });
  }

  /**
   * Réencode le mot de passe si les paramètres Argon2 ont durci depuis sa
   * création. C'est le seul instant où le clair est disponible.
   */
  private async upgradePasswordHashIfNeeded(user: User, password: string): Promise<void> {
    if (!this.passwords.needsRehash(user.passwordHash)) {
      return;
    }

    this.logger.log(`Réencodage du mot de passe de ${user.username} avec les paramètres courants`);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(password) },
    });
  }

  private async createSession(
    user: User,
    context: RequestContext,
    family?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { token, hash } = this.tokens.generateRefreshToken();
    const sessionFamily = family ?? this.tokens.generateSessionFamily();

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        family: sessionFamily,
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 500),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });

    const accessToken = await this.tokens.signAccessToken({
      sub: user.uuid,
      username: user.username,
      role: user.role,
      sid: String(session.id),
    });

    return { accessToken, refreshToken: token };
  }

  private toAuthenticatedUser(user: User): AuthenticatedUser {
    return {
      uuid: user.uuid,
      username: user.username,
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.totpConfirmed,
    };
  }
}

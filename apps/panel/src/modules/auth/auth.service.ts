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
import { AUDIT_EVENTS, AuditService, type AuditEvent } from '../audit/audit.service.js';
import { PasswordService } from './password.service.js';
import { REFRESH_TOKEN_TTL_SECONDS, TokenService, fingerprintOf } from './token.service.js';
import { TotpService } from './totp.service.js';

/** Five attempts per quarter of an hour, per IP and per targeted identifier. */
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
  // Sign-in
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
          // The username is compared case-insensitively: without this,
          // "Julien" and "julien" would look like two separate accounts to the
          // user even though the database already tells them apart.
          { username: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });

    // The hash is verified even when no user was found, against a dummy
    // digest: without this, a non-existent identifier would answer in 1ms and a
    // valid one in 50ms, which is enough to enumerate the accounts.
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
      throw new UnauthorizedException('Incorrect credentials.');
    }

    if (user.suspended) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_BLOCKED,
        actorId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'suspended' },
      });
      throw new ForbiddenException('This account is suspended.');
    }

    if (user.totpConfirmed && user.totpSecret) {
      if (!totpCode) {
        // Answering "code required" confirms the password was right. That is
        // the usual trade-off: the alternative — a code screen shown always,
        // even for a wrong password — degrades the experience for everyone. The
        // rate limit above is what makes the information hard to exploit.
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
        throw new UnauthorizedException('Invalid two-factor code.');
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
  // Refresh and revocation
  // -------------------------------------------------------------------------

  /**
   * Exchanges a refresh token for a fresh pair of tokens.
   *
   * Rotation is systematic and the old token is kept in the database, revoked.
   * Presenting it again signals it was stolen: the whole session family is then
   * revoked, which signs out the attacker and the legitimate user alike. That
   * is intended — a re-login beats a session quietly plundered.
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
      throw new UnauthorizedException('Unknown or expired session.');
    }

    if (session.revokedAt) {
      this.logger.warn(
        `Reuse of a revoked refresh token (user ${session.user.uuid}): revoking family ${session.family}`,
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

      throw new UnauthorizedException('Session revoked. Sign in again.');
    }

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expired.');
    }

    if (session.user.suspended) {
      throw new ForbiddenException('This account is suspended.');
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
      // Signing out an already-absent session is a success: returning an
      // error would leave a client unable to get back to a sane state.
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

  /** Revokes every session of a user. */
  async revokeAllSessions(userId: number): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Two-factor authentication
  // -------------------------------------------------------------------------

  /**
   * Prepares turning 2FA on: generates a secret and the provisioning URI.
   * The secret is stored but `totpConfirmed` stays false until a first code has
   * been validated — otherwise a misconfigured app would lock the account.
   */
  async beginTwoFactorSetup(userId: number): Promise<{ secret: string; provisioningUri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (user.totpConfirmed) {
      throw new ForbiddenException('Two-factor authentication is already on.');
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

  /** Validates the first code and turns 2FA on. Returns the recovery codes. */
  async confirmTwoFactorSetup(
    userId: number,
    code: string,
    context: RequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!user.totpSecret) {
      throw new ForbiddenException('No two-factor setup is under way.');
    }

    if (!this.totp.verify(this.crypto.decrypt(user.totpSecret), code)) {
      throw new UnauthorizedException('Invalid code.');
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
   * Turns 2FA off. The password is asked again: without it, an attacker holding
   * a live session would remove the second factor with no effort at all.
   */
  async disableTwoFactor(userId: number, password: string, context: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Incorrect password.');
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
  // Password
  // -------------------------------------------------------------------------

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });

    // A password change often follows a suspicion of compromise: every other
    // session has to fall.
    await this.revokeAllSessions(userId);

    await this.audit.record({
      event: AUDIT_EVENTS.PASSWORD_CHANGED,
      actorId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /** Account state, for the "My account" screen and the second-factor check. */
  async describeAccount(userId: number): Promise<{ twoFactorEnabled: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpConfirmed: true },
    });

    return { twoFactorEnabled: user.totpConfirmed };
  }

  /**
   * Choosing the initial password, from the link received by email.
   *
   * The token carries a fingerprint of the password in force when it was
   * issued: if it has changed since — because the link was already used, or an
   * administrator went through — the fingerprint no longer matches and the link
   * is refused. That is what makes it single-use without a token table.
   *
   * The rate limit applies as it does to a sign-in: the token is signed, but
   * nothing stops anyone from trying.
   */
  async setPasswordFromToken(
    token: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    const claims = await this.tokens.verifyPasswordSetup(token);

    if (!claims) {
      await this.penalizeSetupFailure(context);
      throw new UnauthorizedException('This link is invalid or has expired.');
    }

    const user = await this.prisma.user.findUnique({ where: { uuid: claims.userUuid } });

    if (!user || fingerprintOf(user.passwordHash) !== claims.fingerprint) {
      await this.penalizeSetupFailure(context);
      throw new UnauthorizedException('This link has already been used, or has expired.');
    }

    if (user.suspended) {
      throw new UnauthorizedException('This account is suspended.');
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
  // Internals
  // -------------------------------------------------------------------------

  private loginKey(identifier: string, ip: string): string {
    return `auth:login:${ip}:${identifier.toLowerCase()}`;
  }

  /**
   * Counts a **failed** password-setup attempt.
   *
   * Only failures count, unlike sign-in: a valid link is a signed token, there
   * is nothing to brute-force. Counting successes would lock out a whole office
   * behind one address — five accounts created, and the sixth would find the
   * door shut.
   */
  private async penalizeSetupFailure(context: RequestContext): Promise<void> {
    const result = await this.rateLimiter.consume(
      `password-setup:${context.ip}`,
      LOGIN_ATTEMPT_LIMIT,
      LOGIN_WINDOW_SECONDS,
    );

    if (!result.allowed) {
      throw new HttpException(
        `Too many attempts. Try again in ${result.resetInSeconds} seconds.`,
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

      // Nest exposes no dedicated exception for 429.
      throw new HttpException(
        `Too many attempts. Try again in ${result.resetInSeconds} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Burns CPU time equivalent to a real verification, so that the response time
   * does not betray the absence of an account.
   */
  private async burnPasswordVerification(password: string): Promise<boolean> {
    await this.passwords.verify(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1maXhlZC1zYWx0$hFtzE0aTQjR7VZKPVlPfzXLLbFmS0nSNBt1JxfJDCXo',
      password,
    );
    return false;
  }

  /** Accepts a TOTP code or a single-use recovery code. */
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

    // Marked immediately: a recovery code serves once only, even if two
    // requests arrive in parallel (the `usedAt: null` clause of the updateMany
    // acts as an optimistic lock).
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
   * Re-encodes the password if the Argon2 parameters have hardened since it was
   * created. This is the only moment the plaintext is available.
   */
  private async upgradePasswordHashIfNeeded(user: User, password: string): Promise<void> {
    if (!this.passwords.needsRehash(user.passwordHash)) {
      return;
    }

    this.logger.log(`Re-encoding ${user.username}'s password with the current parameters`);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(password) },
    });
  }

  /**
   * Turns an already-proven identity into a session.
   *
   * The passkey ceremony proves who someone is by a signature rather than by a
   * password, but everything after that point has to be identical: the same
   * suspension check, the same session row, the same audit trail. A second
   * place minting sessions is a second place to forget one of them.
   *
   * No two-factor step. A passkey is registered and used with user
   * verification required, so the authenticator has already asked for a PIN or
   * a biometric — possession and knowledge, both, before the browser ever
   * spoke to us. Asking for a TOTP code on top would be a third factor, not a
   * second one.
   */
  async completeVerifiedLogin(
    user: User,
    context: RequestContext,
    event: AuditEvent,
  ): Promise<LoginResult> {
    if (user.suspended) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_BLOCKED,
        actorId: user.id,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'suspended' },
      });
      throw new ForbiddenException('This account is suspended.');
    }

    const session = await this.createSession(user, context);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: context.ip },
    });

    await this.audit.record({
      event,
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

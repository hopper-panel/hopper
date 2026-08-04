import { randomUUID } from 'node:crypto';
import {
  CONSOLE_TOKEN_TTL_SECONDS,
  SIGNED_URL_TTL_SECONDS,
  consoleTokenPayloadSchema,
  signedUrlPayloadSchema,
  type ConsoleTokenPayload,
  type Permission,
  type SignedUrlPayload,
} from '@hopper/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Environment } from '../../config/environment.js';

/** Lifetime of the panel's access token. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Lifetime of a refresh session. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AccessTokenPayload {
  sub: string;
  username: string;
  role: 'ADMIN' | 'USER';
  /** Session identifier, to revoke an access token through its session. */
  sid: string;
}

/**
 * Issuing and verifying the panel's tokens.
 *
 * Three distinct families, never interchangeable:
 *
 *  • **access token** — signed with the panel's key, proves identity to the
 *    API. Short-lived, not stored.
 *  • **refresh token** — an opaque random string, stored hashed. It is not a
 *    JWT: it has to be revocable immediately.
 *  • **console token / signed URL** — signed with the secret of the *node*
 *    concerned, because the daemon verifies them without calling the panel.
 *
 * The audience (`aud`) separates the families: a console token presented to the
 * panel's API fails verification, and the other way round.
 */
@Injectable()
export class TokenService {
  private readonly issuer: string;

  constructor(
    private readonly crypto: CryptoService,
    config: ConfigService<Environment, true>,
  ) {
    this.issuer = config.get('APP_URL', { infer: true });
  }

  // -------------------------------------------------------------------------
  // Initial password choice
  // -------------------------------------------------------------------------

  /**
   * Token for a "choose your password" link.
   *
   * It carries a fingerprint of the password in force when it was issued. That
   * is what makes it **single-use with no dedicated table**: as soon as a
   * password is chosen, the fingerprint changes and the link stops working —
   * including for a second click on the same email, or for a link left in a
   * mailbox compromised afterwards.
   */
  async signPasswordSetup(input: {
    userUuid: string;
    passwordHash: string;
    ttlSeconds: number;
  }): Promise<string> {
    return new SignJWT({ fingerprint: fingerprintOf(input.passwordHash) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userUuid)
      .setIssuer(this.issuer)
      .setAudience('hopper:password-setup')
      .setIssuedAt()
      .setExpirationTime(`${input.ttlSeconds}s`)
      .sign(this.crypto.getSigningKey());
  }

  async verifyPasswordSetup(
    token: string,
  ): Promise<{ userUuid: string; fingerprint: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.crypto.getSigningKey(), {
        issuer: this.issuer,
        audience: 'hopper:password-setup',
        algorithms: ['HS256'],
      });

      if (typeof payload.sub !== 'string' || typeof payload.fingerprint !== 'string') {
        return null;
      }

      return { userUuid: payload.sub, fingerprint: payload.fingerprint };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Access token
  // -------------------------------------------------------------------------

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return new SignJWT({ username: payload.username, role: payload.role, sid: payload.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuer(this.issuer)
      .setAudience('hopper:panel')
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.crypto.getSigningKey());
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.crypto.getSigningKey(), {
        issuer: this.issuer,
        audience: 'hopper:panel',
        algorithms: ['HS256'],
      });

      if (
        typeof payload.sub !== 'string' ||
        typeof payload.username !== 'string' ||
        typeof payload.sid !== 'string' ||
        (payload.role !== 'ADMIN' && payload.role !== 'USER')
      ) {
        return null;
      }

      return {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
        sid: payload.sid,
      };
    } catch {
      // Invalid signature, expired token, wrong audience: in every case the
      // request is not authenticated. The detail is of no use to the caller.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Refresh token
  // -------------------------------------------------------------------------

  /**
   * Generates an opaque refresh token and its digest.
   * Only the digest is stored: a database leak does not hand over a usable
   * session.
   */
  generateRefreshToken(): { token: string; hash: string } {
    const token = this.crypto.randomString(64);
    return { token, hash: this.crypto.hashToken(token) };
  }

  /** Family identifier, shared by every rotation of a session. */
  generateSessionFamily(): string {
    return randomUUID();
  }

  // -------------------------------------------------------------------------
  // Tokens meant for the daemon
  // -------------------------------------------------------------------------

  /**
   * Token allowing a WebSocket connection to a server's console.
   *
   * Signed with the node's secret, not the panel's: the daemon verifies it on
   * its own, with no network call. That is what keeps the console fluid, and it
   * is why the lifetime is short — a permission revoked in the panel only takes
   * effect on renewal.
   */
  async signConsoleToken(input: {
    nodeUuid: string;
    nodeJwtSecret: string;
    userUuid: string;
    serverUuid: string;
    permissions: Permission[];
  }): Promise<string> {
    return new SignJWT({
      serverUuid: input.serverUuid,
      permissions: input.permissions,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userUuid)
      .setIssuer(this.issuer)
      .setAudience(input.nodeUuid)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${CONSOLE_TOKEN_TTL_SECONDS}s`)
      .sign(Buffer.from(input.nodeJwtSecret, 'utf8'));
  }

  /** Verifies a console token. Used by the tests and by the daemon. */
  async verifyConsoleToken(
    token: string,
    nodeUuid: string,
    nodeJwtSecret: string,
  ): Promise<ConsoleTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, Buffer.from(nodeJwtSecret, 'utf8'), {
        issuer: this.issuer,
        audience: nodeUuid,
        algorithms: ['HS256'],
      });

      const parsed = consoleTokenPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Single-use signed URL for a file download or upload.
   * Very short-lived: the URL travels in the clear through the address bar and
   * the browser history.
   */
  async signResourceUrl(input: {
    nodeUuid: string;
    nodeJwtSecret: string;
    userUuid: string;
    serverUuid: string;
    resource: SignedUrlPayload['resource'];
  }): Promise<string> {
    return new SignJWT({ serverUuid: input.serverUuid, resource: input.resource })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userUuid)
      .setIssuer(this.issuer)
      .setAudience(input.nodeUuid)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${SIGNED_URL_TTL_SECONDS}s`)
      .sign(Buffer.from(input.nodeJwtSecret, 'utf8'));
  }

  async verifyResourceUrl(
    token: string,
    nodeUuid: string,
    nodeJwtSecret: string,
  ): Promise<SignedUrlPayload | null> {
    try {
      const { payload } = await jwtVerify(token, Buffer.from(nodeJwtSecret, 'utf8'), {
        issuer: this.issuer,
        audience: nodeUuid,
        algorithms: ['HS256'],
      });

      const parsed = signedUrlPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

/**
 * Short fingerprint of a password digest.
 *
 * The argon2 hash itself does not go into the token: the token is readable by
 * its bearer, and putting enough there to mount an offline attack would be
 * absurd. Sixteen characters are enough to detect a change.
 */
export function fingerprintOf(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

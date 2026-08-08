import { randomUUID } from 'node:crypto';
import {
  CONSOLE_TOKEN_TTL_SECONDS,
  SIGNED_URL_TTL_SECONDS,
  consoleTokenPayloadSchema,
  isPermission,
  sanitizePermissions,
  signedUrlPayloadSchema,
  type ConsoleTokenPayload,
  type Permission,
  type SignedUrlPayload,
} from '@hopper/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
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
 * The rule `serverUuid` has to satisfy, borrowed from the contract schemas
 * themselves rather than restated here.
 *
 * The two cannot drift that way: what a claim must satisfy to be *verified* is
 * exactly what it must satisfy to be *signed*. Restating `z.uuid()` in this
 * file would work today and stop working the day the contract tightens.
 */
const serverUuidSchema = consoleTokenPayloadSchema.shape.serverUuid;
const resourceServerUuidSchema = signedUrlPayloadSchema.shape.serverUuid;

/**
 * The subject, held to more than the contract asks of it.
 *
 * Both payload schemas type `sub` as a plain string, so an empty one verifies —
 * and `sub` is the only thing in either token that names a person. It is what
 * the daemon has to tell one console session from another's, having no other
 * handle on who is connected. A token signed without one produces a session
 * belonging to nobody, and nothing downstream can recover an attribution that
 * was never signed. Every caller has a user's uuid to hand.
 */
const subjectSchema = z.uuid();

/**
 * Validates a claim before it is signed, or refuses to sign at all.
 *
 * Throwing is deliberate. The alternative — signing anyway — hands the browser
 * a credential the daemon will refuse, which surfaces as a console that will
 * not open or a download that fails, with the reason a debug line on the node.
 * A 500 on the issuing route names the fault where it happened.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new Error(`Refusing to sign a token whose ${field} the daemon would reject.`);
  }

  return parsed.data;
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
  private readonly logger = new Logger(TokenService.name);
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
   * is why the lifetime is short — a permission revoked in the panel, or the
   * whole session behind it, only takes effect on renewal. See
   * `CONSOLE_TOKEN_TTL_SECONDS` for the size of that window and why it is the
   * only bound there is.
   */
  async signConsoleToken(input: {
    nodeUuid: string;
    nodeJwtSecret: string;
    userUuid: string;
    serverUuid: string;
    permissions: Permission[];
  }): Promise<string> {
    // Everything below is checked *before* being signed, against the very
    // schema the daemon will apply on the way back in. The panel must not be
    // able to hand a browser credentials it already knows are dead: the browser
    // would open a WebSocket with them and be disconnected by the daemon, and
    // the only trace of the reason lives on the node, in a debug line.
    const serverUuid = parseOrThrow(serverUuidSchema, input.serverUuid, 'serverUuid');
    const userUuid = parseOrThrow(subjectSchema, input.userUuid, 'userUuid');

    return new SignJWT({
      serverUuid,
      permissions: this.signablePermissions(input.permissions, serverUuid),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userUuid)
      .setIssuer(this.issuer)
      .setAudience(input.nodeUuid)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${CONSOLE_TOKEN_TTL_SECONDS}s`)
      .sign(Buffer.from(input.nodeJwtSecret, 'utf8'));
  }

  /**
   * The permissions this panel is prepared to put its signature on.
   *
   * `Permission[]` is a compile-time claim only — the list reaches here from a
   * database column through the resolver — and the token's schema validates the
   * array as a whole, so a single unknown value does not degrade the token, it
   * *destroys* it: the daemon refuses the lot and the console will not open at
   * all. Dropping the value instead leaves the bearer with the permissions
   * everyone still agrees on, which is the same reasoning that put
   * `sanitizePermissions` in `ServerPermissionResolver` for subusers; owners and
   * administrators reach this path without passing through it.
   *
   * This does **not** make a panel upgraded ahead of its daemons safe. A
   * permission new enough that the *daemon* does not know it is known here, so
   * it passes this filter and is refused there, taking the token with it. Only
   * upgrading the nodes fixes that; what is fixed here is the panel signing
   * something its own contract rejects.
   */
  private signablePermissions(permissions: Permission[], serverUuid: string): Permission[] {
    const unknown = permissions.filter((permission) => !isPermission(permission));

    if (unknown.length > 0) {
      // Never silently: a permission disappearing between the database and the
      // token is either a leftover from an older version or a bug, and both are
      // worth a line naming the values and the server.
      this.logger.warn(
        `Console token for server ${serverUuid}: dropping ${unknown.length} unknown ` +
          `permission(s) — ${unknown.join(', ')}. Signing them would make the whole token unusable.`,
      );
    }

    return sanitizePermissions(permissions);
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
   * Signed URL for a file download or upload.
   *
   * Very short-lived: the URL travels in the clear through the address bar and
   * the browser history, and that brevity is the entire protection. It is not
   * single-use — nothing consumes the `jti`, on either side — so a link that
   * leaks works for whoever holds it until it expires, as many times as they
   * like. Treat the lifetime as the whole of the guarantee.
   */
  async signResourceUrl(input: {
    nodeUuid: string;
    nodeJwtSecret: string;
    userUuid: string;
    serverUuid: string;
    resource: SignedUrlPayload['resource'];
  }): Promise<string> {
    // Same reasoning as the console token: a URL the daemon's schema refuses is
    // a download that fails in the browser with nothing to point at.
    const serverUuid = parseOrThrow(resourceServerUuidSchema, input.serverUuid, 'serverUuid');
    const userUuid = parseOrThrow(subjectSchema, input.userUuid, 'userUuid');

    return new SignJWT({ serverUuid, resource: input.resource })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userUuid)
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

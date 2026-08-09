import {
  ALL_PERMISSIONS,
  CONSOLE_TOKEN_RENEW_MARGIN_SECONDS,
  CONSOLE_TOKEN_TTL_SECONDS,
  PERMISSIONS,
  SIGNED_URL_TTL_SECONDS,
  type Permission,
} from '@hopper/shared';
import { ForbiddenException, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Environment } from '../../config/environment.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { scopeAllows } from '../api-keys/api-key.js';
import { AUDIT_EVENTS, type AuditService } from '../audit/audit.service.js';
import type { NodesService } from '../nodes/nodes.service.js';
import { ConsoleController } from '../servers/console.controller.js';
import { AuthService, ROTATION_GRACE_MS } from './auth.service.js';
import type { PasswordService } from './password.service.js';
import type { RequestServer, RequestUser } from './request-user.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TokenService,
} from './token.service.js';
import type { TotpService } from './totp.service.js';

/**
 * The console JWT is the one token in this codebase that is verified by a
 * machine the panel does not control, on a connection the panel never sees. If
 * it can be forged, widened or moved between servers, nothing downstream will
 * notice: the daemon has no database to check it against.
 *
 * These tests are written from the attacker's side. Each one names the claim or
 * the key that is doing the work, so that removing it breaks a test rather than
 * a deployment.
 */

const APP_URL = 'https://panel.example.test';

/** Two nodes, with the shape and length the panel actually generates (64 chars). */
const NODE_A = {
  uuid: 'a1111111-1111-4111-8111-111111111111',
  secret: 'A'.repeat(32) + 'a'.repeat(32),
};
const NODE_B = {
  uuid: 'b2222222-2222-4222-8222-222222222222',
  secret: 'B'.repeat(32) + 'b'.repeat(32),
};

/** Two servers on the *same* node: the escalation the daemon has to refuse. */
const SERVER_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SERVER_B = '5c9d1a02-1b7e-4c2f-9d8a-77bb1f0e4402';

const USER_UUID = '9e107d9d-3721-4a1c-8b3f-2f0a9c8d1e55';

function makeCrypto(secret = 'a-test-app-secret-long-enough-1234567890'): CryptoService {
  return new CryptoService({ get: () => secret } as unknown as ConfigService<Environment, true>);
}

function makeTokens(crypto: CryptoService = makeCrypto()): TokenService {
  const config = { get: () => APP_URL } as unknown as ConfigService<Environment, true>;
  return new TokenService(crypto, config);
}

function claimsOf(token: string): Record<string, unknown> {
  return decodeJwt(token);
}

/**
 * Re-encodes a token's payload while keeping the original signature. This is
 * the cheapest forgery there is — no key needed — and the one every JWT
 * verifier has to defeat.
 */
function tamper(token: string, mutate: (claims: Record<string, unknown>) => void): string {
  const [header, body, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  mutate(claims);
  const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${header}.${forged}.${signature}`;
}

/** The same payload, re-headed as `alg: none` and stripped of its signature. */
function unsigned(token: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
  const body = Buffer.from(JSON.stringify(claimsOf(token)), 'utf8').toString('base64url');
  return `${header}.${body}.`;
}

// ---------------------------------------------------------------------------
// Console token — the claims and the lifetime
// ---------------------------------------------------------------------------

describe('console token: what it carries', () => {
  const tokens = makeTokens();

  async function mint(overrides: Partial<Parameters<TokenService['signConsoleToken']>[0]> = {}) {
    return tokens.signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: [PERMISSIONS.WEBSOCKET_CONNECT, PERMISSIONS.CONTROL_CONSOLE],
      ...overrides,
    });
  }

  /**
   * The claim set is pinned exactly, not merely checked for what it contains.
   * A console token and a signed download URL are signed with the *same* node
   * secret for the *same* audience; the only thing keeping one from being read
   * as the other is that their payload shapes do not overlap. Zod object
   * schemas ignore surplus keys, so a single extra claim added here — a
   * `resource` in particular — would silently make every console token a valid
   * file-download URL. That is why an addition has to break this test.
   */
  it('carries exactly eight claims, and no more', async () => {
    expect(Object.keys(claimsOf(await mint())).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'permissions',
      'serverUuid',
      'sub',
    ]);
  });

  it('names the panel as issuer, the node as audience and the user as subject', async () => {
    const claims = claimsOf(await mint());

    expect(claims.iss).toBe(APP_URL);
    expect(claims.aud).toBe(NODE_A.uuid);
    expect(claims.sub).toBe(USER_UUID);
    expect(claims.serverUuid).toBe(SERVER_A);
  });

  /**
   * The figure is two minutes, down from ten, and it is pinned here because it
   * is not a tuning knob: it is the entire revocation delay. Nothing the panel
   * does reaches a console mid-session — see the session test below — so a
   * sign-out or a password change costs the attacker this long and no longer.
   *
   * It cannot go much lower either, and the floor is the renewal margin: the
   * daemon warns the client `CONSOLE_TOKEN_RENEW_MARGIN_SECONDS` before expiry
   * and that warning is the only renewal trigger there is. A lifetime at or
   * below the margin means no warning, and every console dropping at expiry
   * and reconnecting from scratch instead of renewing in place. The assertion
   * below is that relationship rather than the bare number.
   */
  it('lives for two minutes, comfortably clear of the renewal margin', async () => {
    const claims = claimsOf(await mint());

    expect(CONSOLE_TOKEN_TTL_SECONDS).toBe(120);
    expect((claims.exp as number) - (claims.iat as number)).toBe(CONSOLE_TOKEN_TTL_SECONDS);
    expect(CONSOLE_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(
      CONSOLE_TOKEN_RENEW_MARGIN_SECONDS * 2,
    );
    // Still far longer than a signed URL, which is a link in an address bar
    // rather than a live session.
    expect(CONSOLE_TOKEN_TTL_SECONDS).toBeGreaterThan(SIGNED_URL_TTL_SECONDS);
  });

  /**
   * `alg` is pinned in the header at signing and in the allow-list at
   * verification. The unsigned copy is refused by `jose` itself, which has no
   * `none` implementation at all; the allow-list is what refuses everything
   * *else*, and HS512 below is the case that proves it is doing work. A
   * verifier that takes the algorithm from the header instead is the classic
   * route to signature confusion.
   */
  it('is signed with HS256, and no other algorithm is accepted', async () => {
    const token = await mint();

    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    expect(await tokens.verifyConsoleToken(unsigned(token), NODE_A.uuid, NODE_A.secret)).toBeNull();

    const hs512 = await new SignJWT({ serverUuid: SERVER_A, permissions: [...ALL_PERMISSIONS] })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(USER_UUID)
      .setIssuer(APP_URL)
      .setAudience(NODE_A.uuid)
      .setJti('hs512')
      .setIssuedAt()
      .setExpirationTime('600s')
      .sign(Buffer.from(NODE_A.secret, 'utf8'));

    expect(await tokens.verifyConsoleToken(hs512, NODE_A.uuid, NODE_A.secret)).toBeNull();
  });

  it('gives every token a distinct jti', async () => {
    const [first, second] = await Promise.all([mint(), mint()]);

    expect(claimsOf(first).jti).not.toBe(claimsOf(second).jti);
    expect(claimsOf(first).jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * The `jti` is an identifier, not a revocation handle, and the contract now
   * says so where it is declared. Nothing consumes it — no deny-list in the
   * panel, no seen-set in the daemon — so the same token authenticates as many
   * connections as its bearer likes, for its whole two minutes. This test is
   * what keeps the comment and the behaviour together: implementing a deny-list
   * would break it, which is the right moment to rewrite the claim.
   */
  it('is replayable for its whole lifetime: nothing consumes the jti', async () => {
    const token = await mint();

    expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).not.toBeNull();
    expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).not.toBeNull();
  });

  /**
   * The console token carries no session identifier, unlike the access token,
   * which carries `sid` for exactly this reason. A sign-out, a password change
   * or a suspension revokes every session — and leaves any console token minted
   * since fully live, with `control.console` on it.
   *
   * The absence is deliberate and cannot be fixed by adding the claim: the
   * daemon has no session table to check it against and no way to ask. What
   * bounds it is the lifetime above, which is why that one is two minutes, and
   * what closes it immediately is re-keying the node. Both are written down in
   * `docs/security.md`, under "a console already open", for whoever is reading
   * during an incident rather than during a refactor. Pinning the absence here
   * means restoring the binding shows up as a deliberate change — and that
   * whoever restores it has to go and correct that section.
   */
  it('carries nothing that ties it to a session, so no revocation can reach it', async () => {
    const claims = claimsOf(await mint());

    expect(claims.sid).toBeUndefined();
    expect(claims.family).toBeUndefined();
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('still verifies one second before expiry and not one second after', async () => {
      const token = await mint();

      vi.setSystemTime(new Date('2026-01-01T00:01:59Z'));
      expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).not.toBeNull();

      vi.setSystemTime(new Date('2026-01-01T00:02:01Z'));
      expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).toBeNull();
    });

    /** Extending `exp` by hand is the first thing anyone tries. */
    it('refuses a token whose exp was pushed out by re-encoding the payload', async () => {
      const token = await mint();
      const forged = tamper(token, (claims) => {
        claims.exp = (claims.exp as number) + 86_400;
      });

      vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
      expect(await tokens.verifyConsoleToken(forged, NODE_A.uuid, NODE_A.secret)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Console token — bound to one server
// ---------------------------------------------------------------------------

describe('console token: binding to one server', () => {
  const tokens = makeTokens();

  function mintFor(serverUuid: string, permissions: Permission[] = [...ALL_PERMISSIONS]) {
    return tokens.signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid,
      permissions,
    });
  }

  /**
   * A user legitimately holding a token for server A points it at server B,
   * which lives on the same node and is therefore reached with the same key and
   * the same audience. Signature, issuer and audience all pass — cross-server
   * isolation on a node rests on one string comparison, not on cryptography.
   *
   * What this file can assert is its own half: that the token names A and only
   * A, so the daemon has something to compare. It deliberately does **not**
   * reimplement the comparison — an earlier version of this test defined a
   * local `opens()` that re-derived the daemon's `!==` and then asserted on
   * that, which passes whatever the daemon does and would go on passing if the
   * check there were deleted. The comparison itself belongs to
   * `console-gateway.spec.ts`, which exercises the real gateway.
   */
  it('names exactly one server, leaving the daemon a claim to compare', async () => {
    const payload = await tokens.verifyConsoleToken(
      await mintFor(SERVER_A),
      NODE_A.uuid,
      NODE_A.secret,
    );

    // Verified, on the node both servers live on: nothing cryptographic here
    // separates A from B.
    expect(payload).not.toBeNull();
    expect(payload?.serverUuid).toBe(SERVER_A);
    expect(payload?.serverUuid).not.toBe(SERVER_B);
    // And the claim is present, which is what the daemon's check depends on:
    // an absent one would parse as `undefined` and match nothing — or, worse,
    // be read as "any server" by a laxer schema.
    expect(Object.keys(claimsOf(await mintFor(SERVER_A)))).toContain('serverUuid');
  });

  /**
   * `verifyConsoleToken` takes a node uuid and a node secret — and no server.
   * It therefore cannot enforce the binding above, and any future caller that
   * uses it to gate a per-server action without comparing `serverUuid` itself
   * has an authorisation bypass with no visible mistake in the call site.
   */
  it('verifies with no server in scope at all, leaving the comparison to the caller', async () => {
    const token = await mintFor(SERVER_B);

    expect(tokens.verifyConsoleToken.length).toBe(3);
    expect((await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret))?.serverUuid).toBe(
      SERVER_B,
    );
  });

  /** Swapping the target server means re-signing, which the bearer cannot do. */
  it('refuses a token whose serverUuid was rewritten', async () => {
    const forged = tamper(await mintFor(SERVER_A), (claims) => {
      claims.serverUuid = SERVER_B;
    });

    expect(await tokens.verifyConsoleToken(forged, NODE_A.uuid, NODE_A.secret)).toBeNull();
  });

  /**
   * `z.uuid()` accepts either case — the check added at signing time is a
   * format check, not a normalisation — while the daemon compares with `!==`,
   * which does not. So the service will still sign a spelling the daemon
   * cannot match.
   *
   * What stops that reaching anyone is one layer up: `ConsoleController` signs
   * `server.uuid`, the value the guard read out of the database, and builds the
   * socket URL from the same value rather than from the route parameter. Both
   * halves therefore carry the stored spelling whatever the caller typed. This
   * test pins the service's laxity so that a future second caller knows it is
   * responsible for the same discipline.
   */
  it('accepts an upper-case serverUuid that would no longer match the daemon by ===', async () => {
    const upper = SERVER_A.toUpperCase();
    const payload = await tokens.verifyConsoleToken(
      await mintFor(upper),
      NODE_A.uuid,
      NODE_A.secret,
    );

    expect(payload?.serverUuid).toBe(upper);
    expect(payload?.serverUuid).not.toBe(SERVER_A);
  });
});

// ---------------------------------------------------------------------------
// Console token — bound to one node
// ---------------------------------------------------------------------------

describe('console token: binding to one node', () => {
  const tokens = makeTokens();

  function mintOn(node: { uuid: string; secret: string }) {
    return tokens.signConsoleToken({
      nodeUuid: node.uuid,
      nodeJwtSecret: node.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: [...ALL_PERMISSIONS],
    });
  }

  it('is worthless on another node', async () => {
    const token = await mintOn(NODE_A);

    expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).not.toBeNull();
    expect(await tokens.verifyConsoleToken(token, NODE_B.uuid, NODE_B.secret)).toBeNull();
  });

  /**
   * The two barriers are separated deliberately, because "it fails" tells you
   * nothing about which one is load-bearing. Here the key is right and only the
   * audience differs — the case that would arise if two nodes were ever
   * provisioned with the same `jwtSecret`, by a restored backup or a copied
   * `daemon.yml`. The `aud` claim has to hold on its own.
   */
  it('is refused by audience alone, even when the signing key is shared', async () => {
    const token = await mintOn({ uuid: NODE_A.uuid, secret: NODE_A.secret });

    expect(await tokens.verifyConsoleToken(token, NODE_B.uuid, NODE_A.secret)).toBeNull();
  });

  /** And the mirror case: right audience, wrong key. The signature has to hold on its own. */
  it('is refused by signature alone, even when the audience matches', async () => {
    const token = await mintOn({ uuid: NODE_B.uuid, secret: NODE_A.secret });

    expect(await tokens.verifyConsoleToken(token, NODE_B.uuid, NODE_B.secret)).toBeNull();
  });

  /**
   * Proving the key is the node's own secret rather than the panel's, instead
   * of trusting the parameter name. If the panel's signing key were used here,
   * every node operator could mint tokens for every other node — the daemon
   * config file is deliberately readable by whoever runs the machine.
   */
  it('is not signed with the panel key: the node secret is the only key that opens it', async () => {
    const crypto = makeCrypto();
    const panelKey = crypto.getSigningKey();
    const token = await makeTokens(crypto).signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: [],
    });

    // The panel's own key is not the node's, and the reverse forgery fails too:
    // a token signed with the panel key is not accepted for a node.
    const forgedWithPanelKey = await new SignJWT({ serverUuid: SERVER_A, permissions: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_UUID)
      .setIssuer(APP_URL)
      .setAudience(NODE_A.uuid)
      .setJti('forged')
      .setIssuedAt()
      .setExpirationTime('600s')
      .sign(panelKey);

    expect(panelKey.equals(Buffer.from(NODE_A.secret, 'utf8'))).toBe(false);
    expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).not.toBeNull();
    expect(
      await tokens.verifyConsoleToken(forgedWithPanelKey, NODE_A.uuid, NODE_A.secret),
    ).toBeNull();
  });

  /** The issuer is pinned too: a second panel pointed at the same node is not this panel. */
  it('refuses a token minted by a different panel URL', async () => {
    const other = new TokenService(makeCrypto(), {
      get: () => 'https://evil.example.test',
    } as unknown as ConfigService<Environment, true>);

    const token = await other.signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: [...ALL_PERMISSIONS],
    });

    expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keeping the three token families apart
// ---------------------------------------------------------------------------

describe('token families do not cross', () => {
  const crypto = makeCrypto();
  const tokens = makeTokens(crypto);

  const access = () =>
    tokens.signAccessToken({ sub: USER_UUID, username: 'julien', role: 'USER', sid: '42' });

  const console_ = () =>
    tokens.signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: [...ALL_PERMISSIONS],
    });

  it('refuses a console token presented to the panel API', async () => {
    expect(await tokens.verifyAccessToken(await console_())).toBeNull();
  });

  it('refuses a panel access token presented to a node', async () => {
    expect(await tokens.verifyConsoleToken(await access(), NODE_A.uuid, NODE_A.secret)).toBeNull();
  });

  /**
   * The sharpest version of the previous test. A node's `jwtSecret` sits in
   * `/etc/hopper/daemon.yml` on the node machine, so anyone who roots a single
   * node holds it. If that secret could mint panel tokens, one compromised game
   * host would become panel administrator over the whole install. It cannot:
   * the panel verifies with its own HKDF-derived key.
   */
  it('does not let a node operator mint a panel administrator token', async () => {
    const forged = await new SignJWT({ username: 'julien', role: 'ADMIN', sid: '1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_UUID)
      .setIssuer(APP_URL)
      .setAudience('hopper:panel')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(Buffer.from(NODE_A.secret, 'utf8'));

    expect(await tokens.verifyAccessToken(forged)).toBeNull();
  });

  it('refuses a password-setup token as an access token, and the reverse', async () => {
    const setup = await tokens.signPasswordSetup({
      userUuid: USER_UUID,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      ttlSeconds: 3600,
    });

    expect(await tokens.verifyAccessToken(setup)).toBeNull();
    expect(await tokens.verifyPasswordSetup(await access())).toBeNull();
  });

  /**
   * The console token and the signed URL are the one pair the class comment's
   * claim — "the audience separates the families" — does not cover: both are
   * signed with the node secret, for the node's uuid, by the same issuer. Only
   * the payload shape tells them apart, and Zod's object schemas strip surplus
   * keys rather than rejecting them, so a payload carrying both `permissions`
   * and `resource` would parse as *both*. Nothing mints such a payload today.
   * This test is what keeps that true.
   */
  it('separates a console token from a signed URL by shape alone, not by audience', async () => {
    const url = await tokens.signResourceUrl({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      resource: { type: 'file-download', path: '/server.properties' },
    });
    const ws = await console_();

    // Same issuer, same audience, same key: the cryptography does not separate them.
    expect(claimsOf(url).aud).toBe(claimsOf(ws).aud);
    expect(claimsOf(url).iss).toBe(claimsOf(ws).iss);

    // Only the missing claim does.
    expect(await tokens.verifyConsoleToken(url, NODE_A.uuid, NODE_A.secret)).toBeNull();
    expect(await tokens.verifyResourceUrl(ws, NODE_A.uuid, NODE_A.secret)).toBeNull();
    expect(claimsOf(ws).resource).toBeUndefined();
    expect(claimsOf(url).permissions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Permissions: what the panel is willing to sign
// ---------------------------------------------------------------------------

describe('console token: the permission list', () => {
  const tokens = makeTokens();

  function mintWith(permissions: unknown) {
    return tokens.signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: permissions as Permission[],
    });
  }

  /**
   * Known permissions are passed through untouched — same order, duplicates
   * included. The filter added below is a filter and not a rewrite: an owner's
   * fifty permissions have to arrive as the fifty the resolver computed.
   */
  it('signs the list verbatim, in order, without deduplicating', async () => {
    const claims = claimsOf(
      await mintWith([PERMISSIONS.CONTROL_STOP, PERMISSIONS.CONTROL_STOP, PERMISSIONS.FILE_READ]),
    );

    expect(claims.permissions).toEqual([
      PERMISSIONS.CONTROL_STOP,
      PERMISSIONS.CONTROL_STOP,
      PERMISSIONS.FILE_READ,
    ]);
  });

  /**
   * `Permission[]` is a compile-time claim and nothing more: the list reaches
   * this method from a database column, through the resolver. An unknown value
   * used to go into the signature untouched, and the array schema then failed
   * on that one member rather than dropping it — so the *whole* token was
   * refused and the console did not open at all.
   *
   * `sanitizePermissions` now runs on this path too, as it already did in
   * `ServerPermissionResolver` for subusers; owners and administrators reach
   * here without passing through that. The bearer keeps the permissions
   * everyone still agrees on, and the console opens.
   *
   * The dropping is logged, not silent: a value that survived in the database
   * past the version that defined it is either a leftover or a bug, and neither
   * should be discovered from a permission quietly not applying.
   */
  it('drops a permission it does not recognise, and says so, instead of killing the token', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const token = await mintWith([PERMISSIONS.CONTROL_CONSOLE, 'server.root']);

      expect(claimsOf(token).permissions).toEqual([PERMISSIONS.CONTROL_CONSOLE]);

      const payload = await tokens.verifyConsoleToken(token, NODE_A.uuid, NODE_A.secret);
      expect(payload?.permissions).toEqual([PERMISSIONS.CONTROL_CONSOLE]);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('server.root'));
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The half the filter does **not** fix, kept next to it so nobody reads it as
   * fixed: `sanitizePermissions` knows the *panel's* enum. A permission new
   * enough that the daemons have not been upgraded to it passes here and is
   * refused there, taking the whole token with it and every console on those
   * nodes. Only upgrading the nodes closes that. Signing every permission this
   * panel holds is therefore still a bet on the fleet being current — which is
   * why the assertion is that the list signed is exactly the panel's, and not
   * something narrower that would pretend otherwise.
   */
  it('signs every permission this panel knows, and bets the daemons know them too', async () => {
    const payload = await tokens.verifyConsoleToken(
      await mintWith([...ALL_PERMISSIONS]),
      NODE_A.uuid,
      NODE_A.secret,
    );

    expect(payload?.permissions).toEqual([...ALL_PERMISSIONS]);
  });

  /**
   * An empty list is legitimate — a subuser can hold zero permissions — and the
   * token stays valid, which is the part that matters here: an empty
   * `permissions` must not be mistaken for a malformed token and refused.
   *
   * What a session holding one is then allowed to *see* is the daemon's
   * decision, taken per message, and is pinned in `console-gateway.spec.ts`.
   * This file deliberately says nothing about it: a claim made here about
   * behaviour implemented there would be a comment nothing can keep honest.
   */
  it('signs an empty permission list, and the token verifies', async () => {
    const payload = await tokens.verifyConsoleToken(await mintWith([]), NODE_A.uuid, NODE_A.secret);

    expect(payload?.permissions).toEqual([]);
  });

  it('refuses a token whose permission array was widened after signing', async () => {
    const forged = tamper(await mintWith([PERMISSIONS.WEBSOCKET_CONNECT]), (claims) => {
      claims.permissions = [...ALL_PERMISSIONS];
    });

    expect(await tokens.verifyConsoleToken(forged, NODE_A.uuid, NODE_A.secret)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The issuing path: the only caller of signConsoleToken
// ---------------------------------------------------------------------------

describe('the issuing path: ConsoleController', () => {
  const tokens = makeTokens();

  const OWNER: RequestUser = {
    id: 1,
    uuid: USER_UUID,
    username: 'julien',
    email: 'julien@example.test',
    role: 'USER',
    sessionId: '7',
    authenticatedBy: 'session',
  };

  /** The same account, reaching the same route with a personal API key. */
  const OWNER_WITH_KEY: RequestUser = {
    ...OWNER,
    sessionId: 'api-key:3',
    authenticatedBy: 'api-key',
  };

  function makeController(secret = NODE_A.secret) {
    const prisma = {
      node: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          uuid: NODE_A.uuid,
          scheme: 'https',
          fqdn: 'node.example',
          port: 8443,
        }),
      },
    } as unknown as PrismaService;

    const nodes = { getJwtSecret: vi.fn().mockResolvedValue(secret) } as unknown as NodesService;

    return new ConsoleController(prisma, nodes, tokens);
  }

  function access(permissions: Permission[]): RequestServer {
    return { id: 10, uuid: SERVER_A, nodeId: 2, permissions, isOwner: true };
  }

  /**
   * The permissions in the token come from `request.serverAccess`, which only
   * `ServerPermissionGuard` writes, from `ServerPermissionResolver`. There is
   * no body, no query and no header on this route, and the `:serverId` in the
   * path is not a parameter of the handler either — its whole input is two
   * guard-populated objects, so a caller has nothing to influence the token
   * with, list or server.
   */
  it('signs the permissions the resolver computed, with nothing the caller can add', async () => {
    const granted = [PERMISSIONS.WEBSOCKET_CONNECT, PERMISSIONS.FILE_READ];
    const credentials = await makeController().credentials(OWNER, access(granted));

    const payload = await tokens.verifyConsoleToken(credentials.token, NODE_A.uuid, NODE_A.secret);

    expect(payload?.permissions).toEqual(granted);
    expect(payload?.sub).toBe(USER_UUID);
    // The handler takes the user and the resolved access — nothing else.
    expect(ConsoleController.prototype.credentials.length).toBe(2);
  });

  /**
   * The uuid signed, and the one in the socket URL, are both the value the
   * guard read out of the database. They have to be the same value: the daemon
   * compares the token's `serverUuid` against the uuid in the URL the socket
   * was opened on, with `!==`, so two spellings of the same server would be a
   * console that never opens.
   */
  it('names the resolved server in both the token and the socket URL', async () => {
    const credentials = await makeController().credentials(OWNER, access([]));
    const payload = await tokens.verifyConsoleToken(credentials.token, NODE_A.uuid, NODE_A.secret);

    // The uuid the guard resolved, in the token…
    expect(payload?.serverUuid).toBe(SERVER_A);
    // …and the same one in the URL, which is the other half of the comparison.
    expect(credentials.socketUrl).toBe(`wss://node.example:8443/api/servers/${SERVER_A}/ws`);
  });

  it("signs with the secret of the server's own node, fetched per request", async () => {
    const controller = makeController(NODE_B.secret);
    const credentials = await controller.credentials(OWNER, access([...ALL_PERMISSIONS]));

    // Signed with B's secret, so A's cannot open it even though `aud` says A.
    expect(
      await tokens.verifyConsoleToken(credentials.token, NODE_A.uuid, NODE_A.secret),
    ).toBeNull();
    expect(
      await tokens.verifyConsoleToken(credentials.token, NODE_A.uuid, NODE_B.secret),
    ).not.toBeNull();
  });

  it('announces the same lifetime it signed', async () => {
    const credentials = await makeController().credentials(OWNER, access([]));
    const claims = claimsOf(credentials.token);

    expect(credentials.expiresIn).toBe(CONSOLE_TOKEN_TTL_SECONDS);
    expect((claims.exp as number) - (claims.iat as number)).toBe(credentials.expiresIn);
  });

  /**
   * The escalation this route used to allow, now closed.
   *
   * Nothing in the layers *above* the handler stops an API key here, and the
   * first two assertions are the real predicate saying so: the route is a
   * `GET`, `scopeAllows` decides scope from the verb, so a key scoped `read`
   * walks through — while the same key is correctly refused the ordinary way of
   * stopping a server. The resolver, for its part, knows nothing about API keys
   * and hands an owner every permission there is.
   *
   * So the refusal has to be the handler's own, and it has to come before
   * anything is signed: what this route returns is not a read but a credential
   * the daemon honours without ever learning a key was involved — on a
   * Minecraft server, arbitrary command execution from a token whose whole
   * promise was that it could not stop anything.
   */
  it('refuses to mint anything at all for a request authenticated by an API key', async () => {
    const path = `/api/servers/${SERVER_A}/console`;

    // The guard-level checks that do *not* save us, stated as facts.
    expect(scopeAllows(['read'], 'GET', path)).toBe(true);
    expect(scopeAllows(['read'], 'POST', `/api/servers/${SERVER_A}/power`)).toBe(false);

    const controller = makeController();

    await expect(
      controller.credentials(OWNER_WITH_KEY, access([...ALL_PERMISSIONS])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * And refused *early*: before the node is read, before its signing secret is
   * decrypted, and therefore before any token exists to leak. A refusal that
   * happened after the signing would still be a token minted on the strength of
   * a read key, sitting in a log or a stack trace.
   */
  it('refuses the API key before reading the node or its secret', async () => {
    const prisma = {
      node: { findUniqueOrThrow: vi.fn() },
    } as unknown as PrismaService;
    const nodes = { getJwtSecret: vi.fn() } as unknown as NodesService;

    const controller = new ConsoleController(prisma, nodes, tokens);

    await expect(
      controller.credentials(OWNER_WITH_KEY, access([...ALL_PERMISSIONS])),
    ).rejects.toThrow(/API key/i);

    expect(prisma.node.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(nodes.getJwtSecret).not.toHaveBeenCalled();
  });

  /** The same account, signed into the panel, is unaffected. */
  it('still issues a console to the same account when it is a browser session', async () => {
    const credentials = await makeController().credentials(OWNER, access([...ALL_PERMISSIONS]));
    const payload = await tokens.verifyConsoleToken(credentials.token, NODE_A.uuid, NODE_A.secret);

    expect(payload?.permissions).toContain(PERMISSIONS.CONTROL_CONSOLE);
  });
});

// ---------------------------------------------------------------------------
// Malformed input: anything the panel signs, the daemon has to refuse
// ---------------------------------------------------------------------------

describe('console token: malformed input', () => {
  const tokens = makeTokens();

  /**
   * The sign path and the verify path used to disagree: `signConsoleToken`
   * imposed no format on `serverUuid` while `consoleTokenPayloadSchema` — the
   * daemon's schema too — requires a UUID. The panel would mint, sign and hand
   * back over HTTPS a credential its own verifier rejects.
   *
   * Nothing reached it — the only caller signs a uuid the guard has already
   * looked up. It is fixed anyway, and by refusing rather than by correcting: a
   * caller that has lost track of what a server uuid is has a bug, and the
   * useful place to learn that is the stack trace of the request that caused it,
   * not a WebSocket the daemon closes with a debug line on the node.
   */
  it('refuses to sign a serverUuid that is not a UUID', async () => {
    await expect(
      tokens.signConsoleToken({
        nodeUuid: NODE_A.uuid,
        nodeJwtSecret: NODE_A.secret,
        userUuid: USER_UUID,
        serverUuid: '../../etc/passwd',
        permissions: [PERMISSIONS.WEBSOCKET_CONNECT],
      }),
    ).rejects.toThrow(/serverUuid/);
  });

  /** The signed URL is held to the same rule, by the same reasoning. */
  it('refuses to sign a resource URL for a serverUuid that is not a UUID', async () => {
    await expect(
      tokens.signResourceUrl({
        nodeUuid: NODE_A.uuid,
        nodeJwtSecret: NODE_A.secret,
        userUuid: USER_UUID,
        serverUuid: 'not-a-uuid',
        resource: { type: 'file-download', path: '/server.properties' },
      }),
    ).rejects.toThrow(/serverUuid/);
  });

  /**
   * An empty `sub` passes the contract schema — it is only `z.string()` — and
   * the panel is deliberately stricter than the contract here. `sub` is the one
   * claim naming a person, and the only handle the daemon has on who is at the
   * other end of a console; a token signed without one produces a session
   * belonging to nobody. The place to catch that is the issuing side, since
   * nothing downstream can recover an attribution that was never signed.
   */
  it('refuses to sign a subject that is not a user uuid', async () => {
    for (const subject of ['', 'julien', '7']) {
      await expect(
        tokens.signConsoleToken({
          nodeUuid: NODE_A.uuid,
          nodeJwtSecret: NODE_A.secret,
          userUuid: subject,
          serverUuid: SERVER_A,
          permissions: [],
        }),
      ).rejects.toThrow(/userUuid/);
    }
  });

  /**
   * A node row whose `jwtSecret` decrypted to an empty string would mean every
   * console token on that node was signed with a key an attacker also has.
   * Node's HMAC refuses a zero-length key, so this fails loudly at signing time
   * — a 500 on the console route — instead of quietly issuing forgeable
   * credentials. That is the right failure, and it is worth a test because it
   * comes from Node rather than from any check written here.
   */
  it('cannot sign with an empty node secret', async () => {
    await expect(
      tokens.signConsoleToken({
        nodeUuid: NODE_A.uuid,
        nodeJwtSecret: '',
        userUuid: USER_UUID,
        serverUuid: SERVER_A,
        permissions: [],
      }),
    ).rejects.toThrow();
  });

  /**
   * There is no floor on key material here, though. The daemon's config schema
   * insists on `min(32)` for the same secret; the panel, which is the side that
   * *signs*, insists on nothing. The generator produces 64 characters, so this
   * is latent rather than live — but the invariant is being enforced on the
   * verifying side only, which is the side that cannot do anything about it.
   */
  it('will sign with a one-character node secret', async () => {
    const token = await tokens.signConsoleToken({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: 'x',
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      permissions: [...ALL_PERMISSIONS],
    });

    expect(await tokens.verifyConsoleToken(token, NODE_A.uuid, 'x')).not.toBeNull();
  });

  it('returns null rather than throwing on rubbish input', async () => {
    for (const rubbish of ['', 'not.a.jwt', 'a.b', '....', 'Bearer ' + 'x'.repeat(40)]) {
      expect(await tokens.verifyConsoleToken(rubbish, NODE_A.uuid, NODE_A.secret)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Signed URLs
// ---------------------------------------------------------------------------

describe('signed URL', () => {
  const tokens = makeTokens();

  const mint = () =>
    tokens.signResourceUrl({
      nodeUuid: NODE_A.uuid,
      nodeJwtSecret: NODE_A.secret,
      userUuid: USER_UUID,
      serverUuid: SERVER_A,
      resource: { type: 'backup-download', backupUuid: SERVER_B },
    });

  it('lives for one minute and names exactly what it authorises', async () => {
    const claims = claimsOf(await mint());

    expect(SIGNED_URL_TTL_SECONDS).toBe(60);
    expect((claims.exp as number) - (claims.iat as number)).toBe(SIGNED_URL_TTL_SECONDS);
    expect(claims.resource).toEqual({ type: 'backup-download', backupUuid: SERVER_B });
  });

  it('is bound to its node like a console token is', async () => {
    const url = await mint();

    expect(await tokens.verifyResourceUrl(url, NODE_B.uuid, NODE_A.secret)).toBeNull();
    expect(await tokens.verifyResourceUrl(url, NODE_A.uuid, NODE_B.secret)).toBeNull();
  });

  /**
   * It is not single-use, and nothing calls it that any more — not the doc
   * comment on `signResourceUrl`, not the contract schema, not
   * `docs/security.md`. Nothing consumes the jti, so the same link works for
   * its whole minute and for as many downloads as anyone holding it cares to
   * start. A minute in a browser history is the real mitigation; this test is
   * what keeps that the whole of the claim.
   */
  it('is not in fact single-use: the same URL verifies twice', async () => {
    const url = await mint();

    expect(await tokens.verifyResourceUrl(url, NODE_A.uuid, NODE_A.secret)).not.toBeNull();
    expect(await tokens.verifyResourceUrl(url, NODE_A.uuid, NODE_A.secret)).not.toBeNull();
  });

  it('refuses a rewritten download path', async () => {
    const forged = tamper(await mint(), (claims) => {
      claims.resource = { type: 'file-download', path: '/../../etc/shadow' };
    });

    expect(await tokens.verifyResourceUrl(forged, NODE_A.uuid, NODE_A.secret)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

describe('access token', () => {
  const tokens = makeTokens();

  const mint = () =>
    tokens.signAccessToken({ sub: USER_UUID, username: 'julien', role: 'USER', sid: '42' });

  it('lives for fifteen minutes and is addressed to the panel', async () => {
    const claims = claimsOf(await mint());

    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect((claims.exp as number) - (claims.iat as number)).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(claims.aud).toBe('hopper:panel');
    expect(claims.sid).toBe('42');
  });

  /**
   * The `sid` is what makes an access token revocable: the guard reads the
   * session back on every request, so a sign-out or a suspension bites before
   * the fifteen minutes are up. Losing this claim would turn the access token
   * into a bearer token nobody can call back — exactly the property the console
   * token has, and the reason that one is limited to two minutes.
   */
  it('is refused if the session identifier is stripped', async () => {
    const forged = tamper(await mint(), (claims) => {
      delete claims.sid;
    });

    expect(await tokens.verifyAccessToken(forged)).toBeNull();
  });

  /**
   * A role outside the pair is refused rather than treated as a plain user.
   * Failing closed on an unknown role matters more than it looks: a future
   * third role added to the token and not to this check would otherwise be
   * silently downgraded — or, with a laxer check, silently accepted.
   */
  it('refuses an unknown role instead of falling back', async () => {
    const forged = await new SignJWT({ username: 'julien', role: 'SUPERADMIN', sid: '1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_UUID)
      .setIssuer(APP_URL)
      .setAudience('hopper:panel')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(makeCrypto().getSigningKey());

    expect(await tokens.verifyAccessToken(forged)).toBeNull();
  });

  it('refuses a token signed with a different APP_SECRET', async () => {
    const other = makeTokens(makeCrypto('a-completely-different-app-secret-xyz'));

    expect(
      await tokens.verifyAccessToken(
        await other.signAccessToken({
          sub: USER_UUID,
          username: 'julien',
          role: 'ADMIN',
          sid: '1',
        }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refresh token: the opaque half
// ---------------------------------------------------------------------------

describe('refresh token', () => {
  const tokens = makeTokens();

  it('lasts thirty days', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  /**
   * Deliberately not a JWT. A signed token cannot be withdrawn before it
   * expires, and thirty days is far too long to be unable to withdraw
   * something; an opaque value looked up in a table can be revoked in one
   * update.
   */
  it('is opaque, not a JWT', () => {
    const { token } = tokens.generateRefreshToken();

    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[A-Za-z0-9]{64}$/);
    expect(() => decodeJwt(token)).toThrow();
  });

  it('stores a digest that does not contain the token', () => {
    const { token, hash } = tokens.generateRefreshToken();

    expect(hash).not.toContain(token);
    expect(hash).not.toBe(token);
    // Deterministic, or `refresh` could never find the row by its digest.
    expect(makeCrypto().hashToken(token)).toBe(hash);
    expect(tokens.generateRefreshToken().hash).not.toBe(hash);
  });

  it('does not repeat itself', () => {
    const drawn = new Set(Array.from({ length: 500 }, () => tokens.generateRefreshToken().token));

    expect(drawn.size).toBe(500);
  });
});

/**
 * Rotation and replay live in `AuthService`, not here — but they are what make
 * the opaque token above worth anything, and the brief asks for them, so they
 * are exercised against a fake session table rather than assumed.
 */
describe('refresh rotation and replay', () => {
  interface FakeUser {
    id: number;
    uuid: string;
    username: string;
    email: string;
    role: 'ADMIN' | 'USER';
    suspended: boolean;
    totpConfirmed: boolean;
  }

  interface FakeSession {
    id: number;
    userId: number;
    tokenHash: string;
    family: string;
    revokedAt: Date | null;
    expiresAt: Date;
  }

  const CONTEXT = { ip: '203.0.113.7', userAgent: 'vitest' };

  let user: FakeUser;
  let sessions: FakeSession[];
  let nextId: number;
  let auth: AuthService;
  let crypto: CryptoService;
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The reuse path logs a warning by design; it is noise in the test output.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    user = {
      id: 1,
      uuid: USER_UUID,
      username: 'julien',
      email: 'julien@example.test',
      role: 'USER',
      suspended: false,
      totpConfirmed: false,
    };
    sessions = [];
    nextId = 1;
    crypto = makeCrypto();
    record = vi.fn().mockResolvedValue(undefined);

    const prisma = {
      session: {
        findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) => {
          const found = sessions.find((s) => s.tokenHash === where.tokenHash);
          return Promise.resolve(found ? { ...found, user } : null);
        }),
        create: vi.fn(({ data }: { data: Omit<FakeSession, 'id' | 'revokedAt'> }) => {
          const created: FakeSession = { ...data, id: nextId++, revokedAt: null };
          sessions.push(created);
          return Promise.resolve(created);
        }),
        update: vi.fn(({ where, data }: { where: { id: number }; data: { revokedAt: Date } }) => {
          const found = sessions.find((s) => s.id === where.id);
          if (found) found.revokedAt = data.revokedAt;
          return Promise.resolve(found);
        }),
        count: vi.fn(
          ({ where }: { where: { family: string; revokedAt: null; expiresAt: { gt: Date } } }) =>
            Promise.resolve(
              sessions.filter(
                (s) =>
                  s.family === where.family &&
                  s.revokedAt === null &&
                  s.expiresAt > where.expiresAt.gt,
              ).length,
            ),
        ),
        updateMany: vi.fn(
          ({ where, data }: { where: { family: string }; data: { revokedAt: Date } }) => {
            let count = 0;
            for (const s of sessions) {
              if (s.family === where.family && s.revokedAt === null) {
                s.revokedAt = data.revokedAt;
                count += 1;
              }
            }
            return Promise.resolve({ count });
          },
        ),
      },
    } as unknown as PrismaService;

    auth = new AuthService(
      prisma,
      {} as unknown as PasswordService,
      makeTokens(crypto),
      {} as unknown as TotpService,
      crypto,
      // The refresh path does not touch the rate limiter.
      {} as never,
      { record } as unknown as AuditService,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Seeds a live session and returns its plaintext refresh token. */
  function seed(family = 'family-1'): string {
    const tokens = makeTokens(crypto);
    const { token, hash } = tokens.generateRefreshToken();
    sessions.push({
      id: nextId++,
      userId: user.id,
      tokenHash: hash,
      family,
      revokedAt: null,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
    return token;
  }

  it('rotates the token and revokes the one presented', async () => {
    const original = seed();
    const result = await auth.refresh(original, CONTEXT);

    expect(result.refreshToken).not.toBe(original);
    expect(
      sessions.find((s) => s.tokenHash === crypto.hashToken(original))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      sessions.find((s) => s.tokenHash === crypto.hashToken(result.refreshToken))?.revokedAt,
    ).toBeNull();
  });

  it('keeps the rotated session in the same family', async () => {
    const result = await auth.refresh(seed('the-family'), CONTEXT);

    expect(
      sessions.find((s) => s.tokenHash === crypto.hashToken(result.refreshToken))?.family,
    ).toBe('the-family');
  });

  /**
   * The attack this defends against: a refresh token stolen from a browser and
   * used once by the thief. The legitimate client then presents the same token,
   * finds it already revoked, and the whole family falls — thief included. Both
   * parties are signed out, which is the intended trade: a re-login beats a
   * session quietly plundered for thirty days.
   */
  it('cannot be replayed, and burns the whole family when it is tried', async () => {
    const stolen = seed('doomed');
    const rotated = await auth.refresh(stolen, CONTEXT);

    // Past the window a racing tab is given. Only `Date` is faked: faking the
    // timers wholesale would take the microtask queue with it and the awaits
    // below would never settle.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ROTATION_GRACE_MS + 1_000);

    await expect(auth.refresh(stolen, CONTEXT)).rejects.toThrow(/revoked/i);

    // The token the honest client obtained is dead too.
    expect(
      sessions.find((s) => s.tokenHash === crypto.hashToken(rotated.refreshToken))?.revokedAt,
    ).toBeInstanceOf(Date);
    await expect(auth.refresh(rotated.refreshToken, CONTEXT)).rejects.toThrow(/revoked/i);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { family: 'doomed' } }),
    );
  });

  /**
   * Two tabs, one cookie jar, one refresh token.
   *
   * The access cookie's `maxAge` is the access token's own lifetime, so every
   * tab of the same browser loses it at the same second. Each then sees a 401
   * and refreshes — and `api.ts` only de-duplicates that *within a tab*, because
   * its in-flight promise is a module variable. So one tab rotates, the other's
   * request arrives holding the token that rotation just revoked, the family
   * burns, and both tabs are signed out. Every fifteen minutes, for anybody who
   * works with the panel open twice.
   *
   * The replay is real; what it is not is theft. A racing tab presents the old
   * token within milliseconds of its rotation and the family is still alive; a
   * stolen token turns up long afterwards, or after the family has been signed
   * out. Those two are told apart below, and only the second one burns.
   */
  it('does not sign everybody out when two tabs refresh at the same moment', async () => {
    const shared = seed('two-tabs');

    const first = await auth.refresh(shared, CONTEXT);
    const second = await auth.refresh(shared, CONTEXT);

    // Both tabs hold a working session, and neither has been revoked.
    expect(
      sessions.find((s) => s.tokenHash === crypto.hashToken(first.refreshToken))?.revokedAt,
    ).toBeNull();
    expect(
      sessions.find((s) => s.tokenHash === crypto.hashToken(second.refreshToken))?.revokedAt,
    ).toBeNull();

    // And nothing was reported as an attack, because nothing was one.
    expect(record).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: AUDIT_EVENTS.TOKEN_REUSE_DETECTED }),
    );
  });

  /**
   * The other half of the race test, and the one that keeps it honest.
   *
   * Signing out revokes every session in the family and creates no successor,
   * so a token replayed straight afterwards is inside the grace window and must
   * still be refused. Without this, "was it revoked recently?" would be the
   * whole test and a token picked out of a shared machine seconds after its
   * owner signed out would open the session back up.
   */
  it('still refuses a token replayed a second after signing out', async () => {
    const token = seed('signed-out');
    await auth.logout(token, CONTEXT);

    await expect(auth.refresh(token, CONTEXT)).rejects.toThrow(/revoked/i);
  });

  it('burns the family for a replay just past the window', async () => {
    const stolen = seed('late');
    await auth.refresh(stolen, CONTEXT);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ROTATION_GRACE_MS + 1);

    await expect(auth.refresh(stolen, CONTEXT)).rejects.toThrow(/revoked/i);
    expect(sessions.filter((s) => s.family === 'late' && s.revokedAt === null)).toHaveLength(0);
  });

  it('refuses an unknown token without saying whether it ever existed', async () => {
    await expect(auth.refresh('A'.repeat(64), CONTEXT)).rejects.toThrow(/unknown or expired/i);
  });

  it('refuses a session past its thirty days', async () => {
    const token = seed();
    const session = sessions.find((s) => s.tokenHash === crypto.hashToken(token))!;
    session.expiresAt = new Date(Date.now() - 1000);

    await expect(auth.refresh(token, CONTEXT)).rejects.toThrow(/expired/i);
  });

  it('refuses to rotate for a suspended account', async () => {
    const token = seed();
    user.suspended = true;

    await expect(auth.refresh(token, CONTEXT)).rejects.toThrow(/suspended/i);
  });
});

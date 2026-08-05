import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Environment } from '../../config/environment.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AuthService, type LoginResult, type RequestContext } from './auth.service.js';

/**
 * Passkeys.
 *
 * A passkey is a key pair held by the authenticator — a phone, a laptop's
 * secure enclave, a USB key. The private half never leaves it and never
 * reaches us, so there is nothing here for a stolen database to replay, and
 * nothing for a convincing copy of the sign-in page to collect: the signature
 * covers the origin, and a look-alike domain gets a signature that verifies
 * against the wrong one. That is the property passwords cannot be given.
 *
 * Two decisions are worth stating plainly, because both are refusals.
 *
 * `userVerification: 'required'`, at registration and at login. A passkey used
 * without it proves possession only, and would then need a second factor to be
 * a login — which is the arrangement passkeys exist to replace. Required means
 * the authenticator asks for a PIN or a biometric every time, so what arrives
 * here is already two factors. A security key with no PIN cannot be enrolled;
 * that is the price, and it is worth it.
 *
 * The relying party comes from `APP_URL` and from nowhere else. It is the
 * domain the browser binds the credential to, so an instance setting that
 * could move it is an instance setting that could hand every passkey to
 * another origin. Settings are editable by administrators; this is not a
 * decision an administrator should be able to get wrong.
 */

/** A ceremony is someone tapping a key. Anything longer is an abandoned tab. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 300;

/** The columns every reader here needs; Prisma's own row satisfies it. */
interface PasskeyRow {
  id: number;
  name: string;
  backedUp: boolean;
  transports: string[];
  credentialId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface PasskeySummary {
  id: number;
  name: string;
  backedUp: boolean;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * Whether a signature counter says the credential has been cloned.
 *
 * The counter only ever moves forward on a genuine authenticator. A value at
 * or below the one already recorded means the same credential signed
 * somewhere else, on hardware that did not see our last login — a copy.
 *
 * Except when it is always zero. Plenty of authenticators, including most
 * platform ones on phones and laptops, do not implement the counter at all and
 * report zero forever. Reading that as a regression would lock out the
 * majority of real passkeys, so a presented zero is never a regression.
 *
 * Exported and pure so the rule can be tested. It refuses logins, which makes
 * getting it wrong expensive in both directions.
 */
export function isCounterRegression(stored: number, presented: number): boolean {
  if (presented === 0) {
    return false;
  }

  return presented <= stored;
}

/**
 * Whether a stored challenge may be spent on this ceremony, now.
 *
 * A registration challenge presented at the login endpoint would let someone
 * who can start a registration mint something the login path accepts. The two
 * are never interchangeable.
 */
export function challengeIsUsable(
  row: { purpose: string; expiresAt: Date },
  purpose: string,
  now: Date,
): boolean {
  return row.purpose === purpose && row.expiresAt.getTime() > now.getTime();
}

@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private readonly rpId: string;
  private readonly origin: string;
  private readonly rpName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
    config: ConfigService<Environment, true>,
  ) {
    const appUrl = config.get('APP_URL', { infer: true });
    const url = new URL(appUrl);

    // The host without the port: the RP ID is a domain, and a credential
    // registered on :8080 has to keep working once a reverse proxy is in
    // front of it on :443.
    this.rpId = url.hostname;
    this.origin = url.origin;
    this.rpName = 'Hopper';

    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      this.logger.warn(
        `APP_URL is ${appUrl}: browsers only allow passkeys over https, or on localhost. Registration will fail as it stands.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Registration — always inside an authenticated session
  // -------------------------------------------------------------------------

  async beginRegistration(userId: number): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const existing = await this.prisma.passkey.findMany({ where: { userId } });

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      // The account's stable identifier, not its id: a user handle that could
      // be reassigned would let a deleted account's passkey land on a new one.
      userID: Buffer.from(user.uuid, 'utf8'),
      userName: user.email,
      userDisplayName: user.username,
      attestationType: 'none',
      // Registering the same authenticator twice would leave the user with two
      // rows they cannot tell apart, and one of them dead.
      excludeCredentials: existing.map((passkey: PasskeyRow) => ({
        id: passkey.credentialId,
        transports: passkey.transports as never,
      })),
      authenticatorSelection: {
        // Discoverable, so signing in needs no username first: the
        // authenticator says who it is. Without it the login page would have
        // to ask for an identifier, which is the friction passkeys remove.
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    await this.storeChallenge(options.challenge, userId, 'registration');

    return options as unknown as Record<string, unknown>;
  }

  async finishRegistration(
    userId: number,
    response: RegistrationResponseJSON,
    name: string,
    context: RequestContext,
  ): Promise<PasskeySummary> {
    const challenge = await this.consumeChallenge(response.response.clientDataJSON, 'registration');

    if (challenge.userId !== userId) {
      // The challenge was minted for someone else. Nothing good explains this.
      throw new UnauthorizedException('This registration does not belong to you.');
    }

    let verification;

    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'This passkey could not be verified.',
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('This passkey could not be verified.');
    }

    const { credential, credentialBackedUp } = verification.registrationInfo;

    const passkey = await this.prisma.passkey.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64'),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        backedUp: credentialBackedUp,
        name: name.trim().slice(0, 60) || 'Passkey',
      },
    });

    await this.audit.record({
      event: AUDIT_EVENTS.PASSKEY_REGISTERED,
      actorId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
      // The name, never the credential. An audit log is read by
      // administrators and kept for a long time.
      metadata: { name: passkey.name, backedUp: passkey.backedUp },
    });

    return this.toSummary(passkey);
  }

  // -------------------------------------------------------------------------
  // Authentication — anonymous, so rate limited by address
  // -------------------------------------------------------------------------

  async beginAuthentication(context: RequestContext): Promise<Record<string, unknown>> {
    await this.assertNotRateLimited(context);

    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: 'required',
      // No allowCredentials. Naming the credentials an account holds would
      // answer "does this address have a passkey" to anyone who asks, and the
      // discoverable credential makes the list unnecessary anyway.
    });

    await this.storeChallenge(options.challenge, null, 'authentication');

    return options as unknown as Record<string, unknown>;
  }

  async finishAuthentication(
    response: AuthenticationResponseJSON,
    context: RequestContext,
  ): Promise<LoginResult> {
    await this.assertNotRateLimited(context);

    const challenge = await this.consumeChallenge(
      response.response.clientDataJSON,
      'authentication',
    );

    const passkey = await this.prisma.passkey.findUnique({
      where: { credentialId: response.id },
      include: { user: true },
    });

    if (!passkey) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_FAILED,
        actorId: null,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'unknown-passkey' },
      });
      throw new UnauthorizedException('Unknown passkey.');
    }

    let verification;

    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64')),
          counter: Number(passkey.counter),
          transports: passkey.transports as never,
        },
      });
    } catch (error) {
      await this.audit.record({
        event: AUDIT_EVENTS.LOGIN_FAILED,
        actorId: passkey.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { reason: 'passkey-rejected' },
      });
      throw new UnauthorizedException(
        error instanceof Error ? error.message : 'This passkey was refused.',
      );
    }

    if (!verification.verified) {
      throw new UnauthorizedException('This passkey was refused.');
    }

    const { newCounter } = verification.authenticationInfo;

    // A counter that goes backwards means two authenticators hold the same
    // credential, and only one of them is the user's. Authenticators that do
    // not count at all sit at zero forever, which is not a regression and must
    // not be treated as one.
    if (isCounterRegression(Number(passkey.counter), newCounter)) {
      await this.audit.record({
        event: AUDIT_EVENTS.PASSKEY_CLONE_SUSPECTED,
        actorId: passkey.userId,
        ip: context.ip,
        userAgent: context.userAgent,
        metadata: { name: passkey.name, stored: Number(passkey.counter), presented: newCounter },
      });
      throw new ForbiddenException(
        'This passkey looks cloned and has been refused. Remove it from your account and register a new one.',
      );
    }

    await this.prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
    });

    await this.rateLimiter.reset(this.loginKey(context));

    return this.auth.completeVerifiedLogin(passkey.user, context, AUDIT_EVENTS.PASSKEY_LOGIN);
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  async list(userId: number): Promise<PasskeySummary[]> {
    const passkeys = await this.prisma.passkey.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    return passkeys.map((passkey: PasskeyRow) => this.toSummary(passkey));
  }

  async rename(userId: number, id: number, name: string): Promise<PasskeySummary> {
    const passkey = await this.prisma.passkey.findFirst({ where: { id, userId } });

    if (!passkey) {
      throw new NotFoundException('Passkey not found.');
    }

    const updated = await this.prisma.passkey.update({
      where: { id },
      data: { name: name.trim().slice(0, 60) || passkey.name },
    });

    return this.toSummary(updated);
  }

  async remove(userId: number, id: number, context: RequestContext): Promise<void> {
    // Scoped by user, not merely checked: an id belonging to someone else must
    // find nothing rather than be refused, so the endpoint cannot be used to
    // ask which ids exist.
    const passkey = await this.prisma.passkey.findFirst({ where: { id, userId } });

    if (!passkey) {
      throw new NotFoundException('Passkey not found.');
    }

    await this.prisma.passkey.delete({ where: { id } });

    // Removing the last one is allowed. The password still works, and an
    // account that cannot drop a lost authenticator is an account held hostage
    // by it.
    await this.audit.record({
      event: AUDIT_EVENTS.PASSKEY_REMOVED,
      actorId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
      metadata: { name: passkey.name },
    });
  }

  // -------------------------------------------------------------------------
  // Challenges
  // -------------------------------------------------------------------------

  private async storeChallenge(
    challenge: string,
    userId: number | null,
    purpose: 'registration' | 'authentication',
  ): Promise<void> {
    await this.prisma.webauthnChallenge.create({
      data: {
        challenge,
        userId,
        purpose,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });

    // Opportunistic: expired rows are worthless and nothing else would ever
    // remove them.
    await this.prisma.webauthnChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }

  /**
   * Reads the challenge out of the client data and spends it.
   *
   * The delete is the check. Two requests replaying one signature race on the
   * same row, and the database decides: one deletes it, the other finds
   * nothing. Reading first and deleting after would leave a window where both
   * pass — small, but a replay window is exactly what an attacker is patient
   * enough to hit.
   */
  private async consumeChallenge(
    clientDataJSON: string,
    purpose: 'registration' | 'authentication',
  ): Promise<{ challenge: string; userId: number | null }> {
    let presented: string;

    try {
      const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as {
        challenge?: unknown;
      };

      if (typeof clientData.challenge !== 'string') {
        throw new Error('no challenge');
      }

      presented = clientData.challenge;
    } catch {
      throw new BadRequestException('Malformed authenticator response.');
    }

    // `challenge` is unique, so this deletes at most one row and hands it back.
    // A second request presenting the same signature finds nothing to delete.
    let row;

    try {
      row = await this.prisma.webauthnChallenge.delete({ where: { challenge: presented } });
    } catch {
      throw new UnauthorizedException('This request has expired. Start again.');
    }

    // Checked after the row is spent, not before. A challenge offered for the
    // wrong ceremony, or offered late, is burned either way — leaving it
    // usable would hand a retry to whoever got it wrong on purpose.
    if (!challengeIsUsable(row, purpose, new Date())) {
      throw new UnauthorizedException('This request has expired. Start again.');
    }

    return { challenge: row.challenge, userId: row.userId };
  }

  private async assertNotRateLimited(context: RequestContext): Promise<void> {
    const result = await this.rateLimiter.consume(
      this.loginKey(context),
      LOGIN_ATTEMPTS,
      LOGIN_WINDOW_SECONDS,
    );

    if (!result.allowed) {
      throw new UnauthorizedException('Too many attempts. Try again shortly.');
    }
  }

  private loginKey(context: RequestContext): string {
    return `auth:passkey:${context.ip}`;
  }

  private toSummary(passkey: PasskeyRow): PasskeySummary {
    return {
      id: passkey.id,
      name: passkey.name,
      backedUp: passkey.backedUp,
      transports: passkey.transports,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
    };
  }
}

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { apiKeySecretMatches, hashApiKeySecret, ipAllowed } from '../api-keys/api-key.js';
import {
  displayableApplicationKey,
  generateApplicationKey,
  parseApplicationKey,
  type ApplicationKeyScope,
} from './application-key.js';

/**
 * Same reasoning as the personal keys: a key called in a loop must not cost one
 * write per call. A provisioning API is called in bursts — a customer signs up,
 * six requests follow — so the resolution matters more here than there.
 */
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

/** Identity attached to a request authenticated by an application key. */
export interface AuthenticatedApplication {
  id: number;
  uuid: string;
  name: string;
  scopes: string[];
}

export interface CreateApplicationKeyDto {
  name: string;
  scopes: ApplicationKeyScope[];
  allowedIps: string[];
  expiresAt?: string;
}

@Injectable()
export class ApplicationKeysService {
  private readonly logger = new Logger(ApplicationKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const keys = await this.prisma.applicationKey.findMany({
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      include: { createdBy: { select: { username: true } } },
    });

    return keys.map((key) => ({
      uuid: key.uuid,
      name: key.name,
      key: displayableApplicationKey(key.identifier),
      scopes: key.scopes,
      allowedIps: key.allowedIps,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      createdAt: key.createdAt,
      // Null once that account is gone. The key is still here, which is the
      // whole point of it not belonging to anyone.
      createdBy: key.createdBy?.username ?? null,
    }));
  }

  /**
   * Creates a key and returns the token **once only**.
   *
   * @param createdById Who is creating it, for the trail. Optional because the
   *   command line creates keys during an installation, before there is a
   *   session to attribute them to.
   */
  async create(dto: CreateApplicationKeyDto, createdById?: number) {
    const existing = await this.prisma.applicationKey.findFirst({
      where: { name: dto.name, revokedAt: null },
      select: { id: true },
    });

    // Names are how an operator recognises which integration a call came from,
    // in the key list and in the audit trail. Two live keys called "Paymenter"
    // make both unreadable, and revoking "the wrong one" is then a coin toss.
    if (existing) {
      throw new ConflictException(`An active key is already named "${dto.name}".`);
    }

    const { token, identifier, secret } = generateApplicationKey();

    const key = await this.prisma.applicationKey.create({
      data: {
        name: dto.name,
        identifier,
        tokenHash: hashApiKeySecret(secret),
        scopes: dto.scopes,
        allowedIps: dto.allowedIps,
        expiresAt: dto.expiresAt === undefined ? null : new Date(dto.expiresAt),
        createdById: createdById ?? null,
      },
    });

    return {
      uuid: key.uuid,
      name: key.name,
      token,
      scopes: key.scopes,
      allowedIps: key.allowedIps,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    };
  }

  /**
   * Revokes a key without deleting it.
   *
   * Deleting would take with it the only thing that names the integration
   * behind two hundred audit entries. Revoking twice is not an error: an
   * operator hitting revoke again on a key that already reads as revoked has
   * got what they wanted.
   */
  async revoke(uuid: string): Promise<void> {
    const key = await this.prisma.applicationKey.findUnique({
      where: { uuid },
      select: { id: true, revokedAt: true },
    });

    if (!key) {
      throw new NotFoundException('Key not found.');
    }

    if (key.revokedAt !== null) {
      return;
    }

    await this.prisma.applicationKey.update({
      where: { id: key.id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Authenticates a key presented in an `Authorization` header.
   *
   * Returns `null` for every reason of failure without distinguishing them —
   * bad format, unknown identifier, wrong secret, expired, revoked, address
   * outside the list. Telling them apart in the answer would tell a caller
   * which identifiers exist.
   */
  async authenticate(
    token: string,
    ip: string | undefined,
  ): Promise<AuthenticatedApplication | null> {
    const parsed = parseApplicationKey(token);

    if (!parsed) {
      return null;
    }

    const key = await this.prisma.applicationKey.findUnique({
      where: { identifier: parsed.identifier },
    });

    if (!key || !apiKeySecretMatches(parsed.secret, key.tokenHash)) {
      return null;
    }

    if (key.revokedAt !== null) {
      return null;
    }

    if (key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    if (!ipAllowed(key.allowedIps, ip)) {
      // Logged, unlike the other refusals: a key presented from an address
      // outside its list is either a misconfigured integration or a stolen
      // credential, and both are worth an operator's attention. The other
      // failures are indistinguishable from someone probing.
      this.logger.warn(
        `Application key "${key.name}" presented from ${ip ?? 'an unknown address'}, outside its list`,
      );
      return null;
    }

    void this.touch(key.id, key.lastUsedAt);

    return { id: key.id, uuid: key.uuid, name: key.name, scopes: key.scopes };
  }

  private async touch(id: number, lastUsedAt: Date | null): Promise<void> {
    if (lastUsedAt !== null && Date.now() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) {
      return;
    }

    await this.prisma.applicationKey
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch(() => {
        // The key may have been revoked between authentication and here: a
        // missed write must not fail a request that was already authorised.
      });
  }
}

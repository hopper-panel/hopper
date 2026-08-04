import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  apiKeySecretMatches,
  displayableKey,
  generateApiKey,
  hashApiKeySecret,
  ipAllowed,
  parseApiKey,
  type ApiKeyScope,
} from './api-key.js';

/** Past this, the list becomes unmanageable and every forgotten key is a risk. */
const MAX_KEYS_PER_USER = 20;

/**
 * A key is not written back on every request to update its last-use date: an
 * API called in a loop would make one write per read. It is only written if the
 * last trace is more than five minutes old, which is amply enough to answer the
 * question "is this key still in use?".
 */
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

export interface AuthenticatedApiKey {
  id: number;
  scopes: string[];
  user: { id: number; uuid: string; username: string; email: string; role: 'ADMIN' | 'USER' };
}

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: number) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return keys.map((key) => ({
      identifier: key.identifier,
      key: displayableKey(key.identifier),
      memo: key.memo,
      scopes: key.scopes,
      allowedIps: key.allowedIps,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    }));
  }

  /**
   * Creates a key and returns the token **once only**.
   *
   * It is not kept in the clear: losing it forces creating another, which is
   * the intended behaviour.
   */
  async create(
    userId: number,
    role: 'ADMIN' | 'USER',
    dto: { memo: string; scopes: ApiKeyScope[]; allowedIps: string[]; expiresAt?: string },
  ) {
    // An "admin" key created by an ordinary account would grant nothing extra
    // — the guard checks the real role on every request — but it would suggest
    // otherwise. Better to refuse plainly.
    if (dto.scopes.includes('admin') && role !== 'ADMIN') {
      throw new ForbiddenException('The "admin" scope is for administrators only.');
    }

    const count = await this.prisma.apiKey.count({ where: { userId } });

    if (count >= MAX_KEYS_PER_USER) {
      throw new ForbiddenException(
        `You have reached the limit of ${MAX_KEYS_PER_USER} keys. Delete one before creating another.`,
      );
    }

    const { token, identifier, secret } = generateApiKey();

    const key = await this.prisma.apiKey.create({
      data: {
        userId,
        identifier,
        tokenHash: hashApiKeySecret(secret),
        memo: dto.memo,
        scopes: dto.scopes,
        allowedIps: dto.allowedIps,
        expiresAt: dto.expiresAt === undefined ? null : new Date(dto.expiresAt),
      },
    });

    return {
      identifier: key.identifier,
      token,
      memo: key.memo,
      scopes: key.scopes,
      allowedIps: key.allowedIps,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    };
  }

  async remove(userId: number, identifier: string): Promise<void> {
    // Deletion is filtered on the owner: without that, knowing a key's public
    // identifier would be enough to revoke somebody else's.
    const { count } = await this.prisma.apiKey.deleteMany({ where: { userId, identifier } });

    if (count === 0) {
      throw new NotFoundException('Key not found.');
    }
  }

  /**
   * Authenticates a key presented in an `Authorization` header.
   *
   * Returns `null` for any reason of failure, without distinguishing: invalid
   * format, unknown key, wrong secret, expiry, refused address, suspended
   * account. Telling those cases apart in the response would tell an attacker
   * which identifier exists.
   */
  async authenticate(token: string, ip: string | undefined): Promise<AuthenticatedApiKey | null> {
    const parsed = parseApiKey(token);

    if (!parsed) {
      return null;
    }

    const key = await this.prisma.apiKey.findUnique({
      where: { identifier: parsed.identifier },
      include: {
        user: {
          select: {
            id: true,
            uuid: true,
            username: true,
            email: true,
            role: true,
            suspended: true,
          },
        },
      },
    });

    if (!key || !apiKeySecretMatches(parsed.secret, key.tokenHash)) {
      return null;
    }

    if (key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    if (!ipAllowed(key.allowedIps, ip)) {
      this.logger.warn(
        `Key ${key.identifier} presented from ${ip ?? 'an unknown address'}, outside its list`,
      );
      return null;
    }

    if (key.user.suspended) {
      return null;
    }

    void this.touch(key.id, key.lastUsedAt);

    return {
      id: key.id,
      scopes: key.scopes,
      user: {
        id: key.user.id,
        uuid: key.user.uuid,
        username: key.user.username,
        email: key.user.email,
        role: key.user.role,
      },
    };
  }

  private async touch(id: number, lastUsedAt: Date | null): Promise<void> {
    if (lastUsedAt !== null && Date.now() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) {
      return;
    }

    await this.prisma.apiKey
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch(() => {
        // The key may have been revoked between authentication and here: the
        // missed write must not fail a request that was already authorised.
      });
  }
}

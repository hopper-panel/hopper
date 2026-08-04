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

/** Au-delà, la liste devient ingérable et chaque clé oubliée est un risque. */
const MAX_KEYS_PER_USER = 20;

/**
 * Une clé n'est pas relue à chaque requête pour mettre à jour sa date d'usage :
 * une API appelée en boucle ferait une écriture par lecture. On n'écrit que si
 * la dernière trace remonte à plus de cinq minutes, ce qui suffit largement à
 * répondre à la question « cette clé sert-elle encore ? ».
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
   * Crée une clé et rend le jeton **une seule fois**.
   *
   * Il n'est pas conservé en clair : le perdre impose d'en créer une autre,
   * ce qui est le comportement voulu.
   */
  async create(
    userId: number,
    role: 'ADMIN' | 'USER',
    dto: { memo: string; scopes: ApiKeyScope[]; allowedIps: string[]; expiresAt?: string },
  ) {
    // Une clé « admin » créée par un compte ordinaire ne donnerait rien de plus
    // — le garde vérifie le rôle réel à chaque requête — mais elle laisserait
    // croire le contraire. Mieux vaut refuser franchement.
    if (dto.scopes.includes('admin') && role !== 'ADMIN') {
      throw new ForbiddenException('La portée « admin » est réservée aux administrateurs.');
    }

    const count = await this.prisma.apiKey.count({ where: { userId } });

    if (count >= MAX_KEYS_PER_USER) {
      throw new ForbiddenException(
        `Vous avez atteint la limite de ${MAX_KEYS_PER_USER} clés. Supprimez-en une avant d'en créer une autre.`,
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
    // La suppression est filtrée sur le propriétaire : sans cela, connaître
    // l'identifiant public d'une clé suffirait à révoquer celle d'un autre.
    const { count } = await this.prisma.apiKey.deleteMany({ where: { userId, identifier } });

    if (count === 0) {
      throw new NotFoundException('Clé introuvable.');
    }
  }

  /**
   * Authentifie une clé présentée dans un en-tête `Authorization`.
   *
   * Rend `null` pour toute raison d'échec, sans distinguer : format invalide,
   * clé inconnue, secret faux, expiration, adresse refusée, compte suspendu.
   * Distinguer ces cas dans la réponse dirait à un attaquant quel identifiant
   * existe.
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
        `Clé ${key.identifier} présentée depuis ${ip ?? 'une adresse inconnue'}, hors de sa liste`,
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
        // La clé a pu être révoquée entre l'authentification et ici : l'écriture
        // manquée ne doit pas faire échouer une requête déjà autorisée.
      });
  }
}

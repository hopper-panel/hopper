import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Environment } from '../../config/environment.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Secondes avant que le compteur ne reparte à zéro. */
  resetInSeconds: number;
}

/**
 * Compteur à fenêtre glissante, adossé à Redis.
 *
 * Redis plutôt qu'une Map en mémoire : sans lui, un redémarrage du panel
 * remettrait tous les compteurs à zéro — et un attaquant patient n'aurait qu'à
 * provoquer un redémarrage, ou attendre le déploiement suivant, pour reprendre
 * son bourrage d'identifiants.
 *
 * Si `REDIS_URL` n'est pas défini, un repli en mémoire prend le relais pour que
 * le développement local reste simple. Ce repli est journalisé au démarrage :
 * il n'est pas acceptable en production, et l'opérateur doit le savoir.
 */
@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, { count: number; expiresAt: number }>();

  constructor(config: ConfigService<Environment, true>) {
    const url = config.get('REDIS_URL', { infer: true });

    if (url) {
      this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
      this.redis.on('error', (error) => {
        this.logger.error(`Redis indisponible : ${error.message}`);
      });
    } else {
      this.redis = null;
      this.logger.warn(
        'REDIS_URL absent : limitation de débit en mémoire. Les compteurs sont perdus à chaque redémarrage — ne pas utiliser en production.',
      );
    }
  }

  /**
   * Incrémente le compteur de `key` et indique si l'appel est autorisé.
   *
   * @param key    Identifiant du seau, ex. `auth:login:192.0.2.1`.
   * @param limit  Nombre d'appels autorisés dans la fenêtre.
   * @param windowSeconds Durée de la fenêtre.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!this.redis) {
      return this.consumeInMemory(key, limit, windowSeconds);
    }

    try {
      // INCR puis EXPIRE seulement au premier passage : poser l'expiration à
      // chaque appel transformerait la fenêtre en fenêtre glissante infinie,
      // et un attaquant régulier ne verrait jamais son compteur expirer.
      const pipeline = this.redis.multi().incr(key);
      pipeline.ttl(key);
      const results = await pipeline.exec();

      const count = Number(results?.[0]?.[1] ?? 0);
      let ttl = Number(results?.[1]?.[1] ?? -1);

      if (ttl < 0) {
        await this.redis.expire(key, windowSeconds);
        ttl = windowSeconds;
      }

      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetInSeconds: ttl,
      };
    } catch (error: unknown) {
      // Redis en panne ne doit pas bloquer les connexions légitimes, mais on le
      // signale : c'est un affaiblissement, pas un fonctionnement normal.
      this.logger.error(`Limitation de débit indisponible, appel autorisé : ${String(error)}`);
      return { allowed: true, remaining: limit, resetInSeconds: windowSeconds };
    }
  }

  /** Remet un compteur à zéro, après une authentification réussie par exemple. */
  async reset(key: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(key);
      return;
    }
    this.memory.delete(key);
  }

  private consumeInMemory(key: string, limit: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    const existing = this.memory.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.memory.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, resetInSeconds: windowSeconds };
    }

    existing.count += 1;

    return {
      allowed: existing.count <= limit,
      remaining: Math.max(0, limit - existing.count),
      resetInSeconds: Math.ceil((existing.expiresAt - now) / 1000),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }
}

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Environment } from '../../config/environment.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds before the counter starts again from zero. */
  resetInSeconds: number;
}

/**
 * Sliding-window counter, backed by Redis.
 *
 * Redis rather than an in-memory Map: without it, a panel restart would reset
 * every counter — and a patient attacker would only have to cause a restart, or
 * wait for the next deployment, to resume their credential stuffing.
 *
 * If `REDIS_URL` is not set, an in-memory fallback takes over so that local
 * development stays simple. That fallback is logged at startup: it is not
 * acceptable in production, and the operator has to know.
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
        this.logger.error(`Redis unavailable: ${error.message}`);
      });
    } else {
      this.redis = null;
      this.logger.warn(
        'REDIS_URL missing: rate limiting in memory. The counters are lost on every restart — do not use in production.',
      );
    }
  }

  /**
   * Increments `key`'s counter and says whether the call is allowed.
   *
   * @param key    Bucket identifier, e.g. `auth:login:192.0.2.1`.
   * @param limit  Number of calls allowed within the window.
   * @param windowSeconds Length of the window.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!this.redis) {
      return this.consumeInMemory(key, limit, windowSeconds);
    }

    try {
      // INCR then EXPIRE on the first pass only: setting the expiry on every
      // call would turn the window into an endlessly sliding one, and a regular
      // attacker would never see their counter expire.
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
      // A Redis outage must not block legitimate sign-ins, but it is reported:
      // this is a weakening, not normal operation.
      this.logger.error(`Rate limiting unavailable, call allowed: ${String(error)}`);
      return { allowed: true, remaining: limit, resetInSeconds: windowSeconds };
    }
  }

  /** Resets a counter, after a successful sign-in for instance. */
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

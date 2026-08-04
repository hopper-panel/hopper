import { Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DEFAULT_SETTINGS,
  SECRET_KEYS,
  deserializeSetting,
  instanceSettingsSchema,
  isSecretKey,
  serializeSetting,
  type InstanceSettings,
  type UpdateInstanceSettingsDto,
} from './definitions.js';

/**
 * Instance settings.
 *
 * Read every time they are needed — sending an email, making a request to a
 * node — and therefore cached: without that, every call to a daemon would mean
 * a database read to learn its timeout. The cache is invalidated on write,
 * which always goes through here.
 *
 * Secret values are encrypted at rest with the same key as node tokens and SQL
 * passwords. They never leave through the API: the form shows an empty field,
 * and an empty string sent back means "do not touch", failing which opening the
 * screen and saving it would wipe the SMTP password.
 */
@Injectable()
export class InstanceSettingsService {
  private readonly logger = new Logger(InstanceSettingsService.name);
  private cache: InstanceSettings | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Every setting, defaults included. */
  async all(): Promise<InstanceSettings> {
    if (this.cache) {
      return this.cache;
    }

    const rows = await this.prisma.setting.findMany();
    const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };

    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) {
        // A setting removed from the code in a later version must not fail the
        // reading of all the others.
        continue;
      }

      const key = row.key as keyof InstanceSettings;

      let raw = row.value;

      if (isSecretKey(key)) {
        try {
          raw = this.crypto.decrypt(row.value);
        } catch {
          // APP_SECRET changed: the secret is unreadable. It is treated as
          // absent rather than failing the whole configuration.
          this.logger.error(
            `Setting "${key}" cannot be decrypted: did APP_SECRET change? It has to be entered again.`,
          );
          continue;
        }
      }

      const value = deserializeSetting(key, raw);

      if (value !== undefined) {
        values[key] = value;
      }
    }

    const parsed = instanceSettingsSchema.safeParse(values);
    this.cache = parsed.success ? parsed.data : DEFAULT_SETTINGS;

    if (!parsed.success) {
      this.logger.error(
        `Invalid instance settings in the database, defaults applied: ${parsed.error.message}`,
      );
    }

    return this.cache;
  }

  /** The settings as the API returns them: secrets replaced by a flag. */
  async forApi(): Promise<Record<string, unknown>> {
    const settings = await this.all();
    const exposed: Record<string, unknown> = { ...settings };

    for (const key of SECRET_KEYS) {
      exposed[key] = '';
      exposed[`${key}Set`] = settings[key] !== '';
    }

    return exposed;
  }

  async update(dto: UpdateInstanceSettingsDto): Promise<InstanceSettings> {
    const entries = Object.entries(dto) as [keyof InstanceSettings, unknown][];

    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }

      let stored: string;

      if (isSecretKey(key)) {
        // An empty secret means "unchanged": the form cannot redisplay the
        // value in place, and saving it as is would wipe it on every visit to
        // the screen. The type is narrowed on the way — `Object.entries` does
        // not know these keys carry strings, and a blind conversion would write
        // "[object Object]".
        if (typeof value !== 'string' || value === '') {
          continue;
        }

        stored = this.crypto.encrypt(value);
      } else {
        stored = serializeSetting(value);
      }

      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value: stored },
        update: { value: stored },
      });
    }

    this.cache = null;

    return this.all();
  }

  /** Clears a secret — the interface offers to remove it, not only change it. */
  async clearSecret(key: (typeof SECRET_KEYS)[number]): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key } });
    this.cache = null;
  }
}

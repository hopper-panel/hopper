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
 * Paramètres de l'instance.
 *
 * Lus à chaque fois qu'ils servent — un envoi de courriel, une requête vers un
 * node — et donc mis en cache : sans cela, chaque appel à un daemon ferait une
 * lecture en base pour connaître son délai d'attente. Le cache est invalidé à
 * l'écriture, qui passe toujours par ici.
 *
 * Les valeurs secrètes sont chiffrées au repos avec la même clé que les jetons
 * de node et les mots de passe SQL. Elles ne ressortent jamais de l'API : le
 * formulaire affiche un champ vide, et une chaîne vide envoyée signifie « ne
 * touche pas », faute de quoi ouvrir l'écran puis l'enregistrer effacerait le
 * mot de passe SMTP.
 */
@Injectable()
export class InstanceSettingsService {
  private readonly logger = new Logger(InstanceSettingsService.name);
  private cache: InstanceSettings | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Tous les paramètres, valeurs par défaut comprises. */
  async all(): Promise<InstanceSettings> {
    if (this.cache) {
      return this.cache;
    }

    const rows = await this.prisma.setting.findMany();
    const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };

    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) {
        // Un paramètre retiré du code dans une version ultérieure ne doit pas
        // faire échouer la lecture de tous les autres.
        continue;
      }

      const key = row.key as keyof InstanceSettings;

      let raw = row.value;

      if (isSecretKey(key)) {
        try {
          raw = this.crypto.decrypt(row.value);
        } catch {
          // APP_SECRET a changé : le secret est illisible. On le traite comme
          // absent plutôt que de faire échouer toute la configuration.
          this.logger.error(
            `Paramètre « ${key} » indéchiffrable : APP_SECRET a-t-il changé ? Il faut le ressaisir.`,
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
        `Paramètres d'instance invalides en base, valeurs par défaut appliquées : ${parsed.error.message}`,
      );
    }

    return this.cache;
  }

  /** Les paramètres tels que l'API les rend : secrets remplacés par un drapeau. */
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
        // Un secret vide veut dire « inchangé » : le formulaire ne peut pas
        // réafficher la valeur en place, et l'enregistrer telle quelle
        // l'effacerait à chaque passage sur l'écran. Le type est resserré au
        // passage — `Object.entries` ne sait pas que ces clés portent des
        // chaînes, et une conversion aveugle écrirait « [object Object] ».
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

  /** Efface un secret — l'interface propose de le retirer, pas seulement de le changer. */
  async clearSecret(key: (typeof SECRET_KEYS)[number]): Promise<void> {
    await this.prisma.setting.deleteMany({ where: { key } });
    this.cache = null;
  }
}

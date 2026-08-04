import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Une purge par jour suffit : le journal se compte en milliers de lignes, pas en millions. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Purge du journal d'activité.
 *
 * Désactivée par défaut, et c'est délibéré : le journal est la mémoire de
 * l'instance — qui a supprimé ce fichier, depuis quelle adresse, quand — et une
 * rétention imposée d'office effacerait la trace d'un incident avant qu'on ne
 * le découvre. C'est un choix d'exploitation, pris dans l'administration.
 */
@Injectable()
export class ActivityRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
  ) {}

  onModuleInit(): void {
    // Une première passe au démarrage : sur un panel redémarré chaque nuit par
    // une mise à jour, un minuteur de vingt-quatre heures ne se déclencherait
    // jamais.
    void this.prune();

    this.timer = setInterval(() => void this.prune(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async prune(): Promise<number> {
    const { activityRetentionDays } = await this.settings.all();

    if (activityRetentionDays <= 0) {
      return 0;
    }

    const before = new Date(Date.now() - activityRetentionDays * 24 * 60 * 60 * 1000);

    const { count } = await this.prisma.auditLog
      .deleteMany({ where: { createdAt: { lt: before } } })
      .catch(() => ({ count: 0 }));

    if (count > 0) {
      this.logger.log(
        `${count} entrée(s) de journal supprimée(s), antérieures à ${before.toISOString()}`,
      );
    }

    return count;
  }
}

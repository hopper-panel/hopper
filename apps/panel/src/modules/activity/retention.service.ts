import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** One purge a day is enough: the log counts in thousands of rows, not millions. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Purging the activity log.
 *
 * Off by default, and deliberately so: the log is the instance's memory — who
 * deleted that file, from which address, when — and a retention imposed by
 * default would erase the trace of an incident before anyone discovered it. It
 * is an operational choice, made in the administration.
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
    // A first pass at startup: on a panel restarted every night by an update, a
    // twenty-four-hour timer would never fire.
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
      this.logger.log(`${count} log entry/entries deleted, older than ${before.toISOString()}`);
    }

    return count;
  }
}

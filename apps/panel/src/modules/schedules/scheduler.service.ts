import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { BackupsService } from '../backups/backups.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { CronError, nextOccurrence } from './cron.js';

/**
 * Running the scheduled tasks.
 *
 * **Why a plain timer and not BullMQ.** The plan called for Redis repeatable
 * jobs. In practice that would make Redis a mandatory dependency of a panel
 * installed on a VPS to host three servers, and would duplicate a state — the
 * schedule — the database already holds. The schema carries `nextRunAt` and a
 * `running` flag designed for this from the start: a loop that queries the
 * database is enough, and the database stays the single truth.
 *
 * **What prevents a double trigger.** Claiming a task is an
 * `UPDATE … WHERE running = false`: the database decides, and a single process
 * receives `count = 1`. Two panels wired to the same database therefore cannot
 * launch the same restart twice.
 *
 * **What prevents a permanent block.** A panel killed mid-run would leave
 * `running = true` forever, and the task would never fire again. At startup,
 * every task still marked as running is therefore released: no run survives the
 * death of the process that carried it.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  /**
   * Polling period.
   *
   * Thirty seconds for a cron granularity of one minute: an interval equal to
   * the minute would risk, with drift, skipping a due time between two passes.
   */
  private static readonly TICK_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
    private readonly backups: BackupsService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const released = await this.prisma.schedule.updateMany({
      where: { running: true },
      data: { running: false },
    });

    if (released.count > 0) {
      this.logger.warn(
        `${released.count} scheduled task(s) were marked as running: released.`,
      );
    }

    this.timer = setInterval(() => void this.tick(), SchedulerService.TICK_MS);
    // `unref`: an active timer would keep the process from exiting.
    this.timer.unref();

    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass: claims and runs whatever is due.
   *
   * Runs do not overlap — a sequence with offsets can last several minutes, and
   * a second pass would relaunch tasks the first is still working through.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }

    this.ticking = true;

    try {
      const due = await this.prisma.schedule.findMany({
        where: { active: true, running: false, nextRunAt: { lte: new Date() } },
        select: { id: true, uuid: true, name: true },
      });

      for (const schedule of due) {
        await this.runIfClaimed(schedule.id).catch((error: unknown) => {
          this.logger.error(`Task "${schedule.name}": ${String(error)}`);
        });
      }
    } catch (error: unknown) {
      // A momentarily unreachable database must not stop the loop: the next
      // pass will try again.
      this.logger.error(`Scheduler pass interrupted: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async runIfClaimed(scheduleId: number): Promise<void> {
    // The database arbitrates: a single caller gets `count = 1`.
    const claimed = await this.prisma.schedule.updateMany({
      where: { id: scheduleId, running: false },
      data: { running: true },
    });

    if (claimed.count === 0) {
      return;
    }

    const schedule = await this.prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        tasks: { orderBy: { sequence: 'asc' } },
        server: { include: { node: { select: { uuid: true } } } },
      },
    });

    if (!schedule) {
      return;
    }

    try {
      await this.execute(schedule);
    } finally {
      // The next due time is set whatever happens: a task that fails has to
      // fire again at the next slot, not stay stuck on this one.
      await this.prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          running: false,
          lastRunAt: new Date(),
          nextRunAt: this.nextRunFor(schedule),
        },
      });
    }
  }

  private nextRunFor(schedule: {
    cronMinute: string;
    cronHour: string;
    cronDayOfMonth: string;
    cronMonth: string;
    cronDayOfWeek: string;
    name: string;
  }): Date | null {
    try {
      return nextOccurrence(
        {
          minute: schedule.cronMinute,
          hour: schedule.cronHour,
          dayOfMonth: schedule.cronDayOfMonth,
          month: schedule.cronMonth,
          dayOfWeek: schedule.cronDayOfWeek,
        },
        new Date(),
      );
    } catch (error: unknown) {
      if (error instanceof CronError) {
        // With no next due time, the task stops firing rather than being
        // picked up again on every pass.
        this.logger.error(`Task "${schedule.name}" disabled: ${error.message}`);
        return null;
      }

      throw error;
    }
  }

  private async execute(schedule: {
    id: number;
    name: string;
    onlyWhenOnline: boolean;
    serverId: number;
    server: { uuid: string; node: { uuid: string } };
    tasks: {
      sequence: number;
      action: string;
      payload: string;
      offsetSeconds: number;
      continueOnFailure: boolean;
    }[];
  }): Promise<void> {
    const node = await this.nodes.getConnection(schedule.server.node.uuid);

    if (schedule.onlyWhenOnline) {
      const state = await this.client.fetchServerState(node, schedule.server.uuid);

      // `null` means "we do not know", not "stopped": skipping a backup
      // because the node took too long to answer would be worse than
      // attempting it.
      if (state !== null && state !== 'running') {
        this.logger.log(`Task "${schedule.name}" skipped: the server is ${state}.`);
        return;
      }
    }

    const failures: string[] = [];

    for (const task of schedule.tasks) {
      if (task.offsetSeconds > 0) {
        await delay(task.offsetSeconds * 1000);
      }

      try {
        await this.runTask(task, schedule.server.uuid, node);
      } catch (error: unknown) {
        failures.push(`step ${task.sequence + 1} (${task.action}): ${String(error)}`);

        if (!task.continueOnFailure) {
          break;
        }
      }
    }

    await this.audit.record({
      event: AUDIT_EVENTS.SCHEDULE_RUN,
      // The scheduler is not a user.
      actorId: null,
      serverId: schedule.serverId,
      metadata: {
        schedule: schedule.name,
        tasks: schedule.tasks.length,
        failures,
      },
    });

    if (failures.length > 0) {
      this.logger.warn(`Task "${schedule.name}": ${failures.join('; ')}`);
    }
  }

  private async runTask(
    task: { action: string; payload: string },
    serverUuid: string,
    node: { uuid: string; url: string; token: string },
  ): Promise<void> {
    switch (task.action) {
      case 'POWER':
        await this.client.powerServer(
          node,
          serverUuid,
          task.payload as 'start' | 'stop' | 'restart' | 'kill',
        );
        return;

      case 'COMMAND':
        // Several commands per step: announcing a restart then saving the
        // world fits in a single step.
        await this.client.sendCommands(
          node,
          serverUuid,
          task.payload.split(/\r?\n/).filter((line) => line.trim() !== ''),
        );
        return;

      case 'BACKUP':
        await this.backups.create(serverUuid, {
          name: `Scheduled backup`,
          ignoredFiles: task.payload.split(/\r?\n/).filter((line) => line.trim() !== ''),
        });
        return;

      default:
        throw new Error(`Unknown action: ${task.action}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

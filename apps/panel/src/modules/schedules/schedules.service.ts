import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CronError, formatCron, nextOccurrence } from './cron.js';
import type { CreateScheduleDto, UpdateScheduleDto } from './schedules.dto.js';

/**
 * Scheduled tasks, the registry side.
 *
 * Running them lives in `SchedulerService`; here we only keep the list and
 * compute the next due time. The separation matters: `nextRunAt` has to be
 * recomputed on every change to the cron expression, and forgetting that would
 * give a task that keeps firing on the old schedule.
 */
@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const schedules = await this.prisma.schedule.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'asc' },
      include: { tasks: { orderBy: { sequence: 'asc' } } },
    });

    return { data: schedules.map(toPublicSchedule) };
  }

  async findByUuid(serverUuid: string, scheduleUuid: string) {
    return toPublicSchedule(await this.requireSchedule(serverUuid, scheduleUuid));
  }

  async create(serverUuid: string, input: CreateScheduleDto) {
    const server = await this.requireServer(serverUuid);
    const nextRunAt = this.computeNextRun(input);

    const schedule = await this.prisma.schedule.create({
      data: {
        serverId: server.id,
        name: input.name,
        cronMinute: input.cronMinute,
        cronHour: input.cronHour,
        cronDayOfMonth: input.cronDayOfMonth,
        cronMonth: input.cronMonth,
        cronDayOfWeek: input.cronDayOfWeek,
        active: input.active,
        onlyWhenOnline: input.onlyWhenOnline,
        // Null when the task is inactive: a due time on a disabled task would
        // suggest it is about to fire.
        nextRunAt: input.active ? nextRunAt : null,
        tasks: {
          create: input.tasks.map((task, index) => ({
            sequence: index,
            action: task.action,
            payload: task.payload,
            offsetSeconds: task.offsetSeconds,
            continueOnFailure: task.continueOnFailure,
          })),
        },
      },
      include: { tasks: { orderBy: { sequence: 'asc' } } },
    });

    return toPublicSchedule(schedule);
  }

  async update(serverUuid: string, scheduleUuid: string, input: UpdateScheduleDto) {
    const existing = await this.requireSchedule(serverUuid, scheduleUuid);

    const merged = {
      cronMinute: input.cronMinute ?? existing.cronMinute,
      cronHour: input.cronHour ?? existing.cronHour,
      cronDayOfMonth: input.cronDayOfMonth ?? existing.cronDayOfMonth,
      cronMonth: input.cronMonth ?? existing.cronMonth,
      cronDayOfWeek: input.cronDayOfWeek ?? existing.cronDayOfWeek,
    };

    const active = input.active ?? existing.active;

    const updated = await this.prisma.schedule.update({
      where: { id: existing.id },
      data: {
        ...merged,
        name: input.name ?? existing.name,
        active,
        onlyWhenOnline: input.onlyWhenOnline ?? existing.onlyWhenOnline,
        // Recomputed every time: without that, changing the schedule would
        // leave the task firing on the old one.
        nextRunAt: active ? this.computeNextRun(merged) : null,
        ...(input.tasks
          ? {
              // A full replacement rather than a row-by-row reconciliation:
              // the steps have no stable identity in the interface, where they
              // are freely reordered and deleted.
              tasks: {
                deleteMany: {},
                create: input.tasks.map((task, index) => ({
                  sequence: index,
                  action: task.action,
                  payload: task.payload,
                  offsetSeconds: task.offsetSeconds,
                  continueOnFailure: task.continueOnFailure,
                })),
              },
            }
          : {}),
      },
      include: { tasks: { orderBy: { sequence: 'asc' } } },
    });

    return toPublicSchedule(updated);
  }

  async remove(serverUuid: string, scheduleUuid: string): Promise<void> {
    const existing = await this.requireSchedule(serverUuid, scheduleUuid);

    await this.prisma.schedule.delete({ where: { id: existing.id } });
  }

  /** Forces an immediate run, without touching the schedule. */
  async triggerNow(serverUuid: string, scheduleUuid: string): Promise<void> {
    const existing = await this.requireSchedule(serverUuid, scheduleUuid);

    await this.prisma.schedule.update({
      where: { id: existing.id },
      data: { nextRunAt: new Date() },
    });
  }

  private computeNextRun(input: {
    cronMinute: string;
    cronHour: string;
    cronDayOfMonth: string;
    cronMonth: string;
    cronDayOfWeek: string;
  }): Date {
    try {
      return nextOccurrence(
        {
          minute: input.cronMinute,
          hour: input.cronHour,
          dayOfMonth: input.cronDayOfMonth,
          month: input.cronMonth,
          dayOfWeek: input.cronDayOfWeek,
        },
        new Date(),
      );
    } catch (error: unknown) {
      if (error instanceof CronError) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({ where: { uuid } });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }

  private async requireSchedule(serverUuid: string, scheduleUuid: string) {
    const server = await this.requireServer(serverUuid);

    const schedule = await this.prisma.schedule.findFirst({
      where: { uuid: scheduleUuid, serverId: server.id },
      include: { tasks: { orderBy: { sequence: 'asc' } } },
    });

    if (!schedule) {
      throw new NotFoundException('Scheduled task not found.');
    }

    return schedule;
  }
}

interface ScheduleRow {
  uuid: string;
  name: string;
  cronMinute: string;
  cronHour: string;
  cronDayOfMonth: string;
  cronMonth: string;
  cronDayOfWeek: string;
  active: boolean;
  onlyWhenOnline: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  running: boolean;
  tasks: {
    uuid: string;
    sequence: number;
    action: string;
    payload: string;
    offsetSeconds: number;
    continueOnFailure: boolean;
  }[];
}

function toPublicSchedule(schedule: ScheduleRow) {
  return {
    uuid: schedule.uuid,
    name: schedule.name,
    cron: {
      minute: schedule.cronMinute,
      hour: schedule.cronHour,
      dayOfMonth: schedule.cronDayOfMonth,
      month: schedule.cronMonth,
      dayOfWeek: schedule.cronDayOfWeek,
    },
    expression: formatCron({
      minute: schedule.cronMinute,
      hour: schedule.cronHour,
      dayOfMonth: schedule.cronDayOfMonth,
      month: schedule.cronMonth,
      dayOfWeek: schedule.cronDayOfWeek,
    }),
    active: schedule.active,
    onlyWhenOnline: schedule.onlyWhenOnline,
    lastRunAt: schedule.lastRunAt,
    nextRunAt: schedule.nextRunAt,
    running: schedule.running,
    tasks: schedule.tasks.map((task) => ({
      uuid: task.uuid,
      sequence: task.sequence,
      action: task.action,
      payload: task.payload,
      offsetSeconds: task.offsetSeconds,
      continueOnFailure: task.continueOnFailure,
    })),
  };
}

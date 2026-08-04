import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CronError, formatCron, nextOccurrence } from './cron.js';
import type { CreateScheduleDto, UpdateScheduleDto } from './schedules.dto.js';

/**
 * Tâches planifiées, côté registre.
 *
 * L'exécution vit dans `SchedulerService` ; ici on ne fait que tenir la liste
 * et calculer la prochaine échéance. La séparation compte : le calcul de
 * `nextRunAt` doit être refait à chaque modification de l'expression cron, et
 * l'oublier donnerait une tâche qui continue de se déclencher selon l'ancien
 * horaire.
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
        // Nulle si la tâche est inactive : une échéance sur une tâche éteinte
        // laisserait croire qu'elle va se déclencher.
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
        // Recalculée systématiquement : sans cela, changer l'horaire laisserait
        // la tâche se déclencher selon l'ancien.
        nextRunAt: active ? this.computeNextRun(merged) : null,
        ...(input.tasks
          ? {
              // Remplacement complet plutôt que rapprochement ligne à ligne :
              // les étapes n'ont pas d'identité stable côté interface, où on
              // les réordonne et on les supprime librement.
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

  /** Force le déclenchement immédiat, sans toucher à l'horaire. */
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
      throw new NotFoundException('Tâche planifiée introuvable.');
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

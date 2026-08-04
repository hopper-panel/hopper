import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { BackupsService } from '../backups/backups.service.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { CronError, nextOccurrence } from './cron.js';

/**
 * Exécution des tâches planifiées.
 *
 * **Pourquoi un simple minuteur et non BullMQ.** Le plan prévoyait des jobs
 * répétables Redis. À l'usage, cela ferait de Redis une dépendance obligatoire
 * d'un panel qu'on installe sur un VPS pour héberger trois serveurs, et
 * dupliquerait un état — l'horaire — que la base tient déjà. Le schéma porte
 * `nextRunAt` et un drapeau `running` prévus pour cela dès l'origine : une
 * boucle qui interroge la base suffit, et la base reste la seule vérité.
 *
 * **Ce qui empêche un double déclenchement.** La prise en charge d'une tâche
 * est un `UPDATE … WHERE running = false` : la base tranche, et un seul
 * processus reçoit `count = 1`. Deux panels branchés sur la même base ne
 * peuvent donc pas lancer deux fois le même redémarrage.
 *
 * **Ce qui empêche un blocage définitif.** Un panel tué en pleine exécution
 * laisserait `running = true` pour toujours, et la tâche ne repartirait jamais.
 * Au démarrage, toute tâche encore marquée en cours est donc libérée : aucune
 * exécution ne survit à l'arrêt du processus qui la portait.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  /**
   * Période d'interrogation.
   *
   * Trente secondes pour une granularité cron à la minute : un intervalle égal
   * à la minute risquerait, avec la dérive, de sauter une échéance entre deux
   * passages.
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
        `${released.count} tâche(s) planifiée(s) étaient marquées en cours : libérées.`,
      );
    }

    this.timer = setInterval(() => void this.tick(), SchedulerService.TICK_MS);
    // `unref` : un minuteur actif empêcherait le processus de s'arrêter.
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
   * Un passage : prend en charge et exécute ce qui est dû.
   *
   * Les exécutions ne se chevauchent pas — une séquence avec des décalages peut
   * durer plusieurs minutes, et un second passage relancerait des tâches déjà
   * en cours de traitement par le premier.
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
          this.logger.error(`Tâche « ${schedule.name} » : ${String(error)}`);
        });
      }
    } catch (error: unknown) {
      // Une base momentanément injoignable ne doit pas arrêter la boucle : le
      // passage suivant réessaiera.
      this.logger.error(`Passage du planificateur interrompu : ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async runIfClaimed(scheduleId: number): Promise<void> {
    // C'est la base qui arbitre : un seul appelant obtient `count = 1`.
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
      // L'échéance suivante est posée quoi qu'il arrive : une tâche qui échoue
      // doit repartir au prochain créneau, pas rester bloquée sur celui-ci.
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
        // Sans échéance suivante, la tâche cesse de se déclencher plutôt que
        // d'être reprise en boucle à chaque passage.
        this.logger.error(`Tâche « ${schedule.name} » désactivée : ${error.message}`);
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

      // `null` signifie « on ne sait pas », et non « arrêté » : sauter une
      // sauvegarde parce que le node a mis trop longtemps à répondre serait
      // pire que de la tenter.
      if (state !== null && state !== 'running') {
        this.logger.log(`Tâche « ${schedule.name} » ignorée : le serveur est ${state}.`);
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
        failures.push(`étape ${task.sequence + 1} (${task.action}) : ${String(error)}`);

        if (!task.continueOnFailure) {
          break;
        }
      }
    }

    await this.audit.record({
      event: AUDIT_EVENTS.SCHEDULE_RUN,
      // Le planificateur n'est pas un utilisateur.
      actorId: null,
      serverId: schedule.serverId,
      metadata: {
        schedule: schedule.name,
        tasks: schedule.tasks.length,
        failures,
      },
    });

    if (failures.length > 0) {
      this.logger.warn(`Tâche « ${schedule.name} » : ${failures.join(' ; ')}`);
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
        // Plusieurs commandes par étape : annoncer un redémarrage puis
        // sauvegarder le monde tient en une seule étape.
        await this.client.sendCommands(
          node,
          serverUuid,
          task.payload.split(/\r?\n/).filter((line) => line.trim() !== ''),
        );
        return;

      case 'BACKUP':
        await this.backups.create(serverUuid, {
          name: `Sauvegarde planifiée`,
          ignoredFiles: task.payload.split(/\r?\n/).filter((line) => line.trim() !== ''),
        });
        return;

      default:
        throw new Error(`Action inconnue : ${task.action}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

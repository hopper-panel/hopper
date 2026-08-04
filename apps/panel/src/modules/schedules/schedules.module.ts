import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BackupsModule } from '../backups/backups.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { SchedulerService } from './scheduler.service.js';
import { SchedulesController } from './schedules.controller.js';
import { SchedulesService } from './schedules.service.js';

/**
 * Tâches planifiées.
 *
 * `SchedulerService` démarre sa boucle avec le module : c'est ce qui fait
 * qu'un panel qui tourne exécute les tâches, sans processus séparé à lancer ni
 * à surveiller.
 */
@Module({
  imports: [NodesModule, BackupsModule, AuditModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulerService],
  exports: [SchedulesService],
})
export class SchedulesModule {}

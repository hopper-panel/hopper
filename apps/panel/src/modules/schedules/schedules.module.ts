import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BackupsModule } from '../backups/backups.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { SchedulerService } from './scheduler.service.js';
import { SchedulesController } from './schedules.controller.js';
import { SchedulesService } from './schedules.service.js';

/**
 * Scheduled tasks.
 *
 * `SchedulerService` starts its loop with the module: that is what makes a
 * running panel run the tasks, with no separate process to launch or watch.
 */
@Module({
  imports: [NodesModule, BackupsModule, AuditModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, SchedulerService],
  exports: [SchedulesService],
})
export class SchedulesModule {}

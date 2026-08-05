import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';

/**
 * Backups.
 *
 * `BackupsService` is exported: the remote module needs it to record the
 * verdict the daemon returns, and the scheduler to trigger a nightly backup.
 */
@Module({
  imports: [NodesModule, AuditModule],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}

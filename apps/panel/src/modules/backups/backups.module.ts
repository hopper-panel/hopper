import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService } from './backups.service.js';

/**
 * Sauvegardes.
 *
 * `BackupsService` est exporté : le module distant en a besoin pour enregistrer
 * le verdict rendu par le daemon, et le planificateur pour déclencher une
 * sauvegarde nocturne.
 */
@Module({
  imports: [NodesModule, AuditModule],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}

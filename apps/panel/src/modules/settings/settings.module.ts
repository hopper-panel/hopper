import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({
  imports: [NodesModule, AuditModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}

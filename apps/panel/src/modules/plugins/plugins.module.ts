import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NodesModule } from '../nodes/nodes.module.js';
import { ModrinthService } from './modrinth.service.js';
import { PluginsController } from './plugins.controller.js';

@Module({
  imports: [NodesModule, AuditModule],
  controllers: [PluginsController],
  providers: [ModrinthService],
})
export class PluginsModule {}

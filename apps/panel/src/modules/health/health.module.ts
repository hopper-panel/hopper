import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module.js';
import { OverviewController } from './overview.controller.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [NodesModule],
  controllers: [HealthController, OverviewController],
})
export class HealthModule {}

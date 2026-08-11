import { Module } from '@nestjs/common';
import { NodeApplyService } from './node-apply.service.js';
import { NodeClientService } from './node-client.service.js';
import { NodesController } from './nodes.controller.js';
import { NodesService } from './nodes.service.js';

@Module({
  controllers: [NodesController],
  providers: [NodeApplyService, NodeClientService, NodesService],
  exports: [NodeApplyService, NodeClientService, NodesService],
})
export class NodesModule {}

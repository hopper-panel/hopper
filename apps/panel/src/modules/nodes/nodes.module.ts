import { Module } from '@nestjs/common';
import { NodeClientService } from './node-client.service.js';
import { NodesController } from './nodes.controller.js';
import { NodesService } from './nodes.service.js';

@Module({
  controllers: [NodesController],
  providers: [NodeClientService, NodesService],
  exports: [NodeClientService, NodesService],
})
export class NodesModule {}

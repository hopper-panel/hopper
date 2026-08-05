import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { AllocationsController } from './allocations.controller.js';
import { AllocationsService } from './allocations.service.js';

@Module({
  imports: [NodesModule, ServersModule],
  controllers: [AllocationsController],
  providers: [AllocationsService],
})
export class AllocationsModule {}

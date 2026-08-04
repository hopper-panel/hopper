import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { StartupController } from './startup.controller.js';
import { StartupService } from './startup.service.js';

@Module({
  imports: [NodesModule, ServersModule],
  controllers: [StartupController],
  providers: [StartupService],
})
export class StartupModule {}

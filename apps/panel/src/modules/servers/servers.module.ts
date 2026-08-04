import { Module } from '@nestjs/common';
import { NodesModule } from '../nodes/nodes.module.js';
import { AdminServersController } from './admin-servers.controller.js';
import { ConsoleController } from './console.controller.js';
import { FilesController } from './files.controller.js';
import { ServerConfigurationService } from './server-configuration.service.js';
import { ServersController } from './servers.controller.js';
import { ServersService } from './servers.service.js';

@Module({
  imports: [NodesModule],
  controllers: [ServersController, AdminServersController, ConsoleController, FilesController],
  providers: [ServersService, ServerConfigurationService],
  exports: [ServersService, ServerConfigurationService],
})
export class ServersModule {}

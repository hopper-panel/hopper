import { Module } from '@nestjs/common';
import { BackupsModule } from '../backups/backups.module.js';
import { PasswordService } from '../auth/password.service.js';
import { ServersModule } from '../servers/servers.module.js';
import { RemoteNodeGuard } from './remote-node.guard.js';
import { RemoteController } from './remote.controller.js';
import { SftpAuthService } from './sftp-auth.service.js';

@Module({
  imports: [ServersModule, BackupsModule],
  controllers: [RemoteController],
  providers: [RemoteNodeGuard, SftpAuthService, PasswordService],
})
export class RemoteModule {}

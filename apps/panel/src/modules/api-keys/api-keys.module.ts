import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * API keys.
 *
 * Global: the authentication guard, registered once for the whole application,
 * has to be able to inject the service without every module importing this one.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}

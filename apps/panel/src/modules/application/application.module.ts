import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ApplicationInstanceController } from './application-instance.controller.js';
import { ApplicationKeysController } from './application-keys.controller.js';
import { ApplicationKeysService } from './application-keys.service.js';

/**
 * The application API — what a hosting provider's own software talks to.
 *
 * Global for the same reason `ApiKeysModule` is: the authentication guard is
 * registered once for the whole application and has to inject the key service
 * without every module importing this one.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [ApplicationInstanceController, ApplicationKeysController],
  providers: [ApplicationKeysService],
  exports: [ApplicationKeysService],
})
export class ApplicationModule {}

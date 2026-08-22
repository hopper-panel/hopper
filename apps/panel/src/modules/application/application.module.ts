import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { UsersModule } from '../users/users.module.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { ApplicationEstateController } from './application-estate.controller.js';
import { ApplicationInstanceController } from './application-instance.controller.js';
import { ApplicationKeysController } from './application-keys.controller.js';
import { ApplicationKeysService } from './application-keys.service.js';
import { ApplicationServersController } from './application-servers.controller.js';
import { ApplicationUsersController } from './application-users.controller.js';
import { IdempotencyService } from './idempotency.service.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * The application API — what a hosting provider's own software talks to.
 *
 * Global for the same reason `ApiKeysModule` is: the authentication guard is
 * registered once for the whole application and has to inject the key service
 * without every module importing this one.
 */
@Global()
@Module({
  imports: [AuditModule, PlansModule, ServersModule, UsersModule, WebhooksModule],
  controllers: [
    ApplicationInstanceController,
    ApplicationKeysController,
    ApplicationServersController,
    ApplicationEstateController,
    ApplicationUsersController,
  ],
  providers: [ApplicationKeysService, IdempotencyService, ProvisioningService],
  exports: [ApplicationKeysService],
})
export class ApplicationModule {}

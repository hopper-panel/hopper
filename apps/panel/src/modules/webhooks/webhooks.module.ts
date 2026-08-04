import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Notifications sortantes.
 *
 * Le service est exporté : les modules qui apprennent un événement — le
 * rapport d'état du daemon, la fin d'une sauvegarde — le diffusent, plutôt que
 * de laisser ce module deviner ce qui se passe ailleurs.
 */
@Module({
  imports: [AuditModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}

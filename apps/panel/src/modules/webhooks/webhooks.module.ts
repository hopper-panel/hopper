import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Outgoing notifications.
 *
 * The service is exported: the modules that learn of an event — the daemon's
 * status report, the end of a backup — dispatch it, rather than leaving this
 * module to guess what happens elsewhere.
 */
@Module({
  imports: [AuditModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}

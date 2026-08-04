import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { InstanceSettingsController } from './instance-settings.controller.js';
import { InstanceSettingsService } from './instance-settings.service.js';
import { MailService } from './mail.service.js';

/**
 * Paramètres de l'instance et envoi de courriels.
 *
 * Global : les paramètres servent un peu partout — délai d'attente des nodes,
 * exigence de double authentification, courriel de bienvenue — et les importer
 * module par module reviendrait à les câbler dans la moitié de l'application.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [InstanceSettingsController],
  providers: [InstanceSettingsService, MailService],
  exports: [InstanceSettingsService, MailService],
})
export class InstanceSettingsModule {}

import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BrandingController } from './branding.controller.js';
import { InstanceSettingsController } from './instance-settings.controller.js';
import { InstanceSettingsService } from './instance-settings.service.js';
import { MailService } from './mail.service.js';

/**
 * Instance settings and email sending.
 *
 * Global: the settings are needed almost everywhere — node timeout, two-factor
 * requirement, welcome email — and importing them module by module would amount
 * to wiring them through half the application.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [InstanceSettingsController, BrandingController],
  providers: [InstanceSettingsService, MailService],
  exports: [InstanceSettingsService, MailService],
})
export class InstanceSettingsModule {}

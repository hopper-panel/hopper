import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { CurrentUser, type AuthenticatedRequest, type RequestUser } from '../auth/request-user.js';
import {
  LOCALES,
  MAIL_ENCRYPTIONS,
  TWO_FACTOR_REQUIREMENTS,
  updateInstanceSettingsSchema,
  type UpdateInstanceSettingsDto,
} from './definitions.js';
import { InstanceSettingsService } from './instance-settings.service.js';
import { MailService } from './mail.service.js';

const testMailSchema = z.object({ to: z.email().max(255) });

/**
 * Instance settings.
 *
 * Administrators only: the panel's name and the SMTP server bind everybody, and
 * the two-factor requirement is a security setting.
 */
@Controller('api/admin/settings')
@AdminOnly()
export class InstanceSettingsController {
  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get() {
    return {
      settings: await this.settings.forApi(),
      // The possible values come from the server: the interface has no business
      // maintaining its own copy of the enumerations.
      options: {
        twoFactorRequirements: TWO_FACTOR_REQUIREMENTS,
        mailEncryptions: MAIL_ENCRYPTIONS,
        locales: LOCALES,
      },
    };
  }

  @Patch()
  async update(
    @Body(new ZodValidationPipe(updateInstanceSettingsSchema)) body: UpdateInstanceSettingsDto,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.settings.update(body);

    await this.audit.record({
      event: AUDIT_EVENTS.SETTINGS_UPDATED,
      actorId: user.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // The keys changed, never the values: the SMTP password has no business
      // in a log several people read.
      metadata: { keys: Object.keys(body) },
    });

    return this.settings.forApi();
  }

  @Post('mail/test')
  @HttpCode(HttpStatus.NO_CONTENT)
  async testMail(@Body(new ZodValidationPipe(testMailSchema)) body: { to: string }): Promise<void> {
    await this.mail.sendTest(body.to);
  }
}

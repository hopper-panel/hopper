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
 * Paramètres de l'instance.
 *
 * Réservé aux administrateurs : le nom du panel et le serveur SMTP engagent
 * tout le monde, et l'exigence de double authentification est un réglage de
 * sécurité.
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
      // Les valeurs possibles viennent du serveur : l'interface n'a pas à
      // maintenir sa propre copie des énumérations.
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
      // Les clés modifiées, jamais les valeurs : le mot de passe SMTP n'a rien
      // à faire dans un journal que l'on consulte à plusieurs.
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

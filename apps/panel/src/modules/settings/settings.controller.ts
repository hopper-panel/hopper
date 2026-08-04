import { PERMISSIONS } from '@hopper/shared';
import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type AuthenticatedRequest,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import { SettingsService } from './settings.service.js';

/**
 * Paramètres d'un serveur.
 *
 * La lecture ne demande aucune permission particulière : ce qu'elle expose —
 * l'adresse SFTP, l'identifiant du serveur, le nom du node — est déjà connu de
 * quiconque a accès au serveur. Ce qui est protégé, c'est l'usage : le SFTP
 * exige `file.sftp`, et le mot de passe reste celui du panel, jamais transmis
 * ici.
 */
@Controller('api/servers/:serverId/settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission()
  get(@Param('serverId') serverId: string, @CurrentUser() user: RequestUser) {
    return this.settings.get(serverId, user.username);
  }

  @Post('reinstall')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireServerPermission(PERMISSIONS.SETTINGS_REINSTALL)
  async reinstall(
    @Param('serverId') serverId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    // L'audit précède l'opération : une réinstallation qui échoue à mi-chemin a
    // tout de même touché au volume, et c'est le cas où l'on veut savoir qui
    // l'a lancée.
    await this.audit.record({
      event: AUDIT_EVENTS.SERVER_REINSTALLED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: {},
    });

    await this.settings.reinstall(serverId);
  }
}

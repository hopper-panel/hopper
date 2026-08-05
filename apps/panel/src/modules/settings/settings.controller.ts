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
 * A server's settings.
 *
 * Reading them needs no particular permission: what they expose — the SFTP
 * address, the server identifier, the node name — is already known to anyone
 * with access to the server. What is protected is the use: SFTP requires
 * `file.sftp`, and the password stays the panel's, never passed here.
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
    // The audit entry precedes the operation: a reinstall that fails halfway
    // has still touched the volume, and that is the case where one wants to
    // know who launched it.
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

import { Readable } from 'node:stream';
import { BACKUP_ROUTES, PERMISSIONS } from '@hopper/shared';
import { Body, Controller, Delete, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { RequireServerPermission } from '../auth/decorators.js';
import {
  CurrentServer,
  CurrentUser,
  type AuthenticatedRequest,
  type RequestServer,
  type RequestUser,
} from '../auth/request-user.js';
import { NodeClientService } from '../nodes/node-client.service.js';
import { NodesService } from '../nodes/nodes.service.js';
import { BackupsService } from './backups.service.js';
import {
  createBackupSchema,
  lockBackupSchema,
  restoreBackupSchema,
  type CreateBackupDto,
  type LockBackupDto,
  type RestoreBackupDto,
} from './backups.dto.js';

/**
 * A server's backups.
 *
 * The permissions are deliberately separate: reading the list, creating one,
 * downloading it, restoring it and deleting it are five distinct rights.
 * Restoring overwrites the server and downloading carries away a complete copy
 * of its data — these are not variants of one action, and confusing them would
 * amount to granting one while believing you granted the other.
 */
@Controller('api/servers/:serverId/backups')
export class BackupsController {
  constructor(
    private readonly backups: BackupsService,
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireServerPermission(PERMISSIONS.BACKUP_READ)
  list(@Param('serverId') serverId: string) {
    return this.backups.list(serverId);
  }

  @Get(':backupId')
  @RequireServerPermission(PERMISSIONS.BACKUP_READ)
  find(@Param('serverId') serverId: string, @Param('backupId') backupId: string) {
    return this.backups.findByUuid(serverId, backupId);
  }

  @Post()
  @RequireServerPermission(PERMISSIONS.BACKUP_CREATE)
  async create(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(createBackupSchema)) body: CreateBackupDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const backup = await this.backups.create(serverId, body);

    await this.audit.record({
      event: AUDIT_EVENTS.BACKUP_CREATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { backup: backup.uuid, name: backup.name },
    });

    return backup;
  }

  @Post(':backupId/lock')
  @RequireServerPermission(PERMISSIONS.BACKUP_DELETE)
  async lock(
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @Body(new ZodValidationPipe(lockBackupSchema)) body: LockBackupDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const backup = await this.backups.setLocked(serverId, backupId, body.locked);

    await this.audit.record({
      event: AUDIT_EVENTS.BACKUP_LOCKED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { backup: backupId, locked: body.locked },
    });

    return backup;
  }

  @Post(':backupId/restore')
  @RequireServerPermission(PERMISSIONS.BACKUP_RESTORE)
  async restore(
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @Body(new ZodValidationPipe(restoreBackupSchema)) body: RestoreBackupDto,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ) {
    // The audit entry is written **before** the operation: a restore that
    // fails halfway has still touched the volume, and that is precisely the
    // case where one wants to know who launched it.
    await this.audit.record({
      event: AUDIT_EVENTS.BACKUP_RESTORED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { backup: backupId, truncate: body.truncate },
    });

    return this.backups.restore(serverId, backupId, body);
  }

  @Delete(':backupId')
  @RequireServerPermission(PERMISSIONS.BACKUP_DELETE)
  async remove(
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.backups.delete(serverId, backupId);

    await this.audit.record({
      event: AUDIT_EVENTS.BACKUP_DELETED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { backup: backupId },
    });
  }

  /**
   * Downloads the archive, relayed from the node.
   *
   * The stream goes through the panel rather than exposing a daemon URL: the
   * daemon has no notion of a user, and having it serve a file to a browser
   * would mean teaching it the panel's sessions. As a result no archive URL
   * exists that can be reached without going through the permissions.
   *
   * The relay is done **as a stream**: an archive of several gigabytes loaded
   * into memory would take the panel down for all its users, not only for the
   * one downloading.
   */
  @Get(':backupId/download')
  @RequireServerPermission(PERMISSIONS.BACKUP_DOWNLOAD)
  async download(
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @CurrentServer() server: RequestServer,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Checks the backup belongs to the server: without that, a user with
    // access to one server could download another's archive by guessing its
    // identifier.
    await this.backups.findByUuid(serverId, backupId);

    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
      select: { uuid: true },
    });
    const connection = await this.nodes.getConnection(node.uuid);

    const response = await this.client.stream(
      connection,
      BACKUP_ROUTES.backupDownload(serverId, backupId),
    );

    if (!response.body || response.status !== 200) {
      void reply.status(response.status === 200 ? 502 : response.status).send({
        statusCode: response.status,
        message: 'The archive could not be retrieved from the node.',
      });
      return;
    }

    // The header comes from the daemon: it alone knows the format chosen at
    // archiving time — `.tar.zst` or `.tar.gz` depending on the Node version
    // that produced it. Reinventing it here would give a wrong file name.
    const disposition = response.headers.get('content-disposition');

    void reply
      .status(200)
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', disposition ?? `attachment; filename="${backupId}.tar.gz"`);

    const length = response.headers.get('content-length');
    if (length) {
      void reply.header('content-length', length);
    }

    void reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
  }
}

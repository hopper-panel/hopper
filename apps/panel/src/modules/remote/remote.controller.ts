import {
  backupReportSchema,
  installReportSchema,
  remoteServersQuerySchema,
  statusReportSchema,
  sftpAuthRequestSchema,
  type BackupReport,
  type InstallReport,
  type RemoteServersResponse,
  type ServerConfiguration,
  type SftpAuthRequest,
  type SftpAuthResponse,
  type StatusReport,
} from '@hopper/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUDIT_EVENTS, AuditService } from '../audit/audit.service.js';
import { BackupsService } from '../backups/backups.service.js';
import { Public } from '../auth/decorators.js';
import { ServerConfigurationService } from '../servers/server-configuration.service.js';
import { WEBHOOK_EVENTS } from '../webhooks/events.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { RemoteNodeGuard, type RemoteRequest } from './remote-node.guard.js';
import { SftpAuthService } from './sftp-auth.service.js';

/**
 * Routes called by the daemons.
 *
 * `@Public()` removes the global session guard, and `RemoteNodeGuard` replaces
 * it with node-token authentication. Without the first, a daemon would be
 * refused for lack of a cookie; without the second, the route would be open to
 * everyone.
 */
@Controller('api/remote')
@Public()
@UseGuards(RemoteNodeGuard)
export class RemoteController {
  private readonly logger = new Logger(RemoteController.name);

  constructor(
    private readonly configurations: ServerConfigurationService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sftp: SftpAuthService,
    private readonly backups: BackupsService,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * List of the servers this node has to host.
   *
   * Called by the daemon when it starts: this is how it rediscovers the servers
   * it manages, including those already running before its restart. A node sees
   * **only** its own servers — the identity comes from the token, not from a
   * request parameter.
   */
  @Get('servers')
  async servers(
    @Query(new ZodValidationPipe(remoteServersQuerySchema))
    query: { page: number; perPage: number },
    @Req() request: RemoteRequest,
  ): Promise<RemoteServersResponse> {
    const all: ServerConfiguration[] = await this.configurations.buildForNode(request.node!.id);

    const start = (query.page - 1) * query.perPage;
    const data = all.slice(start, start + query.perPage);

    return {
      data,
      meta: {
        currentPage: query.page,
        lastPage: Math.max(1, Math.ceil(all.length / query.perPage)),
        total: all.length,
      },
    };
  }

  /**
   * Authenticates an SFTP connection on the daemon's behalf.
   *
   * The username carries the target server (`julien.b10a05a8`), for want of any
   * other channel in the SFTP protocol. The panel checks the password, then
   * that the user really has access to that server — checking the password
   * alone would not do, or any account could reach any server by guessing eight
   * characters.
   */
  @Post('sftp/auth')
  @HttpCode(HttpStatus.OK)
  async sftpAuth(
    @Body(new ZodValidationPipe(sftpAuthRequestSchema)) body: SftpAuthRequest,
    @Req() request: RemoteRequest,
  ): Promise<SftpAuthResponse> {
    return this.sftp.authenticate(body, request.node!.id);
  }

  /**
   * A backup's verdict, reported by the daemon.
   *
   * Ownership is checked as it is for installation: a node can only close the
   * backups of the servers it hosts. Without that clause, a compromised node
   * could declare successful the backup of a server hosted elsewhere — and
   * retention would then erase a valid archive in favour of one that does not
   * exist.
   */
  @Post('backups/:uuid/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reportBackup(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(backupReportSchema)) body: BackupReport,
    @Req() request: RemoteRequest,
  ): Promise<void> {
    const backup = await this.prisma.backup.findFirst({
      where: { uuid, server: { nodeId: request.node!.id } },
      select: { uuid: true, name: true, serverId: true },
    });

    if (!backup) {
      throw new NotFoundException('This backup does not belong to this node.');
    }

    await this.backups.recordReport(uuid, body);

    this.logger.log(
      `Backup "${backup.name}" ${body.successful ? 'finished' : 'failed'} on ${request.node!.name}`,
    );

    await this.audit.record({
      event: AUDIT_EVENTS.BACKUP_CREATED,
      // The daemon is not a user: the action is the system's.
      actorId: null,
      serverId: backup.serverId,
      metadata: {
        backup: uuid,
        successful: body.successful,
        sizeBytes: body.sizeBytes,
        error: body.error ?? null,
      },
    });

    this.webhooks.dispatch(
      backup.serverId,
      body.successful ? WEBHOOK_EVENTS.BACKUP_COMPLETED : WEBHOOK_EVENTS.BACKUP_FAILED,
      {
        Sauvegarde: backup.name,
        ...(body.successful
          ? { Taille: formatBytes(body.sizeBytes) }
          : { Erreur: body.error ?? 'cause inconnue' }),
      },
    );
  }

  /**
   * An installation's verdict, reported by the daemon.
   *
   * This is what moves a server from "Installing" to "Ready". Without this
   * callback, a perfectly installed server would stay stuck in its initial
   * state and the user would have no way of knowing where it stands.
   */
  @Post('servers/:uuid/install')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reportInstall(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(installReportSchema)) body: InstallReport,
    @Req() request: RemoteRequest,
  ): Promise<void> {
    // The server has to belong to the reporting node: without that clause, a
    // compromised node could declare another's servers installed.
    const server = await this.prisma.server.findFirst({
      where: { uuid, nodeId: request.node!.id },
      select: { id: true, name: true },
    });

    if (!server) {
      throw new NotFoundException('This server does not belong to this node.');
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { status: body.successful ? 'READY' : 'INSTALL_FAILED' },
    });

    this.logger.log(
      `Installation ${body.successful ? 'succeeded' : 'failed'} for "${server.name}" on ${request.node!.name}`,
    );

    await this.audit.record({
      event: body.reinstall ? AUDIT_EVENTS.SERVER_REINSTALLED : AUDIT_EVENTS.SERVER_CREATED,
      // A system action, not a user's: the actor is the daemon.
      actorId: null,
      serverId: server.id,
      metadata: { successful: body.successful, node: request.node!.name },
    });

    this.webhooks.dispatch(
      server.id,
      body.successful ? WEBHOOK_EVENTS.INSTALL_COMPLETED : WEBHOOK_EVENTS.INSTALL_FAILED,
      { Reinstall: body.reinstall ? 'yes' : 'no' },
    );
  }

  /**
   * A server's state change, reported by the daemon.
   *
   * The panel does not store this state — it comes from the daemon, which alone
   * knows it — but it needs it in passing to notify the subscribed recipients.
   * A stop nobody asked for is reported as a crash: it is the one notification
   * worth waking somebody up for.
   */
  @Post('servers/:uuid/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reportStatus(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(statusReportSchema)) body: StatusReport,
    @Req() request: RemoteRequest,
  ): Promise<void> {
    const server = await this.prisma.server.findFirst({
      where: { uuid, nodeId: request.node!.id },
      select: { id: true },
    });

    if (!server) {
      throw new NotFoundException('This server does not belong to this node.');
    }

    if (body.state === 'running') {
      this.webhooks.dispatch(server.id, WEBHOOK_EVENTS.SERVER_STARTED);
      return;
    }

    // Intermediate states — starting, stopping, installing — produce nothing:
    // they would double every useful event with a message of no interest.
    if (body.state !== 'offline') {
      return;
    }

    if (body.expected) {
      this.webhooks.dispatch(server.id, WEBHOOK_EVENTS.SERVER_STOPPED);
      return;
    }

    // The cause when the daemon knows it: "killed for lack of memory" explains
    // on its own a stop nobody understands.
    this.webhooks.dispatch(server.id, WEBHOOK_EVENTS.SERVER_CRASHED, {
      Cause: body.oomKilled
        ? 'killed by the kernel, out of memory'
        : 'the process stopped on its own',
      ...(body.exitCode === undefined ? {} : { 'Code de sortie': body.exitCode }),
    });
  }
}

/** Readable size, for the message sent to the recipient. */
function formatBytes(bytes: number): string {
  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

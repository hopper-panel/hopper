import {
  backupReportSchema,
  installReportSchema,
  remoteServersQuerySchema,
  sftpAuthRequestSchema,
  type BackupReport,
  type InstallReport,
  type RemoteServersResponse,
  type ServerConfiguration,
  type SftpAuthRequest,
  type SftpAuthResponse,
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
import { RemoteNodeGuard, type RemoteRequest } from './remote-node.guard.js';
import { SftpAuthService } from './sftp-auth.service.js';

/**
 * Routes appelées par les daemons.
 *
 * `@Public()` retire le garde de session global, et `RemoteNodeGuard` le
 * remplace par une authentification par jeton de node. Sans le premier, un
 * daemon serait refusé faute de cookie ; sans le second, la route serait
 * ouverte à tous.
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
  ) {}

  /**
   * Liste des serveurs que ce node doit héberger.
   *
   * Appelée par le daemon à son démarrage : il redécouvre ainsi les serveurs
   * qu'il gère, y compris ceux qui tournaient déjà avant son redémarrage. Un
   * node ne voit **que** ses propres serveurs — l'identité vient du jeton, pas
   * d'un paramètre de requête.
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
   * Authentifie une connexion SFTP pour le compte du daemon.
   *
   * Le nom d'utilisateur porte le serveur visé (`julien.b10a05a8`), faute de
   * tout autre canal dans le protocole SFTP. Le panel vérifie le mot de passe,
   * puis que l'utilisateur a bien accès à ce serveur — la seule vérification
   * du mot de passe ne suffirait pas, sans quoi n'importe quel compte pourrait
   * atteindre n'importe quel serveur en devinant huit caractères.
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
   * Verdict d'une sauvegarde, rapporté par le daemon.
   *
   * L'appartenance est vérifiée comme pour l'installation : un node ne peut
   * clore que les sauvegardes des serveurs qu'il héberge. Sans cette clause,
   * un node compromis pourrait déclarer réussie la sauvegarde d'un serveur
   * hébergé ailleurs — et la rétention effacerait alors une archive valide au
   * profit d'une qui n'existe pas.
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
      throw new NotFoundException("Cette sauvegarde n'appartient pas à ce node.");
    }

    await this.backups.recordReport(uuid, body);

    this.logger.log(
      `Sauvegarde « ${backup.name} » ${body.successful ? 'terminée' : 'en échec'} sur ${request.node!.name}`,
    );

    await this.audit.record({
      event: AUDIT_EVENTS.BACKUP_CREATED,
      // Le daemon n'est pas un utilisateur : l'action est celle du système.
      actorId: null,
      serverId: backup.serverId,
      metadata: {
        backup: uuid,
        successful: body.successful,
        sizeBytes: body.sizeBytes,
        error: body.error ?? null,
      },
    });
  }

  /**
   * Verdict d'une installation, rapporté par le daemon.
   *
   * C'est ce qui fait passer un serveur de « Installation » à « Prêt ». Sans
   * ce rappel, un serveur parfaitement installé resterait bloqué à l'état
   * initial et l'utilisateur n'aurait aucun moyen de savoir où il en est.
   */
  @Post('servers/:uuid/install')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reportInstall(
    @Param('uuid') uuid: string,
    @Body(new ZodValidationPipe(installReportSchema)) body: InstallReport,
    @Req() request: RemoteRequest,
  ): Promise<void> {
    // Le serveur doit appartenir au node qui rapporte : sans cette clause, un
    // node compromis pourrait déclarer installés les serveurs d'un autre.
    const server = await this.prisma.server.findFirst({
      where: { uuid, nodeId: request.node!.id },
      select: { id: true, name: true },
    });

    if (!server) {
      throw new NotFoundException("Ce serveur n'appartient pas à ce node.");
    }

    await this.prisma.server.update({
      where: { id: server.id },
      data: { status: body.successful ? 'READY' : 'INSTALL_FAILED' },
    });

    this.logger.log(
      `Installation ${body.successful ? 'réussie' : 'échouée'} pour « ${server.name} » sur ${request.node!.name}`,
    );

    await this.audit.record({
      event: body.reinstall ? AUDIT_EVENTS.SERVER_REINSTALLED : AUDIT_EVENTS.SERVER_CREATED,
      // Action du système, pas d'un utilisateur : l'acteur est le daemon.
      actorId: null,
      serverId: server.id,
      metadata: { successful: body.successful, node: request.node!.name },
    });
  }
}

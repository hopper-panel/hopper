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
 * Sauvegardes d'un serveur.
 *
 * Les permissions sont volontairement séparées : lire la liste, en créer une,
 * la télécharger, la restaurer et la supprimer sont cinq droits distincts.
 * Restaurer écrase le serveur et télécharger emporte une copie complète de ses
 * données — ce ne sont pas des variantes d'une même action, et les confondre
 * reviendrait à donner l'un en croyant accorder l'autre.
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
    // L'audit est écrit **avant** l'opération : une restauration qui échoue à
    // mi-chemin a tout de même touché au volume, et c'est justement le cas où
    // l'on veut savoir qui l'a lancée.
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
   * Télécharge l'archive, relayée depuis le node.
   *
   * Le flux transite par le panel plutôt que d'exposer une URL du daemon : le
   * daemon n'a pas de notion d'utilisateur, et lui faire servir un fichier à un
   * navigateur demanderait de lui apprendre les sessions du panel. Il
   * n'existe ainsi aucune URL d'archive atteignable sans passer par les
   * permissions.
   *
   * Le relais est fait **en flux** : une archive de plusieurs gigaoctets
   * chargée en mémoire ferait tomber le panel pour tous ses utilisateurs, pas
   * seulement pour celui qui télécharge.
   */
  @Get(':backupId/download')
  @RequireServerPermission(PERMISSIONS.BACKUP_DOWNLOAD)
  async download(
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @CurrentServer() server: RequestServer,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Vérifie l'appartenance de la sauvegarde au serveur : sans cela, un
    // utilisateur ayant accès à un serveur pourrait télécharger l'archive d'un
    // autre en devinant son identifiant.
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
        message: "L'archive n'a pas pu être récupérée sur le node.",
      });
      return;
    }

    // L'en-tête vient du daemon : lui seul connaît le format retenu à
    // l'archivage — `.tar.zst` ou `.tar.gz` selon la version de Node qui l'a
    // produit. Le réinventer ici donnerait un nom de fichier faux.
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

import {
  DAEMON_FILE_ROUTES,
  PERMISSIONS,
  chmodFilesRequestSchema,
  compressFilesRequestSchema,
  copyFileRequestSchema,
  createDirectoryRequestSchema,
  decompressFileRequestSchema,
  deleteFilesRequestSchema,
  downloadFileQuerySchema,
  listFilesQuerySchema,
  readFileQuerySchema,
  renameFileRequestSchema,
  uploadFileQuerySchema,
  writeFileRequestSchema,
  type ChmodFilesRequest,
  type DownloadFileQuery,
  type Permission,
  type UploadFileQuery,
} from '@hopper/shared';
import { Readable } from 'node:stream';
import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
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

/**
 * Relais de l'API fichiers vers le daemon.
 *
 * Le partage des responsabilités est net : **le panel décide qui a le droit de
 * faire quoi, le daemon décide où**. Le panel ne valide aucun chemin — c'est le
 * jail du daemon qui détient cette vérité, et la dupliquer ici créerait deux
 * implémentations dont l'une finirait par diverger.
 *
 * Les permissions suivent l'usage plutôt que la route : lister un dossier
 * demande `file.read`, en lire le contenu demande `file.read-content`. Un
 * membre du staff peut ainsi voir l'arborescence sans lire les configurations
 * qui contiennent des mots de passe de base de données.
 */
@Controller('api/servers/:serverId/files')
export class FilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nodes: NodesService,
    private readonly client: NodeClientService,
    private readonly audit: AuditService,
  ) {}

  @Get('list')
  @RequireServerPermission(PERMISSIONS.FILE_READ)
  list(
    @Param('serverId') serverId: string,
    @Query(new ZodValidationPipe(listFilesQuerySchema)) query: { directory: string },
    @CurrentServer() server: RequestServer,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const url = `${DAEMON_FILE_ROUTES.list(serverId)}?directory=${encodeURIComponent(query.directory)}`;
    return this.relay(server, url, { method: 'GET' }, reply);
  }

  @Get('contents')
  @RequireServerPermission(PERMISSIONS.FILE_READ_CONTENT)
  contents(
    @Param('serverId') serverId: string,
    @Query(new ZodValidationPipe(readFileQuerySchema)) query: { file: string },
    @CurrentServer() server: RequestServer,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const url = `${DAEMON_FILE_ROUTES.contents(serverId)}?file=${encodeURIComponent(query.file)}`;
    return this.relay(server, url, { method: 'GET' }, reply);
  }

  @Post('write')
  @RequireServerPermission(PERMISSIONS.FILE_UPDATE)
  write(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(writeFileRequestSchema)) body: { file: string; content: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.write', { file: body.file });
    return this.relay(server, DAEMON_FILE_ROUTES.write(serverId), { method: 'POST', body }, reply);
  }

  @Post('create-directory')
  @RequireServerPermission(PERMISSIONS.FILE_CREATE)
  createDirectory(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(createDirectoryRequestSchema)) body: { directory: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.create-directory', body);

    return this.relay(
      server,
      DAEMON_FILE_ROUTES.createDirectory(serverId),
      { method: 'POST', body },
      reply,
    );
  }

  @Post('rename')
  @RequireServerPermission(PERMISSIONS.FILE_UPDATE)
  rename(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(renameFileRequestSchema)) body: { from: string; to: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.rename', body);
    return this.relay(server, DAEMON_FILE_ROUTES.rename(serverId), { method: 'POST', body }, reply);
  }

  @Post('copy')
  @RequireServerPermission(PERMISSIONS.FILE_CREATE)
  copy(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(copyFileRequestSchema)) body: { from: string; to: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.copy', body);

    return this.relay(server, DAEMON_FILE_ROUTES.copy(serverId), { method: 'POST', body }, reply);
  }

  @Post('delete')
  @RequireServerPermission(PERMISSIONS.FILE_DELETE)
  remove(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(deleteFilesRequestSchema)) body: { files: string[] },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    // Journalisé systématiquement : c'est l'opération qu'on cherche à
    // reconstituer quand un opérateur signale des fichiers disparus.
    void this.record(server, user, request, 'file.delete', { files: body.files });
    return this.relay(server, DAEMON_FILE_ROUTES.delete(serverId), { method: 'POST', body }, reply);
  }

  @Post('compress')
  @RequireServerPermission(PERMISSIONS.FILE_ARCHIVE)
  compress(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(compressFilesRequestSchema))
    body: { files: string[]; directory: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.compress', body);

    return this.relay(
      server,
      DAEMON_FILE_ROUTES.compress(serverId),
      // Compresser un monde peut prendre plusieurs minutes.
      { method: 'POST', body, timeoutMs: 600_000 },
      reply,
    );
  }

  @Post('decompress')
  @RequireServerPermission(PERMISSIONS.FILE_ARCHIVE)
  decompress(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(decompressFileRequestSchema))
    body: { file: string; directory: string },
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.decompress', body);

    return this.relay(
      server,
      DAEMON_FILE_ROUTES.decompress(serverId),
      { method: 'POST', body, timeoutMs: 600_000 },
      reply,
    );
  }

  @Post('chmod')
  @RequireServerPermission(PERMISSIONS.FILE_UPDATE)
  chmod(
    @Param('serverId') serverId: string,
    @Body(new ZodValidationPipe(chmodFilesRequestSchema)) body: ChmodFilesRequest,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void this.record(server, user, request, 'file.chmod', body);

    return this.relay(server, DAEMON_FILE_ROUTES.chmod(serverId), { method: 'POST', body }, reply);
  }

  // -------------------------------------------------------------------------
  // Transfert
  // -------------------------------------------------------------------------

  /**
   * Télécharge un fichier, relayé depuis le node **en flux**.
   *
   * `file.read-content` et non `file.read` : lister un dossier et emporter le
   * contenu d'un fichier ne sont pas le même droit. Un membre du staff peut
   * ainsi parcourir l'arborescence sans exfiltrer les configurations qui
   * contiennent des mots de passe.
   */
  @Get('download')
  @RequireServerPermission(PERMISSIONS.FILE_READ_CONTENT)
  async download(
    @Param('serverId') serverId: string,
    @Query(new ZodValidationPipe(downloadFileQuerySchema)) query: DownloadFileQuery,
    @CurrentServer() server: RequestServer,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const connection = await this.connectionFor(server);
    const path = `${DAEMON_FILE_ROUTES.download(serverId)}?file=${encodeURIComponent(query.file)}`;
    const response = await this.client.stream(connection, path);

    if (!response.body || response.status !== 200) {
      void reply
        .status(response.status === 200 ? 502 : response.status)
        .send({ statusCode: response.status, message: 'Ce fichier n’a pas pu être récupéré.' });
      return;
    }

    // Les en-têtes viennent du daemon : lui seul connaît le nom réel du fichier
    // une fois le chemin résolu par le jail.
    for (const header of ['content-disposition', 'content-length']) {
      const value = response.headers.get(header);
      if (value) {
        void reply.header(header, value);
      }
    }

    void reply
      .status(200)
      .header('content-type', 'application/octet-stream')
      .send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
  }

  /**
   * Envoi d'un fichier.
   *
   * Le corps de la requête est retransmis au node tel quel, sans jamais tenir
   * en mémoire dans le panel : un modpack de deux gigaoctets traverserait
   * autrement le tas du processus, pour tous ses utilisateurs à la fois.
   *
   * Le nom et le dossier passent en paramètres d'URL, et c'est le jail du
   * daemon qui juge le chemin obtenu — le panel ne valide aucun chemin, ici
   * comme ailleurs.
   */
  @Post('upload')
  @RequireServerPermission(PERMISSIONS.FILE_CREATE)
  async upload(
    @Param('serverId') serverId: string,
    @Query(new ZodValidationPipe(uploadFileQuerySchema)) query: UploadFileQuery,
    @CurrentServer() server: RequestServer,
    @CurrentUser() user: RequestUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const connection = await this.connectionFor(server);
    const path =
      `${DAEMON_FILE_ROUTES.upload(serverId)}?directory=${encodeURIComponent(query.directory)}` +
      `&name=${encodeURIComponent(query.name)}`;

    const response = await this.client.pipeTo(
      connection,
      path,
      request.raw,
      request.headers['content-length'],
    );

    await this.record(server, user, request, 'upload', {
      directory: query.directory,
      name: query.name,
    });

    reply.status(response.status);

    if (response.contentType) {
      reply.header('content-type', response.contentType);
    }

    return response.status === 204 ? undefined : response.body;
  }

  // -------------------------------------------------------------------------

  /** Coordonnées du node qui héberge ce serveur. */
  private async connectionFor(server: RequestServer) {
    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
      select: { uuid: true },
    });

    return this.nodes.getConnection(node.uuid);
  }

  private async relay(
    server: RequestServer,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
    reply: FastifyReply,
  ): Promise<unknown> {
    const node = await this.prisma.node.findUniqueOrThrow({
      where: { id: server.nodeId },
      select: { uuid: true },
    });

    const connection = await this.nodes.getConnection(node.uuid);
    const response = await this.client.proxy(connection, path, options);

    reply.status(response.status);

    if (response.contentType) {
      reply.header('content-type', response.contentType);
    }

    // 204 : Fastify refuse un corps sur une réponse sans contenu.
    return response.status === 204 ? undefined : response.body;
  }

  private async record(
    server: RequestServer,
    user: RequestUser,
    request: AuthenticatedRequest,
    event: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      // `event` est libre ici alors que l'audit attend une valeur connue : les
      // actions sur fichiers sont trop nombreuses pour figurer une à une dans
      // l'énumération, et leur granularité vit dans `metadata`.
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { action: event, ...metadata },
    });
  }
}

/** Permissions requises par opération, pour information dans l'interface. */
export const FILE_OPERATION_PERMISSIONS: Record<string, Permission> = {
  list: PERMISSIONS.FILE_READ,
  read: PERMISSIONS.FILE_READ_CONTENT,
  write: PERMISSIONS.FILE_UPDATE,
  create: PERMISSIONS.FILE_CREATE,
  delete: PERMISSIONS.FILE_DELETE,
  archive: PERMISSIONS.FILE_ARCHIVE,
};

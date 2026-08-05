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
 * Relay of the file API towards the daemon.
 *
 * The split of responsibilities is clean: **the panel decides who may do what,
 * the daemon decides where**. The panel validates no path — the daemon's jail
 * holds that truth, and duplicating it here would create two implementations,
 * one of which would eventually drift.
 *
 * Permissions follow the use rather than the route: listing a folder needs
 * `file.read`, reading its content needs `file.read-content`. A staff member
 * can thus browse the tree without reading the configurations that hold
 * database passwords.
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
    // Always logged: this is the operation one tries to reconstruct when an
    // operator reports missing files.
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
      // Compressing a world can take several minutes.
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
  // Transfer
  // -------------------------------------------------------------------------

  /**
   * Downloads a file, relayed from the node **as a stream**.
   *
   * `file.read-content` and not `file.read`: listing a folder and carrying away
   * a file's content are not the same right. A staff member can browse the tree
   * without exfiltrating the configurations that hold passwords.
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
        .send({ statusCode: response.status, message: 'This file could not be retrieved.' });
      return;
    }

    // The headers come from the daemon: it alone knows the file's real name
    // once the path has been resolved by the jail.
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
   * File upload.
   *
   * The request body is passed on to the node as is, never held in memory in
   * the panel: a two-gigabyte modpack would otherwise cross the process heap,
   * for every user at once.
   *
   * The name and the folder travel as URL parameters, and it is the daemon's
   * jail that judges the resulting path — the panel validates no path, here as
   * everywhere else.
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

  /** Address of the node hosting this server. */
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

    // 204: Fastify refuses a body on a no-content response.
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
      // `event` is free-form here although the audit expects a known value:
      // file actions are too numerous to list one by one in the enumeration,
      // and their granularity lives in `metadata`.
      event: AUDIT_EVENTS.SERVER_UPDATED,
      actorId: user.id,
      serverId: server.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { action: event, ...metadata },
    });
  }
}

/** Permissions required per operation, for display in the interface. */
export const FILE_OPERATION_PERMISSIONS: Record<string, Permission> = {
  list: PERMISSIONS.FILE_READ,
  read: PERMISSIONS.FILE_READ_CONTENT,
  write: PERMISSIONS.FILE_UPDATE,
  create: PERMISSIONS.FILE_CREATE,
  delete: PERMISSIONS.FILE_DELETE,
  archive: PERMISSIONS.FILE_ARCHIVE,
};

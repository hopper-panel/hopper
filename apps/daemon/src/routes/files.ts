import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_EDITABLE_FILE_BYTES,
  MAX_UPLOAD_BYTES,
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
  type ListFilesResponse,
} from '@hopper/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { ArchiveError, createArchive, extractArchive } from '../fs/archive.js';
import {
  DeniedFileError,
  JailedFilesystem,
  NotFoundError,
  PathEscapeError,
  QuotaExceededError,
} from '../fs/jailed-filesystem.js';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';

/** Upload past the bound: deserves a 413 rather than an internal error. */
class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

/**
 * The daemon's file API.
 *
 * Every route fetches the jail of the server concerned and delegates everything
 * to it. No path is handled directly here: that is the rule that makes the
 * check verifiable in one single place.
 */
export function registerFileRoutes(
  app: FastifyInstance,
  manager: ServerManager,
  ownership: { uid: number; gid: number },
): void {
  /** The server's jail, built on the fly from its configuration. */
  function jailFor(server: ServerInstance): JailedFilesystem {
    return new JailedFilesystem({
      root: server.volumePath,
      denylist: server.configuration.fileDenylist,
      quota: () => server.diskQuota,
      // `chown` does not exist on Windows, where the development machine runs
      // — and where there is no container anyway.
      ownership: process.platform === 'win32' ? undefined : ownership,
    });
  }

  /**
   * Translates the jail's errors into HTTP responses.
   *
   * An escape and a denied file both return 403 with the same message:
   * distinguishing the two would confirm to an attacker that a file exists
   * outside the volume.
   */
  function fail(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
    if (error instanceof TooLargeError) {
      return reply.code(413).send({
        error: { code: 'file_too_large', message: error.message, requestId: request.id },
      });
    }

    // 507 rather than 413: the payload is not too large in itself, the server
    // has no room left for it. The distinction matters to a client deciding
    // whether to retry with a smaller file or to free space first.
    if (error instanceof QuotaExceededError) {
      return reply.code(507).send({
        error: {
          code: 'disk_quota_exceeded',
          message: error.message,
          usedBytes: error.usedBytes,
          limitBytes: error.limitBytes,
          requestId: request.id,
        },
      });
    }

    if (error instanceof PathEscapeError || error instanceof DeniedFileError) {
      request.log.warn({ path: error.requestedPath }, 'File access refused by the jail');

      return reply.code(403).send({
        error: {
          code: 'forbidden_path',
          message: 'This path is outside the server directory, or protected.',
          requestId: request.id,
        },
      });
    }

    if (error instanceof NotFoundError) {
      return reply.code(404).send({
        error: { code: 'not_found', message: error.message, requestId: request.id },
      });
    }

    if (error instanceof ArchiveError) {
      return reply.code(422).send({
        error: { code: 'invalid_archive', message: error.message, requestId: request.id },
      });
    }

    throw error;
  }

  /** Shared wrapper: server resolution, validation, error handling. */
  function handler<TSchema extends z.ZodType>(
    schema: TSchema,
    source: 'body' | 'query',
    action: (
      context: { jail: JailedFilesystem; server: ServerInstance },
      input: z.infer<TSchema>,
      reply: FastifyReply,
      request: FastifyRequest,
    ) => Promise<unknown>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const { uuid } = request.params as { uuid: string };
      const server = manager.require(uuid);

      const parsed = schema.safeParse(source === 'body' ? request.body : request.query);

      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid_request',
            message: parsed.error.issues
              .map((issue) => `${issue.path.join('.')} : ${issue.message}`)
              .join(', '),
            requestId: request.id,
          },
        });
      }

      try {
        return await action({ jail: jailFor(server), server }, parsed.data, reply, request);
      } catch (error: unknown) {
        return fail(reply, request, error);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  app.get(
    '/api/servers/:uuid/files/list',
    handler(listFilesQuerySchema, 'query', async ({ jail }, query) => {
      const entries = await jail.list(query.directory);
      const response: ListFilesResponse = { directory: query.directory, entries };
      return response;
    }),
  );

  app.get(
    '/api/servers/:uuid/files/contents',
    handler(readFileQuerySchema, 'query', async ({ jail }, query, reply) => {
      const entry = await jail.stat(query.file);

      if (entry.directory) {
        return reply.code(400).send({
          error: {
            code: 'is_directory',
            message: 'This path names a folder.',
            requestId: 'n/a',
          },
        });
      }

      // Past the limit, the editor would freeze the tab for a file the user
      // has no business hand-editing anyway.
      if (entry.sizeBytes > MAX_EDITABLE_FILE_BYTES) {
        return reply.code(413).send({
          error: {
            code: 'file_too_large',
            message: `File too large for the editor (${entry.sizeBytes} bytes). Download it instead.`,
            requestId: 'n/a',
          },
        });
      }

      const absolute = await jail.absolutePathFor(query.file);

      // Streamed rather than loaded into memory: a 4 MiB file per concurrent
      // request would quickly exhaust the daemon's heap.
      await reply
        .header('content-type', 'application/octet-stream')
        .send(createReadStream(absolute));

      return reply;
    }),
  );

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  app.post(
    '/api/servers/:uuid/files/write',
    handler(writeFileRequestSchema, 'body', async ({ jail }, body, reply) => {
      await jail.writeFile(body.file, body.content);
      return reply.code(204).send();
    }),
  );

  app.post(
    '/api/servers/:uuid/files/create-directory',
    handler(createDirectoryRequestSchema, 'body', async ({ jail }, body, reply) => {
      await jail.createDirectory(body.directory);
      return reply.code(204).send();
    }),
  );

  app.post(
    '/api/servers/:uuid/files/rename',
    handler(renameFileRequestSchema, 'body', async ({ jail }, body, reply) => {
      await jail.rename(body.from, body.to);
      return reply.code(204).send();
    }),
  );

  app.post(
    '/api/servers/:uuid/files/copy',
    handler(copyFileRequestSchema, 'body', async ({ jail }, body, reply) => {
      await jail.copy(body.from, body.to);
      return reply.code(204).send();
    }),
  );

  app.post(
    '/api/servers/:uuid/files/delete',
    handler(deleteFilesRequestSchema, 'body', async ({ jail }, body, reply) => {
      await jail.delete(body.files);
      return reply.code(204).send();
    }),
  );

  // -------------------------------------------------------------------------
  // Archives
  // -------------------------------------------------------------------------

  app.post(
    '/api/servers/:uuid/files/compress',
    handler(compressFilesRequestSchema, 'body', async ({ jail }, body) => {
      // Timestamped: two successive compressions must not overwrite each other.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const archivePath = `${body.directory.replace(/\/+$/, '')}/archive-${stamp}.tar.gz`;

      await createArchive(jail, body.files, archivePath);

      return jail.stat(archivePath);
    }),
  );

  app.post(
    '/api/servers/:uuid/files/decompress',
    handler(decompressFileRequestSchema, 'body', async ({ jail }, body, reply) => {
      const result = await extractArchive(jail, body.file, body.directory);
      return reply.code(200).send(result);
    }),
  );

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------

  app.get(
    '/api/servers/:uuid/files/download',
    handler(downloadFileQuerySchema, 'query', async ({ jail }, query, reply) => {
      const entry = await jail.stat(query.file);

      if (entry.directory) {
        return reply.code(400).send({
          error: {
            code: 'is_directory',
            message: 'A folder cannot be downloaded as is: compress it first.',
            requestId: 'n/a',
          },
        });
      }

      const absolute = await jail.absolutePathFor(query.file);

      // The name is taken from the resolved entry, never from the requested
      // path: a value containing a newline or a quote would allow injecting
      // headers into the response.
      const filename = entry.name.replace(/[^\w.\- ]+/g, '_');

      await reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(entry.sizeBytes))
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(createReadStream(absolute));

      return reply;
    }),
  );

  /**
   * File upload.
   *
   * The body is the file itself, with no multipart envelope: the panel then
   * only has to relay a stream of bytes, without reassembling it in memory. An
   * archive of several gigabytes crosses the panel without ever fitting in it
   * whole.
   */
  app.post(
    '/api/servers/:uuid/files/upload',
    { bodyLimit: MAX_UPLOAD_BYTES },
    handler(uploadFileQuerySchema, 'query', async ({ jail, server }, query, reply, request) => {
      const target = `${query.directory.replace(/\/+$/, '')}/${query.name}`;
      // The jail is what judges the path: a name containing `../` is rejected
      // here, before a single byte is written.
      const absolute = await jail.absolutePathFor(target);

      await mkdir(dirname(absolute), { recursive: true });

      // The counter doubles up Fastify's `bodyLimit` rather than trust it:
      // `Content-Length` is declared by the client and can lie, whereas the
      // bytes actually received cannot. The same pass enforces the disk quota,
      // for the same reason: an upload that announces one megabyte and sends a
      // hundred has to be cut off as it arrives, not diagnosed afterwards.
      const quota = server.diskQuota;
      const room = jail.remainingBytes();
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;

          if (written > MAX_UPLOAD_BYTES) {
            done(new TooLargeError('File too large.'));
            return;
          }

          if (written > room) {
            done(new QuotaExceededError(quota.usedBytes, quota.limitBytes));
            return;
          }

          done(null, chunk);
        },
      });

      try {
        await pipeline(request.raw, counter, createWriteStream(absolute));
      } catch (error) {
        // A truncated file is worse than none: it would show in the listing
        // with a plausible size and break on the first load.
        await jail.delete([target]).catch(() => undefined);
        throw error;
      }

      await jail.applyOwnership(absolute);

      return reply.code(201).send(await jail.stat(target));
    }),
  );

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  app.post(
    '/api/servers/:uuid/files/chmod',
    handler(chmodFilesRequestSchema, 'body', async ({ jail }, body, reply) => {
      const mode = Number.parseInt(body.mode, 8);

      for (const file of body.files) {
        await jail.chmod(file, mode);
      }

      return reply.code(204).send();
    }),
  );
}

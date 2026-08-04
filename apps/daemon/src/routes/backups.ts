import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  BACKUP_EXTENSIONS,
  createBackupRequestSchema,
  restoreBackupRequestSchema,
} from '@hopper/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BackupError } from '../backup/backup-archive.js';
import type { BackupManager } from '../backup/backup-manager.js';
import { JailedFilesystem } from '../fs/jailed-filesystem.js';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';

/**
 * Backup routes, called by the panel.
 *
 * The panel has already recorded the backup and checked the permissions; it
 * supplies the identifier. The daemon chooses neither the name, nor the moment,
 * nor the retention — it only knows where the volumes are, and that is the one
 * thing the panel cannot know.
 *
 * The identifier received is never concatenated into a path as is: it is
 * validated as a UUID by the schema, which rules out `../` before the path is
 * even built.
 */
/** Name of the exclusions file dropped at the server's root. */
const IGNORE_FILE = '.hopperignore';

/**
 * Reads the server's exclusions, if it declared any.
 *
 * The path is a constant resolved by the jail — no value from a request enters
 * here. A missing file is the normal case, not an error: most servers have
 * none.
 */
async function readIgnoreFile(jail: JailedFilesystem, request: FastifyRequest): Promise<string[]> {
  try {
    const absolute = await jail.absolutePathFor(IGNORE_FILE);
    const content = await readFile(absolute, 'utf8');

    return content.split(/\r?\n/);
  } catch {
    request.log.debug(`No readable ${IGNORE_FILE} for this server`);
    return [];
  }
}

export function registerBackupRoutes(
  app: FastifyInstance,
  manager: ServerManager,
  backups: BackupManager,
): void {
  function jailFor(server: ServerInstance): JailedFilesystem {
    return new JailedFilesystem({
      root: server.volumePath,
      denylist: server.configuration.fileDenylist,
    });
  }

  function fail(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
    if (error instanceof BackupError) {
      return reply.code(409).send({
        error: { code: 'backup_error', message: error.message, requestId: request.id },
      });
    }

    request.log.error({ err: error }, 'Erreur de sauvegarde');

    return reply.code(500).send({
      error: {
        code: 'backup_failed',
        message: 'The backup failed. Check the node logs.',
        requestId: request.id,
      },
    });
  }

  app.post('/api/servers/:uuid/backups', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };
    const body = createBackupRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_body',
          message: body.error.issues.map((issue) => issue.path.join('.')).join(', '),
          requestId: request.id,
        },
      });
    }

    const server = manager.require(uuid);

    // With no explicit list, the server's own prevails. That is what lets one
    // version their exclusions along with the rest of their configuration,
    // instead of retyping them on every backup.
    const ignoredFiles =
      body.data.ignoredFiles.length > 0
        ? body.data.ignoredFiles
        : await readIgnoreFile(jailFor(server), request);

    try {
      // Returns at once: archiving carries on in the background and the
      // verdict reaches the panel through
      // `/api/remote/backups/:uuid/status`.
      const response = backups.start({
        backupUuid: body.data.uuid,
        serverUuid: server.uuid,
        volumePath: server.volumePath,
        ignoredFiles,
      });

      return reply.code(202).send(response);
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.delete('/api/servers/:uuid/backups/:backupUuid', async (request, reply) => {
    const { uuid, backupUuid } = request.params as { uuid: string; backupUuid: string };
    manager.require(uuid);

    if (backups.isRunning(backupUuid)) {
      return reply.code(409).send({
        error: {
          code: 'backup_running',
          message: 'This backup is running: it cannot be deleted.',
          requestId: request.id,
        },
      });
    }

    // Silent if the archive is already gone: deletion is idempotent, and the
    // panel has to be able to remove an entry whose file has vanished.
    await backups.delete(backupUuid);

    return reply.code(204).send();
  });

  app.post('/api/servers/:uuid/backups/:backupUuid/restore', async (request, reply) => {
    const { uuid, backupUuid } = request.params as { uuid: string; backupUuid: string };
    const body = restoreBackupRequestSchema.safeParse(request.body ?? {});

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Invalid request.', requestId: request.id },
      });
    }

    const server = manager.require(uuid);

    // Extracting under a running server would mix the archive's files with
    // those the server rewrites: the result would be neither one nor the other.
    // It is the panel's job to stop the server before calling here, and the
    // daemon's to refuse if that was not done.
    if (server.currentState !== 'offline') {
      return reply.code(409).send({
        error: {
          code: 'server_running',
          message: 'The server has to be stopped before a restore.',
          requestId: request.id,
        },
      });
    }

    const checksum = (request.query as { checksum?: string } | undefined)?.checksum;

    try {
      const result = await backups.restore({
        backupUuid,
        jail: jailFor(server),
        truncate: body.data.truncate,
        expectedChecksum: checksum,
      });

      request.log.info(
        { server: server.uuid, backup: backupUuid, files: result.restoredFiles },
        'Backup restored',
      );

      return reply.send(result);
    } catch (error) {
      return fail(reply, request, error);
    }
  });

  app.get('/api/servers/:uuid/backups/:backupUuid/download', async (request, reply) => {
    const { uuid, backupUuid } = request.params as { uuid: string; backupUuid: string };
    manager.require(uuid);

    const archive = await backups.findArchive(backupUuid);

    if (!archive) {
      return reply.code(404).send({
        error: {
          code: 'backup_not_found',
          message: 'Archive introuvable sur ce node.',
          requestId: request.id,
        },
      });
    }

    const extension = archive.path.endsWith(BACKUP_EXTENSIONS.zstd)
      ? BACKUP_EXTENSIONS.zstd
      : BACKUP_EXTENSIONS.gzip;

    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(archive.sizeBytes))
      .header('content-disposition', `attachment; filename="${backupUuid}${extension}"`)
      .send(createReadStream(archive.path));
  });
}

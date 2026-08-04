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
 * Routes de sauvegarde, appelées par le panel.
 *
 * Le panel a déjà enregistré la sauvegarde et vérifié les permissions ; il
 * fournit l'identifiant. Le daemon ne choisit ni le nom, ni le moment, ni la
 * rétention — il sait seulement où sont les volumes, et c'est la seule chose
 * que le panel ne peut pas savoir.
 *
 * L'identifiant reçu n'est jamais concaténé tel quel dans un chemin : il est
 * validé comme UUID par le schéma, ce qui exclut le `../` avant même que le
 * chemin ne soit construit.
 */
/** Nom du fichier d'exclusions déposé à la racine du serveur. */
const IGNORE_FILE = '.hopperignore';

/**
 * Lit les exclusions du serveur, s'il en a déclaré.
 *
 * Le chemin est une constante résolue par le jail — aucune valeur venue d'une
 * requête n'entre ici. Un fichier absent est le cas normal, pas une erreur :
 * la plupart des serveurs n'en ont pas.
 */
async function readIgnoreFile(jail: JailedFilesystem, request: FastifyRequest): Promise<string[]> {
  try {
    const absolute = await jail.absolutePathFor(IGNORE_FILE);
    const content = await readFile(absolute, 'utf8');

    return content.split(/\r?\n/);
  } catch {
    request.log.debug(`Aucun ${IGNORE_FILE} lisible pour ce serveur`);
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
        message: 'La sauvegarde a échoué. Consultez les journaux du node.',
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

    // Sans liste explicite, celle du serveur fait foi. C'est ce qui permet de
    // versionner ses exclusions avec le reste de sa configuration, au lieu de
    // les retaper à chaque sauvegarde.
    const ignoredFiles =
      body.data.ignoredFiles.length > 0
        ? body.data.ignoredFiles
        : await readIgnoreFile(jailFor(server), request);

    try {
      // Rend la main tout de suite : l'archivage se poursuit en arrière-plan et
      // le verdict arrive au panel par `/api/remote/backups/:uuid/status`.
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
          message: 'Cette sauvegarde est en cours : elle ne peut pas être supprimée.',
          requestId: request.id,
        },
      });
    }

    // Silencieux si l'archive manque déjà : la suppression est idempotente, et
    // le panel doit pouvoir retirer une entrée dont le fichier a disparu.
    await backups.delete(backupUuid);

    return reply.code(204).send();
  });

  app.post('/api/servers/:uuid/backups/:backupUuid/restore', async (request, reply) => {
    const { uuid, backupUuid } = request.params as { uuid: string; backupUuid: string };
    const body = restoreBackupRequestSchema.safeParse(request.body ?? {});

    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Requête invalide.', requestId: request.id },
      });
    }

    const server = manager.require(uuid);

    // Extraire sous un serveur en fonctionnement mélangerait les fichiers de
    // l'archive et ceux que le serveur réécrit : le résultat ne serait ni l'un
    // ni l'autre. C'est au panel d'arrêter le serveur avant d'appeler ici, et
    // au daemon de refuser si ce n'est pas fait.
    if (server.currentState !== 'offline') {
      return reply.code(409).send({
        error: {
          code: 'server_running',
          message: 'Le serveur doit être arrêté avant une restauration.',
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
        'Sauvegarde restaurée',
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

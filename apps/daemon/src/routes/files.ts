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
} from '../fs/jailed-filesystem.js';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';

/** Envoi dépassant la borne : mérite un 413 plutôt qu'une erreur interne. */
class TooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooLargeError';
  }
}

/**
 * API fichiers du daemon.
 *
 * Chaque route récupère le jail du serveur concerné et lui délègue tout. Aucun
 * chemin n'est manipulé directement ici : c'est la règle qui rend le contrôle
 * vérifiable en un seul endroit.
 */
export function registerFileRoutes(
  app: FastifyInstance,
  manager: ServerManager,
  ownership: { uid: number; gid: number },
): void {
  /** Jail du serveur, construit à la volée à partir de sa configuration. */
  function jailFor(server: ServerInstance): JailedFilesystem {
    return new JailedFilesystem({
      root: server.volumePath,
      denylist: server.configuration.fileDenylist,
      // `chown` n'existe pas sous Windows, où tourne la machine de
      // développement — et où il n'y a de toute façon aucun conteneur.
      ownership: process.platform === 'win32' ? undefined : ownership,
    });
  }

  /**
   * Traduit les erreurs du jail en réponses HTTP.
   *
   * Une évasion et un fichier interdit renvoient tous deux 403 avec le même
   * message : distinguer les deux confirmerait à un attaquant qu'un fichier
   * existe hors du volume.
   */
  function fail(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
    if (error instanceof TooLargeError) {
      return reply.code(413).send({
        error: { code: 'file_too_large', message: error.message, requestId: request.id },
      });
    }

    if (error instanceof PathEscapeError || error instanceof DeniedFileError) {
      request.log.warn({ path: error.requestedPath }, 'Accès fichier refusé par le jail');

      return reply.code(403).send({
        error: {
          code: 'forbidden_path',
          message: 'Ce chemin est hors du répertoire du serveur ou protégé.',
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

  /** Enveloppe commune : résolution du serveur, validation, gestion d'erreur. */
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
  // Lecture
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
            message: 'Ce chemin désigne un dossier.',
            requestId: 'n/a',
          },
        });
      }

      // Au-delà de la limite, l'éditeur figerait l'onglet pour un fichier que
      // l'utilisateur n'a de toute façon pas à modifier à la main.
      if (entry.sizeBytes > MAX_EDITABLE_FILE_BYTES) {
        return reply.code(413).send({
          error: {
            code: 'file_too_large',
            message: `Fichier trop volumineux pour l'éditeur (${entry.sizeBytes} octets). Téléchargez-le.`,
            requestId: 'n/a',
          },
        });
      }

      const absolute = await jail.absolutePathFor(query.file);

      // Envoyé en flux plutôt que chargé en mémoire : un fichier de 4 Mio par
      // requête concurrente épuiserait vite le tas du daemon.
      await reply
        .header('content-type', 'application/octet-stream')
        .send(createReadStream(absolute));

      return reply;
    }),
  );

  // -------------------------------------------------------------------------
  // Écriture
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
      // Horodaté : deux compressions successives ne doivent pas s'écraser.
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
  // Transfert
  // -------------------------------------------------------------------------

  app.get(
    '/api/servers/:uuid/files/download',
    handler(downloadFileQuerySchema, 'query', async ({ jail }, query, reply) => {
      const entry = await jail.stat(query.file);

      if (entry.directory) {
        return reply.code(400).send({
          error: {
            code: 'is_directory',
            message: 'Un dossier ne se télécharge pas tel quel : compressez-le d’abord.',
            requestId: 'n/a',
          },
        });
      }

      const absolute = await jail.absolutePathFor(query.file);

      // Le nom est repris de l'entrée résolue, jamais du chemin demandé : une
      // valeur contenant un retour à la ligne ou un guillemet permettrait
      // d'injecter des en-têtes dans la réponse.
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
   * Envoi d'un fichier.
   *
   * Le corps est le fichier lui-même, sans enveloppe multipart : le panel n'a
   * ainsi qu'à relayer un flux d'octets, sans le réassembler en mémoire. Une
   * archive de plusieurs gigaoctets traverse le panel sans jamais y tenir en
   * entier.
   */
  app.post(
    '/api/servers/:uuid/files/upload',
    { bodyLimit: MAX_UPLOAD_BYTES },
    handler(uploadFileQuerySchema, 'query', async ({ jail }, query, reply, request) => {
      const target = `${query.directory.replace(/\/+$/, '')}/${query.name}`;
      // C'est le jail qui juge le chemin : un nom contenant `../` est rejeté
      // ici, avant qu'aucun octet ne soit écrit.
      const absolute = await jail.absolutePathFor(target);

      await mkdir(dirname(absolute), { recursive: true });

      // Le compteur double le `bodyLimit` de Fastify plutôt que de s'y fier :
      // `Content-Length` est déclaré par le client et peut mentir, alors que
      // les octets réellement reçus, eux, ne mentent pas.
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;

          if (written > MAX_UPLOAD_BYTES) {
            done(new TooLargeError('Fichier trop volumineux.'));
            return;
          }

          done(null, chunk);
        },
      });

      try {
        await pipeline(request.raw, counter, createWriteStream(absolute));
      } catch (error) {
        // Un fichier tronqué est pire qu'aucun : il apparaîtrait dans la liste
        // avec une taille plausible et casserait au premier chargement.
        await jail.delete([target]).catch(() => undefined);
        throw error;
      }

      await jail.applyOwnership(absolute);

      return reply.code(201).send(await jail.stat(target));
    }),
  );

  // -------------------------------------------------------------------------
  // Droits
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

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chown, lstat, mkdir, opendir, rm, utimes } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { BACKUP_EXTENSIONS, type BackupCompression } from '@hopper/shared';
import { extract, pack } from 'tar-stream';
import type { JailedFilesystem } from '../fs/jailed-filesystem.js';
import { ALWAYS_IGNORED, IgnoreList } from './ignore.js';

/**
 * Production et restauration des archives de sauvegarde.
 *
 * Deux propriétés gouvernent ce fichier.
 *
 * **Tout est en flux.** Un monde Minecraft dépasse couramment plusieurs
 * gigaoctets ; rien n'est jamais chargé en mémoire, et l'empreinte SHA-256 est
 * calculée au passage plutôt que par une seconde lecture du fichier produit.
 *
 * **L'archive vit hors du volume.** La ranger dedans la placerait sous le
 * gestionnaire de fichiers et le SFTP : n'importe quel sous-utilisateur ayant
 * `file.delete` pourrait effacer les sauvegardes, et la sauvegarde suivante
 * s'archiverait elle-même.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Compression retenue.
 *
 * zstd est nettement plus rapide que gzip à taux comparable, mais n'existe dans
 * `node:zlib` qu'à partir de Node 22.15. Plutôt que d'imposer cette version, on
 * teste sa présence et on inscrit le format dans le nom du fichier : une
 * archive produite sur un hôte reste restaurable sur un autre.
 */
export function detectCompression(): BackupCompression {
  return typeof (zlib as { createZstdCompress?: unknown }).createZstdCompress === 'function'
    ? 'zstd'
    : 'gzip';
}

function compressor(compression: BackupCompression) {
  return compression === 'zstd'
    ? (zlib as unknown as { createZstdCompress: () => Transform }).createZstdCompress()
    : zlib.createGzip({ level: 6 });
}

function decompressor(compression: BackupCompression) {
  return compression === 'zstd'
    ? (zlib as unknown as { createZstdDecompress: () => Transform }).createZstdDecompress()
    : zlib.createGunzip();
}

/** Déduit le format d'une archive de son extension. */
export function compressionOf(archivePath: string): BackupCompression {
  const normalized = archivePath.replace(/\\/g, '/');

  for (const [compression, extension] of Object.entries(BACKUP_EXTENSIONS)) {
    if (normalized.endsWith(extension)) {
      return compression as BackupCompression;
    }
  }

  throw new BackupError(`Format d'archive inconnu : ${archivePath}`);
}

export interface BackupArchiveResult {
  sizeBytes: number;
  checksum: string;
  fileCount: number;
}

export interface CreateBackupOptions {
  /** Racine du volume, telle que le daemon la connaît. */
  volumePath: string;
  /** Destination de l'archive, hors du volume. */
  archivePath: string;
  ignoredFiles: readonly string[];
  compression: BackupCompression;
}

/**
 * Archive un volume de serveur.
 *
 * Les liens symboliques sont archivés **en tant que liens**, sans être suivis :
 * suivre un lien pointant hors du volume ferait entrer dans la sauvegarde des
 * fichiers de l'hôte, et un lien pointant vers un parent produirait une archive
 * infinie.
 */
export async function createBackupArchive(
  options: CreateBackupOptions,
): Promise<BackupArchiveResult> {
  const ignore = new IgnoreList([...ALWAYS_IGNORED, ...options.ignoredFiles]);
  const packer = pack();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let fileCount = 0;

  // L'empreinte porte sur l'archive **compressée**, celle qui sera relue à la
  // restauration. La calculer sur le flux non compressé ne détecterait pas une
  // corruption survenue après la compression.
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      done(null, chunk);
    },
  });

  await mkdir(dirname(options.archivePath), { recursive: true });

  // Le rejet du pipeline est rattaché **immédiatement**, avant tout `await`
  // susceptible d'échouer. Détruire le paquetage sur erreur fait rejeter cette
  // promesse avec `ERR_STREAM_PREMATURE_CLOSE` ; si personne ne l'écoute
  // encore, Node la traite en rejet non géré et termine le processus — c'est
  // le daemon entier qui tombe pour une sauvegarde manquée.
  let writeError: Error | undefined;
  const written = pipeline(
    packer,
    compressor(options.compression),
    measure,
    createWriteStream(options.archivePath),
  ).catch((error: unknown) => {
    writeError =
      error instanceof Error ? error : new BackupError("Écriture de l'archive interrompue.");
  });

  try {
    fileCount = await packDirectory(packer, options.volumePath, ignore);
    packer.finalize();
    await written;

    if (writeError) {
      throw writeError;
    }
  } catch (error) {
    packer.destroy();
    await written;
    // Une archive partielle est pire qu'aucune : elle serait proposée à la
    // restauration et n'échouerait qu'au moment d'extraire, sur un volume déjà
    // vidé.
    await rm(options.archivePath, { force: true });
    throw error;
  }

  return { sizeBytes, checksum: hash.digest('hex'), fileCount };
}

async function packDirectory(
  packer: ReturnType<typeof pack>,
  root: string,
  ignore: IgnoreList,
): Promise<number> {
  let count = 0;
  const queue: string[] = [root];

  // Parcours itératif : une récursion sur l'arborescence d'un serveur bien
  // rempli peut atteindre la limite de pile, et le plantage serait attribué à
  // la sauvegarde plutôt qu'à sa profondeur.
  while (queue.length > 0) {
    const directory = queue.pop()!;
    const entries = await opendir(directory);

    for await (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join('/');

      if (entry.isDirectory()) {
        if (ignore.canPrune(relativePath)) {
          continue;
        }
        if (!ignore.ignores(relativePath, true)) {
          const stats = await lstat(absolute);
          packer.entry({ name: `${relativePath}/`, type: 'directory', mode: stats.mode & 0o7777 });
        }
        queue.push(absolute);
        continue;
      }

      if (ignore.ignores(relativePath, false)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        const stats = await lstat(absolute);
        const { readlink } = await import('node:fs/promises');
        packer.entry({
          name: relativePath,
          type: 'symlink',
          linkname: await readlink(absolute),
          mode: stats.mode & 0o7777,
        });
        count += 1;
        continue;
      }

      if (!entry.isFile()) {
        // Sockets, tubes nommés, périphériques : rien de tout cela n'a de sens
        // dans une sauvegarde, et `tar-stream` ne saurait qu'en faire.
        continue;
      }

      const stats = await lstat(absolute);
      const target = packer.entry({
        name: relativePath,
        size: stats.size,
        mode: stats.mode & 0o7777,
        mtime: stats.mtime,
      });

      await pipeline(createReadStream(absolute), target);
      count += 1;
    }
  }

  return count;
}

export interface RestoreBackupOptions {
  jail: JailedFilesystem;
  archivePath: string;
  /** Vider le volume avant extraction. */
  truncate: boolean;
  /** Empreinte attendue ; l'extraction n'est pas tentée sans correspondance. */
  expectedChecksum?: string;
  /**
   * Utilisateur du conteneur, à qui appartiennent les fichiers restaurés.
   *
   * Sans cela, l'extraction — faite par le daemon, donc par root — produit un
   * volume que le serveur ne peut plus écrire : il démarre, puis échoue à
   * sauvegarder son monde, sur une erreur qui ne mentionne jamais la
   * restauration. L'appartenance n'est délibérément pas relue de l'archive :
   * une sauvegarde peut être restaurée sur un node dont l'utilisateur de
   * conteneur porte un autre identifiant.
   *
   * Absent sous Windows, où `chown` n'a pas de sens.
   */
  ownership?: { uid: number; gid: number };
}

/**
 * Restaure une archive dans le volume d'un serveur.
 *
 * L'empreinte est vérifiée **avant** d'écrire quoi que ce soit. Une archive
 * corrompue détectée en cours d'extraction laisserait un volume à moitié
 * écrasé — c'est-à-dire un serveur détruit par l'opération censée le sauver.
 */
export async function restoreBackupArchive(options: RestoreBackupOptions): Promise<number> {
  const compression = compressionOf(options.archivePath);

  if (options.expectedChecksum) {
    const actual = await checksumOf(options.archivePath);

    if (actual !== options.expectedChecksum) {
      throw new BackupError(
        "L'archive ne correspond pas à son empreinte : restauration refusée pour ne pas " +
          'écraser le serveur avec des données corrompues.',
      );
    }
  }

  if (options.truncate) {
    await options.jail.emptyRoot();
  }

  const extractor = extract();
  let restored = 0;

  extractor.on('entry', (header, stream, next) => {
    void (async () => {
      try {
        // `resolveArchiveEntry` est ce qui interdit le zip-slip : c'est le jail
        // qui décide où va l'entrée, jamais le nom qu'elle porte.
        const destination = await options.jail.resolveArchiveEntry('/', header.name);

        if (header.type === 'directory') {
          await mkdir(destination, { recursive: true });
          await applyOwnership(destination, options.ownership);
          stream.resume();
        } else if (header.type === 'file') {
          await mkdir(dirname(destination), { recursive: true });
          await pipeline(stream, createWriteStream(destination, { mode: header.mode ?? 0o644 }));

          if (header.mtime) {
            await utimes(destination, header.mtime, header.mtime);
          }

          await applyOwnership(destination, options.ownership);
          restored += 1;
        } else {
          // Les liens symboliques d'une archive ne sont pas recréés : rien ne
          // garantit que leur cible reste dans le volume, et un lien vers
          // `/etc/shadow` rendu lisible par le SFTP annulerait le jail.
          stream.resume();
        }

        next();
      } catch (error) {
        extractor.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  await pipeline(createReadStream(options.archivePath), decompressor(compression), extractor);

  return restored;
}

/**
 * Donne le fichier à l'utilisateur du conteneur.
 *
 * Un échec n'interrompt pas la restauration : sur un système de fichiers qui ne
 * gère pas les propriétaires, perdre l'appartenance vaut mieux que perdre la
 * restauration entière.
 */
async function applyOwnership(
  path: string,
  ownership: { uid: number; gid: number } | undefined,
): Promise<void> {
  if (!ownership) {
    return;
  }

  await chown(path, ownership.uid, ownership.gid).catch(() => undefined);
}

/** SHA-256 d'un fichier, lu en flux. */
export async function checksumOf(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

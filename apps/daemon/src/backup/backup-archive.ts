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
 * Producing and restoring backup archives.
 *
 * Two properties govern this file.
 *
 * **Everything streams.** A Minecraft world routinely exceeds several
 * gigabytes; nothing is ever loaded into memory, and the SHA-256 digest is
 * computed on the way through rather than by reading the produced file again.
 *
 * **The archive lives outside the volume.** Putting it inside would place it
 * under the file manager and SFTP: any subuser holding `file.delete` could
 * erase the backups, and the next backup would archive itself.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Compression to use.
 *
 * zstd is markedly faster than gzip at a comparable ratio, but only exists in
 * `node:zlib` from Node 22.15 on. Rather than mandate that version, its
 * presence is probed and the format is written into the file name: an archive
 * produced on one host stays restorable on another.
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

/** Infers an archive's format from its extension. */
export function compressionOf(archivePath: string): BackupCompression {
  const normalized = archivePath.replace(/\\/g, '/');

  for (const [compression, extension] of Object.entries(BACKUP_EXTENSIONS)) {
    if (normalized.endsWith(extension)) {
      return compression as BackupCompression;
    }
  }

  throw new BackupError(`Unknown archive format: ${archivePath}`);
}

export interface BackupArchiveResult {
  sizeBytes: number;
  checksum: string;
  fileCount: number;
}

export interface CreateBackupOptions {
  /** Volume root, as the daemon knows it. */
  volumePath: string;
  /** Destination of the archive, outside the volume. */
  archivePath: string;
  ignoredFiles: readonly string[];
  compression: BackupCompression;
}

/**
 * Archives a server's volume.
 *
 * Symlinks are archived **as links**, without being followed: following a link
 * pointing outside the volume would pull host files into the backup, and a link
 * pointing at a parent would produce an infinite archive.
 */
export async function createBackupArchive(
  options: CreateBackupOptions,
): Promise<BackupArchiveResult> {
  const ignore = new IgnoreList([...ALWAYS_IGNORED, ...options.ignoredFiles]);
  const packer = pack();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let fileCount = 0;

  // The digest covers the **compressed** archive, the one that will be read
  // back on restore. Computing it on the uncompressed stream would not catch a
  // corruption that happened after compression.
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      done(null, chunk);
    },
  });

  await mkdir(dirname(options.archivePath), { recursive: true });

  // The pipeline's rejection is attached **immediately**, before any `await`
  // that could fail. Destroying the packer on error rejects this promise with
  // `ERR_STREAM_PREMATURE_CLOSE`; if nobody is listening yet, Node treats it as
  // an unhandled rejection and ends the process — the whole daemon falls over
  // for one missed backup.
  let writeError: Error | undefined;
  const written = pipeline(
    packer,
    compressor(options.compression),
    measure,
    createWriteStream(options.archivePath),
  ).catch((error: unknown) => {
    writeError =
      error instanceof Error ? error : new BackupError('Archive write interrupted.');
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
    // A partial archive is worse than none: it would be offered for restore
    // and would only fail at extraction time, on an already-emptied volume.
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

  // Iterative walk: recursing over the tree of a well-filled server can hit
  // the stack limit, and the crash would be blamed on the backup rather than on
  // the depth of the tree.
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
        // Sockets, named pipes, devices: none of that makes sense in a backup,
        // and `tar-stream` would not know what to do with them.
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
  /** Empty the volume before extracting. */
  truncate: boolean;
  /** Expected digest; extraction is not attempted without a match. */
  expectedChecksum?: string;
  /**
   * Container user, who owns the restored files.
   *
   * Without this, the extraction — done by the daemon, so by root — produces a
   * volume the server can no longer write to: it starts, then fails to save its
   * world, on an error that never mentions the restore. Ownership is
   * deliberately not read back from the archive: a backup can be restored on a
   * node whose container user carries a different identifier.
   *
   * Absent on Windows, where `chown` makes no sense.
   */
  ownership?: { uid: number; gid: number };
}

/**
 * Restores an archive into a server's volume.
 *
 * The digest is checked **before** anything is written. A corrupt archive
 * detected mid-extraction would leave a half-overwritten volume — that is, a
 * server destroyed by the operation meant to save it.
 */
export async function restoreBackupArchive(options: RestoreBackupOptions): Promise<number> {
  const compression = compressionOf(options.archivePath);

  if (options.expectedChecksum) {
    const actual = await checksumOf(options.archivePath);

    if (actual !== options.expectedChecksum) {
      throw new BackupError(
        'The archive does not match its digest: restore refused so as not to ' +
          'overwrite the server with corrupt data.',
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
        // `resolveArchiveEntry` is what forbids the zip slip: the jail decides
        // where the entry goes, never the name it carries.
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
          // Symlinks from an archive are not recreated: nothing guarantees
          // their target stays inside the volume, and a link to `/etc/shadow`
          // made readable over SFTP would undo the jail.
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
 * Hands the file over to the container user.
 *
 * A failure does not interrupt the restore: on a filesystem with no notion of
 * owners, losing ownership beats losing the whole restore.
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

/** SHA-256 of a file, read as a stream. */
export async function checksumOf(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

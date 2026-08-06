import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { extract, pack } from 'tar-stream';
import type { JailedFilesystem } from './jailed-filesystem.js';

/**
 * Compressing and extracting archives, under the jail's control.
 *
 * `tar-stream` is used rather than a higher-level library precisely because it
 * **writes nothing on its own**: every entry is handed to us and we decide
 * where it goes. Turnkey extractors write the entry where its name says, which
 * makes the zip-slip attack trivial — an entry named
 * `../../etc/cron.d/backdoor` lands in `/etc/cron.d`.
 */

/**
 * Largest number of entries extracted from an archive.
 *
 * An archive of a few kilobytes can hold millions of empty entries: that is the
 * "decompression bomb", which fills the host's inode table without ever
 * exceeding the volume's size limit.
 */
const MAX_ARCHIVE_ENTRIES = 100_000;

/** Largest total extracted size, across all files. */
const MAX_EXTRACTED_BYTES = 8 * 1024 ** 3;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** Creates a `.tar.gz` archive from a list of paths. */
export async function createArchive(
  jail: JailedFilesystem,
  files: string[],
  archivePath: string,
): Promise<void> {
  const destination = await jail.absolutePathFor(archivePath);

  // The jail opens the destination itself and hands back a stream over that
  // descriptor. Building a `createWriteStream(destination)` here would look the
  // name up a second time, and the server owner — who has a shell in their own
  // container — only has to drop a symlink on that name in between for the
  // archive to be written wherever the link points, by a daemon running as
  // root.
  const sink = await jail.createWriteStream(destination);
  const packer = pack();

  // The rejection is attached in the same turn as the pipeline, before the
  // first `await` that can fail. Destroying the packer below rejects this
  // promise, and a rejection nobody is listening for yet is what Node turns
  // into a process exit — the whole node would fall over for one refused
  // source path.
  let writeError: Error | undefined;
  const written = pipeline(packer, createGzip(), sink).catch((error: unknown) => {
    writeError = error instanceof Error ? error : new ArchiveError('Archive write interrupted.');
  });

  try {
    for (const file of files) {
      await addToArchive(jail, packer, file);
    }

    packer.finalize();
    await written;

    if (writeError) {
      throw writeError;
    }
  } catch (error) {
    // Tearing the pipeline down is what closes the descriptor the jail opened:
    // it belongs to no caller now, so nothing else would ever close it. A user
    // asking to compress `../secret` is refused on the first entry, and without
    // this the daemon would leak one descriptor per attempt.
    packer.destroy();
    await written;
    throw error;
  }
}

async function addToArchive(
  jail: JailedFilesystem,
  packer: ReturnType<typeof pack>,
  userPath: string,
): Promise<void> {
  const entry = await jail.stat(userPath);

  if (entry.symlink) {
    // A link pointing outside would carry its content out of the volume by way
    // of the archive, then of a download.
    return;
  }

  if (entry.directory) {
    for (const child of await jail.list(userPath)) {
      await addToArchive(jail, packer, child.path);
    }
    return;
  }

  const absolute = await jail.absolutePathFor(userPath);

  // The `stat` above says this was a regular file when it was looked at; the
  // jail's open says it still is at the instant it is read. The gap between the
  // two belongs to the server owner, who can drop a link on the name from their
  // own console — and an archive is downloadable, so a link followed here
  // carries `/etc/shadow` out of the volume in one step.
  const source = await jail.createReadStream(absolute);

  await pipeline(source, packer.entry({ name: entry.path, size: entry.sizeBytes }));
}

/**
 * Extracts a `.tar.gz` archive into a folder.
 *
 * Every entry goes through `jail.resolveArchiveEntry`, which refuses any
 * destination outside the requested folder. Symlinks held in the archive are
 * ignored: recreating a link to `/etc` would give the user, on their next
 * access, a read outside the volume.
 */
export async function extractArchive(
  jail: JailedFilesystem,
  archivePath: string,
  destination: string,
): Promise<{ entries: number; bytes: number }> {
  const absolute = await jail.absolutePathFor(archivePath);
  const extractor = extract();

  let entries = 0;
  let bytes = 0;

  extractor.on('entry', (header, stream, next) => {
    void (async () => {
      try {
        entries += 1;

        if (entries > MAX_ARCHIVE_ENTRIES) {
          throw new ArchiveError(
            `Archive refused: more than ${MAX_ARCHIVE_ENTRIES} entries. A legitimate archive rarely holds that many.`,
          );
        }

        bytes += header.size ?? 0;

        if (bytes > MAX_EXTRACTED_BYTES) {
          throw new ArchiveError(
            'Archive refused: the decompressed content exceeds the allowed size.',
          );
        }

        // Checked per entry rather than once up front: a tar announces nothing
        // about its total, and the ceiling above is a bomb guard shared by
        // every server, not this one's allowance.
        jail.assertRoomFor(bytes);

        // Neither symlink, nor hard link, nor device: only files and folders
        // are extracted.
        if (header.type !== 'file' && header.type !== 'directory') {
          stream.resume();
          stream.on('end', next);
          return;
        }

        const target = await jail.resolveArchiveEntry(destination, header.name);

        if (header.type === 'directory') {
          await mkdir(target, { recursive: true });
          stream.resume();
          stream.on('end', next);
          return;
        }

        await mkdir(dirname(target), { recursive: true });

        // `resolveArchiveEntry` reduces the entry name and checks where it
        // lands, but it walks no links: a name that is already a symlink in the
        // volume passes both containment checks, being exactly where it should
        // be. Opening through the jail is what refuses it — the stream comes
        // from a descriptor opened with `O_NOFOLLOW`, so an archive entry can
        // never overwrite the target of a link the server planted beforehand.
        const sink = await jail.createWriteStream(target);
        await pipeline(stream, sink);
        next();
      } catch (error) {
        extractor.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  // Awaited before the pipeline rather than built inside it: the jail opens the
  // archive itself, so the file the extraction reads is the one the path check
  // approved, not whatever the name points at by the time the stream starts
  // pulling. An extraction reading through a link would decompress a host file
  // into the volume, where its owner can then read it at leisure.
  const source = await jail.createReadStream(absolute);

  await pipeline(source, createGunzip(), extractor);

  return { entries, bytes };
}

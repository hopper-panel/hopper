import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { extract, pack } from 'tar-stream';
import type { JailedFilesystem } from './jailed-filesystem.js';

/**
 * Compression et extraction d'archives, sous contrôle du jail.
 *
 * `tar-stream` est utilisé plutôt qu'une bibliothèque de plus haut niveau
 * précisément parce qu'il **n'écrit rien tout seul** : chaque entrée nous est
 * remise et c'est nous qui décidons où elle va. Les extracteurs « clés en main »
 * écrivent l'entrée là où son nom l'indique, ce qui rend l'attaque zip-slip
 * triviale — une entrée nommée `../../etc/cron.d/backdoor` atterrit dans
 * `/etc/cron.d`.
 */

/**
 * Nombre maximal d'entrées extraites d'une archive.
 *
 * Une archive de quelques kilooctets peut contenir des millions d'entrées
 * vides : c'est la « bombe de décompression », qui remplit la table d'inodes
 * de l'hôte sans jamais dépasser la limite de taille du volume.
 */
const MAX_ARCHIVE_ENTRIES = 100_000;

/** Taille maximale extraite, tous fichiers confondus. */
const MAX_EXTRACTED_BYTES = 8 * 1024 ** 3;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** Crée une archive `.tar.gz` à partir d'une liste de chemins. */
export async function createArchive(
  jail: JailedFilesystem,
  files: string[],
  archivePath: string,
): Promise<void> {
  const destination = await jail.absolutePathFor(archivePath);
  const packer = pack();

  const output = pipeline(packer, createGzip(), createWriteStream(destination));

  for (const file of files) {
    await addToArchive(jail, packer, file);
  }

  packer.finalize();
  await output;
}

async function addToArchive(
  jail: JailedFilesystem,
  packer: ReturnType<typeof pack>,
  userPath: string,
): Promise<void> {
  const entry = await jail.stat(userPath);

  if (entry.symlink) {
    // Un lien vers l'extérieur ferait sortir son contenu du volume par le biais
    // de l'archive, puis d'un téléchargement.
    return;
  }

  if (entry.directory) {
    for (const child of await jail.list(userPath)) {
      await addToArchive(jail, packer, child.path);
    }
    return;
  }

  const absolute = await jail.absolutePathFor(userPath);

  await pipeline(
    createReadStream(absolute),
    packer.entry({ name: entry.path, size: entry.sizeBytes }),
  );
}

/**
 * Extrait une archive `.tar.gz` dans un dossier.
 *
 * Chaque entrée passe par `jail.resolveArchiveEntry`, qui refuse toute
 * destination hors du dossier demandé. Les liens symboliques contenus dans
 * l'archive sont ignorés : recréer un lien vers `/etc` donnerait à
 * l'utilisateur, au prochain accès, une lecture hors du volume.
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
            `Archive refusée : plus de ${MAX_ARCHIVE_ENTRIES} entrées. Une archive légitime en contient rarement autant.`,
          );
        }

        bytes += header.size ?? 0;

        if (bytes > MAX_EXTRACTED_BYTES) {
          throw new ArchiveError(
            'Archive refusée : le contenu décompressé dépasse la taille autorisée.',
          );
        }

        // Ni lien symbolique, ni lien physique, ni périphérique : seuls les
        // fichiers et les dossiers sont extraits.
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
        await pipeline(stream, createWriteStream(target));
        next();
      } catch (error) {
        extractor.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  await pipeline(createReadStream(absolute), createGunzip(), extractor);

  return { entries, bytes };
}

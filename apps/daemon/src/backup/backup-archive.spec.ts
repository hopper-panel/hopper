import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JailedFilesystem } from '../fs/jailed-filesystem.js';
import {
  BackupError,
  checksumOf,
  compressionOf,
  createBackupArchive,
  detectCompression,
  restoreBackupArchive,
} from './backup-archive.js';

/**
 * Synchronous probe, at module level.
 *
 * `describe.runIf` is evaluated when the tests are collected, before any
 * `beforeAll`: an asynchronous probe would arrive too late and the tests would
 * be silently skipped everywhere.
 */
const symlinkSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hopper-backup-symlink-probe-'));

  try {
    mkdirSync(join(probe, 'target'));
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let workspace: string;
let volume: string;
let archives: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hopper-backup-'));
  volume = join(workspace, 'volume');
  archives = join(workspace, 'archives');
  await mkdir(volume, { recursive: true });
  await mkdir(archives, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function jailFor(root: string): JailedFilesystem {
  return new JailedFilesystem({ root });
}

async function seedVolume(): Promise<void> {
  await writeFile(join(volume, 'server.properties'), 'motd=Hopper\n');
  await mkdir(join(volume, 'world'), { recursive: true });
  await writeFile(join(volume, 'world', 'level.dat'), 'world-data');
  await mkdir(join(volume, 'logs'), { recursive: true });
  await writeFile(join(volume, 'logs', 'latest.log'), 'x'.repeat(4096));
}

describe('detectCompression', () => {
  // The format is not fixed: it depends on the Node version. What matters is
  // that it is written into the file name — an archive produced before an
  // upgrade has to stay restorable afterwards.
  it('keeps a known format', () => {
    expect(['gzip', 'zstd']).toContain(detectCompression());
  });
});

describe('compressionOf', () => {
  it('infers the format from the extension', () => {
    expect(compressionOf('/var/lib/hopper/backups/abc.tar.gz')).toBe('gzip');
    expect(compressionOf('/var/lib/hopper/backups/abc.tar.zst')).toBe('zstd');
  });

  // Refuse rather than guess: opening an archive with the wrong decompressor
  // produces an unreadable stream error, long after writing into the volume has
  // begun.
  it('rejects an unknown extension', () => {
    expect(() => compressionOf('/backups/abc.zip')).toThrow(BackupError);
  });
});

describe('createBackupArchive', () => {
  it('archives the volume and returns a verifiable digest', async () => {
    await seedVolume();
    const archivePath = join(
      archives,
      `a${detectCompression() === 'zstd' ? '.tar.zst' : '.tar.gz'}`,
    );

    const result = await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: [],
      compression: detectCompression(),
    });

    expect(result.fileCount).toBe(3);
    expect(result.sizeBytes).toBeGreaterThan(0);
    // The digest covers the archive as it will be read back: it is the only one
    // that catches a corruption occurring after compression.
    expect(await checksumOf(archivePath)).toBe(result.checksum);
  });

  it('applies the ignore list', async () => {
    await seedVolume();
    const archivePath = join(archives, 'b.tar.gz');

    const result = await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: ['*.log'],
      compression: 'gzip',
    });

    expect(result.fileCount).toBe(2);
  });

  // A truncated archive is worse than no archive: the panel would present it as
  // restorable and the failure would only appear at extraction time, on an
  // already-emptied volume.
  //
  // This test also guards a second, less visible property: it revealed an
  // unattached rejection on the write stream. Destroying the packer rejected the
  // pipeline with nobody listening, which Node treats as an unhandled rejection
  // — the whole daemon fell over for one missed backup. Vitest fails the run on
  // such a rejection: if the guard disappears, this test goes red again.
  it('leaves no partial archive behind a failure', async () => {
    const archivePath = join(archives, 'c.tar.gz');

    await expect(
      createBackupArchive({
        volumePath: join(workspace, 'inexistant'),
        archivePath,
        ignoredFiles: [],
        compression: 'gzip',
      }),
    ).rejects.toThrow();

    await expect(readFile(archivePath)).rejects.toThrow();
  });

  it('archives an empty tree without failing', async () => {
    const archivePath = join(archives, 'd.tar.gz');

    const result = await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: [],
      compression: 'gzip',
    });

    expect(result.fileCount).toBe(0);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('restoreBackupArchive', () => {
  async function archiveVolume(name: string, ignored: string[] = []): Promise<string> {
    const archivePath = join(archives, name);
    await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: ignored,
      compression: 'gzip',
    });
    return archivePath;
  }

  it('puts the files back into the volume', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('e.tar.gz');

    const target = join(workspace, 'restore');
    await mkdir(target, { recursive: true });

    const restored = await restoreBackupArchive({
      jail: jailFor(target),
      archivePath,
      truncate: true,
    });

    expect(restored).toBe(3);
    expect(await readFile(join(target, 'world', 'level.dat'), 'utf8')).toBe('world-data');
  });

  // Restoring means going back to the state that was saved. Without a purge, a
  // file created after the backup would survive, and the resulting state would
  // be that of no real moment.
  it('empties the volume when asked to', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('f.tar.gz');

    await writeFile(join(volume, 'ajoute-apres.txt'), 'parasite');

    await restoreBackupArchive({ jail: jailFor(volume), archivePath, truncate: true });

    await expect(readFile(join(volume, 'ajoute-apres.txt'))).rejects.toThrow();
    expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('motd=Hopper\n');
  });

  it('overlays without purging when truncate is false', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('g.tar.gz');

    await writeFile(join(volume, 'ajoute-apres.txt'), 'a garder');

    await restoreBackupArchive({ jail: jailFor(volume), archivePath, truncate: false });

    expect(await readFile(join(volume, 'ajoute-apres.txt'), 'utf8')).toBe('a garder');
  });

  // The case that matters: a corrupt archive must not start writing. Detecting
  // the corruption mid-extraction would leave a half-overwritten volume — a
  // server destroyed by the operation meant to save it.
  it('refuses an archive whose digest does not match', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('h.tar.gz');

    const jail = jailFor(volume);
    await expect(
      restoreBackupArchive({
        jail,
        archivePath,
        truncate: true,
        expectedChecksum: 'f'.repeat(64),
      }),
    ).rejects.toThrow(BackupError);

    // The volume is intact: nothing was purged.
    expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('motd=Hopper\n');
  });

  it('accepts an archive whose digest matches', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('i.tar.gz');
    const checksum = await checksumOf(archivePath);

    await expect(
      restoreBackupArchive({
        jail: jailFor(volume),
        archivePath,
        truncate: true,
        expectedChecksum: checksum,
      }),
    ).resolves.toBeGreaterThan(0);
  });
});

describe.runIf(symlinkSupported)('symbolic links', () => {
  // Following a link would pull host files into the backup — a link to `/etc`
  // would be enough — and a link to a parent would produce an archive that
  // never ends.
  it('archives the link, without following its target', async () => {
    await writeFile(join(volume, 'reel.txt'), 'contenu');
    await symlink(join(volume, 'reel.txt'), join(volume, 'lien.txt'));

    const archivePath = join(archives, 'lien.tar.gz');
    const result = await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: [],
      compression: 'gzip',
    });

    // Two entries: the file and the link — not the file twice.
    expect(result.fileCount).toBe(2);
  });

  // A restored link pointing outside the volume would make any host file
  // readable through the file manager and SFTP: the jail bypassed by an
  // archive.
  it('does not recreate links on restore', async () => {
    await writeFile(join(volume, 'reel.txt'), 'contenu');
    await symlink('/etc/shadow', join(volume, 'evasion.txt'));

    const archivePath = join(archives, 'evasion.tar.gz');
    await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: [],
      compression: 'gzip',
    });

    const target = join(workspace, 'restore-lien');
    await mkdir(target, { recursive: true });
    await restoreBackupArchive({ jail: jailFor(target), archivePath, truncate: true });

    expect(await readFile(join(target, 'reel.txt'), 'utf8')).toBe('contenu');
    await expect(lstat(join(target, 'evasion.txt'))).rejects.toThrow();
  });
});

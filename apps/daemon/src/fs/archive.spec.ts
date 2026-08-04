import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArchive, extractArchive } from './archive.js';
import { JailedFilesystem, PathEscapeError } from './jailed-filesystem.js';

/**
 * Builds a `.tar.gz` archive with arbitrary entry names.
 *
 * That is the point: a hostile archive is not produced by a normal tool. One
 * has to be built by hand to check that extraction refuses what no ordinary
 * `tar` would produce.
 */
async function buildArchive(
  destination: string,
  entries: { name: string; content?: string; type?: 'file' | 'directory' | 'symlink' }[],
): Promise<void> {
  const packer = pack();
  const done = pipeline(packer, createGzip(), createWriteStream(destination));

  for (const entry of entries) {
    const content = entry.content ?? '';

    if (entry.type === 'directory') {
      packer.entry({ name: entry.name, type: 'directory' });
    } else if (entry.type === 'symlink') {
      packer.entry({ name: entry.name, type: 'symlink', linkname: '/etc/passwd' });
    } else {
      packer.entry({ name: entry.name, size: content.length }, content);
    }
  }

  packer.finalize();
  await done;
}

describe('archives', () => {
  let sandbox: string;
  let volume: string;
  let outside: string;
  let jail: JailedFilesystem;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-archive-'));
    volume = join(sandbox, 'volume');
    outside = join(sandbox, 'secret');

    await mkdir(volume, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(join(volume, 'plugins'), { recursive: true });
    await writeFile(join(volume, 'server.properties'), 'server-port=25565');
    await writeFile(join(volume, 'plugins', 'config.yml'), 'debug: false');

    jail = new JailedFilesystem({ root: volume });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  describe('creation', () => {
    it('archives files and folders', async () => {
      await createArchive(jail, ['server.properties', 'plugins'], 'sauvegarde.tar.gz');

      const entry = await jail.stat('sauvegarde.tar.gz');
      expect(entry.sizeBytes).toBeGreaterThan(0);
    });

    it('refuses a source outside the volume', async () => {
      await expect(createArchive(jail, ['../secret'], 'x.tar.gz')).rejects.toThrow(PathEscapeError);
    });

    it('refuses a destination outside the volume', async () => {
      await expect(createArchive(jail, ['server.properties'], '../evasion.tar.gz')).rejects.toThrow(
        PathEscapeError,
      );
    });
  });

  describe('extraction', () => {
    it('extrait une archive normale', async () => {
      await buildArchive(join(volume, 'normale.tar.gz'), [
        { name: 'plugins/nouveau.yml', content: 'ok: true' },
      ]);

      const result = await extractArchive(jail, 'normale.tar.gz', '.');

      expect(result.entries).toBe(1);
      expect(await readFile(join(volume, 'plugins', 'nouveau.yml'), 'utf8')).toBe('ok: true');
    });

    // The "zip slip": many extraction libraries write this entry where its name
    // says, that is, outside the volume.
    it('refuses an entry that climbs out of the volume', async () => {
      await buildArchive(join(volume, 'hostile.tar.gz'), [
        { name: '../../secret/backdoor.sh', content: 'rm -rf /' },
      ]);

      await expect(extractArchive(jail, 'hostile.tar.gz', '.')).rejects.toThrow();

      await expect(readFile(join(outside, 'backdoor.sh'), 'utf8')).rejects.toThrow();
    });

    it('refuses an entry that leaves the requested destination', async () => {
      await buildArchive(join(volume, 'hostile2.tar.gz'), [
        { name: '../server.properties', content: 'server-port=1337' },
      ]);

      await expect(extractArchive(jail, 'hostile2.tar.gz', 'plugins')).rejects.toThrow();

      // The original file was not overwritten.
      expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('server-port=25565');
    });

    // Recreating a link to /etc would give, on the next access, a read outside
    // the volume — the jail would refuse, but better not to create the link.
    it('ignores the symlinks held in an archive', async () => {
      await buildArchive(join(volume, 'liens.tar.gz'), [
        { name: 'evasion', type: 'symlink' },
        { name: 'normal.txt', content: 'ok' },
      ]);

      await extractArchive(jail, 'liens.tar.gz', '.');

      const names = (await jail.list('.')).map((entry) => entry.name);
      expect(names).toContain('normal.txt');
      expect(names).not.toContain('evasion');
    });

    it('creates the declared folders', async () => {
      await buildArchive(join(volume, 'dossiers.tar.gz'), [
        { name: 'monde/region', type: 'directory' },
        { name: 'monde/region/r.0.0.mca', content: 'donnees' },
      ]);

      await extractArchive(jail, 'dossiers.tar.gz', '.');

      expect((await jail.stat('monde/region')).directory).toBe(true);
    });

    it('refuse une archive absente', async () => {
      await expect(extractArchive(jail, 'absente.tar.gz', '.')).rejects.toThrow();
    });
  });

  describe('aller-retour', () => {
    it('restores the content byte for byte', async () => {
      await createArchive(jail, ['plugins'], 'rt.tar.gz');
      await jail.delete(['plugins']);
      await extractArchive(jail, 'rt.tar.gz', '.');

      expect(await readFile(join(volume, 'plugins', 'config.yml'), 'utf8')).toBe('debug: false');
    });
  });
});

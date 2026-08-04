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
 * Fabrique une archive `.tar.gz` avec des noms d'entrées arbitraires.
 *
 * C'est le point : une archive hostile n'est pas produite par un outil normal.
 * Il faut donc en construire une à la main pour vérifier que l'extraction
 * refuse ce qu'aucun `tar` ordinaire ne produirait.
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

  describe('création', () => {
    it('archive des fichiers et des dossiers', async () => {
      await createArchive(jail, ['server.properties', 'plugins'], 'sauvegarde.tar.gz');

      const entry = await jail.stat('sauvegarde.tar.gz');
      expect(entry.sizeBytes).toBeGreaterThan(0);
    });

    it('refuse une source hors du volume', async () => {
      await expect(createArchive(jail, ['../secret'], 'x.tar.gz')).rejects.toThrow(PathEscapeError);
    });

    it('refuse une destination hors du volume', async () => {
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

    // Le « zip-slip » : beaucoup de bibliothèques d'extraction écrivent cette
    // entrée là où son nom l'indique, c'est-à-dire hors du volume.
    it('refuse une entrée qui remonte hors du volume', async () => {
      await buildArchive(join(volume, 'hostile.tar.gz'), [
        { name: '../../secret/backdoor.sh', content: 'rm -rf /' },
      ]);

      await expect(extractArchive(jail, 'hostile.tar.gz', '.')).rejects.toThrow();

      await expect(readFile(join(outside, 'backdoor.sh'), 'utf8')).rejects.toThrow();
    });

    it('refuse une entrée qui sort de la destination demandée', async () => {
      await buildArchive(join(volume, 'hostile2.tar.gz'), [
        { name: '../server.properties', content: 'server-port=1337' },
      ]);

      await expect(extractArchive(jail, 'hostile2.tar.gz', 'plugins')).rejects.toThrow();

      // Le fichier d'origine n'a pas été écrasé.
      expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('server-port=25565');
    });

    // Recréer un lien vers /etc donnerait, au prochain accès, une lecture hors
    // du volume — le jail refuserait, mais autant ne pas créer le lien.
    it('ignore les liens symboliques contenus dans une archive', async () => {
      await buildArchive(join(volume, 'liens.tar.gz'), [
        { name: 'evasion', type: 'symlink' },
        { name: 'normal.txt', content: 'ok' },
      ]);

      await extractArchive(jail, 'liens.tar.gz', '.');

      const names = (await jail.list('.')).map((entry) => entry.name);
      expect(names).toContain('normal.txt');
      expect(names).not.toContain('evasion');
    });

    it('crée les dossiers déclarés', async () => {
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
    it('restitue le contenu à l’identique', async () => {
      await createArchive(jail, ['plugins'], 'rt.tar.gz');
      await jail.delete(['plugins']);
      await extractArchive(jail, 'rt.tar.gz', '.');

      expect(await readFile(join(volume, 'plugins', 'config.yml'), 'utf8')).toBe('debug: false');
    });
  });
});

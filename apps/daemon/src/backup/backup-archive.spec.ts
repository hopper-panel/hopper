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
 * Sonde synchrone, au niveau du module.
 *
 * `describe.runIf` est évalué au moment de la collecte des tests, avant tout
 * `beforeAll` : une sonde asynchrone arriverait trop tard et les tests seraient
 * silencieusement ignorés partout.
 */
const symlinkSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hopper-backup-symlink-probe-'));

  try {
    mkdirSync(join(probe, 'cible'));
    symlinkSync(join(probe, 'cible'), join(probe, 'lien'), 'dir');
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
  await writeFile(join(volume, 'world', 'level.dat'), 'donnees-du-monde');
  await mkdir(join(volume, 'logs'), { recursive: true });
  await writeFile(join(volume, 'logs', 'latest.log'), 'x'.repeat(4096));
}

describe('detectCompression', () => {
  // Le format n'est pas figé : il dépend de la version de Node. Ce qui compte,
  // c'est qu'il soit inscrit dans le nom du fichier — une archive produite
  // avant une mise à jour doit rester restaurable après.
  it('retient un format connu', () => {
    expect(['gzip', 'zstd']).toContain(detectCompression());
  });
});

describe('compressionOf', () => {
  it('déduit le format de l’extension', () => {
    expect(compressionOf('/var/lib/hopper/backups/abc.tar.gz')).toBe('gzip');
    expect(compressionOf('/var/lib/hopper/backups/abc.tar.zst')).toBe('zstd');
  });

  // Refuser plutôt que deviner : ouvrir une archive avec le mauvais
  // décompresseur produit une erreur de flux illisible, bien après avoir
  // commencé à écrire dans le volume.
  it('refuse une extension inconnue', () => {
    expect(() => compressionOf('/backups/abc.zip')).toThrow(BackupError);
  });
});

describe('createBackupArchive', () => {
  it('archive le volume et rend une empreinte vérifiable', async () => {
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
    // L'empreinte porte sur l'archive telle qu'elle sera relue : c'est la seule
    // qui détecte une corruption survenue après la compression.
    expect(await checksumOf(archivePath)).toBe(result.checksum);
  });

  it('applique la liste d’exclusion', async () => {
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

  // Une archive tronquée est pire que pas d'archive : le panel la présenterait
  // comme restaurable et l'échec n'apparaîtrait qu'au moment d'extraire, sur un
  // volume déjà vidé.
  //
  // Ce test garde aussi une seconde propriété, moins visible : il a révélé un
  // rejet non rattaché sur le flux d'écriture. Détruire le paquetage faisait
  // rejeter le pipeline sans que personne n'écoute, ce que Node traite en
  // « unhandled rejection » — le daemon entier tombait pour une sauvegarde
  // manquée. Vitest fait échouer la campagne sur un tel rejet : si la parade
  // disparaît, ce test redevient rouge.
  it('ne laisse pas d’archive partielle derrière un échec', async () => {
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

  it('archive une arborescence vide sans échouer', async () => {
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

  it('rétablit les fichiers dans le volume', async () => {
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
    expect(await readFile(join(target, 'world', 'level.dat'), 'utf8')).toBe('donnees-du-monde');
  });

  // Restaurer, c'est revenir à l'état sauvegardé. Sans purge, un fichier créé
  // après la sauvegarde survivrait, et l'état obtenu ne serait celui d'aucun
  // instant réel.
  it('vide le volume quand on le lui demande', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('f.tar.gz');

    await writeFile(join(volume, 'ajoute-apres.txt'), 'parasite');

    await restoreBackupArchive({ jail: jailFor(volume), archivePath, truncate: true });

    await expect(readFile(join(volume, 'ajoute-apres.txt'))).rejects.toThrow();
    expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('motd=Hopper\n');
  });

  it('superpose sans purger quand truncate est faux', async () => {
    await seedVolume();
    const archivePath = await archiveVolume('g.tar.gz');

    await writeFile(join(volume, 'ajoute-apres.txt'), 'a garder');

    await restoreBackupArchive({ jail: jailFor(volume), archivePath, truncate: false });

    expect(await readFile(join(volume, 'ajoute-apres.txt'), 'utf8')).toBe('a garder');
  });

  // Le cas qui compte : une archive corrompue ne doit pas commencer à écrire.
  // Détecter la corruption en cours d'extraction laisserait un volume à moitié
  // écrasé — un serveur détruit par l'opération censée le sauver.
  it('refuse une archive dont l’empreinte ne correspond pas', async () => {
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

    // Le volume est intact : rien n'a été purgé.
    expect(await readFile(join(volume, 'server.properties'), 'utf8')).toBe('motd=Hopper\n');
  });

  it('accepte une archive dont l’empreinte correspond', async () => {
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

describe.runIf(symlinkSupported)('liens symboliques', () => {
  // Suivre un lien ferait entrer dans la sauvegarde des fichiers de l'hôte —
  // un lien vers `/etc` suffirait — et un lien vers un parent produirait une
  // archive qui ne se termine jamais.
  it('archive le lien, sans suivre sa cible', async () => {
    await writeFile(join(volume, 'reel.txt'), 'contenu');
    await symlink(join(volume, 'reel.txt'), join(volume, 'lien.txt'));

    const archivePath = join(archives, 'lien.tar.gz');
    const result = await createBackupArchive({
      volumePath: volume,
      archivePath,
      ignoredFiles: [],
      compression: 'gzip',
    });

    // Deux entrées : le fichier et le lien — pas le fichier deux fois.
    expect(result.fileCount).toBe(2);
  });

  // Un lien restauré pointant hors du volume rendrait n'importe quel fichier de
  // l'hôte lisible par le gestionnaire de fichiers et le SFTP : ce serait le
  // jail contourné par une archive.
  it('ne recrée pas les liens à la restauration', async () => {
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

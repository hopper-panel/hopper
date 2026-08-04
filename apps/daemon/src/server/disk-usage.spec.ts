import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directorySize } from './disk-usage.js';

/**
 * Sonde synchrone au niveau du module : `it.runIf` est évalué à la collecte des
 * tests, avant tout `beforeAll`. Windows refuse les liens symboliques sans
 * élévation ; l'intégration continue, sous Linux, les exécute.
 */
const symlinkSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hopper-symlink-probe-'));

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

describe('directorySize', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-disk-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('additionne les fichiers de toute l’arborescence', async () => {
    await writeFile(join(sandbox, 'server.jar'), 'x'.repeat(500));
    await mkdir(join(sandbox, 'world', 'region'), { recursive: true });
    await writeFile(join(sandbox, 'world', 'level.dat'), 'y'.repeat(120));
    await writeFile(join(sandbox, 'world', 'region', 'r.0.0.mca'), 'z'.repeat(4096));

    expect(await directorySize(sandbox)).toBe(4716);
  });

  it('rend zéro pour un volume vide', async () => {
    expect(await directorySize(sandbox)).toBe(0);
  });

  it('rend zéro plutôt que d’échouer sur un volume absent', async () => {
    expect(await directorySize(join(sandbox, 'jamais-créé'))).toBe(0);
  });

  it.runIf(symlinkSupported)('ne compte pas la cible d’un lien symbolique', async () => {
    const dehors = join(sandbox, 'dehors');
    await mkdir(dehors);
    await writeFile(join(dehors, 'gros'), 'x'.repeat(10_000));

    const volume = join(sandbox, 'volume');
    await mkdir(volume);
    await writeFile(join(volume, 'server.properties'), 'x'.repeat(100));
    await symlink(join(dehors, 'gros'), join(volume, 'lien'));

    // Le fichier visé pèse cent fois le contenu réel du volume : le suivre
    // ferait passer le serveur pour saturé, et un joueur pourrait fabriquer ce
    // lien lui-même par SFTP.
    expect(await directorySize(volume)).toBe(100);
  });

  it.runIf(symlinkSupported)(
    'ne boucle pas sur un lien de répertoire pointant vers son parent',
    async () => {
      const volume = join(sandbox, 'volume');
      await mkdir(join(volume, 'plugins'), { recursive: true });
      await writeFile(join(volume, 'plugins', 'essentials.jar'), 'x'.repeat(64));
      await symlink(volume, join(volume, 'plugins', 'retour'), 'dir');

      expect(await directorySize(volume)).toBe(64);
    },
  );
});

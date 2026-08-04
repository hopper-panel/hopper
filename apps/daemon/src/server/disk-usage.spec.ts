import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directorySize } from './disk-usage.js';

/**
 * Synchronous probe at module level: `it.runIf` is evaluated when the tests are
 * collected, before any `beforeAll`. Windows refuses symlinks without
 * elevation; continuous integration, on Linux, runs them.
 */
const symlinkSupported = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'hopper-symlink-probe-'));

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

describe('directorySize', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-disk-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('adds up the files of the whole tree', async () => {
    await writeFile(join(sandbox, 'server.jar'), 'x'.repeat(500));
    await mkdir(join(sandbox, 'world', 'region'), { recursive: true });
    await writeFile(join(sandbox, 'world', 'level.dat'), 'y'.repeat(120));
    await writeFile(join(sandbox, 'world', 'region', 'r.0.0.mca'), 'z'.repeat(4096));

    expect(await directorySize(sandbox)).toBe(4716);
  });

  it('returns zero for an empty volume', async () => {
    expect(await directorySize(sandbox)).toBe(0);
  });

  it('returns zero rather than fail on a missing volume', async () => {
    expect(await directorySize(join(sandbox, 'never-created'))).toBe(0);
  });

  it.runIf(symlinkSupported)('does not count the target of a symbolic link', async () => {
    const dehors = join(sandbox, 'dehors');
    await mkdir(dehors);
    await writeFile(join(dehors, 'gros'), 'x'.repeat(10_000));

    const volume = join(sandbox, 'volume');
    await mkdir(volume);
    await writeFile(join(volume, 'server.properties'), 'x'.repeat(100));
    await symlink(join(dehors, 'gros'), join(volume, 'lien'));

    // The target file weighs a hundred times the volume's real content:
    // following it would make the server look full, and a player could craft
    // that link themselves over SFTP.
    expect(await directorySize(volume)).toBe(100);
  });

  it.runIf(symlinkSupported)(
    'does not loop on a directory link pointing at its parent',
    async () => {
      const volume = join(sandbox, 'volume');
      await mkdir(join(volume, 'plugins'), { recursive: true });
      await writeFile(join(volume, 'plugins', 'essentials.jar'), 'x'.repeat(64));
      await symlink(volume, join(volume, 'plugins', 'back'), 'dir');

      expect(await directorySize(volume)).toBe(64);
    },
  );
});

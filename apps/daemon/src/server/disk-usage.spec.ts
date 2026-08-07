import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { directorySize, formatBytes, freeSpaceBytes, usableSpace } from './disk-usage.js';

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

/**
 * What the install preflight reads before it lets a download begin.
 *
 * The measurement has to be of the filesystem the volume is really on, which is
 * why it takes a path rather than assuming the daemon's root: `dataDirectory`
 * can sit on a different disk, and an operator who gave a server its own mount
 * deserves that mount checked.
 */
describe('freeSpaceBytes', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'hopper-free-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('reads the free space of the filesystem a path is on', async () => {
    const free = await freeSpaceBytes(sandbox);

    expect(free).not.toBeNull();
    // Any machine that can check out this repository has a megabyte spare; the
    // figure itself is the host's business, not this test's.
    expect(free).toBeGreaterThan(1024 * 1024);
  });

  // Not knowing must not be a refusal: an exotic filesystem `statfs` cannot
  // describe would otherwise make every installation on that node impossible.
  it('answers null rather than throwing when the question cannot be answered', async () => {
    expect(await freeSpaceBytes(join(sandbox, 'never-created', 'deeper'))).toBeNull();
  });
});

/**
 * Which of the two free-block figures `statfs` offers is the one that gets
 * spent.
 *
 * Asked of the answer rather than of a path, because no real filesystem can be
 * made to demonstrate the difference on demand: on a machine that can check out
 * this repository `bavail` and `bfree` are both simply large, so a test against
 * a real directory passes whichever field the code reads.
 */
describe('usableSpace', () => {
  /**
   * `bfree` is every free block; `bavail` is every free block an unprivileged
   * process may have. The difference is what the filesystem holds back for root
   * — five percent of an ext4 by default, which on a 2 TB volume is a hundred
   * gigabytes — and hopperd runs as root, so `bfree` really is space it can
   * write into. Those blocks are the margin that keeps a full machine
   * repairable, and spending them on a game server's install is how a full disk
   * becomes an unrecoverable one.
   */
  it('leaves the blocks a filesystem reserves for root out of the figure', () => {
    expect(usableSpace({ bsize: 4096, bavail: 1_000, bfree: 1_250 })).toBe(4_096_000);
  });

  /**
   * An answer arithmetic cannot use reads as not knowing rather than as a
   * quantity. Handed to the preflight as free space, either of these would let
   * an installation start on a node with nothing left.
   */
  it.each([
    ['a product too large to be a number', { bsize: Number.MAX_VALUE, bavail: Number.MAX_VALUE }],
    ['a negative count', { bsize: 4096, bavail: -1 }],
  ])('answers null for %s', (_name, answer) => {
    expect(usableSpace({ ...answer, bfree: answer.bavail })).toBeNull();
  });
});

describe('formatBytes', () => {
  it('scales to the unit an operator would use', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 ** 2)).toBe('1 MiB');
    expect(formatBytes(8 * 1024 ** 3)).toBe('8 GiB');
    expect(formatBytes(1024 ** 5)).toBe('1 PiB');
  });

  it('keeps one decimal for a figure that is not round', () => {
    expect(formatBytes(1536 * 1024 * 1024)).toBe('1.5 GiB');
  });
});

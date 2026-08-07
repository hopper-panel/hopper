import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Space taken by a server's volume.
 *
 * An iterative walk rather than a recursive one: a modpack's tree runs deep,
 * and an explicit stack cannot exhaust the engine's own.
 *
 * Symlinks are **not** followed. A player can create them over SFTP: following
 * them would count the target's content — potentially outside the volume, or
 * the same folder several times — and a link pointing at its own parent would
 * make the measurement run forever.
 *
 * Per-entry errors are ignored: a file deleted during the walk is the norm on a
 * running server, and beats an abandoned measurement.
 */
export async function directorySize(root: string): Promise<number> {
  const pending = [root];
  let total = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }

      // `Dirent` already tells links from ordinary files: anything that is not
      // a regular file — link, socket, pipe — occupies nothing worth counting.
      if (!entry.isFile()) {
        continue;
      }

      try {
        // `lstat` and not `stat`: between the `readdir` and here, the entry may
        // have been replaced by a link, whose target would then be measured.
        total += (await lstat(path)).size;
      } catch {
        continue;
      }
    }
  }

  return total;
}

/**
 * The usable part of what `statfs` answered, or `null` if it answered nothing
 * usable.
 *
 * **`bavail` and not `bfree`, and that choice is the whole content of this
 * function.** The two differ by the blocks a filesystem reserves for root — five
 * percent of an ext4 by default, which on a 2 TB volume is a hundred gigabytes —
 * and hopperd runs as root, so `bfree` really is space it can write into. That
 * is exactly why it must not: those blocks are the margin that keeps a full
 * machine repairable, and an operator logging in to delete something needs the
 * shell, the log and the package manager to still work. Spending them on a game
 * server's install is how a full disk becomes an unrecoverable one.
 *
 * Separated from the `statfs` call below for the one reason that matters: no
 * real filesystem can be made to demonstrate the difference on demand, so a test
 * against a real path passes whichever field is read. Given the answer instead,
 * a test can fail on the one-character change that gives a node's reserve away.
 *
 * `null` for an answer arithmetic cannot use. Some filesystems report block
 * counts whose product overflows into `Infinity`, and a few report nonsense
 * outright; handed to the preflight as free space, either would let an
 * installation start on a node with nothing left, which is the one thing that
 * check exists to prevent.
 */
export function usableSpace(stats: {
  bavail: number;
  bfree: number;
  bsize: number;
}): number | null {
  const free = stats.bavail * stats.bsize;

  return Number.isFinite(free) && free >= 0 ? free : null;
}

/**
 * Space left on the filesystem a path lives on.
 *
 * `null` rather than a throw when the question cannot be answered — an exotic
 * filesystem, a path that has just gone. The caller decides what to do about not
 * knowing, and refusing every installation on a node whose `statfs` returns
 * something unexpected is not it. See {@link usableSpace} for which figure is
 * read out of the answer, and why it is the smaller of the two on offer.
 */
export async function freeSpaceBytes(path: string): Promise<number | null> {
  try {
    return usableSpace(await statfs(path));
  } catch {
    return null;
  }
}

/**
 * Bytes as an operator reads them.
 *
 * The panel has its own copy of this over `bigint`, and the two are deliberately
 * not shared: this one exists to put figures in a console line the daemon writes
 * at the moment it refuses something, and a shared helper would drag the panel's
 * dependency graph into hopperd for eight lines of arithmetic.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = Math.max(0, bytes);
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // One decimal, and none at all on a whole number: "1 GiB" reads as a limit
  // somebody chose, "1.0 GiB" as a measurement that happened to land there.
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

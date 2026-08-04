import { lstat, readdir } from 'node:fs/promises';
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

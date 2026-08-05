import { stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_EXTENSIONS, type BackupCompression, type BackupResponse } from '@hopper/shared';
import type { JailedFilesystem } from '../fs/jailed-filesystem.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import {
  BackupError,
  checksumOf,
  createBackupArchive,
  detectCompression,
  restoreBackupArchive,
} from './backup-archive.js';

/**
 * Orchestrating backups on a node.
 *
 * A backup is **asynchronous**: the panel's request returns as soon as
 * archiving starts, and the daemon calls the panel back once the archive is
 * closed. Archiving several gigabytes does not fit in an HTTP request, and a
 * client that gives up must not leave a truncated archive behind.
 *
 * The in-memory tracking is deliberately not persisted: when the daemon
 * restarts, an interrupted backup is lost, and that is the intended behaviour.
 * The panel keeps the trace of the backup left `running` and can mark it
 * failed — a backup declared missed beats an incomplete archive presented as
 * valid.
 */

export interface BackupManagerOptions {
  /** Archive directory, outside the server volumes. */
  backupDirectory: string;
  /** Container user: the restored files have to belong to them. */
  ownership: { uid: number; gid: number };
  /** Format chosen for **new** archives. */
  compression: BackupCompression;
  panel: PanelClient;
  logger: Logger;
}

interface RunningBackup {
  serverUuid: string;
  startedAt: number;
}

export class BackupManager {
  private readonly running = new Map<string, RunningBackup>();
  private readonly compression: BackupCompression;

  constructor(private readonly options: BackupManagerOptions) {
    const available = detectCompression();

    // zstd only exists in `node:zlib` from Node 22.15 on. Asking for it on an
    // older version would fail every backup; it falls back to gzip and says so,
    // rather than produce nothing.
    if (options.compression === 'zstd' && available !== 'zstd') {
      options.logger.warn(
        'zstd requested but absent from this Node version: backups will use gzip.',
      );
    }

    this.compression = options.compression === 'zstd' && available === 'zstd' ? 'zstd' : 'gzip';

    options.logger.info({ compression: this.compression }, 'Compression chosen for new backups');
  }

  /** Path of a backup's archive, whatever its compression. */
  archivePathFor(backupUuid: string, compression = this.compression): string {
    return join(this.options.backupDirectory, `${backupUuid}${BACKUP_EXTENSIONS[compression]}`);
  }

  /**
   * Finds a backup's archive without knowing its format.
   *
   * The format depends on the Node version that produced it: an archive made
   * before an upgrade stays readable afterwards.
   */
  async findArchive(backupUuid: string): Promise<{ path: string; sizeBytes: number } | null> {
    for (const compression of Object.keys(BACKUP_EXTENSIONS) as BackupCompression[]) {
      const path = this.archivePathFor(backupUuid, compression);
      const stats = await stat(path).catch(() => null);

      if (stats?.isFile()) {
        return { path, sizeBytes: stats.size };
      }
    }

    return null;
  }

  isRunning(backupUuid: string): boolean {
    return this.running.has(backupUuid);
  }

  /**
   * Starts a backup and returns immediately.
   *
   * @throws {BackupError} if the backup is already running — a double call
   *   would have two archivers writing into the same file.
   */
  start(input: {
    backupUuid: string;
    serverUuid: string;
    volumePath: string;
    ignoredFiles: readonly string[];
  }): BackupResponse {
    if (this.running.has(input.backupUuid)) {
      throw new BackupError('This backup is already running.');
    }

    this.running.set(input.backupUuid, {
      serverUuid: input.serverUuid,
      startedAt: Date.now(),
    });

    void this.run(input);

    return {
      uuid: input.backupUuid,
      status: 'running',
      compression: this.compression,
      sizeBytes: 0,
    };
  }

  private async run(input: {
    backupUuid: string;
    serverUuid: string;
    volumePath: string;
    ignoredFiles: readonly string[];
  }): Promise<void> {
    const logger = this.options.logger.child({
      backup: input.backupUuid,
      server: input.serverUuid,
    });
    const archivePath = this.archivePathFor(input.backupUuid);

    try {
      const started = Date.now();
      const result = await createBackupArchive({
        volumePath: input.volumePath,
        archivePath,
        ignoredFiles: input.ignoredFiles,
        compression: this.compression,
      });

      logger.info(
        {
          sizeBytes: result.sizeBytes,
          fileCount: result.fileCount,
          durationMs: Date.now() - started,
        },
        'Backup finished',
      );

      await this.options.panel.reportBackup(input.backupUuid, {
        successful: true,
        sizeBytes: result.sizeBytes,
        checksum: result.checksum,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'Backup failed');

      // The partial archive was already removed by `createBackupArchive`, but
      // a failure elsewhere — panel outage, full disk — can leave one behind:
      // no orphan archive should be presented as restorable.
      await rm(archivePath, { force: true }).catch(() => undefined);

      await this.options.panel
        .reportBackup(input.backupUuid, {
          successful: false,
          sizeBytes: 0,
          // The contract requires a well-formed digest; on failure it points
          // at nothing, hence the digest of emptiness rather than a fake.
          checksum: EMPTY_SHA256,
          error: message,
        })
        .catch((reportError: unknown) => {
          // If even the report fails, the panel will see the backup stay
          // `running` and declare it missed: nothing is silently lost.
          logger.error({ err: reportError }, 'Could not report the failure to the panel');
        });
    } finally {
      this.running.delete(input.backupUuid);
    }
  }

  /**
   * Restores a backup into a server's volume.
   *
   * The caller must have stopped the server: extracting under a running server
   * would mix the archive's files with those the server rewrites, for a result
   * that is neither one nor the other.
   */
  async restore(input: {
    backupUuid: string;
    jail: JailedFilesystem;
    truncate: boolean;
    expectedChecksum?: string;
  }): Promise<{ restoredFiles: number }> {
    const archive = await this.findArchive(input.backupUuid);

    if (!archive) {
      throw new BackupError("This backup's archive cannot be found on this node.");
    }

    const restoredFiles = await restoreBackupArchive({
      jail: input.jail,
      archivePath: archive.path,
      truncate: input.truncate,
      expectedChecksum: input.expectedChecksum,
      // `chown` does not exist on Windows: the development machine has no
      // container user to honour anyway.
      ownership: process.platform === 'win32' ? undefined : this.options.ownership,
    });

    return { restoredFiles };
  }

  /** Deletes the archive. Silent if it does not exist: deletion is idempotent. */
  async delete(backupUuid: string): Promise<boolean> {
    const archive = await this.findArchive(backupUuid);

    if (!archive) {
      return false;
    }

    await rm(archive.path, { force: true });
    return true;
  }

  /** Checks that an archive still matches its digest. */
  async verify(backupUuid: string, expectedChecksum: string): Promise<boolean> {
    const archive = await this.findArchive(backupUuid);

    if (!archive) {
      return false;
    }

    return (await checksumOf(archive.path)) === expectedChecksum;
  }
}

/** SHA-256 of the empty string: a valid digest that designates nothing. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

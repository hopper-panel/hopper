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
 * Orchestration des sauvegardes sur un node.
 *
 * Une sauvegarde est **asynchrone** : la requête du panel rend la main dès que
 * l'archivage démarre, et le daemon rappelle le panel une fois l'archive close.
 * Archiver plusieurs gigaoctets ne tient pas dans une requête HTTP, et un
 * client qui abandonne ne doit pas laisser une archive tronquée derrière lui.
 *
 * Le suivi en mémoire n'est volontairement pas persisté : au redémarrage du
 * daemon, une sauvegarde interrompue est perdue, et c'est le comportement
 * voulu. Le panel, lui, garde la trace de la sauvegarde restée `running` et
 * peut la marquer en échec — mieux vaut une sauvegarde déclarée manquée qu'une
 * archive incomplète présentée comme valide.
 */

export interface BackupManagerOptions {
  /** Répertoire des archives, hors des volumes de serveurs. */
  backupDirectory: string;
  /** Utilisateur du conteneur : les fichiers restaurés doivent lui appartenir. */
  ownership: { uid: number; gid: number };
  /** Format retenu pour les **nouvelles** archives. */
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

    // zstd n'existe dans `node:zlib` qu'à partir de Node 22.15. Le demander sur
    // une version plus ancienne ferait échouer chaque sauvegarde ; on retombe
    // sur gzip en le disant, plutôt que de ne rien produire.
    if (options.compression === 'zstd' && available !== 'zstd') {
      options.logger.warn(
        'zstd demandé mais absent de cette version de Node : les sauvegardes seront en gzip.',
      );
    }

    this.compression = options.compression === 'zstd' && available === 'zstd' ? 'zstd' : 'gzip';

    options.logger.info(
      { compression: this.compression },
      'Compression retenue pour les nouvelles sauvegardes',
    );
  }

  /** Chemin de l'archive d'une sauvegarde, quelle que soit sa compression. */
  archivePathFor(backupUuid: string, compression = this.compression): string {
    return join(this.options.backupDirectory, `${backupUuid}${BACKUP_EXTENSIONS[compression]}`);
  }

  /**
   * Retrouve l'archive d'une sauvegarde sans connaître son format.
   *
   * Le format dépend de la version de Node qui l'a produite : une archive faite
   * avant une mise à jour reste lisible après.
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
   * Lance une sauvegarde et rend la main immédiatement.
   *
   * @throws {BackupError} si la sauvegarde est déjà en cours — un double appel
   *   ferait écrire deux archivages dans le même fichier.
   */
  start(input: {
    backupUuid: string;
    serverUuid: string;
    volumePath: string;
    ignoredFiles: readonly string[];
  }): BackupResponse {
    if (this.running.has(input.backupUuid)) {
      throw new BackupError('Cette sauvegarde est déjà en cours.');
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
        'Sauvegarde terminée',
      );

      await this.options.panel.reportBackup(input.backupUuid, {
        successful: true,
        sizeBytes: result.sizeBytes,
        checksum: result.checksum,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'Sauvegarde en échec');

      // L'archive partielle a déjà été retirée par `createBackupArchive`, mais
      // un échec survenu ailleurs — panne du panel, disque plein — peut en
      // laisser une : on ne veut pas d'archive orpheline présentée comme
      // restaurable.
      await rm(archivePath, { force: true }).catch(() => undefined);

      await this.options.panel
        .reportBackup(input.backupUuid, {
          successful: false,
          sizeBytes: 0,
          // Le contrat impose une empreinte bien formée ; en échec elle ne
          // désigne rien, d'où l'empreinte du vide plutôt qu'une chaîne bidon.
          checksum: EMPTY_SHA256,
          error: message,
        })
        .catch((reportError: unknown) => {
          // Si même le rapport échoue, le panel verra la sauvegarde rester
          // `running` et la déclarera manquée : rien n'est perdu silencieusement.
          logger.error({ err: reportError }, "Impossible de signaler l'échec au panel");
        });
    } finally {
      this.running.delete(input.backupUuid);
    }
  }

  /**
   * Restaure une sauvegarde dans le volume d'un serveur.
   *
   * L'appelant doit avoir arrêté le serveur : extraire sous un serveur en
   * cours d'exécution mélangerait les fichiers de l'archive et ceux que le
   * serveur réécrit, pour un résultat qui n'est ni l'un ni l'autre.
   */
  async restore(input: {
    backupUuid: string;
    jail: JailedFilesystem;
    truncate: boolean;
    expectedChecksum?: string;
  }): Promise<{ restoredFiles: number }> {
    const archive = await this.findArchive(input.backupUuid);

    if (!archive) {
      throw new BackupError("L'archive de cette sauvegarde est introuvable sur ce node.");
    }

    const restoredFiles = await restoreBackupArchive({
      jail: input.jail,
      archivePath: archive.path,
      truncate: input.truncate,
      expectedChecksum: input.expectedChecksum,
      // `chown` n'existe pas sous Windows : la machine de développement n'a
      // de toute façon pas d'utilisateur de conteneur à honorer.
      ownership: process.platform === 'win32' ? undefined : this.options.ownership,
    });

    return { restoredFiles };
  }

  /** Supprime l'archive. Silencieux si elle n'existe pas : la suppression est idempotente. */
  async delete(backupUuid: string): Promise<boolean> {
    const archive = await this.findArchive(backupUuid);

    if (!archive) {
      return false;
    }

    await rm(archive.path, { force: true });
    return true;
  }

  /** Vérifie qu'une archive correspond toujours à son empreinte. */
  async verify(backupUuid: string, expectedChecksum: string): Promise<boolean> {
    const archive = await this.findArchive(backupUuid);

    if (!archive) {
      return false;
    }

    return (await checksumOf(archive.path)) === expectedChecksum;
  }
}

/** SHA-256 de la chaîne vide : une empreinte valide qui ne désigne rien. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

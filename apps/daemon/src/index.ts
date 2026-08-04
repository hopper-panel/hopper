import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { BackupManager } from './backup/backup-manager.js';
import { ConfigError, loadConfig } from './config/load.js';
import { DockerClient } from './docker/client.js';
import { buildHttpServer } from './http/server.js';
import { createLogger } from './logger.js';
import { PanelClient } from './panel/panel-client.js';
import { ServerManager } from './server/server-manager.js';
import { SftpServer } from './sftp/sftp-server.js';
import { DAEMON_VERSION } from './version.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: false,
  });

  if (values.version) {
    process.stdout.write(`hopperd ${DAEMON_VERSION}\n`);
    return;
  }

  const loaded = await loadConfig(values.config);
  const logger = createLogger(loaded.config.debug);

  logger.info(
    { version: DAEMON_VERSION, node: loaded.config.uuid, config: loaded.sourcePath },
    'Starting hopperd',
  );

  // The directories are created at startup rather than on the first write: a
  // permissions problem has to surface now, not in the middle of a backup.
  for (const directory of Object.values(loaded.paths)) {
    await mkdir(directory, { recursive: true });
  }

  const docker = new DockerClient(loaded.config, logger);

  // Docker is checked before the port is opened: a daemon that answers but
  // cannot create a container shows the node as "online" and fails every server
  // creation with no explanation.
  try {
    await docker.ping();
    await docker.ensureNetwork();
  } catch (error: unknown) {
    throw new ConfigError(
      `Docker est injoignable sur ${loaded.config.docker.socket}.`,
      `Check that the Docker service is running and that the daemon's user belongs to the "docker" group. Detail: ${String(error)}`,
    );
  }

  const panel = new PanelClient(loaded.config, logger);
  const manager = new ServerManager(loaded, docker, panel, logger);

  const backups = new BackupManager({
    backupDirectory: loaded.paths.backups,
    ownership: { uid: loaded.config.system.uid, gid: loaded.config.system.gid },
    compression: loaded.config.system.backupCompression,
    panel,
    logger,
  });

  const app = await buildHttpServer({ loaded, logger, docker, manager, backups });

  await app.listen({ host: loaded.config.api.host, port: loaded.config.api.port });

  // Reconciliation comes after the port is opened: the servers already running
  // are found again while the panel can already reach us.
  await manager.reconcile().catch((error: unknown) => {
    logger.error({ err: error }, 'Container reconciliation failed');
  });

  const sftp = new SftpServer({
    config: loaded.config,
    paths: loaded.paths,
    manager,
    panel,
    logger,
  });

  // After reconciliation: SFTP needs to know the servers in order to accept a
  // connection, otherwise the first attempts would fail on an incomprehensible
  // "unknown server".
  await sftp.start().catch((error: unknown) => {
    logger.error({ err: error }, 'Could not start the SFTP server');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutdown requested');
    // The server containers are deliberately not stopped: restarting the daemon
    // must not disconnect the players. They are reconciled on the next start.
    manager.shutdown();
    sftp.stop();

    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Clean shutdown failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`\n✖ ${error.message}\n`);
    if (error.hint) {
      process.stderr.write(`  ${error.hint}\n`);
    }
    process.stderr.write('\n');
    process.exit(78); // EX_CONFIG
  }

  process.stderr.write(`\n✖ hopperd failed to start:\n${String(error)}\n\n`);
  process.exit(1);
});

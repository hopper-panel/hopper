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
    'Démarrage de hopperd',
  );

  // Les répertoires sont créés au démarrage plutôt qu'à la première écriture :
  // un problème de droits doit apparaître maintenant, pas au milieu d'un backup.
  for (const directory of Object.values(loaded.paths)) {
    await mkdir(directory, { recursive: true });
  }

  const docker = new DockerClient(loaded.config, logger);

  // Docker est vérifié avant d'ouvrir le port : un daemon qui répond mais ne
  // sait pas créer de conteneur affiche un node « en ligne » et fait échouer
  // chaque création de serveur sans explication.
  try {
    await docker.ping();
    await docker.ensureNetwork();
  } catch (error: unknown) {
    throw new ConfigError(
      `Docker est injoignable sur ${loaded.config.docker.socket}.`,
      `Vérifiez que le service Docker tourne et que l'utilisateur du daemon appartient au groupe « docker ». Détail : ${String(error)}`,
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

  // La réconciliation vient après l'ouverture du port : les serveurs déjà en
  // cours sont retrouvés pendant que le panel peut déjà nous joindre.
  await manager.reconcile().catch((error: unknown) => {
    logger.error({ err: error }, 'Réconciliation des conteneurs échouée');
  });

  const sftp = new SftpServer({
    config: loaded.config,
    paths: loaded.paths,
    manager,
    panel,
    logger,
  });

  // Après la réconciliation : le SFTP a besoin de connaître les serveurs pour
  // accepter une connexion, sinon les premières tentatives échoueraient sur un
  // « serveur inconnu » incompréhensible.
  await sftp.start().catch((error: unknown) => {
    logger.error({ err: error }, 'Démarrage du serveur SFTP impossible');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Arrêt demandé');
    // Les conteneurs des serveurs ne sont volontairement pas arrêtés : redémarrer
    // le daemon ne doit pas déconnecter les joueurs. Ils sont réconciliés au
    // prochain démarrage.
    manager.shutdown();
    sftp.stop();

    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, "Échec de l'arrêt propre");
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

  process.stderr.write(`\n✖ Échec du démarrage de hopperd :\n${String(error)}\n\n`);
  process.exit(1);
});

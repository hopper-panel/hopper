import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PERMISSIONS, type Permission } from '@hopper/shared';
import {
  Server as SshServer,
  utils,
  type Attributes,
  type Connection,
  type FileEntry as SshFileEntry,
  type SFTPWrapper,
} from 'ssh2';
import type { DaemonConfig } from '../config/schema.js';
import type { ResolvedPaths } from '../config/load.js';
import {
  DeniedFileError,
  JailedFilesystem,
  NotFoundError,
  PathEscapeError,
} from '../fs/jailed-filesystem.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import type { ServerManager } from '../server/server-manager.js';
import { parseSftpUsername } from './sftp-username.js';

/**
 * Serveur SFTP intégré.
 *
 * Il n'expose **pas** un shell : seul le sous-système `sftp` est accepté, et la
 * requête `exec` est refusée. Un serveur SFTP qui autorise l'exécution de
 * commandes donnerait à l'utilisateur un shell sur la machine hôte — hors de
 * tout conteneur.
 *
 * Chaque opération passe par `JailedFilesystem`, exactement comme l'API HTTP.
 * C'est la raison d'être de cette classe : le jail est écrit une fois et sert
 * les deux chemins d'accès, plutôt que d'avoir une validation par protocole
 * dont l'une prendrait du retard sur l'autre.
 */

/**
 * Constantes du protocole SFTP, reprises de ssh2 plutôt que réécrites.
 *
 * Les redéfinir invitait à la confusion avec les constantes de `node:fs`, dont
 * les valeurs diffèrent : `OPEN_MODE.READ` vaut 1, comme `O_WRONLY`.
 */
const { OPEN_MODE, STATUS_CODE: STATUS } = utils.sftp;

/** Poignées ouvertes par une session, indexées par identifiant binaire. */
interface OpenHandle {
  type: 'file' | 'directory';
  path: string;
  /** Pour un dossier : entrées restant à envoyer. */
  pending?: SshFileEntry[];
  /** Pour un fichier en écriture. */
  writeStream?: ReturnType<typeof createWriteStream>;
  /** Pour un fichier en lecture. */
  readPath?: string;
}

export interface SftpServerOptions {
  config: DaemonConfig;
  paths: ResolvedPaths;
  manager: ServerManager;
  panel: PanelClient;
  logger: Logger;
}

export class SftpServer {
  private server: SshServer | null = null;

  constructor(private readonly options: SftpServerOptions) {}

  /**
   * Charge la clé d'hôte, ou en génère une.
   *
   * Une clé régénérée à chaque démarrage ferait afficher à tous les clients
   * l'avertissement « l'identité de l'hôte a changé », qui est précisément le
   * signal d'une attaque de l'intercepteur. On la persiste donc.
   */
  private async hostKey(): Promise<Buffer> {
    const path =
      this.options.config.system.sftp.hostKeyPath ??
      join(this.options.paths.root, 'ssh_host_ed25519_key');

    try {
      return await readFile(path);
    } catch {
      this.options.logger.info({ path }, "Génération de la clé d'hôte SFTP");

      const keys = utils.generateKeyPairSync('ed25519');

      await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
      // 0600 : la clé privée de l'hôte ne doit être lisible que par le daemon.
      await writeFile(path, keys.private, { mode: 0o600 });

      return Buffer.from(keys.private);
    }
  }

  async start(): Promise<void> {
    const { config, logger } = this.options;

    if (!config.system.sftp.enabled) {
      logger.info('SFTP désactivé par la configuration');
      return;
    }

    const hostKeys = [await this.hostKey()];

    this.server = new SshServer({ hostKeys }, (client, info) => {
      // L'adresse vient du second argument : `Connection` ne l'expose pas, et
      // sans elle le panel ne pourrait pas limiter les tentatives par IP.
      this.handleClient(client, info.ip);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(config.system.sftp.bindPort, config.system.sftp.bindAddress, () => {
        logger.info(
          { port: config.system.sftp.bindPort, address: config.system.sftp.bindAddress },
          'SFTP à l’écoute',
        );
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  // -------------------------------------------------------------------------

  private handleClient(client: Connection, remoteIp: string): void {
    const { logger, panel, manager } = this.options;

    let jail: JailedFilesystem | null = null;
    let permissions: Permission[] = [];
    let serverUuid = '';

    client.on('authentication', (context) => {
      void (async () => {
        // Seul le mot de passe est accepté : les clés publiques exigeraient une
        // gestion de clés par utilisateur que le panel n'offre pas encore, et
        // les accepter sans vérification reviendrait à ne pas authentifier.
        if (context.method !== 'password') {
          context.reject(['password']);
          return;
        }

        const parsed = parseSftpUsername(context.username);

        if (!parsed) {
          context.reject();
          return;
        }

        try {
          // C'est le panel qui authentifie : lui seul connaît les comptes, les
          // mots de passe et les permissions de sous-utilisateur.
          const result = await panel.authenticateSftp({
            username: context.username,
            password: context.password,
            ip: remoteIp,
          });

          const instance = manager.get(result.serverUuid);

          if (!instance) {
            logger.warn({ server: result.serverUuid }, 'SFTP : serveur inconnu de ce node');
            context.reject();
            return;
          }

          if (instance.configuration.suspended) {
            logger.warn({ server: result.serverUuid }, 'SFTP refusé : serveur suspendu');
            context.reject();
            return;
          }

          // La permission SFTP est distincte de la permission de lecture : un
          // sous-utilisateur peut consulter les fichiers dans le panel sans
          // qu'on lui ouvre un accès protocolaire à la machine.
          if (!result.permissions.includes(PERMISSIONS.FILE_SFTP)) {
            logger.warn({ user: result.userUuid }, 'SFTP refusé : permission manquante');
            context.reject();
            return;
          }

          permissions = result.permissions;
          serverUuid = result.serverUuid;
          jail = new JailedFilesystem({
            root: instance.volumePath,
            denylist: instance.configuration.fileDenylist,
          });

          context.accept();
        } catch (error: unknown) {
          logger.warn({ err: error, user: context.username }, 'Authentification SFTP refusée');
          context.reject();
        }
      })();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        // Un shell donnerait un accès direct à l'hôte, hors de tout conteneur.
        session.on('shell', (_a, reject) => reject());
        session.on('exec', (_a, reject) => reject());

        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          this.attachSftpHandlers(
            sftp,
            () => jail,
            () => permissions,
            serverUuid,
          );
        });
      });
    });

    client.on('error', (error) => {
      logger.debug({ err: error }, 'Erreur de connexion SFTP');
    });
  }

  /**
   * Branche les gestionnaires du protocole SFTP.
   *
   * Chaque opération vérifie sa permission puis délègue au jail. Les erreurs du
   * jail sont traduites en codes SFTP : une évasion et un fichier interdit
   * renvoient tous deux `PERMISSION_DENIED`, sans distinction — la différence
   * confirmerait l'existence d'un fichier hors du volume.
   */
  private attachSftpHandlers(
    sftp: SFTPWrapper,
    getJail: () => JailedFilesystem | null,
    getPermissions: () => Permission[],
    serverUuid: string,
  ): void {
    const { logger } = this.options;
    const handles = new Map<string, OpenHandle>();
    let nextHandle = 0;

    const allocate = (handle: OpenHandle): Buffer => {
      const id = Buffer.from(String(nextHandle++));
      handles.set(id.toString(), handle);
      return id;
    };

    const has = (permission: Permission): boolean => getPermissions().includes(permission);

    /** Traduit une erreur en code SFTP. */
    const fail = (reqId: number, error: unknown): void => {
      if (error instanceof PathEscapeError || error instanceof DeniedFileError) {
        logger.warn({ server: serverUuid }, 'SFTP : chemin refusé par le jail');
        sftp.status(reqId, STATUS.PERMISSION_DENIED);
        return;
      }

      if (error instanceof NotFoundError) {
        sftp.status(reqId, STATUS.NO_SUCH_FILE);
        return;
      }

      logger.error({ err: error, server: serverUuid }, 'SFTP : erreur inattendue');
      sftp.status(reqId, STATUS.FAILURE);
    };

    const run = (reqId: number, permission: Permission, action: () => Promise<void>): void => {
      const jail = getJail();

      if (!jail) {
        sftp.status(reqId, STATUS.PERMISSION_DENIED);
        return;
      }

      if (!has(permission)) {
        sftp.status(reqId, STATUS.PERMISSION_DENIED);
        return;
      }

      void action().catch((error: unknown) => fail(reqId, error));
    };

    sftp.on('REALPATH', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_READ, async () => {
        const jail = getJail()!;
        // Le client demande la forme canonique ; on lui rend un chemin relatif
        // au volume, jamais le chemin réel sur l'hôte.
        const entry = await jail.stat(path).catch(() => null);
        const canonical = '/' + (entry?.path ?? path.replace(/^\/+/, ''));

        sftp.name(reqId, [{ filename: canonical, longname: canonical, attrs: {} } as SshFileEntry]);
      });
    }) as never);

    sftp.on('STAT', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_READ, async () => {
        sftp.attrs(reqId, this.toSftpAttrs(await getJail()!.stat(path)));
      });
    }) as never);

    // LSTAT décrit le lien plutôt que sa cible ; `jail.stat` fait déjà un
    // `lstat`, les deux opérations sont donc identiques ici.
    sftp.on('LSTAT', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_READ, async () => {
        sftp.attrs(reqId, this.toSftpAttrs(await getJail()!.stat(path)));
      });
    }) as never);

    sftp.on('FSTAT', ((reqId: number, handle: Buffer) => {
      const entry = handles.get(handle.toString());

      if (!entry) {
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      run(reqId, PERMISSIONS.FILE_READ, async () => {
        sftp.attrs(reqId, this.toSftpAttrs(await getJail()!.stat(entry.path)));
      });
    }) as never);

    sftp.on('OPENDIR', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_READ, async () => {
        const entries = await getJail()!.list(path);

        const names: SshFileEntry[] = entries.map((entry) => ({
          filename: entry.name,
          // `longname` est la ligne que les clients en mode texte affichent
          // telle quelle : elle imite la sortie de `ls -l`.
          longname: `${entry.directory ? 'd' : '-'}${entry.mode} 1 container container ${entry.sizeBytes} ${entry.name}`,
          attrs: this.toSftpAttrs(entry),
        }));

        sftp.handle(reqId, allocate({ type: 'directory', path, pending: names }));
      });
    }) as never);

    sftp.on('READDIR', ((reqId: number, handle: Buffer) => {
      const entry = handles.get(handle.toString());

      if (!entry?.pending) {
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      if (entry.pending.length === 0) {
        sftp.status(reqId, STATUS.EOF);
        return;
      }

      // Envoyé par lots : un dossier de dix mille fichiers dépasserait la
      // taille maximale d'un paquet SFTP.
      const batch = entry.pending.splice(0, 100);
      sftp.name(reqId, batch);
    }) as never);

    sftp.on('OPEN', ((reqId: number, path: string, flags: number) => {
      // Les drapeaux du protocole SFTP ne sont **pas** ceux de `open(2)` : dans
      // SFTP, la valeur 1 signifie « lecture », alors qu'en POSIX c'est
      // `O_WRONLY`. Les confondre faisait ouvrir en écriture tout fichier
      // demandé en lecture — et donc le tronquer à l'ouverture.
      const write =
        (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
      const permission = write ? PERMISSIONS.FILE_UPDATE : PERMISSIONS.FILE_READ_CONTENT;

      run(reqId, permission, async () => {
        const jail = getJail()!;
        const absolute = await jail.absolutePathFor(path);

        if (write) {
          await mkdir(join(absolute, '..'), { recursive: true });

          const stream = createWriteStream(absolute);

          // Sans ce gestionnaire, une erreur d'écriture — disque plein,
          // permission refusée — devient un événement `error` non capté, et
          // Node termine le processus. Le daemon entier tomberait, avec les
          // consoles de tous les serveurs de la machine, parce qu'un
          // utilisateur a tenté d'envoyer un fichier.
          stream.on('error', (error) => {
            logger.error({ err: error, server: serverUuid }, 'Écriture SFTP impossible');
            stream.destroy();
          });

          sftp.handle(reqId, allocate({ type: 'file', path, writeStream: stream }));
          return;
        }

        // Vérifie l'existence avant d'annoncer une poignée valide.
        await jail.stat(path);
        sftp.handle(reqId, allocate({ type: 'file', path, readPath: absolute }));
      });
    }) as never);

    sftp.on('WRITE', ((reqId: number, handle: Buffer, _offset: number, data: Buffer) => {
      const entry = handles.get(handle.toString());

      if (!entry?.writeStream) {
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      if (entry.writeStream.destroyed) {
        // Le flux a déjà échoué : répondre FAILURE plutôt que d'écrire dans le
        // vide, sans quoi le client croirait son envoi réussi.
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      entry.writeStream.write(data, (error) => {
        sftp.status(reqId, error ? STATUS.FAILURE : STATUS.OK);
      });
    }) as never);

    sftp.on('READ', ((reqId: number, handle: Buffer, offset: number, length: number) => {
      const entry = handles.get(handle.toString());

      if (!entry?.readPath) {
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      const chunks: Buffer[] = [];
      const stream = createReadStream(entry.readPath, { start: offset, end: offset + length - 1 });

      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('error', () => sftp.status(reqId, STATUS.FAILURE));
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          sftp.status(reqId, STATUS.EOF);
        } else {
          sftp.data(reqId, buffer);
        }
      });
    }) as never);

    sftp.on('CLOSE', ((reqId: number, handle: Buffer) => {
      const key = handle.toString();
      const entry = handles.get(key);

      handles.delete(key);

      if (entry?.writeStream) {
        entry.writeStream.end(() => sftp.status(reqId, STATUS.OK));
        return;
      }

      sftp.status(reqId, STATUS.OK);
    }) as never);

    sftp.on('MKDIR', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_CREATE, async () => {
        await getJail()!.createDirectory(path);
        sftp.status(reqId, STATUS.OK);
      });
    }) as never);

    sftp.on('REMOVE', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_DELETE, async () => {
        await getJail()!.delete([path]);
        sftp.status(reqId, STATUS.OK);
      });
    }) as never);

    sftp.on('RMDIR', ((reqId: number, path: string) => {
      run(reqId, PERMISSIONS.FILE_DELETE, async () => {
        await getJail()!.delete([path]);
        sftp.status(reqId, STATUS.OK);
      });
    }) as never);

    sftp.on('RENAME', ((reqId: number, from: string, to: string) => {
      run(reqId, PERMISSIONS.FILE_UPDATE, async () => {
        await getJail()!.rename(from, to);
        sftp.status(reqId, STATUS.OK);
      });
    }) as never);

    // Créer un lien symbolique depuis SFTP est le moyen le plus direct de
    // tenter une évasion, et aucun usage légitime n'en a besoin sur un volume
    // de serveur Minecraft.
    for (const unsupported of ['SYMLINK', 'READLINK']) {
      sftp.on(unsupported, ((reqId: number) => {
        sftp.status(reqId, STATUS.OP_UNSUPPORTED);
      }) as never);
    }

    // Les changements de permissions et de dates sont acceptés sans effet.
    // Hopper impose l'UID et les permissions du volume, il n'y a donc rien à
    // appliquer — mais répondre « non supporté » ferait abandonner l'envoi à
    // plusieurs clients, qui positionnent les dates juste après un transfert.
    for (const ignored of ['SETSTAT', 'FSETSTAT']) {
      sftp.on(ignored, ((reqId: number) => {
        sftp.status(reqId, STATUS.OK);
      }) as never);
    }
  }

  /** Traduit une entrée du jail en attributs SFTP. */
  private toSftpAttrs(entry: {
    directory: boolean;
    sizeBytes: number;
    modifiedAt: Date;
  }): Attributes {
    const seconds = Math.floor(entry.modifiedAt.getTime() / 1000);

    return {
      // Les permissions réelles du volume ne sont pas exposées : elles
      // n'apprennent rien d'utile au client et varient selon l'hôte.
      mode: entry.directory ? 0o40755 : 0o100644,
      size: entry.sizeBytes,
      uid: this.options.config.system.uid,
      gid: this.options.config.system.gid,
      atime: seconds,
      mtime: seconds,
    };
  }
}

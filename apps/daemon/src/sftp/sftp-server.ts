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
 * Built-in SFTP server.
 *
 * It does **not** expose a shell: only the `sftp` subsystem is accepted, and
 * the `exec` request is refused. An SFTP server that allows running commands
 * would hand the user a shell on the host machine — outside any container.
 *
 * Every operation goes through `JailedFilesystem`, exactly like the HTTP API.
 * That is the reason this class exists: the jail is written once and serves
 * both access paths, rather than having one validation per protocol, one of
 * which would fall behind the other.
 */

/**
 * SFTP protocol constants, taken from ssh2 rather than rewritten.
 *
 * Redefining them invited confusion with the `node:fs` constants, whose values
 * differ: `OPEN_MODE.READ` is 1, same as `O_WRONLY`.
 */
const { OPEN_MODE, STATUS_CODE: STATUS } = utils.sftp;

/** Handles opened by a session, keyed by binary identifier. */
interface OpenHandle {
  type: 'file' | 'directory';
  path: string;
  /** For a directory: entries left to send. */
  pending?: SshFileEntry[];
  /** For a file being written. */
  writeStream?: ReturnType<typeof createWriteStream>;
  /** For a file being read. */
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
   * Loads the host key, or generates one.
   *
   * A key regenerated on every start would show every client the "host identity
   * has changed" warning, which is precisely the signal of a man-in-the-middle
   * attack. So it is persisted.
   */
  private async hostKey(): Promise<Buffer> {
    const path =
      this.options.config.system.sftp.hostKeyPath ??
      join(this.options.paths.root, 'ssh_host_ed25519_key');

    try {
      return await readFile(path);
    } catch {
      this.options.logger.info({ path }, 'Generating the SFTP host key');

      const keys = utils.generateKeyPairSync('ed25519');

      await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
      // 0600: the host private key must be readable by the daemon only.
      await writeFile(path, keys.private, { mode: 0o600 });

      return Buffer.from(keys.private);
    }
  }

  async start(): Promise<void> {
    const { config, logger } = this.options;

    if (!config.system.sftp.enabled) {
      logger.info('SFTP disabled by configuration');
      return;
    }

    const hostKeys = [await this.hostKey()];

    this.server = new SshServer({ hostKeys }, (client, info) => {
      // The address comes from the second argument: `Connection` does not
      // expose it, and without it the panel could not rate-limit attempts by
      // IP.
      this.handleClient(client, info.ip);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(config.system.sftp.bindPort, config.system.sftp.bindAddress, () => {
        logger.info(
          { port: config.system.sftp.bindPort, address: config.system.sftp.bindAddress },
          'SFTP listening',
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
        // Only passwords are accepted: public keys would need a per-user key
        // management the panel does not offer yet, and accepting them without
        // checking would amount to not authenticating at all.
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
          // The panel is what authenticates: it alone knows the accounts, the
          // passwords and the subuser permissions.
          const result = await panel.authenticateSftp({
            username: context.username,
            password: context.password,
            ip: remoteIp,
          });

          const instance = manager.get(result.serverUuid);

          if (!instance) {
            logger.warn({ server: result.serverUuid }, 'SFTP: server unknown to this node');
            context.reject();
            return;
          }

          if (instance.configuration.suspended) {
            logger.warn({ server: result.serverUuid }, 'SFTP refused: server suspended');
            context.reject();
            return;
          }

          // The SFTP permission is distinct from the read permission: a
          // subuser can browse files in the panel without being handed
          // protocol-level access to the machine.
          if (!result.permissions.includes(PERMISSIONS.FILE_SFTP)) {
            logger.warn({ user: result.userUuid }, 'SFTP refused: missing permission');
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
          logger.warn({ err: error, user: context.username }, 'SFTP authentication refused');
          context.reject();
        }
      })();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        // A shell would give direct access to the host, outside any container.
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
      logger.debug({ err: error }, 'SFTP connection error');
    });
  }

  /**
   * Wires up the SFTP protocol handlers.
   *
   * Every operation checks its permission then delegates to the jail. The
   * jail's errors are translated into SFTP codes: an escape and a denied file
   * both return `PERMISSION_DENIED`, with no distinction — the difference would
   * confirm the existence of a file outside the volume.
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

    /** Translates an error into an SFTP code. */
    const fail = (reqId: number, error: unknown): void => {
      if (error instanceof PathEscapeError || error instanceof DeniedFileError) {
        logger.warn({ server: serverUuid }, 'SFTP: path refused by the jail');
        sftp.status(reqId, STATUS.PERMISSION_DENIED);
        return;
      }

      if (error instanceof NotFoundError) {
        sftp.status(reqId, STATUS.NO_SUCH_FILE);
        return;
      }

      logger.error({ err: error, server: serverUuid }, 'SFTP: unexpected error');
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
        // The client asks for the canonical form; it gets a path relative to
        // the volume, never the real path on the host.
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

    // LSTAT describes the link rather than its target; `jail.stat` already
    // does an `lstat`, so both operations are identical here.
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
          // `longname` is the line text-mode clients display verbatim: it
          // imitates the output of `ls -l`.
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

      // Sent in batches: a folder of ten thousand files would exceed the
      // maximum size of an SFTP packet.
      const batch = entry.pending.splice(0, 100);
      sftp.name(reqId, batch);
    }) as never);

    sftp.on('OPEN', ((reqId: number, path: string, flags: number) => {
      // The SFTP protocol flags are **not** those of `open(2)`: in SFTP the
      // value 1 means "read", whereas in POSIX it is `O_WRONLY`. Confusing them
      // opened every file requested for reading in write mode — and therefore
      // truncated it on open.
      const write =
        (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
      const permission = write ? PERMISSIONS.FILE_UPDATE : PERMISSIONS.FILE_READ_CONTENT;

      run(reqId, permission, async () => {
        const jail = getJail()!;
        const absolute = await jail.absolutePathFor(path);

        if (write) {
          await mkdir(join(absolute, '..'), { recursive: true });

          const stream = createWriteStream(absolute);

          // Without this handler, a write error — disk full, permission
          // denied — becomes an uncaught `error` event, and Node ends the
          // process. The whole daemon would fall over, with the consoles of
          // every server on the machine, because one user tried to upload a
          // file.
          stream.on('error', (error) => {
            logger.error({ err: error, server: serverUuid }, 'SFTP write failed');
            stream.destroy();
          });

          sftp.handle(reqId, allocate({ type: 'file', path, writeStream: stream }));
          return;
        }

        // Check existence before announcing a valid handle.
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
        // The stream already failed: answer FAILURE rather than write into the
        // void, otherwise the client would believe its upload succeeded.
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

    // Creating a symlink over SFTP is the most direct way to attempt an
    // escape, and no legitimate use needs it on a Minecraft server volume.
    for (const unsupported of ['SYMLINK', 'READLINK']) {
      sftp.on(unsupported, ((reqId: number) => {
        sftp.status(reqId, STATUS.OP_UNSUPPORTED);
      }) as never);
    }

    // Permission and timestamp changes are accepted with no effect. Hopper
    // imposes the volume's UID and permissions, so there is nothing to apply —
    // but answering "unsupported" would make several clients abandon the
    // upload, as they set timestamps right after a transfer.
    for (const ignored of ['SETSTAT', 'FSETSTAT']) {
      sftp.on(ignored, ((reqId: number) => {
        sftp.status(reqId, STATUS.OK);
      }) as never);
    }
  }

  /** Translates a jail entry into SFTP attributes. */
  private toSftpAttrs(entry: {
    directory: boolean;
    sizeBytes: number;
    modifiedAt: Date;
  }): Attributes {
    const seconds = Math.floor(entry.modifiedAt.getTime() / 1000);

    return {
      // The volume's real permissions are not exposed: they teach the client
      // nothing useful and vary from host to host.
      mode: entry.directory ? 0o40755 : 0o100644,
      size: entry.sizeBytes,
      uid: this.options.config.system.uid,
      gid: this.options.config.system.gid,
      atime: seconds,
      mtime: seconds,
    };
  }
}

import type { WriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

/**
 * Largest amount of data served for a single READ.
 *
 * The length comes from the client as a 32-bit integer and the buffer is
 * allocated before anything is read, so an unbounded one lets a client ask for
 * four gigabytes of a one-byte file and take the daemon down with it. Reading
 * through a stream used to bound this implicitly — it never produced more than
 * the file held.
 *
 * A short read is legal in SFTP and every client loops until it has what it
 * asked for; the ceiling sits far above the 32 KiB real clients request, so in
 * practice none of them ever sees one.
 */
const MAX_SFTP_READ_BYTES = 512 * 1024;

/**
 * Handles one session may hold open at a time.
 *
 * A read handle now owns a file descriptor for as long as it lives, where it
 * used to hold only a path string. That is the point — reopening the name on
 * every chunk was the hole — but it turns OPEN from a free operation into one
 * that spends a process-wide resource, and the map it goes into is per session
 * and unbounded. A client that sends OPEN in a loop and never sends CLOSE walks
 * the daemon into `EMFILE`, at which point it can no longer reach Docker or
 * write a log line: every server on the node loses its console, not just the
 * one whose owner did it.
 *
 * Real clients hold a handful. FileZilla opens ten transfers at its most
 * parallel, and `sftp` itself one.
 */
const MAX_SFTP_HANDLES = 64;

/**
 * Refusal to open more handles in one session.
 *
 * Distinct from a jail refusal so the log says which ceiling was reached, and
 * so an operator seeing it knows to look at a client that is not closing what
 * it opens rather than at a path.
 */
class TooManyHandlesError extends Error {
  constructor() {
    super('Too many open handles for this session.');
    this.name = 'TooManyHandlesError';
  }
}

/** Handles opened by a session, keyed by binary identifier. */
interface OpenHandle {
  type: 'file' | 'directory';
  path: string;
  /** For a directory: entries left to send. */
  pending?: SshFileEntry[];
  /** For a file being written, over a descriptor the jail has vetted. */
  writeStream?: WriteStream;
  /** Bytes accepted so far, charged against the server's disk allowance. */
  written?: number;
  /** Room left when the handle was opened; `Infinity` without a quota. */
  room?: number;
  /**
   * For a file being read, over a descriptor the jail has vetted.
   *
   * The descriptor is kept for the life of the SFTP handle rather than reopened
   * per READ: a client downloads in 32 KiB chunks, and one `open(2)` per chunk
   * would be both wasteful and a fresh chance for the name to be swapped
   * underneath — the very thing the jail opens once to prevent.
   */
  readHandle?: FileHandle;
}

export interface SftpServerOptions {
  config: DaemonConfig;
  paths: ResolvedPaths;
  manager: ServerManager;
  panel: PanelClient;
  logger: Logger;
}

/**
 * How many keys are generated before giving up on ssh2's generator.
 *
 * One in 256 is short, so eight in a row is a one in eighteen million million
 * million event: reaching this limit means the failure is no longer the one
 * described below.
 */
const GENERATION_ATTEMPTS = 8;

/**
 * An ed25519 host key that ssh2 will read back.
 *
 * `utils.generateKeyPairSync('ed25519')` produces a key ssh2's own parser
 * rejects roughly **one time in 256**: measured at 12 in 3000, and the shape of
 * the damage says where that figure comes from — the public key comes out 31
 * bytes instead of 32 and the secret 63 instead of 64, one byte short at the
 * front. A leading zero stripped as though the key material were an integer,
 * which one key in 256 begins with.
 *
 * It is not a rare inconvenience. The key is written to disk on a node's first
 * start and read at every start after it, so one node in 256 would have
 * generated a key that only fails later, on a message naming neither the daemon
 * nor the file — and no reinstall would fix it, since the broken key is exactly
 * what is kept.
 *
 * So each key is put through the parser that will read it, and a short one is
 * thrown away. Node's own `crypto.generateKeyPairSync('ed25519')` was tried
 * first and is not an option: ssh2 answers "Unsupported key format" to the
 * PKCS#8 PEM it exports, 2000 times out of 2000.
 */
export function generateHostKey(): Buffer {
  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt += 1) {
    const generated = utils.generateKeyPairSync('ed25519').private;

    if (!(utils.parseKey(generated) instanceof Error)) {
      return Buffer.from(generated);
    }
  }

  throw new Error(
    `Generated ${GENERATION_ATTEMPTS} SSH host keys and ssh2 refused every one of them. This is ` +
      'not the known one-in-256 short key: something about key generation on this machine has ' +
      'changed.',
  );
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

    const existing = await readFile(path).catch(() => null);

    if (existing !== null) {
      // Read here rather than left to `new SshServer`, which throws "Malformed
      // OpenSSH private key" from inside a constructor and names no file. A
      // node that generated an unusable key before the check below existed is
      // stuck on exactly that message at every start, so this is the one place
      // that can say which file and what to do about it.
      const parsed = utils.parseKey(existing);

      if (parsed instanceof Error) {
        throw new Error(
          `${path} is not a key this daemon can use (${parsed.message}). Delete it and start ` +
            'again to have another generated — every SFTP client will then report a changed host ' +
            'key, which is the price of replacing it.',
        );
      }

      return existing;
    }

    this.options.logger.info({ path }, 'Generating the SFTP host key');

    const key = generateHostKey();

    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);

    // Written beside its destination and renamed onto it, because a daemon
    // killed in the middle of the write would otherwise leave a truncated key —
    // and a truncated key is not a missing one: it is read on the next start,
    // rejected, and SFTP never comes up again on that node.
    //
    // 0600 on the temporary file, which the rename carries over: the host
    // private key must be readable by the daemon alone, and a file that is
    // world-readable for even a moment has been readable.
    const temporary = `${path}.${process.pid}.tmp`;

    await writeFile(temporary, key, { mode: 0o600 });
    await rename(temporary, path);

    return key;
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
            quota: () => instance.diskQuota,
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

    /**
     * Refuses a new handle before anything is opened for it.
     *
     * Checked up front rather than inside `allocate`, because by the time
     * `allocate` runs the descriptor or the write stream already exists —
     * refusing there would mean unwinding a resource that should never have
     * been acquired.
     */
    const assertHandleRoom = (): void => {
      if (handles.size >= MAX_SFTP_HANDLES) {
        throw new TooManyHandlesError();
      }
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

      if (error instanceof TooManyHandlesError) {
        logger.warn({ server: serverUuid }, 'SFTP: session handle ceiling reached');
        sftp.status(reqId, STATUS.FAILURE);
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
        assertHandleRoom();

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
        assertHandleRoom();

        const jail = getJail()!;
        const absolute = await jail.absolutePathFor(path);

        if (write) {
          await mkdir(join(absolute, '..'), { recursive: true });

          // The jail opens the file; this only writes into it. Reopening
          // `absolute` by name would hand the kernel a name the SFTP session
          // itself can rewrite: a client is free to `rm` a file and the server's
          // own process to put a symlink in its place, between the resolution
          // above and this line. The refusal comes back as a `PathEscapeError`
          // thrown inside `run`, so it reaches `fail` and becomes
          // `PERMISSION_DENIED` like any other escape — the `error` listener
          // below only ever covers failures that happen once bytes are flowing.
          const stream = await jail.createWriteStream(absolute);

          // Without this handler, a write error — disk full, permission
          // denied — becomes an uncaught `error` event, and Node ends the
          // process. The whole daemon would fall over, with the consoles of
          // every server on the machine, because one user tried to upload a
          // file.
          stream.on('error', (error) => {
            logger.error({ err: error, server: serverUuid }, 'SFTP write failed');
            stream.destroy();
          });

          // The allowance is captured at open time and counted down as the
          // client writes. SFTP never announces a size, so there is nothing to
          // check up front — only as it arrives.
          sftp.handle(
            reqId,
            allocate({
              type: 'file',
              path,
              writeStream: stream,
              written: 0,
              room: jail.remainingBytes(),
            }),
          );
          return;
        }

        // Check existence before announcing a valid handle: `stat` is what
        // turns a missing file into NO_SUCH_FILE, where the open below would
        // only report an opaque failure.
        await jail.stat(path);

        // The jail opens the file, once, and READ works on that descriptor
        // afterwards. Keeping the *name* and reopening it per read would hand
        // the kernel a name the server's own process can rewrite between two
        // chunks: leave a genuine file there long enough for the checks above to
        // pass, then `ln -sfn /etc/shadow` on it, and the rest of the download
        // comes from the link's target, read as root.
        const file = await jail.openForRead(absolute);

        sftp.handle(reqId, allocate({ type: 'file', path, readHandle: file }));
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

      entry.written = (entry.written ?? 0) + data.length;

      if (entry.written > (entry.room ?? Number.POSITIVE_INFINITY)) {
        // The partial file is left for the jail to clean up on CLOSE: writing
        // more would take the volume further past a limit already reached.
        logger.warn({ server: serverUuid, path: entry.path }, 'SFTP write refused: disk limit');
        entry.writeStream.destroy();
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      entry.writeStream.write(data, (error) => {
        sftp.status(reqId, error ? STATUS.FAILURE : STATUS.OK);
      });
    }) as never);

    sftp.on('READ', ((reqId: number, handle: Buffer, offset: number, length: number) => {
      const entry = handles.get(handle.toString());

      if (!entry?.readHandle) {
        sftp.status(reqId, STATUS.FAILURE);
        return;
      }

      const file = entry.readHandle;

      void (async () => {
        // Read at an explicit position rather than sequentially: SFTP names the
        // offset in every request and clients issue several at once, out of
        // order, to fill the pipe. A positional read leaves the descriptor's own
        // cursor alone, so those requests cannot tread on each other.
        //
        // The buffer is sized against what the file actually holds past the
        // offset, not against `length` alone. `length` is a client-supplied
        // 32-bit integer and the allocation happens before a byte is read, so
        // capping it at 512 KiB still leaves a request costing thirty thousand
        // times what it asks for: pipeline a megabyte of READs for 4 GiB each
        // against a one-byte file and the daemon allocates its way out of
        // memory, taking every console on the node with it. `fstat` on the
        // descriptor is free and removes the amplification entirely.
        const { size } = await file.stat();
        const remaining = Math.max(0, size - offset);
        const wanted = Math.min(length, MAX_SFTP_READ_BYTES, remaining);

        if (wanted === 0) {
          sftp.status(reqId, STATUS.EOF);
          return;
        }

        const buffer = Buffer.allocUnsafe(wanted);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);

        if (bytesRead === 0) {
          sftp.status(reqId, STATUS.EOF);
          return;
        }

        sftp.data(reqId, buffer.subarray(0, bytesRead));
      })().catch(() => sftp.status(reqId, STATUS.FAILURE));
    }) as never);

    sftp.on('CLOSE', ((reqId: number, handle: Buffer) => {
      const key = handle.toString();
      const entry = handles.get(key);

      handles.delete(key);

      if (entry?.writeStream) {
        entry.writeStream.end(() => sftp.status(reqId, STATUS.OK));
        return;
      }

      if (entry?.readHandle) {
        // The descriptor lives as long as the SFTP handle now, so CLOSE is what
        // releases it. A failure to close is not worth an error to the client —
        // it has its bytes — but leaving it unhandled would reject a promise
        // nobody awaits, which Node turns into a process exit.
        void entry.readHandle.close().catch(() => undefined);
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

    // A client that vanishes mid-transfer never sends CLOSE, and once the
    // channel is gone nothing will ever mention these handles again. The
    // descriptor a read holds would then stay open for as long as the daemon
    // runs — one per abandoned download, and abandoning one costs a `Ctrl-C`.
    sftp.on('close', () => {
      for (const entry of handles.values()) {
        entry.writeStream?.destroy();
        void entry.readHandle?.close().catch(() => undefined);
      }

      handles.clear();
    });
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

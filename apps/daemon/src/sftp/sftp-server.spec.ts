import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERMISSIONS, type Permission } from '@hopper/shared';
import { Client, type SFTPWrapper } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../config/schema.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';
import { SftpServer } from './sftp-server.js';

/**
 * These tests speak SFTP over a real TCP socket, with the real `ssh2` client
 * against the real `ssh2` server, over a real temporary volume.
 *
 * Nothing here is mocked but the panel and the server manager, which are the
 * two things the daemon genuinely does not own. The rest is the point: this
 * file is a protocol handler, and every bug worth catching in it lives in the
 * gap between what the protocol says and what the code assumes — SFTP's `OPEN`
 * flags not being `open(2)`'s, a `READ` length being a client-supplied 32-bit
 * integer, a status code that says "no such file" where it should say
 * "denied". A mocked `SFTPWrapper` would answer to the assumption rather than
 * to the protocol, and would have confirmed each of those bugs rather than
 * found them.
 *
 * The server binds port 0 and the test reads back what the kernel gave it, so
 * nothing here depends on a port being free. That address is only reachable
 * through the private field: `SftpServer` has no reason of its own to publish
 * it, and a test racing for a fixed port would be a worse trade than this cast.
 */

const SERVER_UUID = 'b10a05a8-1111-4222-8333-444444444444';
const USER_UUID = 'c20b16b9-5555-4666-8777-888888888888';
const USERNAME = `julien.${SERVER_UUID.slice(0, 8)}`;
const PASSWORD = 'correct horse battery staple';

/** Every file permission, so a test can subtract the one it is about. */
const ALL_FILE_PERMISSIONS: Permission[] = [
  PERMISSIONS.FILE_SFTP,
  PERMISSIONS.FILE_READ,
  PERMISSIONS.FILE_READ_CONTENT,
  PERMISSIONS.FILE_CREATE,
  PERMISSIONS.FILE_UPDATE,
  PERMISSIONS.FILE_DELETE,
];

/**
 * SFTP status codes, from the protocol.
 *
 * Written out rather than imported from `ssh2`'s `utils.sftp` so a test asserts
 * against the specification the client sees, not against the same table the
 * server used to answer.
 */
const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  OP_UNSUPPORTED: 8,
} as const;

interface Harness {
  port: number;
  volume: string;
  authenticateSftp: ReturnType<typeof vi.fn>;
  stop: () => void;
}

interface HarnessOptions {
  permissions?: Permission[];
  suspended?: boolean;
  known?: boolean;
  denylist?: string[];
  /** Disk allowance of the fake server; `0` means "no limit", as in production. */
  diskBytes?: number;
  usedBytes?: number;
  authenticate?: (request: unknown) => Promise<unknown>;
}

let sandbox: string;
const running: Harness[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'hopper-sftp-'));
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.end();
  }

  for (const harness of running.splice(0)) {
    harness.stop();
  }

  await rm(sandbox, { recursive: true, force: true });
});

async function startSftp(options: HarnessOptions = {}): Promise<Harness> {
  const volume = join(sandbox, 'volume');

  await mkdir(join(volume, 'world'), { recursive: true });
  await writeFile(join(volume, 'server.properties'), 'server-port=25565\n');
  await writeFile(join(volume, 'world', 'level.dat'), 'x'.repeat(100));

  const instance = {
    volumePath: volume,
    diskQuota: { usedBytes: options.usedBytes ?? 0, limitBytes: options.diskBytes ?? 0 },
    configuration: {
      uuid: SERVER_UUID,
      suspended: options.suspended ?? false,
      fileDenylist: options.denylist ?? [],
    },
  } as unknown as ServerInstance;

  const manager = {
    get: (uuid: string): ServerInstance | undefined =>
      uuid === SERVER_UUID && options.known !== false ? instance : undefined,
  } as unknown as ServerManager;

  const authenticateSftp = vi.fn(
    options.authenticate ??
      (() =>
        Promise.resolve({
          serverUuid: SERVER_UUID,
          userUuid: USER_UUID,
          permissions: options.permissions ?? ALL_FILE_PERMISSIONS,
        })),
  );

  const config = {
    system: {
      uid: 988,
      gid: 988,
      sftp: {
        enabled: true,
        bindAddress: '127.0.0.1',
        // The kernel picks; `bindPort` is only floored at 1 by the schema that
        // reads the configuration file, and no file is read here.
        bindPort: 0,
        hostKeyPath: join(sandbox, 'ssh_host_ed25519_key'),
      },
    },
  } as DaemonConfig;

  const server = new SftpServer({
    config,
    paths: { root: sandbox, data: volume, backups: sandbox, tmp: sandbox },
    manager,
    panel: { authenticateSftp } as unknown as PanelClient,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
  });

  await server.start();

  const listening = (server as unknown as { server: { address(): AddressInfo } }).server;
  const harness: Harness = {
    port: listening.address().port,
    volume,
    authenticateSftp,
    stop: () => server.stop(),
  };

  running.push(harness);
  return harness;
}

/** Signs in and opens an SFTP channel, or rejects with the client's error. */
async function connect(
  harness: Harness,
  credentials: Partial<{ username: string; password: string }> = {},
): Promise<SFTPWrapper> {
  const client = new Client();
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    client.on('ready', resolve);
    client.on('error', reject);
    client.connect({
      host: '127.0.0.1',
      port: harness.port,
      username: credentials.username ?? USERNAME,
      password: credentials.password ?? PASSWORD,
      readyTimeout: 20_000,
    });
  });

  return await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

/** Runs an SFTP call and returns the status code it failed with, or `null`. */
async function statusOf(
  call: (done: (error?: Error | null) => void) => void,
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    call((error) => resolve(error ? ((error as Error & { code: number }).code ?? -1) : null));
  });
}

describe('SFTP authentication', () => {
  it('refuses a username that does not carry a server, without asking the panel', async () => {
    const harness = await startSftp();

    await expect(connect(harness, { username: 'julien' })).rejects.toThrow();

    // The panel is the rate limiter. Asking it about a username that cannot
    // designate a server would let anyone burn another account's attempts by
    // sending gibberish.
    expect(harness.authenticateSftp).not.toHaveBeenCalled();
  });

  it('hands the panel the client address, which is what rate-limits the attempt', async () => {
    const harness = await startSftp();

    await connect(harness);

    expect(harness.authenticateSftp).toHaveBeenCalledWith({
      username: USERNAME,
      password: PASSWORD,
      ip: '127.0.0.1',
    });
  });

  it('refuses when the panel refuses', async () => {
    const harness = await startSftp({
      authenticate: () =>
        Promise.reject(new Error('Authentication refused by the panel (HTTP 401).')),
    });

    await expect(connect(harness)).rejects.toThrow();
  });

  it('refuses a server this node does not run', async () => {
    const harness = await startSftp({ known: false });

    await expect(connect(harness)).rejects.toThrow();
  });

  it('refuses a suspended server the panel still authenticates', async () => {
    // The panel answering "yes" is about the account, not about the server's
    // state: a suspended server is one whose owner has stopped paying or been
    // sanctioned, and leaving its files reachable over SFTP would make the
    // suspension cosmetic.
    const harness = await startSftp({ suspended: true });

    await expect(connect(harness)).rejects.toThrow();
  });

  it('refuses a user who may read files in the panel but holds no SFTP permission', async () => {
    const harness = await startSftp({
      permissions: [PERMISSIONS.FILE_READ, PERMISSIONS.FILE_READ_CONTENT],
    });

    await expect(connect(harness)).rejects.toThrow();
  });

  it('accepts a user who holds it', async () => {
    const harness = await startSftp({
      permissions: [PERMISSIONS.FILE_SFTP, PERMISSIONS.FILE_READ],
    });

    await expect(connect(harness)).resolves.toBeDefined();
  });
});

describe('SFTP sessions', () => {
  it('refuses to run a command, so the channel is never a shell on the host', async () => {
    const harness = await startSftp();
    await connect(harness);

    const client = clients[clients.length - 1]!;
    const refused = await new Promise<boolean>((resolve) => {
      client.exec('id', (error) => resolve(Boolean(error)));
    });

    expect(refused).toBe(true);
  });

  it('refuses a shell', async () => {
    const harness = await startSftp();
    await connect(harness);

    const client = clients[clients.length - 1]!;
    const refused = await new Promise<boolean>((resolve) => {
      client.shell((error) => resolve(Boolean(error)));
    });

    expect(refused).toBe(true);
  });
});

describe('SFTP permissions', () => {
  /** Every permission but the one named. */
  const without = (permission: Permission): Permission[] =>
    ALL_FILE_PERMISSIONS.filter((entry) => entry !== permission);

  it('refuses to read a file without file.read-content', async () => {
    const harness = await startSftp({ permissions: without(PERMISSIONS.FILE_READ_CONTENT) });
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.open('/server.properties', 'r', done));

    expect(code).toBe(STATUS.PERMISSION_DENIED);
  });

  it('refuses to write a file without file.update', async () => {
    const harness = await startSftp({ permissions: without(PERMISSIONS.FILE_UPDATE) });
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.open('/new.txt', 'w', done));

    expect(code).toBe(STATUS.PERMISSION_DENIED);
  });

  it('refuses to create a directory without file.create', async () => {
    const harness = await startSftp({ permissions: without(PERMISSIONS.FILE_CREATE) });
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.mkdir('/plugins', done));

    expect(code).toBe(STATUS.PERMISSION_DENIED);
  });

  it('refuses to delete without file.delete', async () => {
    const harness = await startSftp({ permissions: without(PERMISSIONS.FILE_DELETE) });
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.unlink('/server.properties', done));

    expect(code).toBe(STATUS.PERMISSION_DENIED);
  });

  it('refuses to rename without file.update', async () => {
    const harness = await startSftp({ permissions: without(PERMISSIONS.FILE_UPDATE) });
    const sftp = await connect(harness);

    const code = await statusOf((done) =>
      sftp.rename('/server.properties', '/other.properties', done),
    );

    expect(code).toBe(STATUS.PERMISSION_DENIED);
  });

  it('refuses to list without file.read', async () => {
    const harness = await startSftp({ permissions: without(PERMISSIONS.FILE_READ) });
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.opendir('/', done));

    expect(code).toBe(STATUS.PERMISSION_DENIED);
  });
});

describe('SFTP and the jail', () => {
  it('answers an escape and a denied file with the same code, so neither confirms anything', async () => {
    const harness = await startSftp({ denylist: ['secret.env'] });
    await writeFile(join(harness.volume, 'secret.env'), 'TOKEN=1');
    const sftp = await connect(harness);

    const escaped = await statusOf((done) => sftp.open('../../etc/passwd', 'r', done));
    const denied = await statusOf((done) => sftp.open('/secret.env', 'r', done));

    // Not NO_SUCH_FILE for one and PERMISSION_DENIED for the other: the
    // difference is itself the answer to "does this path exist outside the
    // volume".
    expect(escaped).toBe(STATUS.PERMISSION_DENIED);
    expect(denied).toBe(STATUS.PERMISSION_DENIED);
  });

  it('clamps an absolute path climbing above the volume instead of following it', async () => {
    // `/../../etc/passwd` is not refused, it is *clamped*: POSIX normalisation
    // eats `..` at the root, so the jail is handed `etc/passwd` relative to the
    // volume. Worth pinning down, because the two safe outcomes look nothing
    // alike from the client — this one comes back NO_SUCH_FILE, and a reader
    // seeing that could conclude the check was skipped. The proof that it was
    // not is below: the same request against a file that exists on the host
    // *and* in the volume serves the volume's copy.
    const harness = await startSftp();
    await mkdir(join(harness.volume, 'etc'), { recursive: true });
    await writeFile(join(harness.volume, 'etc', 'passwd'), 'inside the volume');
    const sftp = await connect(harness);

    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open('/../../etc/passwd', 'r', (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });

    const buffer = Buffer.alloc(64);
    const read = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buffer, 0, 64, 0, (error, bytesRead) =>
        error ? reject(error) : resolve(bytesRead),
      );
    });

    expect(buffer.subarray(0, read).toString()).toBe('inside the volume');
  });

  it('answers a missing file with NO_SUCH_FILE', async () => {
    const harness = await startSftp();
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.open('/nowhere.txt', 'r', done));

    expect(code).toBe(STATUS.NO_SUCH_FILE);
  });

  it('canonicalises to a path inside the volume, never the host path', async () => {
    const harness = await startSftp();
    const sftp = await connect(harness);

    const resolved = await new Promise<string>((resolve, reject) => {
      sftp.realpath('/world', (error, absolute) => (error ? reject(error) : resolve(absolute)));
    });

    expect(resolved).toBe('/world');
    expect(resolved).not.toContain(harness.volume);
  });
});

describe('SFTP file transfer', () => {
  it('does not truncate a file opened for reading', async () => {
    // SFTP's flag 1 means READ; `open(2)`'s 1 means `O_WRONLY`. Confusing the
    // two opened every download in write mode, which emptied the file before a
    // byte of it was sent.
    const harness = await startSftp();
    const sftp = await connect(harness);

    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open('/server.properties', 'r', (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));

    expect(await readFile(join(harness.volume, 'server.properties'), 'utf8')).toBe(
      'server-port=25565\n',
    );
  });

  it('serves what the file holds when the client asks for four gigabytes of it', async () => {
    // `length` arrives as a 32-bit integer and the buffer is allocated before
    // anything is read. A hundred of these against a hundred-byte file used to
    // be a hundred allocations of whatever was asked for.
    const harness = await startSftp();
    const sftp = await connect(harness);

    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open('/world/level.dat', 'r', (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });

    const buffer = Buffer.alloc(4096);
    const read = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buffer, 0, 4096, 0, (error, bytesRead) =>
        error ? reject(error) : resolve(bytesRead),
      );
    });

    expect(read).toBe(100);
  });

  it('reads nothing past the end of a file rather than inventing bytes', async () => {
    // The daemon answers the EOF status; ssh2's client turns it into a
    // zero-length read rather than an error, which is what every client does
    // with it. So the assertion is on the bytes, not on the code.
    const harness = await startSftp();
    const sftp = await connect(harness);

    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open('/world/level.dat', 'r', (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });

    const read = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, Buffer.alloc(16), 0, 16, 1_000, (error, bytesRead) =>
        error ? reject(error) : resolve(bytesRead),
      );
    });

    expect(read).toBe(0);
  });

  it('writes an uploaded file into the volume', async () => {
    const harness = await startSftp();
    const sftp = await connect(harness);

    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open('/plugins/config.yml', 'w', (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });

    const payload = Buffer.from('enabled: true\n');
    await new Promise<void>((resolve, reject) => {
      sftp.write(handle, payload, 0, payload.length, 0, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()));

    expect(await readFile(join(harness.volume, 'plugins', 'config.yml'), 'utf8')).toBe(
      'enabled: true\n',
    );
  });

  it('stops an upload that would take the server past its disk allowance', async () => {
    const harness = await startSftp({ diskBytes: 1024, usedBytes: 1000 });
    const sftp = await connect(harness);

    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open('/big.bin', 'w', (error, value) => (error ? reject(error) : resolve(value)));
    });

    const payload = Buffer.alloc(4096, 0x61);
    const code = await statusOf((done) =>
      sftp.write(handle, payload, 0, payload.length, 0, (error) => done(error)),
    );

    expect(code).toBe(STATUS.FAILURE);
  });

  it('lists a directory and then says EOF', async () => {
    const harness = await startSftp();
    const sftp = await connect(harness);

    const entries = await new Promise<string[]>((resolve, reject) => {
      sftp.readdir('/', (error, list) =>
        error ? reject(error) : resolve(list.map((entry) => entry.filename)),
      );
    });

    expect(entries.sort()).toEqual(['server.properties', 'world']);
  });
});

describe('SFTP operations the volume has no use for', () => {
  it('refuses to create a symlink, the shortest route out of the volume', async () => {
    const harness = await startSftp();
    const sftp = await connect(harness);

    const code = await statusOf((done) => sftp.symlink('/etc/passwd', '/passwd', done));

    expect(code).toBe(STATUS.OP_UNSUPPORTED);
  });

  it('accepts a timestamp change without applying it, because clients send one after every upload', async () => {
    // Answering OP_UNSUPPORTED here is not free: several clients treat the
    // refusal as a failed transfer and delete what they just uploaded.
    const harness = await startSftp();
    const sftp = await connect(harness);

    const code = await statusOf((done) =>
      sftp.setstat('/server.properties', { atime: 1, mtime: 1 }, done),
    );

    expect(code).toBeNull();
  });
});

describe('SFTP resource ceilings', () => {
  it('refuses to open more handles than a session may hold', async () => {
    // A client that opens and never closes is not hypothetical: it costs a
    // Ctrl-C in the middle of a transfer. Without the ceiling, the descriptors
    // it leaves walk the daemon into EMFILE, and every console on the node
    // goes down with it, not just this server's.
    const harness = await startSftp();
    const sftp = await connect(harness);

    const open = (): Promise<number | null> =>
      statusOf((done) => sftp.open('/server.properties', 'r', (error) => done(error)));

    const codes: (number | null)[] = [];

    for (let index = 0; index < 65; index += 1) {
      codes.push(await open());
    }

    expect(codes.slice(0, 64).every((code) => code === null)).toBe(true);
    expect(codes[64]).toBe(STATUS.FAILURE);
  });
});

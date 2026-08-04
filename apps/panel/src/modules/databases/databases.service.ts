import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  IdentifierError,
  assertSafeHostPattern,
  databaseNameFor,
  userNameFor,
} from './identifiers.js';
import { MysqlClientService, type HostCredentials } from './mysql-client.service.js';

/**
 * Databases assigned to servers.
 *
 * A database lives on a **host** declared by an administrator: a MySQL or
 * MariaDB server the panel holds an administration account for. The panel
 * creates the database there, a dedicated account, and grants that account
 * rights on that database only — a Minecraft server must be able to read
 * nothing of the others.
 *
 * The generated password is **encrypted, not hashed**: the user has to read it
 * back to write it into their plugin's configuration. It is the same trade-off
 * as for node tokens, and it is accepted — a secret one has to present cannot
 * be one-way.
 */
@Injectable()
export class DatabasesService {
  private readonly logger = new Logger(DatabasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mysql: MysqlClientService,
  ) {}

  async list(serverUuid: string) {
    const server = await this.requireServer(serverUuid);

    const databases = await this.prisma.database.findMany({
      where: { serverId: server.id },
      orderBy: { createdAt: 'asc' },
      include: { host: true },
    });

    const hosts = await this.availableHosts(server.nodeId);

    return {
      data: databases.map((entry) => this.toPublic(entry)),
      meta: {
        limit: server.databaseLimit,
        used: databases.length,
        /** With no host declared, the create button would lead nowhere. */
        hostsAvailable: hosts.length,
      },
    };
  }

  async create(serverUuid: string, input: { name: string; remote?: string }) {
    const server = await this.requireServer(serverUuid);

    if (server.databaseLimit <= 0) {
      throw new BadRequestException(
        'This server is not allowed to hold databases.',
      );
    }

    const used = await this.prisma.database.count({ where: { serverId: server.id } });

    if (used >= server.databaseLimit) {
      throw new ConflictException(
        `This server already uses its ${server.databaseLimit} allowed database(s).`,
      );
    }

    const hosts = await this.availableHosts(server.nodeId);
    const host = hosts[0];

    if (!host) {
      throw new ConflictException(
        'No database server is declared for this node. ' +
          'Un administrateur doit en ajouter un.',
      );
    }

    let database: string;
    let username: string;
    let remote: string;

    try {
      database = databaseNameFor(server.id, input.name);
      // Eight hexadecimal bytes: enough that two databases of the same server
      // never fight over an account, short enough for MySQL's 32-character
      // limit.
      username = userNameFor(server.id, randomBytes(4).toString('hex'));
      remote = assertSafeHostPattern(input.remote ?? '');
    } catch (error: unknown) {
      if (error instanceof IdentifierError) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }

    const existing = await this.prisma.database.findFirst({
      where: { hostId: host.id, database },
    });

    if (existing) {
      throw new ConflictException('A database already bears this name on this server.');
    }

    // 24 bytes: the password is never typed by hand, so it may as well be out
    // of reach of an offline attack.
    const password = randomBytes(24).toString('base64url');

    await this.mysql.createDatabase(this.credentialsOf(host), {
      database,
      username,
      password,
      remote,
    });

    try {
      const created = await this.prisma.database.create({
        data: {
          serverId: server.id,
          hostId: host.id,
          database,
          username,
          passwordEncrypted: this.crypto.encrypt(password),
          remote,
        },
        include: { host: true },
      });

      return this.toPublic(created);
    } catch (error: unknown) {
      // The database exists on the SQL server but not in the panel: without
      // this removal it would become invisible and nobody could use or delete
      // it any more.
      this.logger.error(`Enregistrement de ${database} impossible, retrait : ${String(error)}`);

      await this.mysql
        .dropDatabase(this.credentialsOf(host), { database, username, remote })
        .catch(() => undefined);

      throw error;
    }
  }

  /** Regenerates the password. The old one stops working at once. */
  async rotatePassword(serverUuid: string, databaseUuid: string) {
    const entry = await this.requireDatabase(serverUuid, databaseUuid);
    const password = randomBytes(24).toString('base64url');

    await this.mysql.updatePassword(this.credentialsOf(entry.host), {
      username: entry.username,
      remote: entry.remote,
      password,
    });

    const updated = await this.prisma.database.update({
      where: { id: entry.id },
      data: { passwordEncrypted: this.crypto.encrypt(password) },
      include: { host: true },
    });

    return this.toPublic(updated);
  }

  async remove(serverUuid: string, databaseUuid: string): Promise<void> {
    const entry = await this.requireDatabase(serverUuid, databaseUuid);

    await this.mysql.dropDatabase(this.credentialsOf(entry.host), {
      database: entry.database,
      username: entry.username,
      remote: entry.remote,
    });

    await this.prisma.database.delete({ where: { id: entry.id } });
  }

  /**
   * Hosts a server can use.
   *
   * Those attached to its node first, then the general hosts: a database is
   * better off close to the server querying it, since a plugin's every query
   * crosses the network on every tick.
   */
  private async availableHosts(nodeId: number) {
    return this.prisma.databaseHost.findMany({
      where: { OR: [{ nodeId }, { nodeId: null }] },
      orderBy: [{ nodeId: 'desc' }, { id: 'asc' }],
    });
  }

  private credentialsOf(host: {
    host: string;
    port: number;
    username: string;
    passwordEncrypted: string;
  }): HostCredentials {
    return {
      host: host.host,
      port: host.port,
      username: host.username,
      password: this.crypto.decrypt(host.passwordEncrypted),
    };
  }

  private toPublic(entry: {
    uuid: string;
    database: string;
    username: string;
    passwordEncrypted: string;
    remote: string;
    createdAt: Date;
    host: {
      name: string;
      host: string;
      port: number;
      publicHost: string | null;
      publicPort: number | null;
    };
  }) {
    // The announced address is the one by which the **player** reaches the SQL
    // server, often different from the panel's: the panel happily goes through
    // an internal network unreachable from outside.
    const host = entry.host.publicHost ?? entry.host.host;
    const port = entry.host.publicPort ?? entry.host.port;

    return {
      uuid: entry.uuid,
      name: entry.database,
      username: entry.username,
      password: this.crypto.decrypt(entry.passwordEncrypted),
      remote: entry.remote,
      host: { name: entry.host.name, address: host, port },
      /** String ready to paste into a plugin's configuration. */
      connectionString: `mysql://${entry.username}@${host}:${port}/${entry.database}`,
      createdAt: entry.createdAt,
    };
  }

  private async requireServer(uuid: string) {
    const server = await this.prisma.server.findUnique({ where: { uuid } });

    if (!server) {
      throw new NotFoundException('Serveur introuvable.');
    }

    return server;
  }

  private async requireDatabase(serverUuid: string, databaseUuid: string) {
    const server = await this.requireServer(serverUuid);

    const entry = await this.prisma.database.findFirst({
      where: { uuid: databaseUuid, serverId: server.id },
      include: { host: true },
    });

    if (!entry) {
      throw new NotFoundException('Database not found.');
    }

    return entry;
  }
}

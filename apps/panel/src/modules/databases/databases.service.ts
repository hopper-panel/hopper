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
 * Bases de données attribuées aux serveurs.
 *
 * Une base vit sur un **host** déclaré par un administrateur : un serveur
 * MySQL ou MariaDB dont le panel connaît un compte d'administration. Le panel y
 * crée la base, un compte dédié, et n'accorde à ce compte que les droits sur
 * cette base — un serveur Minecraft ne doit rien pouvoir lire des autres.
 *
 * Le mot de passe généré est **chiffré et non haché** : l'utilisateur doit
 * pouvoir le relire pour l'écrire dans la configuration de son plugin. C'est le
 * même compromis que pour les jetons de node, et il est assumé — un secret
 * qu'on doit présenter ne peut pas être à sens unique.
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
        /** Sans host déclaré, le bouton de création ne mènerait nulle part. */
        hostsAvailable: hosts.length,
      },
    };
  }

  async create(serverUuid: string, input: { name: string; remote?: string }) {
    const server = await this.requireServer(serverUuid);

    if (server.databaseLimit <= 0) {
      throw new BadRequestException(
        "Ce serveur n'est pas autorisé à disposer de bases de données.",
      );
    }

    const used = await this.prisma.database.count({ where: { serverId: server.id } });

    if (used >= server.databaseLimit) {
      throw new ConflictException(
        `Ce serveur utilise déjà ses ${server.databaseLimit} base(s) autorisée(s).`,
      );
    }

    const hosts = await this.availableHosts(server.nodeId);
    const host = hosts[0];

    if (!host) {
      throw new ConflictException(
        "Aucun serveur de bases de données n'est déclaré pour ce node. " +
          'Un administrateur doit en ajouter un.',
      );
    }

    let database: string;
    let username: string;
    let remote: string;

    try {
      database = databaseNameFor(server.id, input.name);
      // Huit octets hexadécimaux : assez pour que deux bases d'un même serveur
      // ne se disputent jamais un compte, assez court pour la limite de 32
      // caractères de MySQL.
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
      throw new ConflictException('Une base porte déjà ce nom sur ce serveur.');
    }

    // 24 octets : le mot de passe n'est jamais tapé à la main, autant le rendre
    // hors de portée d'une attaque hors ligne.
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
      // La base existe sur le serveur SQL mais pas dans le panel : sans ce
      // retrait, elle deviendrait invisible et personne ne pourrait plus ni
      // l'utiliser ni la supprimer.
      this.logger.error(`Enregistrement de ${database} impossible, retrait : ${String(error)}`);

      await this.mysql
        .dropDatabase(this.credentialsOf(host), { database, username, remote })
        .catch(() => undefined);

      throw error;
    }
  }

  /** Régénère le mot de passe. L'ancien cesse aussitôt de fonctionner. */
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
   * Hosts utilisables par un serveur.
   *
   * Ceux rattachés à son node d'abord, puis les hosts généraux : une base
   * gagne à vivre près du serveur qui l'interroge, chaque requête d'un plugin
   * traversant le réseau à chaque tick.
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
    // L'adresse annoncée est celle par laquelle le **joueur** joint le serveur
    // SQL, souvent différente de celle qu'emprunte le panel : celui-ci passe
    // volontiers par un réseau interne inaccessible de l'extérieur.
    const host = entry.host.publicHost ?? entry.host.host;
    const port = entry.host.publicPort ?? entry.host.port;

    return {
      uuid: entry.uuid,
      name: entry.database,
      username: entry.username,
      password: this.crypto.decrypt(entry.passwordEncrypted),
      remote: entry.remote,
      host: { name: entry.host.name, address: host, port },
      /** Chaîne prête à coller dans la configuration d'un plugin. */
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
      throw new NotFoundException('Base de données introuvable.');
    }

    return entry;
  }
}

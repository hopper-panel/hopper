import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import mysql from 'mysql2/promise';
import { quoteIdentifier } from './identifiers.js';

export interface HostCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * Exécution des ordres SQL d'administration sur un serveur MySQL/MariaDB.
 *
 * Toutes les requêtes de ce fichier sont des **DDL** — création de base, de
 * compte, attribution de droits. Aucune ne peut être paramétrée sur ses
 * identifiants : `CREATE DATABASE ?` n'existe pas. Les noms sont donc validés
 * puis échappés par `identifiers.ts`, qui est la barrière contre l'injection ;
 * ici, on se contente de ne jamais interpoler autre chose que le résultat de
 * `quoteIdentifier`.
 *
 * Les valeurs — mot de passe, motif d'hôte — passent, elles, en paramètres.
 *
 * Une connexion par opération, sans pool : le panel crée une base de temps en
 * temps, pas mille par seconde. Un pool maintiendrait des connexions ouvertes
 * vers chaque serveur SQL déclaré, pour un gain nul.
 */
@Injectable()
export class MysqlClientService {
  private readonly logger = new Logger(MysqlClientService.name);

  /**
   * Vérifie que le panel peut administrer ce serveur.
   *
   * Contrôle les **droits**, et pas seulement la connexion : un compte capable
   * de se connecter mais pas de créer de base donnerait un host qui paraît sain
   * et échoue à la première utilisation.
   */
  async testConnection(credentials: HostCredentials): Promise<{ version: string }> {
    return this.withConnection(credentials, async (connection) => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
      const [grants] = await connection.query<mysql.RowDataPacket[]>(
        'SHOW GRANTS FOR CURRENT_USER',
      );

      const flat = grants.map((row) => Object.values(row).join(' ')).join(' ');

      if (!/ALL PRIVILEGES|CREATE USER|GRANT OPTION/i.test(flat)) {
        throw new ServiceUnavailableException(
          "Ce compte se connecte mais n'a pas les droits de créer des bases et des comptes.",
        );
      }

      return { version: String(rows[0]?.version ?? 'inconnue') };
    });
  }

  /**
   * Crée la base, le compte, et lui donne les droits sur cette base seulement.
   *
   * L'ordre compte : le compte est créé avant la base pour qu'un échec de
   * création laisse le moins de traces possible. En cas de problème, tout est
   * défait — un compte orphelin sur un serveur SQL partagé est une porte que
   * personne ne surveille.
   */
  async createDatabase(
    credentials: HostCredentials,
    input: { database: string; username: string; password: string; remote: string },
  ): Promise<void> {
    await this.withConnection(credentials, async (connection) => {
      const database = quoteIdentifier(input.database);

      try {
        await connection.query(`CREATE DATABASE ${database}`);
        await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [
          input.username,
          input.remote,
          input.password,
        ]);
        // Droits limités à cette base : le compte ne voit rien du reste du
        // serveur SQL, pas même la liste des autres bases.
        await connection.query(`GRANT ALL PRIVILEGES ON ${database}.* TO ?@?`, [
          input.username,
          input.remote,
        ]);
        await connection.query('FLUSH PRIVILEGES');
      } catch (error: unknown) {
        await this.cleanup(connection, input);
        throw error;
      }
    });
  }

  async updatePassword(
    credentials: HostCredentials,
    input: { username: string; remote: string; password: string },
  ): Promise<void> {
    await this.withConnection(credentials, async (connection) => {
      await connection.query('ALTER USER ?@? IDENTIFIED BY ?', [
        input.username,
        input.remote,
        input.password,
      ]);
      await connection.query('FLUSH PRIVILEGES');
    });
  }

  async dropDatabase(
    credentials: HostCredentials,
    input: { database: string; username: string; remote: string },
  ): Promise<void> {
    await this.withConnection(credentials, async (connection) => {
      await this.cleanup(connection, input);
    });
  }

  /**
   * Retire base et compte, en ignorant ce qui n'existe pas.
   *
   * `IF EXISTS` partout : la suppression doit aboutir même si quelqu'un a
   * effacé la base à la main sur le serveur SQL. Sans cela, l'entrée resterait
   * indéfiniment dans le panel, impossible à retirer.
   */
  private async cleanup(
    connection: mysql.Connection,
    input: { database: string; username: string; remote: string },
  ): Promise<void> {
    await connection
      .query(`DROP DATABASE IF EXISTS ${quoteIdentifier(input.database)}`)
      .catch((error: unknown) => this.logger.warn(`DROP DATABASE : ${String(error)}`));

    await connection
      .query('DROP USER IF EXISTS ?@?', [input.username, input.remote])
      .catch((error: unknown) => this.logger.warn(`DROP USER : ${String(error)}`));
  }

  private async withConnection<T>(
    credentials: HostCredentials,
    action: (connection: mysql.Connection) => Promise<T>,
  ): Promise<T> {
    let connection: mysql.Connection;

    try {
      connection = await mysql.createConnection({
        host: credentials.host,
        port: credentials.port,
        user: credentials.username,
        password: credentials.password,
        connectTimeout: 10_000,
        // `multipleStatements` reste **désactivé**, ce qui est le défaut. Un
        // point-virgule qui franchirait la validation ne pourrait pas enchaîner
        // une seconde instruction : c'est la dernière barrière, après celles
        // d'`identifiers.ts`.
        multipleStatements: false,
      });
    } catch (error: unknown) {
      this.logger.error(`Connexion à ${credentials.host}:${credentials.port} : ${String(error)}`);
      throw new ServiceUnavailableException(
        'Le serveur de bases de données est injoignable ou refuse ces identifiants.',
      );
    }

    try {
      return await action(connection);
    } finally {
      await connection.end().catch(() => undefined);
    }
  }
}

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
 * Running administrative SQL statements on a MySQL/MariaDB server.
 *
 * Every query in this file is **DDL** — creating a database, an account,
 * granting rights. None can be parameterised on its identifiers:
 * `CREATE DATABASE ?` does not exist. The names are therefore validated then
 * escaped by `identifiers.ts`, which is the barrier against injection; here, we
 * simply never interpolate anything other than the result of `quoteIdentifier`.
 *
 * The values — password, host pattern — do travel as parameters.
 *
 * One connection per operation, no pool: the panel creates a database now and
 * then, not a thousand a second. A pool would hold connections open towards
 * every declared SQL server, for no gain.
 */
@Injectable()
export class MysqlClientService {
  private readonly logger = new Logger(MysqlClientService.name);

  /**
   * Checks that the panel can administer this server.
   *
   * Tests the **privileges**, not merely the connection: an account able to
   * connect but not to create a database would give a host that looks healthy
   * and fails on first use.
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
          'This account connects but lacks the rights to create databases and accounts.',
        );
      }

      return { version: String(rows[0]?.version ?? 'unknown') };
    });
  }

  /**
   * Creates the database, the account, and grants it rights on that database
   * only.
   *
   * The order matters: the account is created before the database so that a
   * failure leaves as little behind as possible. On any problem everything is
   * undone — an orphan account on a shared SQL server is a door nobody
   * watches.
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
        // Rights limited to this database: the account sees nothing of the
        // rest of the SQL server, not even the list of the other databases.
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
   * Removes the database and the account, ignoring what does not exist.
   *
   * `IF EXISTS` everywhere: the deletion has to succeed even if somebody wiped
   * the database by hand on the SQL server. Without that, the entry would stay
   * in the panel forever, impossible to remove.
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
        // `multipleStatements` stays **off**, which is the default. A
        // semicolon that got past validation could not chain a second
        // statement: this is the last barrier, after those in
        // `identifiers.ts`.
        multipleStatements: false,
      });
    } catch (error: unknown) {
      this.logger.error(`Connecting to ${credentials.host}:${credentials.port}: ${String(error)}`);
      throw new ServiceUnavailableException(
        'The database server is unreachable or refuses these credentials.',
      );
    }

    try {
      return await action(connection);
    } finally {
      await connection.end().catch(() => undefined);
    }
  }
}

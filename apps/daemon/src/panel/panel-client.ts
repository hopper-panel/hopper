import {
  REMOTE_ROUTES,
  remoteServersResponseSchema,
  sftpAuthResponseSchema,
  type BackupReport,
  type ServerConfiguration,
  type SftpAuthRequest,
  type SftpAuthResponse,
  type StatusReport,
} from '@hopper/shared';
import type { DaemonConfig } from '../config/schema.js';
import type { Logger } from '../logger.js';

/**
 * The daemon's HTTP client towards the panel.
 *
 * The daemon has no database: what it knows of the servers comes entirely from
 * here. It authenticates with the same node token as the one it accepts on
 * input — the panel checks it against its encrypted copy.
 */
export class PanelClient {
  constructor(
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
  ) {}

  private get token(): string {
    return `${this.config.tokenId}.${this.config.tokenSecret}`;
  }

  /**
   * Fetches every server this node has to host.
   *
   * Paginated: an instance hosting hundreds of servers must not demand a single
   * multi-megabyte response, nor a processing time that would make the request
   * expire.
   */
  async fetchServers(): Promise<ServerConfiguration[]> {
    const servers: ServerConfiguration[] = [];
    let page = 1;
    // Set by the first response, which always happens before the condition is
    // read: the loop is a do/while precisely so the panel decides how many
    // pages there are, rather than this starting from a guess.
    let lastPage: number;

    do {
      const url = new URL(REMOTE_ROUTES.servers, this.config.panel.url);
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', '50');

      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'The panel refused this node token. Regenerate it from the node page.'
            : `The panel answered ${response.status} on ${REMOTE_ROUTES.servers}.`,
        );
      }

      const parsed = remoteServersResponseSchema.safeParse(await response.json());

      if (!parsed.success) {
        throw new Error(
          'Unreadable answer from the panel: the panel and daemon versions are probably incompatible.',
        );
      }

      servers.push(...parsed.data.data);
      lastPage = parsed.data.meta.lastPage;
      page += 1;
    } while (page <= lastPage);

    this.logger.info({ count: servers.length }, 'Servers fetched from the panel');

    return servers;
  }

  /**
   * Reports the outcome of an installation.
   *
   * This callback is what moves the server from "Installing" to "Ready" in the
   * interface: without it, a perfectly installed server would keep showing as
   * installing forever.
   */
  async reportInstall(serverUuid: string, successful: boolean, reinstall = false): Promise<void> {
    const response = await fetch(
      new URL(REMOTE_ROUTES.serverInstall(serverUuid), this.config.panel.url),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ successful, reinstall }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(`The panel answered ${response.status} to the install report.`);
    }
  }

  /**
   * Tells the panel about a state change.
   *
   * The panel does not store this state — it could not keep it up to date — but
   * it needs it on the fly for outgoing notifications. A failure of this call
   * therefore has no consequence for the server: it is logged, not retried, and
   * the timeout is short so as not to hold the daemon on an unavailable
   * panel.
   */
  async reportStatus(serverUuid: string, report: StatusReport): Promise<void> {
    const response = await fetch(
      new URL(REMOTE_ROUTES.serverStatus(serverUuid), this.config.panel.url),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!response.ok) {
      throw new Error(`The panel answered ${response.status} to the status report.`);
    }
  }

  /**
   * Tells the panel the fate of a backup.
   *
   * This callback is what gives the backup its size, its digest and its
   * verdict. Without it, the backup would stay "running": the panel cannot
   * guess an archive has been closed, and watching the disk on its behalf would
   * invert the division of roles.
   *
   * The timeout is generous because the panel writes to the database and may
   * apply retention in the same breath — a successful backup must not be
   * counted as failed over one second too many.
   */
  async reportBackup(backupUuid: string, report: BackupReport): Promise<void> {
    const response = await fetch(
      new URL(REMOTE_ROUTES.backupStatus(backupUuid), this.config.panel.url),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw new Error(`The panel answered ${response.status} to the backup report.`);
    }
  }

  /**
   * Authenticates an SFTP connection with the panel.
   *
   * The daemon knows neither the accounts, nor the passwords, nor the
   * permissions: it delegates entirely. That is also what lets the panel apply
   * its rate limit to SFTP attempts, just as it does to web sign-ins.
   */
  async authenticateSftp(request: SftpAuthRequest): Promise<SftpAuthResponse> {
    const response = await fetch(new URL(REMOTE_ROUTES.sftpAuth, this.config.panel.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Authentication refused by the panel (HTTP ${response.status}).`);
    }

    const parsed = sftpAuthResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error('Unreadable SFTP authentication answer.');
    }

    return parsed.data;
  }
}

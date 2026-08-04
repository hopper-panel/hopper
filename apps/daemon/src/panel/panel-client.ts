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
 * Client HTTP du daemon vers le panel.
 *
 * Le daemon n'a aucune base de données : sa connaissance des serveurs vient
 * entièrement d'ici. Il s'authentifie avec le même jeton de node que celui
 * qu'il accepte en entrée — le panel le vérifie contre sa copie chiffrée.
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
   * Récupère tous les serveurs que ce node doit héberger.
   *
   * Paginé : une instance qui héberge des centaines de serveurs ne doit pas
   * exiger une seule réponse de plusieurs mégaoctets, ni un temps de traitement
   * qui ferait expirer la requête.
   */
  async fetchServers(): Promise<ServerConfiguration[]> {
    const servers: ServerConfiguration[] = [];
    let page = 1;
    let lastPage = 1;

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
            ? 'Le panel a refusé le jeton de ce node. Régénérez-le depuis la page du node.'
            : `Le panel a répondu ${response.status} sur ${REMOTE_ROUTES.servers}.`,
        );
      }

      const parsed = remoteServersResponseSchema.safeParse(await response.json());

      if (!parsed.success) {
        throw new Error(
          'Réponse du panel illisible : les versions du panel et du daemon sont probablement incompatibles.',
        );
      }

      servers.push(...parsed.data.data);
      lastPage = parsed.data.meta.lastPage;
      page += 1;
    } while (page <= lastPage);

    this.logger.info({ count: servers.length }, 'Serveurs récupérés depuis le panel');

    return servers;
  }

  /**
   * Rapporte l'issue d'une installation.
   *
   * C'est ce rappel qui fait passer le serveur de « Installation » à « Prêt »
   * dans l'interface : sans lui, un serveur parfaitement installé resterait
   * affiché comme en cours d'installation indéfiniment.
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
      throw new Error(`Le panel a répondu ${response.status} au rapport d'installation.`);
    }
  }

  /**
   * Signale au panel un changement d'état.
   *
   * Le panel ne stocke pas cet état — il ne saurait pas le tenir à jour — mais
   * il en a besoin au vol pour les notifications sortantes. L'échec de cet
   * appel n'a donc aucune conséquence sur le serveur : il est journalisé, pas
   * réessayé, et le délai est court pour ne pas retenir le daemon sur un panel
   * indisponible.
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
      throw new Error(`Le panel a répondu ${response.status} au rapport d'état.`);
    }
  }

  /**
   * Signale au panel le sort d'une sauvegarde.
   *
   * C'est ce rappel qui donne à la sauvegarde sa taille, son empreinte et son
   * verdict. Sans lui, elle resterait « en cours » : le panel ne peut pas
   * deviner qu'une archive est close, et surveiller le disque à sa place
   * inverserait la répartition des rôles.
   *
   * Le délai est large car le panel écrit en base et peut appliquer la
   * rétention dans la foulée — une sauvegarde réussie ne doit pas être comptée
   * en échec pour une seconde de trop.
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
      throw new Error(`Le panel a répondu ${response.status} au rapport de sauvegarde.`);
    }
  }

  /**
   * Authentifie une connexion SFTP auprès du panel.
   *
   * Le daemon ne connaît ni les comptes, ni les mots de passe, ni les
   * permissions : il délègue entièrement. C'est aussi ce qui permet au panel
   * d'appliquer sa limitation de débit sur les tentatives SFTP, au même titre
   * que sur les connexions web.
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
      throw new Error(`Authentification refusée par le panel (HTTP ${response.status}).`);
    }

    const parsed = sftpAuthResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error("Réponse d'authentification SFTP illisible.");
    }

    return parsed.data;
  }
}

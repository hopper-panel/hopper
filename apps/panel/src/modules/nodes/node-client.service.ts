import type { Readable } from 'node:stream';
import {
  CONTRACT_VERSION,
  DAEMON_ROUTES,
  redactNodeToken,
  serverStatusResponseSchema,
  systemInformationSchema,
  type PowerAction,
  type ServerConfiguration,
  type ServerState,
  type SystemInformation,
} from '@hopper/shared';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** Coordonnées d'un daemon. En phase 1, elles viendront de la table `Node`. */
export interface NodeConnection {
  uuid: string;
  /** URL de base du daemon, ex. `https://node1.example.com:8443`. */
  url: string;
  /** Jeton complet `<id>.<secret>`. */
  token: string;
}

export type NodeHealth =
  | { reachable: true; system: SystemInformation; latencyMs: number }
  | { reachable: false; reason: string; latencyMs: number };

/**
 * Client HTTP vers un daemon.
 *
 * Toutes les erreurs sont converties en résultat structuré plutôt qu'en
 * exception : un node injoignable est un état normal du système, pas un bug. Le
 * panel doit continuer à servir l'interface et afficher le node hors ligne.
 */
@Injectable()
export class NodeClientService {
  private readonly logger = new Logger(NodeClientService.name);

  /** Un daemon injoignable ne doit pas bloquer le rendu d'une page. */
  private static readonly TIMEOUT_MS = 5000;

  async fetchSystemInformation(node: NodeConnection): Promise<NodeHealth> {
    const startedAt = performance.now();

    try {
      const response = await fetch(new URL(DAEMON_ROUTES.system, node.url), {
        headers: {
          authorization: `Bearer ${node.token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(NodeClientService.TIMEOUT_MS),
      });

      const latencyMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        this.logger.warn(
          `Node ${node.uuid} a répondu ${response.status} (jeton ${redactNodeToken(node.token)})`,
        );
        return {
          reachable: false,
          reason:
            response.status === 401
              ? 'Jeton de node refusé par le daemon.'
              : `Le daemon a répondu ${response.status}.`,
          latencyMs,
        };
      }

      // Un écart de version majeure du contrat signifie que le panel et le
      // daemon ne parlent plus la même langue : mieux vaut le dire tout de
      // suite que laisser échouer une création de serveur plus tard.
      const remoteContract = response.headers.get('x-hopper-contract');
      if (remoteContract && remoteContract !== CONTRACT_VERSION) {
        return {
          reachable: false,
          reason: `Version de contrat incompatible : le daemon annonce ${remoteContract}, le panel attend ${CONTRACT_VERSION}.`,
          latencyMs,
        };
      }

      const parsed = systemInformationSchema.safeParse(await response.json());
      if (!parsed.success) {
        return {
          reachable: false,
          reason:
            'Réponse du daemon illisible : la version du daemon est probablement trop ancienne.',
          latencyMs,
        };
      }

      return { reachable: true, system: parsed.data, latencyMs };
    } catch (error: unknown) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `Aucune réponse du daemon en ${NodeClientService.TIMEOUT_MS} ms.`
          : 'Connexion au daemon impossible.';

      this.logger.warn(`Node ${node.uuid} injoignable : ${reason}`);
      return { reachable: false, reason, latencyMs };
    }
  }

  // -------------------------------------------------------------------------
  // Pilotage des serveurs
  // -------------------------------------------------------------------------

  /**
   * Crée le serveur sur le daemon et lance son installation.
   * Contrairement aux sondes d'état, un échec lève : créer un serveur en base
   * sans que le daemon n'en sache rien laisserait un enregistrement fantôme.
   */
  async createServer(
    node: NodeConnection,
    configuration: ServerConfiguration,
    startOnCompletion: boolean,
  ): Promise<void> {
    await this.send(node, DAEMON_ROUTES.servers, 'POST', { configuration, startOnCompletion });
  }

  /** Transmet une configuration à jour sans toucher au conteneur. */
  async syncServer(node: NodeConnection, configuration: ServerConfiguration): Promise<void> {
    await this.send(node, DAEMON_ROUTES.serverSync(configuration.uuid), 'POST', configuration);
  }

  async powerServer(node: NodeConnection, uuid: string, action: PowerAction): Promise<void> {
    await this.send(node, DAEMON_ROUTES.serverPower(uuid), 'POST', { action, wait: false });
  }

  /** Envoie des commandes à la console du serveur. */
  async sendCommands(node: NodeConnection, uuid: string, commands: string[]): Promise<void> {
    await this.send(node, DAEMON_ROUTES.serverCommands(uuid), 'POST', { commands });
  }

  /**
   * État courant d'un serveur, tel que le daemon le voit.
   *
   * Rend `null` si le node est injoignable ou répond de travers : l'appelant —
   * le planificateur — doit pouvoir distinguer « le serveur est arrêté » de
   * « on ne sait pas », et ne pas prendre le second pour le premier.
   */
  async fetchServerState(node: NodeConnection, uuid: string): Promise<ServerState | null> {
    try {
      const response = await fetch(new URL(DAEMON_ROUTES.server(uuid), node.url), {
        headers: { authorization: `Bearer ${node.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(NodeClientService.TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const parsed = serverStatusResponseSchema.safeParse(await response.json());

      return parsed.success ? parsed.data.state : null;
    } catch {
      return null;
    }
  }

  async deleteServer(node: NodeConnection, uuid: string, purgeVolume: boolean): Promise<void> {
    await this.send(node, DAEMON_ROUTES.server(uuid), 'DELETE', { purgeVolume });
  }

  /**
   * Relaie une requête vers le daemon et rend sa réponse telle quelle.
   *
   * Utilisé par l'API fichiers : le panel décide *qui* a le droit de faire
   * quoi, le daemon décide *où* — c'est lui qui détient le jail. Réimplémenter
   * la validation des chemins côté panel créerait deux vérités, et celle qui
   * dériverait serait forcément la mauvaise.
   *
   * Les corps d'erreur du daemon sont transmis sans réécriture : ils sont déjà
   * rédigés pour être lus par un utilisateur, et les masquer priverait celui-ci
   * de la raison du refus.
   */
  async proxy(
    node: NodeConnection,
    path: string,
    options: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number },
  ): Promise<{ status: number; contentType: string | null; body: Buffer }> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method: options.method,
        headers: {
          authorization: `Bearer ${node.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Compresser un monde de plusieurs gigaoctets prend du temps ; la
        // requête ne doit pas expirer avant que le daemon n'ait fini.
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
    } catch (error: unknown) {
      this.logger.error(`Relais ${options.method} ${path} vers ${node.uuid} : ${String(error)}`);
      throw new ServiceUnavailableException('Le node est injoignable.');
    }

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  /**
   * Relaie une réponse du daemon **en flux**, sans la mettre en mémoire.
   *
   * `proxy` accumule le corps dans un `Buffer`, ce qui convient à une réponse
   * JSON mais pas à une archive de sauvegarde : un monde de quelques
   * gigaoctets ferait tomber le panel — et le ferait tomber pour tous ses
   * utilisateurs, pas seulement pour celui qui télécharge.
   *
   * Aucun délai n'est posé : la durée d'un téléchargement dépend du débit du
   * client, et couper au bout d'un temps fixe pénaliserait précisément les
   * connexions lentes qui en ont le plus besoin.
   */
  async stream(
    node: NodeConnection,
    path: string,
  ): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method: 'GET',
        headers: { authorization: `Bearer ${node.token}` },
      });
    } catch (error: unknown) {
      this.logger.error(`Flux GET ${path} vers ${node.uuid} : ${String(error)}`);
      throw new ServiceUnavailableException('Le node est injoignable.');
    }

    return { status: response.status, headers: response.headers, body: response.body };
  }

  /**
   * Retransmet un corps de requête **en flux** vers le daemon.
   *
   * Le pendant de `stream` pour l'envoi. Le fichier ne tient à aucun moment en
   * mémoire dans le panel : les octets reçus du navigateur repartent vers le
   * node au fil de leur arrivée. Sans cela, envoyer un modpack de deux
   * gigaoctets ferait tomber le panel pour tout le monde.
   */
  async pipeTo(
    node: NodeConnection,
    path: string,
    body: Readable,
    contentLength: string | undefined,
  ): Promise<{ status: number; contentType: string | null; body: Buffer }> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${node.token}`,
          'content-type': 'application/octet-stream',
          ...(contentLength ? { 'content-length': contentLength } : {}),
        },
        body,
        // Exigé par `fetch` dès que le corps est un flux : la requête commence
        // à partir avant que la réponse n'existe.
        duplex: 'half',
      });
    } catch (error: unknown) {
      this.logger.error(`Envoi vers ${node.uuid} sur ${path} : ${String(error)}`);
      throw new ServiceUnavailableException('Le node est injoignable.');
    }

    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  private async send(
    node: NodeConnection,
    path: string,
    method: 'POST' | 'DELETE',
    body: unknown,
  ): Promise<void> {
    let response: Response;

    try {
      response = await fetch(new URL(path, node.url), {
        method,
        headers: {
          authorization: `Bearer ${node.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // Plus généreux que la sonde d'état : créer un serveur peut impliquer
        // le téléchargement d'une image Docker.
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error: unknown) {
      this.logger.error(
        `Appel ${method} ${path} vers le node ${node.uuid} impossible (jeton ${redactNodeToken(node.token)}) : ${String(error)}`,
      );
      throw new ServiceUnavailableException(
        "Le node est injoignable. L'opération n'a pas été appliquée.",
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Node ${node.uuid} a répondu ${response.status} sur ${path} : ${detail}`);

      throw new ServiceUnavailableException(
        response.status === 401
          ? 'Jeton de node refusé par le daemon. Régénérez-le depuis la page du node.'
          : `Le daemon a refusé l'opération (HTTP ${response.status}).`,
      );
    }
  }
}

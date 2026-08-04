import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
  type Permission,
  type PowerAction,
  type ResourceUsage,
  type ServerState,
} from '@hopper/shared';
import { api } from './api';

interface ConsoleCredentials {
  socketUrl: string;
  token: string;
  expiresIn: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface ConsoleController {
  status: ConnectionStatus;
  state: ServerState;
  permissions: Permission[];
  /**
   * S'abonne aux relevés de ressources. Rend la fonction de désabonnement.
   *
   * Un abonnement plutôt qu'une valeur d'état : le daemon émet un relevé par
   * seconde, et le tenir dans un `useState` faisait re-rendre la mise en page du
   * serveur — donc **tous** les onglets — à cette cadence. Un écran de
   * permissions ouvert par-dessus se reconstruisait ainsi une fois par seconde
   * pour afficher des chiffres qu'il ne montre pas.
   */
  onUsage: (handler: (usage: ResourceUsage) => void) => () => void;
  /** Enregistre le récepteur des lignes de console. */
  onLine: (handler: (line: string) => void) => void;
  /**
   * Lignes déjà reçues, les plus anciennes d'abord.
   *
   * Rendues par une fonction et non par un état : une ligne de console arrive
   * plusieurs fois par milliseconde au démarrage d'un serveur, et déclencher un
   * rendu React à chacune figerait l'onglet.
   */
  getHistory: () => string[];
  sendCommand: (command: string) => void;
  setPower: (action: PowerAction) => void;
}

/** Délais de reconnexion, en millisecondes. Le dernier est répété. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * Lignes conservées côté navigateur pour rejouer la console.
 *
 * La connexion vit désormais dans la mise en page du serveur et survit aux
 * changements d'onglet, ce qui est exactement ce qu'on veut — sauf que le
 * terminal, lui, est détruit et recréé. Sans ce tampon, revenir sur la console
 * après un détour par les fichiers afficherait un écran vide, alors que le
 * serveur n'a jamais cessé de parler : le daemon ne rejoue son propre tampon
 * qu'à l'authentification, qui n'a pas lieu de nouveau.
 */
const HISTORY_LIMIT = 2000;

/**
 * Connexion à la console d'un serveur.
 *
 * Le navigateur parle **directement au daemon** : le panel ne sert qu'à
 * délivrer un jeton de courte durée. Ce hook gère le cycle complet — obtention
 * du jeton, connexion, renouvellement avant expiration, reconnexion après une
 * coupure réseau.
 */
export function useConsole(serverUuid: string): ConsoleController {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [state, setState] = useState<ServerState>('offline');
  const [permissions, setPermissions] = useState<Permission[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const lineHandlerRef = useRef<(line: string) => void>(() => undefined);
  const historyRef = useRef<string[]>([]);
  const usageListeners = useRef(new Set<(usage: ResourceUsage) => void>());
  const attemptRef = useRef(0);

  const onLine = useCallback((handler: (line: string) => void) => {
    lineHandlerRef.current = handler;
  }, []);

  const getHistory = useCallback(() => historyRef.current, []);

  const onUsage = useCallback((handler: (usage: ResourceUsage) => void) => {
    usageListeners.current.add(handler);

    return () => {
      usageListeners.current.delete(handler);
    };
  }, []);

  /** Achemine une ligne vers le terminal, et la garde pour un rejeu ultérieur. */
  const emit = useCallback((line: string) => {
    historyRef.current.push(line);

    if (historyRef.current.length > HISTORY_LIMIT) {
      historyRef.current.splice(0, historyRef.current.length - HISTORY_LIMIT);
    }

    lineHandlerRef.current(line);
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(clientMessageSchema.parse(message)));
    }
  }, []);

  const sendCommand = useCallback(
    (command: string) => send({ event: 'send_command', command }),
    [send],
  );

  const setPower = useCallback(
    (action: PowerAction) => send({ event: 'set_state', action }),
    [send],
  );

  useEffect(() => {
    /**
     * Drapeau **local à cette exécution de l'effet**, et non une `ref`.
     *
     * Une `ref` survit au démontage : en mode strict, React monte, démonte,
     * puis remonte. Le nettoyage du premier montage la passait à `false`, mais
     * le second montage la remettait aussitôt à `true` — si bien que la
     * connexion du premier montage, encore en vol, se croyait toujours active
     * et ouvrait son socket. Deux WebSockets recevaient alors les mêmes lignes,
     * et la console affichait tout en double.
     *
     * Une variable de fermeture appartient à une seule exécution : celle du
     * premier montage reste `false` quoi qu'il arrive ensuite.
     */
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    async function connect(): Promise<void> {
      if (!active) {
        return;
      }

      try {
        const credentials = await api.get<ConsoleCredentials>(`/api/servers/${serverUuid}/console`);

        // L'obtention du jeton est asynchrone : l'effet a pu être nettoyé
        // pendant ce temps.
        if (!active) {
          return;
        }

        // Référence non nullable pour les gestionnaires : `socket` reste
        // `WebSocket | null` du point de vue du nettoyage, mais à l'intérieur
        // de cette connexion l'objet existe forcément.
        const connection = new WebSocket(credentials.socketUrl);
        socket = connection;
        socketRef.current = connection;

        connection.onopen = () => {
          // Une connexion neuve reçoit le tampon du daemon juste après
          // l'authentification : on repart de zéro pour ne pas empiler une
          // seconde copie des mêmes lignes après une reconnexion. Le
          // renouvellement de jeton, lui, se fait sur la connexion en cours et
          // ne rejoue rien — d'où la remise à zéro ici et non à `auth_success`.
          historyRef.current = [];
          connection.send(JSON.stringify({ event: 'auth', token: credentials.token }));
        };

        connection.onmessage = (event: MessageEvent<string>) => {
          const parsed = serverMessageSchema.safeParse(JSON.parse(event.data));

          if (!parsed.success) {
            return;
          }

          const message = parsed.data;

          switch (message.event) {
            case 'auth_success':
              attemptRef.current = 0;
              setStatus('connected');
              setPermissions(message.permissions);
              break;

            case 'token_expiring':
              // Le jeton arrive à échéance : on en demande un nouveau et on se
              // ré-authentifie sur la même connexion, sans coupure visible.
              void api
                .get<ConsoleCredentials>(`/api/servers/${serverUuid}/console`)
                .then((renewed) =>
                  connection.send(JSON.stringify({ event: 'auth', token: renewed.token })),
                )
                .catch(() => setStatus('failed'));
              break;

            case 'status':
              setState(message.state);
              break;

            case 'stats':
              // Diffusé hors de React : aucun rendu n'est déclenché pour les
              // écrans qui n'affichent pas ces chiffres.
              usageListeners.current.forEach((handler) => handler(message.usage));
              break;

            case 'console_output':
              emit(message.line);
              break;

            case 'daemon_message':
              emit(`[Hopper] ${message.message}`);
              break;

            case 'error':
              emit(`[Hopper] ${message.message}`);
              break;

            case 'token_expired':
              // Le renouvellement n'a pas abouti à temps : le daemon ferme la
              // connexion, `onclose` déclenche une reconnexion complète.
              setStatus('reconnecting');
              break;

            case 'install_started':
            case 'install_output':
            case 'install_completed':
            case 'backup_completed':
            case 'backup_restore_completed':
              // Traités par les écrans d'installation et de sauvegarde, aux
              // phases 3 et 5. Listés explicitement pour que l'ajout d'un
              // événement au contrat casse la compilation ici.
              break;
          }
        };

        connection.onclose = () => {
          socketRef.current = null;

          if (!active) {
            return;
          }

          const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)]!;
          attemptRef.current += 1;
          setStatus('reconnecting');
          reconnectTimer = window.setTimeout(() => void connect(), delay);
        };

        connection.onerror = () => connection.close();
      } catch {
        if (!active) {
          return;
        }

        // Échec de l'obtention du jeton : le serveur a pu être supprimé ou nos
        // droits révoqués. On réessaie, mais sans insister indéfiniment vite.
        const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)]!;
        attemptRef.current += 1;
        setStatus(attemptRef.current > 3 ? 'failed' : 'reconnecting');
        reconnectTimer = window.setTimeout(() => void connect(), delay);
      }
    }

    void connect();

    return () => {
      active = false;
      window.clearTimeout(reconnectTimer);

      // `onclose` est retiré avant la fermeture : sans cela, fermer le socket
      // déclencherait la reconnexion automatique que l'on cherche justement à
      // arrêter.
      if (socket) {
        socket.onclose = null;
        socket.close();
      }

      // La référence partagée n'est effacée que si elle désigne encore *notre*
      // socket : un remontage a pu la réassigner entre-temps.
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [serverUuid, emit]);

  return { status, state, permissions, onLine, onUsage, getHistory, sendCommand, setPower };
}

/**
 * Relevés de ressources récents, du plus ancien au plus récent.
 *
 * L'état vit **ici** et non dans le contrôleur : seul le composant qui appelle
 * ce hook se rend à chaque relevé, au lieu de toute la mise en page du serveur.
 *
 * L'historique est conservé plutôt que le seul dernier relevé, pour les courbes
 * de la page de console. Il n'est pas partagé entre montages : revenir sur la
 * console repart d'un graphe vide, ce qui reste honnête — un historique
 * reconstitué depuis un tampon montrerait une continuité que la mesure n'a pas.
 */
export function useUsageHistory(
  controller: ConsoleController,
  limit = 60,
): readonly ResourceUsage[] {
  const [history, setHistory] = useState<ResourceUsage[]>([]);
  const { onUsage } = controller;

  useEffect(
    () => onUsage((usage) => setHistory((previous) => [...previous, usage].slice(-limit))),
    [onUsage, limit],
  );

  return history;
}

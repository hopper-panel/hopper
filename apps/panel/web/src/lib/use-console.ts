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

/**
 * RFC 6455's "policy violation", and the daemon's answer to a socket it will
 * never accept — an origin absent from `api.allowedOrigins`. Distinguished
 * from every other close because it is the one that cannot be waited out.
 */
const POLICY_VIOLATION = 1008;

export interface ConsoleController {
  status: ConnectionStatus;
  state: ServerState;
  permissions: Permission[];
  /** The reason the far end refused, when the close carried one. */
  failure: string | null;
  /**
   * Subscribes to resource samples. Returns the unsubscribe function.
   *
   * A subscription rather than a state value: the daemon emits one sample per
   * second, and holding it in a `useState` re-rendered the server layout — so
   * **every** tab — at that rate. A permissions screen opened on top was thus
   * rebuilt once a second to display figures it does not show.
   */
  onUsage: (handler: (usage: ResourceUsage) => void) => () => void;
  /** Registers the receiver of console lines. */
  onLine: (handler: (line: string) => void) => void;
  /**
   * Lines already received, oldest first.
   *
   * Returned by a function and not by state: a console line arrives several
   * times per millisecond when a server starts, and triggering a React render
   * on each would freeze the tab.
   */
  getHistory: () => string[];
  sendCommand: (command: string) => void;
  setPower: (action: PowerAction) => void;
}

/** Reconnection delays, in milliseconds. The last one repeats. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * Lines kept browser-side to replay the console.
 *
 * The connection now lives in the server layout and survives tab changes, which
 * is exactly what we want — except that the terminal itself is destroyed and
 * recreated. Without this buffer, coming back to the console after a detour
 * through the files would show an empty screen, even though the server never
 * stopped talking: the daemon only replays its own buffer on authentication,
 * which does not happen again.
 */
const HISTORY_LIMIT = 2000;

/**
 * Connection to a server's console.
 *
 * The browser talks **directly to the daemon**: the panel only issues a
 * short-lived token. This hook handles the whole cycle — obtaining the token,
 * connecting, renewing before expiry, reconnecting after a network drop.
 */
export function useConsole(serverUuid: string): ConsoleController {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [state, setState] = useState<ServerState>('offline');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  /** What the far end said when it refused, when it said anything. */
  const [failure, setFailure] = useState<string | null>(null);

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

  /** Routes a line to the terminal, and keeps it for a later replay. */
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
     * Flag **local to this run of the effect**, not a `ref`.
     *
     * A `ref` survives unmounting: in strict mode React mounts, unmounts, then
     * mounts again. The first mount's cleanup set it to `false`, but the second
     * mount immediately set it back to `true` — so the first mount's
     * connection, still in flight, believed it was active and opened its
     * socket. Two WebSockets then received the same lines, and the console
     * showed everything twice.
     *
     * A closure variable belongs to a single run: the first mount's stays
     * `false` whatever happens next.
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

        // Obtaining the token is asynchronous: the effect may have been cleaned
        // up in the meantime.
        if (!active) {
          return;
        }

        // Non-nullable reference for the handlers: `socket` stays
        // `WebSocket | null` from the cleanup's point of view, but inside this
        // connection the object necessarily exists.
        const connection = new WebSocket(credentials.socketUrl);
        socket = connection;
        socketRef.current = connection;

        connection.onopen = () => {
          // A fresh connection receives the daemon's buffer right after
          // authentication: start from scratch so as not to stack a second copy
          // of the same lines after a reconnect. Token renewal, in contrast,
          // happens on the current connection and replays nothing — hence the
          // reset here and not on `auth_success`.
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
              // The token is about to expire: ask for a new one and
              // re-authenticate on the same connection, with no visible break.
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
              // Broadcast outside React: no render is triggered for the screens
              // that do not display these figures.
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
              // Renewal did not land in time: the daemon closes the connection,
              // `onclose` triggers a full reconnect.
              setStatus('reconnecting');
              break;

            case 'install_started':
            case 'install_output':
            case 'install_completed':
            case 'backup_completed':
            case 'backup_restore_completed':
              // Handled by the install and backup screens. Listed explicitly so
              // that adding an event to the contract breaks compilation here.
              break;
          }
        };

        connection.onclose = (event) => {
          socketRef.current = null;

          if (!active) {
            return;
          }

          /*
           * A refusal is not a dropped connection, and retrying it is not
           * patience — it is a loop that never ends.
           *
           * 1008 is what the daemon closes with when it will not accept this
           * socket at all: an origin that is not on its list, which is what a
           * panel reached by an address the node has never been told about
           * looks like. Reconnecting every thirty seconds produced exactly
           * that in the daemon's log, for ever, while the page showed a
           * console that was merely empty — and the input under it said the
           * reader lacked permission, because permissions arrive on a
           * connection that had never been made.
           *
           * So it stops, and `failed` is what the page reports. The reason the
           * daemon gave travels with it: the operator can read "Origin not
           * allowed." and go to the address their node knows, which is the one
           * piece of information that ends this.
           */
          if (event.code === POLICY_VIOLATION) {
            setStatus('failed');
            setFailure(event.reason || null);
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

        // Failed to obtain the token: the server may have been deleted or our
        // rights revoked. Retry, but without insisting quickly forever.
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

      // `onclose` is removed before closing: without that, closing the socket
      // would trigger the very automatic reconnect we are trying to stop.
      if (socket) {
        socket.onclose = null;
        socket.close();
      }

      // The shared reference is only cleared if it still points at *our*
      // socket: a remount may have reassigned it in the meantime.
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [serverUuid, emit]);

  return {
    status,
    state,
    permissions,
    failure,
    onLine,
    onUsage,
    getHistory,
    sendCommand,
    setPower,
  };
}

/**
 * Recent resource samples, oldest to newest.
 *
 * The state lives **here** and not in the controller: only the component that
 * calls this hook re-renders on each sample, instead of the whole server
 * layout.
 *
 * The history is kept rather than just the latest sample, for the charts on the
 * console page. It is not shared across mounts: coming back to the console
 * starts from an empty chart, which stays honest — a history rebuilt from a
 * buffer would show a continuity the measurement does not have.
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

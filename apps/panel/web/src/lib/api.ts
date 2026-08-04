/**
 * Client HTTP du panel.
 *
 * L'authentification repose sur les cookies httpOnly posés par l'API : aucun
 * jeton n'est stocké côté JavaScript, donc une faille XSS ne permet pas d'en
 * exfiltrer un. En contrepartie, chaque requête doit être émise avec
 * `credentials: 'include'`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

interface ErrorBody {
  message?: string | string[];
  issues?: { path: string; message: string }[];
}

/** Refresh en cours, partagé : évite N rotations concurrentes sur une page qui
 *  déclenche plusieurs requêtes en même temps — et donc N révocations en
 *  cascade par le détecteur de réutilisation de jeton. */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};

  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // Réponse non JSON (502 d'un reverse proxy, page d'erreur HTML) : le
    // message générique ci-dessous vaut mieux qu'une exception de parsing.
  }

  const message = Array.isArray(body.message)
    ? body.message.join(', ')
    : (body.message ?? `Erreur ${response.status}`);

  return new ApiError(response.status, message, body.issues);
}

async function send<T>(path: string, options: RequestOptions, retry: boolean): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    signal: options.signal,
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // Une 401 sur une requête normale signifie presque toujours un access token
  // périmé : on tente une rotation silencieuse avant de renvoyer l'utilisateur
  // vers l'écran de connexion. Une seule fois, pour ne pas boucler.
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) {
      return send<T>(path, options, false);
    }
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => send<T>(path, { signal }, true),
  post: <T>(path: string, body?: unknown) => send<T>(path, { method: 'POST', body }, true),
  patch: <T>(path: string, body?: unknown) => send<T>(path, { method: 'PATCH', body }, true),
  delete: <T>(path: string) => send<T>(path, { method: 'DELETE' }, true),
};

// ---------------------------------------------------------------------------
// Types des réponses de l'API
// ---------------------------------------------------------------------------

export interface Paginated<T> {
  data: T[];
  meta: { currentPage: number; perPage: number; lastPage: number; total: number };
}

export interface CurrentUser {
  uuid: string;
  username: string;
  email: string;
  role: 'ADMIN' | 'USER';
  /** Nom de l'instance, réglé dans l'administration. */
  panelName: string;
  twoFactorEnabled: boolean;
  /** L'instance exige un second facteur que ce compte n'a pas encore activé. */
  mustEnableTwoFactor: boolean;
}

export interface ServerSummary {
  uuid: string;
  name: string;
  description: string;
  status: string;
  memoryBytes: number;
  diskBytes: number;
  cpuPercent: number;
  node: { uuid: string; name: string; fqdn: string };
  template: { uuid: string; name: string };
  primaryAllocation: { ip: string; port: number; alias: string | null } | null;
  isOwner: boolean;
  createdAt: string;
}

export interface NodeSummary {
  uuid: string;
  name: string;
  description: string;
  fqdn: string;
  scheme: string;
  port: number;
  sftpPort: number;
  memoryBytes: number;
  diskBytes: number;
  maintenance: boolean;
  daemonTokenId: string;
  serverCount: number;
  allocationCount: number;
  createdAt: string;
}

export interface UserSummary {
  uuid: string;
  email: string;
  username: string;
  role: 'ADMIN' | 'USER';
  suspended: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AllocationSummary {
  id: number;
  ip: string;
  port: number;
  alias: string | null;
  assignedTo: { uuid: string; name: string } | null;
}

export type NodeHealth =
  | { reachable: true; latencyMs: number; system: { version: string; cpuCount: number } }
  | { reachable: false; latencyMs: number; reason: string };

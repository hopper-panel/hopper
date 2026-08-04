/**
 * The panel's HTTP client.
 *
 * Authentication rests on the httpOnly cookies the API sets: no token is stored
 * on the JavaScript side, so an XSS flaw cannot exfiltrate one. In exchange,
 * every request has to be sent with `credentials: 'include'`.
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

/** In-flight refresh, shared: avoids N concurrent rotations on a page firing
 *  several requests at once — and therefore N cascading revocations by the
 *  token-reuse detector. */
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
    // A non-JSON answer (a reverse proxy's 502, an HTML error page): the
    // generic message below beats a parsing exception.
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

  // A 401 on a normal request nearly always means an expired access token: a
  // silent rotation is attempted before sending the user back to the sign-in
  // screen. Once only, so as not to loop.
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
// Types of the API responses
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
  /** Instance name, set in the administration. */
  panelName: string;
  twoFactorEnabled: boolean;
  /** The instance demands a second factor this account has not turned on yet. */
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

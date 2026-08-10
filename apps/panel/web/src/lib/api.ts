import type { ConfigFile, Readiness, StopConfiguration } from '@hopper/shared';

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
  /**
   * Shape used by the daemon, relayed verbatim by the panel.
   *
   * The panel's own errors are Nest's `{ message }`; the daemon nests them
   * under `error`. Reading only the flat one turned every refusal coming from
   * a node — forbidden path, invalid archive, disk limit — into a bare
   * "Error 403", which tells the user nothing they can act on.
   */
  error?: { code?: string; message?: string };
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

/** Exported for the tests: the two shapes it has to read are the whole point. */
export async function parseError(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};

  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A non-JSON answer (a reverse proxy's 502, an HTML error page): the
    // generic message below beats a parsing exception.
  }

  const message = Array.isArray(body.message)
    ? body.message.join(', ')
    : (body.message ?? body.error?.message ?? `Error ${response.status}`);

  return new ApiError(response.status, message, body.issues);
}

/**
 * The endpoints where a 401 is the answer rather than an accident.
 *
 * Signing in with the wrong password, a passkey assertion that does not verify,
 * a password-setup link that has expired: each of those returns 401 and means
 * it. Refreshing and retrying them would be pointless at best, and `refresh`
 * itself would recurse.
 *
 * **Everything else under `/api/auth` is an ordinary authenticated call**, and
 * the prefix test this replaces did not know the difference. `/api/auth/me` is
 * the one that mattered. It is what `AuthProvider` asks on every mount, the
 * access cookie lives exactly as long as the access token, and so coming back
 * to the panel more than fifteen minutes later meant: cookie gone, `me` answers
 * 401, no refresh even attempted because the path begins with `/api/auth/`, the
 * query resolves to "no session", and the sign-in screen appears. Every time,
 * on top of a refresh token good for thirty days and a session the database
 * still held as live. Changing the password and the 2FA endpoints were caught
 * by the same prefix and would have failed the same way once the access token
 * had expired.
 *
 * Listed rather than derived, because the property that matters — "reachable
 * while signed out" — is not visible in the path.
 */
const SIGN_IN_ENDPOINTS = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/password-setup',
  '/api/auth/passkeys/authenticate/',
];

function isSignInEndpoint(path: string): boolean {
  return SIGN_IN_ENDPOINTS.some((endpoint) => path.startsWith(endpoint));
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
  if (response.status === 401 && retry && !isSignInEndpoint(path)) {
    if (await refreshSession()) {
      return send<T>(path, options, false);
    }
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  /*
   * An empty body, not merely a 204.
   *
   * Two routes answer `202 Accepted` with nothing in them — reinstalling a
   * server, and running a schedule now — and this parsed them as JSON. An
   * empty string is not JSON, so `response.json()` threw a `SyntaxError`, the
   * mutation's `onError` ran, and the settings page said "Reinstall failed"
   * over a reinstall that had already been accepted, audited and started. It
   * did that every single time, and the only way to find out otherwise was to
   * look in the volume.
   *
   * Read as text and parsed here rather than special-casing 202 beside 204:
   * the property that matters is that there is nothing to parse, and a third
   * status answering emptily would otherwise be a third bug of exactly this
   * shape. `undefined` is what a caller typed `<void>` already expects.
   */
  const body = await response.text();

  return (body === '' ? undefined : JSON.parse(body)) as T;
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

/**
 * Templates, as the three administration screens read them.
 *
 * Declared here rather than in each page, and that is not tidying: the reason
 * the "edited" badge never appeared on any installation is that the catalogue
 * page declared a shape of its own, TypeScript checked the JSX against that
 * declaration, and the fields it named were never in the response. A single
 * declaration cannot drift from itself.
 *
 * `stop`, `readiness` and `configFiles` are taken from `@hopper/shared`, which
 * is the same contract the daemon parses — so the editor cannot describe a
 * template a node could not read.
 */
export interface TemplateGroupSummary {
  uuid: string;
  name: string;
  description: string;
  author: string;
  templateCount: number;
}

export interface TemplateSummary {
  uuid: string;
  key: string;
  name: string;
  description: string;
  author: string;
  modifiedByAdmin: boolean;
  serverCount: number;
  group: { uuid: string; name: string };
  dockerImages: { name: string; image: string }[];
  startup: string;
  /**
   * Only the variables a server's own users may see — the read view filters
   * the rest out, and the editor's `TemplateDetail` below carries them all.
   *
   * Here because the create-server form fills its variable fields from this
   * very response: both screens share the `['admin', 'templates']` cache, and
   * they described it two different ways until this declaration was the only
   * one.
   */
  variables: Omit<TemplateVariableDetail, 'userViewable'>[];
}

export interface TemplateVariableDetail {
  name: string;
  description: string;
  envVariable: string;
  defaultValue: string;
  /** A non-viewable variable is hidden from the server's own Startup tab. */
  userViewable: boolean;
  userEditable: boolean;
  rules: string;
}

export interface TemplateDetail {
  uuid: string;
  key: string;
  group: { uuid: string; name: string };
  name: string;
  description: string;
  author: string;
  modifiedByAdmin: boolean;

  dockerImages: { name: string; image: string }[];
  startup: string;

  stopCommand: string;
  stop: StopConfiguration | null;
  stopTimeoutSeconds: number | null;
  startupDetection: string | null;
  readiness: Readiness | null;

  configFiles: ConfigFile[];
  fileDenylist: string[];

  installContainer: string;
  installEntrypoint: string;
  installScript: string;
  installInactivityTimeoutMs: number | null;
  installRequiredDiskBytes: number | null;

  importedFromEgg: string | null;
  /** How many servers stand in the way of deleting it. */
  serverCount: number;
  variables: TemplateVariableDetail[];

  createdAt: string;
  updatedAt: string;
}

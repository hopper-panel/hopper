import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, type CurrentUser } from './api';

/**
 * The browser half of the two WebAuthn ceremonies.
 *
 * Both are the same shape: ask the server for options, hand them to the
 * authenticator, send back what it signed. The server chose the challenge and
 * is the only one that can say whether the answer is good — nothing here
 * decides anything, and nothing here should try to.
 *
 * Kept out of the components because the login page and the account page run
 * the same two round trips, and a second copy would be a second place for the
 * order of the calls to drift.
 */

/** True when the browser can do this at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function'
  );
}

export interface PasskeySummary {
  id: number;
  name: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export async function registerPasskey(name: string): Promise<PasskeySummary> {
  const options = await api.post<Record<string, unknown>>('/api/auth/passkeys/register/begin', {});
  const response = await startRegistration({ optionsJSON: options as never });

  return api.post<PasskeySummary>('/api/auth/passkeys/register/finish', { name, response });
}

export async function authenticateWithPasskey(): Promise<CurrentUser> {
  const options = await api.post<Record<string, unknown>>(
    '/api/auth/passkeys/authenticate/begin',
    {},
  );

  const response = await startAuthentication({ optionsJSON: options as never });

  const result = await api.post<{ status: string; user: CurrentUser }>(
    '/api/auth/passkeys/authenticate/finish',
    { response },
  );

  return result.user;
}

/**
 * Whether the user simply walked away.
 *
 * Cancelling the browser's prompt raises the same kind of error as a genuine
 * failure. Showing "sign-in failed" to someone who pressed Escape is telling
 * them something went wrong when nothing did.
 */
export function wasCancelled(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
  );
}

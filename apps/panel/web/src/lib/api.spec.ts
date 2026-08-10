import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, parseError } from './api';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The panel and the daemon do not shape their errors the same way, and the
 * panel relays the daemon's verbatim. Reading only one shape turned every
 * refusal coming from a node — forbidden path, invalid archive, disk limit —
 * into a bare "Error 403", which tells a user nothing they can act on.
 */
describe('parseError', () => {
  it("reads the panel's own shape", async () => {
    const error = await parseError(response(409, { message: 'This backup is still running.' }));

    expect(error.message).toBe('This backup is still running.');
  });

  it("reads the daemon's nested shape, relayed by the panel", async () => {
    const error = await parseError(
      response(507, {
        error: { code: 'disk_quota_exceeded', message: 'The server has reached its disk limit.' },
      }),
    );

    expect(error.message).toBe('The server has reached its disk limit.');
  });

  // Nest sends an array when several fields fail validation at once.
  it('joins the several messages of a validation failure', async () => {
    const error = await parseError(
      response(400, { message: ['name is required', 'port invalid'] }),
    );

    expect(error.message).toBe('name is required, port invalid');
  });

  // A reverse proxy's 502 is HTML, not JSON. Falling over while reporting an
  // error is how a small outage becomes an unreadable one.
  it('survives an answer that is not JSON', async () => {
    const error = await parseError(new Response('<html>502</html>', { status: 502 }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('502');
  });

  it('keeps the status for the caller to branch on', async () => {
    const error = await parseError(response(401, { message: 'Authentication required.' }));

    expect(error.status).toBe(401);
  });
});

/**
 * Which 401 is worth a silent rotation, and which is the answer.
 *
 * The distinction used to be the path's prefix, and `/api/auth/me` was on the
 * wrong side of it. That endpoint is what `AuthProvider` asks on every mount;
 * the access cookie lives exactly as long as the access token; so returning to
 * the panel a quarter of an hour later meant a 401 nothing tried to recover
 * from, a query resolving to "no session" and the sign-in screen — on top of a
 * refresh token good for thirty days.
 */
/**
 * What comes back when nothing comes back.
 *
 * Reinstalling a server answers `202 Accepted` with an empty body, and the
 * client parsed that as JSON. An empty string is not JSON, so the parse threw,
 * the mutation's `onError` ran, and the page reported "Reinstall failed" over a
 * reinstall that had been accepted, audited and started — every time, with the
 * volume as the only way to learn otherwise.
 */
describe('a response with no body', () => {
  function stub(status: number, body: string | null) {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(body, { status, headers: { 'Content-Type': 'application/json' } }),
      ),
    );

    vi.stubGlobal('fetch', fetch);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a 202 that carries nothing', async () => {
    stub(202, null);

    await expect(api.post('/api/servers/x/settings/reinstall')).resolves.toBeUndefined();
  });

  it('still resolves a 204', async () => {
    stub(204, null);

    await expect(api.delete('/api/servers/x/backups/y')).resolves.toBeUndefined();
  });

  it('still parses a body when there is one', async () => {
    stub(200, JSON.stringify({ name: 'Bot' }));

    await expect(api.get('/api/servers/x')).resolves.toEqual({ name: 'Bot' });
  });
});

describe('the silent refresh', () => {
  function stubFetch(answers: (path: string) => Response) {
    const calls: string[] = [];

    const fetch = vi.fn((input: string) => {
      calls.push(input);
      return Promise.resolve(answers(input));
    });

    vi.stubGlobal('fetch', fetch);

    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renews an expired session behind the account lookup', async () => {
    let meCalls = 0;

    const calls = stubFetch((path) => {
      if (path === '/api/auth/refresh') {
        return response(200, {});
      }

      // Expired on the first call, answered once the token has been rotated.
      meCalls += 1;
      return meCalls === 1
        ? response(401, { message: 'Unauthorized' })
        : response(200, { username: 'admin' });
    });

    await expect(api.get('/api/auth/me')).resolves.toEqual({ username: 'admin' });

    expect(calls).toEqual(['/api/auth/me', '/api/auth/refresh', '/api/auth/me']);
  });

  it('does not try to renew a sign-in that was refused', async () => {
    // A wrong password is a 401 that means it. Rotating anything here would be
    // pointless, and the visitor has no session to rotate.
    const calls = stubFetch(() => response(401, { message: 'Invalid credentials.' }));

    await expect(api.post('/api/auth/login', { identifier: 'admin' })).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(calls).toEqual(['/api/auth/login']);
  });

  it('does not recurse when the renewal itself is refused', async () => {
    const calls = stubFetch(() => response(401, { message: 'Session revoked.' }));

    await expect(api.post('/api/auth/refresh')).rejects.toBeInstanceOf(ApiError);

    expect(calls).toEqual(['/api/auth/refresh']);
  });

  it('gives up after one rotation rather than looping', async () => {
    const calls = stubFetch((path) =>
      path === '/api/auth/refresh' ? response(200, {}) : response(401, { message: 'nope' }),
    );

    await expect(api.get('/api/servers')).rejects.toBeInstanceOf(ApiError);

    // The original, the rotation, the retry — and then it stops.
    expect(calls).toEqual(['/api/servers', '/api/auth/refresh', '/api/servers']);
  });
});

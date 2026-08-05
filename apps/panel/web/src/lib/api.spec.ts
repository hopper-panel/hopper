import { describe, expect, it } from 'vitest';
import { ApiError, parseError } from './api';

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

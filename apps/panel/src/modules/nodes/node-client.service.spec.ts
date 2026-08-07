import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { NodeClientService, type NodeConnection } from './node-client.service.js';

/**
 * What the panel learns from a daemon that refused.
 *
 * Every refusal used to arrive as "the daemon refused the operation (HTTP
 * 500)", and that string is what a scheduled task's audit record then said
 * about a command the game server never received. The daemon knew perfectly
 * well that a password variable was empty or that a named port did not exist —
 * it wrote a sentence saying so, for the one person able to fix it — and the
 * panel dropped it on the floor. A failure nobody can act on is a step above
 * silence and not much more.
 */

const NODE: NodeConnection = {
  uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  url: 'https://node.example:8443',
  token: 'tokenid.tokensecret',
};

/** Settings are only consulted for the timeout; nothing here waits on one. */
const settings = {
  all: () => Promise.resolve({ nodeTimeoutMs: 5000 }),
} as unknown as InstanceSettingsService;

function answering(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(body, { status }))),
  );
}

/** The shape the daemon's error handler and its routes both send. */
const daemonError = (code: string, message: string): string =>
  JSON.stringify({ error: { code, message, requestId: 'req-1' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a call the daemon refuses', () => {
  it("carries the daemon's own explanation through to the caller", async () => {
    answering(
      502,
      daemonError(
        'command_undelivered',
        'The command "save-all" was not delivered: the variable RCON_PASSWORD holds this server\'s RCON password and is not set. Set it in the server\'s Startup tab.',
      ),
    );

    const client = new NodeClientService(settings);

    // The scheduler turns whatever this throws into one line of an audit
    // record, and that line is the only trace a nightly task leaves.
    await expect(client.sendCommands(NODE, 'server-uuid', ['save-all'])).rejects.toThrow(
      'RCON_PASSWORD',
    );
  });

  it('keeps the status beside the explanation', async () => {
    // The two answer different questions — whether the node refused or failed,
    // and why — and an operator reading a notification wants both.
    answering(502, daemonError('command_undelivered', 'Nothing answered RCON at 10.0.0.4:27020.'));

    const client = new NodeClientService(settings);

    await expect(client.sendCommands(NODE, 'server-uuid', ['save-all'])).rejects.toThrow(
      'HTTP 502',
    );
  });

  it('falls back to the status alone when the body is not the daemon speaking', async () => {
    // A reverse proxy's HTML error page, a truncated stream, a daemon too old
    // to send a structured body. Pasting any of those into a notification is
    // worse than a status code.
    answering(504, '<html><body><h1>504 Gateway Time-out</h1></body></html>');

    const client = new NodeClientService(settings);

    await expect(client.sendCommands(NODE, 'server-uuid', ['save-all'])).rejects.toThrow(
      'The daemon refused the operation (HTTP 504).',
    );
  });

  it('still answers a refused token with what to do about it', async () => {
    // Unchanged, and the one status whose meaning the panel knows better than
    // the daemon does: the fix is on the node page, not in the message.
    answering(401, daemonError('unauthorized', 'Invalid node token.'));

    const client = new NodeClientService(settings);

    await expect(client.sendCommands(NODE, 'server-uuid', ['save-all'])).rejects.toThrow(
      'Regenerate it from the node page.',
    );
  });
});

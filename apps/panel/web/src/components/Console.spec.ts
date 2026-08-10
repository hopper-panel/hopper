import { describe, expect, it } from 'vitest';
import { consolePlaceholder } from './Console';
import type { ConnectionStatus } from '../lib/use-console';

/**
 * What the command box says, and the four cases it used to say one thing about.
 *
 * This is not a cosmetic test. The single message was "you do not have
 * permission to send commands" — a sentence about the reader's account — and it
 * appeared whenever the console had not connected, because permissions arrive
 * with the socket's `auth_success` and an unconnected socket has none.
 *
 * On a real instance that sentence sat under an empty console for both servers
 * while the daemon's log filled with `WebSocket connection refused: origin not
 * allowed` every thirty seconds. The panel was being reached by an address the
 * node had never been told about. Nothing on the page said so, and the one
 * thing it did say pointed at the wrong subsystem entirely.
 */

const controller = (over: Partial<Parameters<typeof consolePlaceholder>[0]> = {}) => ({
  status: 'connected' as ConnectionStatus,
  permissions: ['control.console' as const],
  failure: null,
  ...over,
});

describe('consolePlaceholder', () => {
  it('invites a command when the socket is up and the token allows it', () => {
    expect(consolePlaceholder(controller())).toBe('console.commandPlaceholder');
  });

  it('claims a refusal only when there is a connection to refuse on', () => {
    // Connected, and the token did not carry the permission: this is the one
    // case the old message was right about.
    expect(consolePlaceholder(controller({ permissions: [] }))).toBe('console.commandDenied');
  });

  it.each(['connecting', 'reconnecting'] as const)('says it is still trying while %s', (status) => {
    // Not a refusal. Permissions are simply not in yet, and saying anything
    // about permissions here is what sent an operator to the wrong page.
    expect(consolePlaceholder(controller({ status, permissions: [] }))).toBe('console.connecting');
  });

  it('repeats what the node said when the node refused outright', () => {
    // "Origin not allowed." is the whole diagnosis, and the daemon puts it in
    // the close frame. Swallowing it leaves the operator with an empty box.
    expect(
      consolePlaceholder(
        controller({ status: 'failed', permissions: [], failure: 'Origin not allowed.' }),
      ),
    ).toBe('console.refused');
  });

  it('falls back to a plain refusal when the close carried no reason', () => {
    expect(
      consolePlaceholder(controller({ status: 'failed', permissions: [], failure: null })),
    ).toBe('console.disconnected');
  });
});

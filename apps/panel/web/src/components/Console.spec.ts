import { ORIGIN_REFUSED_REASON } from '@hopper/shared';
import { describe, expect, it } from 'vitest';
import { consolePlaceholder, refusalAdvice } from './Console';
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

/**
 * The sentence under the refusal.
 *
 * "Origin not allowed." was already repeated to the operator, and on a real
 * instance that was still not enough: the panel had been opened by the server's
 * IP address while the node held its host name, so the message named a rule
 * without naming either address it was about. Somebody stares at a true
 * sentence and changes nothing.
 */
describe('refusalAdvice', () => {
  it('names the address to go to when the browser is on another one', () => {
    expect(
      refusalAdvice(ORIGIN_REFUSED_REASON, {
        kind: 'wrong-address',
        expected: 'https://panel.example.com',
      }),
    ).toBe('console.wrongAddress');
  });

  it('points at the node when the browser is already where it should be', () => {
    // The other half of the same mismatch, and a different person's job: the
    // node's `daemon.yml` was written before this address existed.
    expect(refusalAdvice(ORIGIN_REFUSED_REASON, { kind: 'expected' })).toBe('console.nodeUnaware');
  });

  it('says nothing when it has no address to compare against', () => {
    expect(refusalAdvice(ORIGIN_REFUSED_REASON, { kind: 'unknown' })).toBeNull();
  });

  it.each(['No authentication supplied.', 'Invalid token.', 'Token expired.'])(
    'stays out of a refusal that is not about an address: %s',
    (reason) => {
      // All three close with 1008 as well. Advising an operator to change
      // address over an expired token would send them to break a configuration
      // that was right.
      expect(refusalAdvice(reason, { kind: 'wrong-address', expected: 'https://a' })).toBeNull();
    },
  );

  it('stays out of a connection that simply dropped', () => {
    expect(refusalAdvice(null, { kind: 'wrong-address', expected: 'https://a' })).toBeNull();
  });
});

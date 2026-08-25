import { describe, expect, it } from 'vitest';
import { environmentSchema } from './environment.js';

/**
 * The one field in this file that is compared, character for character, against
 * something a browser sends.
 *
 * `APP_URL` reaches three places that do not forgive a difference: the origin
 * list the daemon checks a WebSocket against, the `iss` it verifies on a console
 * token, and the relying party a passkey is bound to. None of them ever sees a
 * path or a trailing slash, so a URL carrying either refused every console on an
 * installation whose configuration read correctly everywhere it was displayed —
 * including in `hopper doctor`, which called it valid, because it was.
 */

const minimal = { APP_SECRET: 'x'.repeat(48) };

const appUrl = (value?: string): string =>
  environmentSchema.parse(value === undefined ? minimal : { ...minimal, APP_URL: value }).APP_URL;

describe('APP_URL', () => {
  it('keeps an address already spelled as an origin', () => {
    expect(appUrl('https://panel.example.com')).toBe('https://panel.example.com');
  });

  it('drops a trailing slash', () => {
    expect(appUrl('https://panel.example.com/')).toBe('https://panel.example.com');
  });

  it('drops a path somebody pasted from their address bar', () => {
    expect(appUrl('https://panel.example.com/admin/nodes')).toBe('https://panel.example.com');
  });

  it('keeps a non-standard port, which belongs to the origin', () => {
    // A panel behind no reverse proxy answers on 8080, and the browser sends
    // that port in its `Origin`.
    expect(appUrl('http://192.168.1.141:8080')).toBe('http://192.168.1.141:8080');
  });

  it('drops the default port, which a browser never sends', () => {
    expect(appUrl('https://panel.example.com:443')).toBe('https://panel.example.com');
  });

  it('normalises the default too', () => {
    expect(appUrl()).toBe('http://localhost:8080');
  });

  it('still refuses what is not a URL at all', () => {
    // The launch has to fail here rather than at somebody's first sign-in.
    expect(() => appUrl('panel.example.com')).toThrow();
  });
});

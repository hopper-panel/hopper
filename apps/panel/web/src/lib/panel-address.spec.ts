import { describe, expect, it } from 'vitest';
import { compareAddress } from './panel-address';

/**
 * The comparison behind "you are not at the address this panel answers to".
 *
 * It decides whether a refused console gets an explanation or a shrug, so its
 * two failure modes are not symmetrical. Missing a mismatch leaves the operator
 * exactly where they were — staring at "Origin not allowed." Claiming one that
 * is not there sends them to change a configuration that was right, and they
 * come back with a console that is still empty and a node whose address list no
 * longer matches anything.
 */

describe('compareAddress', () => {
  it('recognises the address it was configured with', () => {
    expect(compareAddress('https://panel.example.com', 'https://panel.example.com')).toEqual({
      kind: 'expected',
    });
  });

  it('names the expected address when the browser is on another', () => {
    // The case this exists for: a panel opened by its IP address. Everything
    // works except the console, because the node holds the host name.
    expect(compareAddress('https://panel.example.com', 'https://203.0.113.7')).toEqual({
      kind: 'wrong-address',
      expected: 'https://panel.example.com',
    });
  });

  it('treats the scheme as part of the address', () => {
    // `http://` and `https://` are different origins, and the node's list holds
    // one of them. A panel put behind TLS after its node was declared refuses
    // every console until that node is given its configuration again.
    expect(compareAddress('https://panel.example.com', 'http://panel.example.com')).toMatchObject({
      kind: 'wrong-address',
    });
  });

  it('sees through a trailing slash', () => {
    // An origin never carries one; a configured URL still can, on a panel
    // upgraded from a version that stored what it was given. Calling that a
    // mismatch would be a false alarm about the one thing that is fine.
    expect(compareAddress('https://panel.example.com/', 'https://panel.example.com')).toEqual({
      kind: 'expected',
    });
  });

  it('ignores a path, which no Origin header ever carries', () => {
    expect(compareAddress('https://panel.example.com/hopper', 'https://panel.example.com')).toEqual(
      { kind: 'expected' },
    );
  });

  it('keeps the port, which is part of the origin', () => {
    expect(
      compareAddress('http://panel.example.com:8080', 'http://panel.example.com'),
    ).toMatchObject({ kind: 'wrong-address' });
  });

  it.each([undefined, '', 'not-a-url'])('says nothing rather than something wrong: %s', (value) => {
    // A panel too old to send its address, or one sending something this
    // cannot read. Silence is the honest answer.
    expect(compareAddress(value, 'https://panel.example.com')).toEqual({ kind: 'unknown' });
  });
});

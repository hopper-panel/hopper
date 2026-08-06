import { describe, expect, it } from 'vitest';
import { RconError, decodePackets, encodePacket, isAuthFailure } from './rcon.js';

/**
 * The framing, which is where RCON clients go wrong.
 *
 * Three ways, all of them silent: a size that counts the wrong bytes, so the
 * server authenticates and then waits for ever; a reader that assumes one TCP
 * read is one packet, which works until the server is busy; and an
 * authentication failure read as success, after which every command sent is
 * discarded without a word.
 */

describe('encodePacket', () => {
  it('sizes the packet as everything after the size field', () => {
    const buffer = encodePacket({ id: 1, type: 3, body: 'hunter2' });

    // 4 id + 4 type + 7 body + 2 nulls = 17, and the length prefix does not
    // count itself. Off by one here is a client that hangs after logging in.
    expect(buffer.readInt32LE(0)).toBe(17);
    expect(buffer.length).toBe(21);
  });

  it('terminates the body and the packet separately', () => {
    const buffer = encodePacket({ id: 1, type: 2, body: 'quit' });

    // Two nulls, not one. A server that does not find the second waits for
    // the rest of a packet that has already been sent in full.
    expect(buffer[buffer.length - 1]).toBe(0);
    expect(buffer[buffer.length - 2]).toBe(0);
    expect(buffer.toString('utf8', 12, 16)).toBe('quit');
  });

  it('writes its integers little-endian', () => {
    const buffer = encodePacket({ id: 0x5a5a, type: 3, body: '' });

    expect(buffer.readInt32LE(4)).toBe(0x5a5a);
    expect(buffer.readInt32LE(8)).toBe(3);
  });
});

describe('decodePackets', () => {
  it('reads back what was written', () => {
    const { packets, rest } = decodePackets(encodePacket({ id: 7, type: 0, body: 'pong' }));

    expect(packets).toEqual([{ id: 7, type: 0, body: 'pong' }]);
    expect(rest.length).toBe(0);
  });

  it('reads two packets that arrived in one read', () => {
    // A busy server answers a command with several packets, and TCP is free
    // to hand them over together.
    const stream = Buffer.concat([
      encodePacket({ id: 1, type: 0, body: 'first' }),
      encodePacket({ id: 2, type: 0, body: 'second' }),
    ]);

    const { packets, rest } = decodePackets(stream);

    expect(packets.map((p) => p.body)).toEqual(['first', 'second']);
    expect(rest.length).toBe(0);
  });

  it('keeps a packet that arrived in halves', () => {
    // The other direction, and the one that breaks a naive client: a reply
    // split across two reads. The tail has to survive until the rest lands.
    const whole = encodePacket({ id: 3, type: 0, body: 'a longer answer' });
    const first = decodePackets(whole.subarray(0, 10));

    expect(first.packets).toEqual([]);
    expect(first.rest.length).toBe(10);

    const second = decodePackets(Buffer.concat([first.rest, whole.subarray(10)]));

    expect(second.packets).toEqual([{ id: 3, type: 0, body: 'a longer answer' }]);
  });

  it('refuses a stream that cannot be RCON', () => {
    // Usually something else listening on that port. Reading gibberish until
    // it happens to parse is worse than saying so.
    expect(() => decodePackets(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0]))).toThrow(
      RconError,
    );
  });
});

describe('isAuthFailure', () => {
  it('recognises the id the protocol uses to say no', () => {
    // A refusal is a well-formed packet with an id of -1, not an error. A
    // client that only checks for a reply concludes it is logged in, and then
    // every command it sends is silently discarded.
    expect(isAuthFailure({ id: -1, type: 2, body: '' })).toBe(true);
    expect(isAuthFailure({ id: 0x5a5a, type: 2, body: '' })).toBe(false);
  });
});

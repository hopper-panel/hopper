import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  RconError,
  decodePackets,
  encodePacket,
  isAuthFailure,
  rconDeliver,
  rconExecute,
} from './rcon.js';

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

/**
 * A peer that behaves like a game server, including when it is dying.
 *
 * `afterCommand` is the interesting knob and the reason this double exists at
 * all: a server that has just run `quit` does not answer. It hangs up
 * mid-shutdown, or it goes quiet because the thread that reads RCON is gone.
 * Both are what success looks like on this path, and both used to be read as
 * the command never having been sent.
 */
interface Peer {
  port: number;
  received: string[];
  close: () => Promise<void>;
}

async function peer(options: {
  password: string;
  afterCommand: 'answer' | 'close' | 'silence';
  answer?: string;
}): Promise<Peer> {
  const received: string[] = [];
  const accepted = new Set<Socket>();

  const server: Server = createServer((socket) => {
    let pending: ReturnType<typeof decodePackets>['rest'] = Buffer.alloc(0);
    let authenticated = false;

    accepted.add(socket);
    socket.on('close', () => accepted.delete(socket));

    socket.on('data', (chunk: Buffer) => {
      const read = decodePackets(Buffer.concat([pending, chunk]));
      pending = read.rest;

      for (const packet of read.packets) {
        if (!authenticated) {
          if (packet.body !== options.password) {
            socket.write(encodePacket({ id: -1, type: 2, body: '' }));
            return;
          }

          authenticated = true;
          socket.write(encodePacket({ id: packet.id, type: 2, body: '' }));
          continue;
        }

        received.push(packet.body);

        if (options.afterCommand === 'answer') {
          socket.write(encodePacket({ id: packet.id, type: 0, body: options.answer ?? '' }));
        } else if (options.afterCommand === 'close') {
          socket.destroy();
        }
      }
    });

    socket.on('error', () => undefined);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));

  return {
    port: (server.address() as AddressInfo).port,
    received,
    // Connections are cut rather than waited out: a delivery leaves the client
    // socket open for a late answer, and a double that waited for that would
    // add the whole RCON timeout to every test that used one.
    close: () =>
      new Promise<void>((resolve) => {
        accepted.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}

/**
 * Delivery and an answer are different questions, and one client cannot answer
 * both.
 *
 * The readiness check needs an answer: a server that says nothing has proved
 * nothing, and calling it ready would be the silent lie that whole mechanism
 * exists to remove. A shutdown command needs delivery: `quit` is acknowledged
 * by the process exiting, so the exchange ends in a hangup or a timeout exactly
 * when it worked. Reading the second question with the first one's client
 * refused stops that had been delivered — the game went down because it had
 * been told to, and the daemon reported that nothing had happened.
 */
describe('rconDeliver', () => {
  it('succeeds when the peer hangs up without answering', async () => {
    const server = await peer({ password: 'hunter2', afterCommand: 'close' });

    try {
      await expect(
        rconDeliver(
          { host: '127.0.0.1', port: server.port, password: 'hunter2', timeoutMs: 500 },
          'quit',
        ),
      ).resolves.toBeUndefined();

      // Waited for rather than asserted outright, and that is the definition at
      // work: the promise settles when the bytes leave this process, which is
      // necessarily before the peer has read them.
      await vi.waitFor(() => expect(server.received).toEqual(['quit']));
    } finally {
      await server.close();
    }
  });

  it('succeeds when the peer answers nothing at all', async () => {
    // The other shape of a dying server: the socket stays open because nothing
    // is left to close it. Waiting out the timeout and calling that a failure
    // is how a stop that worked was reported as undelivered.
    const server = await peer({ password: 'hunter2', afterCommand: 'silence' });

    try {
      await expect(
        rconDeliver(
          { host: '127.0.0.1', port: server.port, password: 'hunter2', timeoutMs: 500 },
          'quit',
        ),
      ).resolves.toBeUndefined();

      await vi.waitFor(() => expect(server.received).toEqual(['quit']));
    } finally {
      await server.close();
    }
  });

  it('hands an answer to the caller when one does arrive', async () => {
    const server = await peer({
      password: 'hunter2',
      afterCommand: 'answer',
      answer: 'Saving and shutting down',
    });

    try {
      const heard: string[] = [];

      await rconDeliver(
        { host: '127.0.0.1', port: server.port, password: 'hunter2', timeoutMs: 500 },
        'quit',
        (body) => heard.push(body),
      );

      // Later than the promise, always: an answer is a bonus the caller is not
      // waiting on, which is exactly why the stop no longer depends on one.
      await vi.waitFor(() => expect(heard).toEqual(['Saving and shutting down']));
    } finally {
      await server.close();
    }
  });

  it('fails on a password the peer refuses, before the command leaves', async () => {
    // The line this whole path rests on: everything that rejects here happens
    // while the command is still in this process, so the caller can refuse the
    // stop knowing the server has been told nothing.
    const server = await peer({ password: 'hunter2', afterCommand: 'answer' });

    try {
      await expect(
        rconDeliver(
          { host: '127.0.0.1', port: server.port, password: 'wrong', timeoutMs: 500 },
          'quit',
        ),
      ).rejects.toThrow('refused the password');

      expect(server.received).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('fails when nothing accepts the connection', async () => {
    // Port 1 is privileged and unbound: the kernel refuses at once.
    await expect(
      rconDeliver({ host: '127.0.0.1', port: 1, password: 'hunter2', timeoutMs: 500 }, 'quit'),
    ).rejects.toThrow();
  });
});

describe('rconExecute', () => {
  it('still demands an answer, because readiness is nothing else', async () => {
    // The behaviour `rconDeliver` exists *not* to change. A server that logs
    // this client in and then hangs up has proved it is listening and nothing
    // more; promoting it to `running` on that basis is the readiness that was
    // declared and never checked.
    const server = await peer({ password: 'hunter2', afterCommand: 'close' });

    try {
      await expect(
        rconExecute(
          { host: '127.0.0.1', port: server.port, password: 'hunter2', timeoutMs: 500 },
          'list',
        ),
      ).rejects.toThrow(RconError);
    } finally {
      await server.close();
    }
  });

  it('returns the body when the server answers', async () => {
    const server = await peer({ password: 'hunter2', afterCommand: 'answer', answer: 'pong' });

    try {
      await expect(
        rconExecute(
          { host: '127.0.0.1', port: server.port, password: 'hunter2', timeoutMs: 500 },
          'ping',
        ),
      ).resolves.toBe('pong');
    } finally {
      await server.close();
    }
  });
});

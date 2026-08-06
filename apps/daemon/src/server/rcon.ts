import { connect, type Socket } from 'node:net';

/**
 * Source RCON, enough of it.
 *
 * The protocol Valve wrote for srcds and that half the game-server world
 * copied: Rust, ARK, Palworld, 7 Days to Die, Factorio, Minecraft itself.
 * Hopper needs it for two things a Minecraft-shaped daemon never had to do —
 * stop a server that does not read stdin, and ask a server whether it is
 * actually serving rather than merely running.
 *
 * No dependency for this. It is a length prefix, three little-endian integers
 * and two null bytes; a package would be more code to audit than the protocol
 * is to write, and this one has to hold a password.
 *
 * The framing is where the bugs live, so it is a pure function and it is
 * tested. The socket work around it is not clever and is not tested here.
 */

/** Client → server. `AUTH` and `EXEC` are the only two Hopper sends. */
const AUTH = 3;
const EXEC = 2;

/**
 * Server → client. `AUTH_RESPONSE` shares its number with `EXEC`, which is a
 * quirk of the protocol and not a mistake here: the two never travel in the
 * same direction.
 */
const RESPONSE_VALUE = 0;

/** An id the server echoes back so replies can be matched to requests. */
const REQUEST_ID = 0x5a5a;

export class RconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RconError';
  }
}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/**
 * A packet on the wire.
 *
 * Size counts everything after itself — id, type, body and *both* trailing
 * nulls. Getting that off by one is the classic way to write an RCON client
 * that authenticates and then hangs for ever.
 */
export function encodePacket(packet: RconPacket): Buffer {
  const body = Buffer.from(packet.body, 'utf8');
  const buffer = Buffer.alloc(4 + 4 + 4 + body.length + 2);

  buffer.writeInt32LE(4 + 4 + body.length + 2, 0);
  buffer.writeInt32LE(packet.id, 4);
  buffer.writeInt32LE(packet.type, 8);
  body.copy(buffer, 12);
  // Two nulls: one terminating the body, one terminating the packet. The
  // second is not padding — a server that does not find it waits for more.
  buffer.writeUInt8(0, 12 + body.length);
  buffer.writeUInt8(0, 13 + body.length);

  return buffer;
}

/**
 * Reads whole packets out of a stream, leaving any partial tail behind.
 *
 * TCP does not preserve message boundaries, so a reply can arrive split across
 * reads or two replies can arrive in one. Both happen in practice on a busy
 * server, and a client that assumes one read is one packet works right up
 * until it does not.
 */
export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);

    // A size that cannot be a packet means the stream is not RCON at all —
    // usually something else listening on that port. Better to say so than to
    // read gibberish until it happens to parse.
    if (size < 10 || size > 4096) {
      throw new RconError(`Nonsensical packet size (${size}): this does not look like RCON.`);
    }

    if (buffer.length - offset < 4 + size) {
      break;
    }

    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.toString('utf8', offset + 12, offset + 4 + size - 2),
    });

    offset += 4 + size;
  }

  return { packets, rest: Buffer.from(buffer.subarray(offset)) };
}

/**
 * A failed authentication is an id of −1, not an error message.
 *
 * The server answers a well-formed packet either way, so a client that only
 * checks for a reply concludes it is logged in when it is not — and then
 * every command it sends is silently discarded.
 */
export function isAuthFailure(packet: RconPacket): boolean {
  return packet.id === -1;
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

/**
 * Connects, authenticates, optionally sends one command, and hangs up.
 *
 * One exchange per connection rather than a pooled session: Hopper uses this
 * to stop a server and to ask whether it is up, both of which happen rarely
 * and neither of which is worth a socket kept open against a process that may
 * die at any moment.
 */
export async function rconExecute(options: RconOptions, command?: string): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise<string>((resolve, reject) => {
    let pending: Buffer = Buffer.alloc(0);
    let authenticated = false;
    let settled = false;

    const socket: Socket = connect({ host: options.host, port: options.port, timeout: timeoutMs });

    const finish = (error: Error | null, value = ''): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    socket.once('connect', () => {
      socket.write(encodePacket({ id: REQUEST_ID, type: AUTH, body: options.password }));
    });

    socket.on('data', (chunk: Buffer) => {
      let packets: RconPacket[];

      try {
        const read = decodePackets(Buffer.concat([pending, chunk]));
        packets = read.packets;
        pending = read.rest;
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new RconError('Unreadable RCON stream.'));
        return;
      }

      for (const packet of packets) {
        if (!authenticated) {
          // Some servers send an empty RESPONSE_VALUE before the auth verdict.
          // It is not the answer, and treating it as one is how a client
          // decides it is logged in before the server has said so.
          if (packet.type === RESPONSE_VALUE && packet.id !== -1) {
            continue;
          }

          if (isAuthFailure(packet)) {
            finish(new RconError('RCON refused the password.'));
            return;
          }

          authenticated = true;

          if (command === undefined) {
            finish(null, '');
            return;
          }

          socket.write(encodePacket({ id: REQUEST_ID, type: EXEC, body: command }));
          continue;
        }

        finish(null, packet.body);
        return;
      }
    });

    socket.once('timeout', () => finish(new RconError('RCON timed out.')));
    socket.once('error', (error: Error) => finish(error));
    socket.once('close', () => finish(new RconError('RCON closed before answering.')));
  });
}

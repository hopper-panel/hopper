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
 * tested. The socket work around it is mostly not clever — with one exception,
 * also tested: *when* an exchange counts as having worked is not the same
 * question for a readiness check and for a shutdown command, and answering it
 * once for both is what made a delivered stop read as an undelivered one.
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
 * What the caller is waiting for, which is not the same question for everybody
 * who speaks this protocol.
 *
 * `response` is the obvious one and the one a readiness check needs: the server
 * has to say something back, because saying something back *is* the evidence
 * that it is serving. Silence there is a failure, and so is a peer that hangs
 * up — a server that closes the socket without answering has not proved
 * anything.
 *
 * `delivery` is the one a shutdown command needs, and reading the two as the
 * same thing is a bug with teeth. `quit` is answered by the server exiting: it
 * acknowledges nothing, closes the socket mid-hangup, or simply stops reading —
 * so the exchange ends in a close or a five-second timeout **precisely when it
 * worked**. A caller that treats those as "not delivered" concludes the server
 * was never told, while the server is at that moment saving its world and going
 * down. Everything it does next — refusing the stop, not waiting for the exit,
 * not arming the SIGKILL — is decided from the exact opposite of the truth.
 */
type Settlement = 'response' | 'delivery';

/**
 * Connects, authenticates, optionally sends one command, and hangs up when the
 * server has answered.
 *
 * One exchange per connection rather than a pooled session: Hopper uses this
 * to stop a server and to ask whether it is up, both of which happen rarely
 * and neither of which is worth a socket kept open against a process that may
 * die at any moment.
 *
 * Unchanged, and deliberately so: the readiness path is built on the answer and
 * on nothing else, and `rconDeliver` below exists rather than a flag on this
 * one so that no future edit can loosen what "ready" means by loosening what
 * "succeeded" means here.
 */
export async function rconExecute(options: RconOptions, command?: string): Promise<string> {
  return rconExchange(options, command, 'response');
}

/**
 * Connects, authenticates and sends one command, settling the moment the
 * command has left.
 *
 * For a shutdown command that is the only honest place to draw the line. Once
 * the bytes are gone the server has been told, and what happens to the socket
 * afterwards says nothing about whether it was: an answer, a hangup and a
 * silence are all ordinary outcomes of asking a game to exit, and only the
 * first of them would satisfy `rconExecute`.
 *
 * So the failures this rejects on are the ones that happen **before** the write:
 * a connection that never opens, a password the server refuses, a stream that
 * is not RCON, a peer that hangs up during the handshake. In every one of them
 * the command never left this process and the server is running exactly as it
 * was — which is what makes refusing the stop safe, and what makes refusing it
 * after a delivery a lie.
 *
 * `onResponse` is a bonus and it arrives late by construction: the promise has
 * usually settled by the time anything can come back. It is here because some
 * servers do answer a shutdown with a sentence, and the operator watching the
 * console is the one person that sentence was written for. The socket is left
 * open for it until the answer, the peer's hangup or the timeout — all three
 * bounded, none of them waited on by the caller.
 */
export async function rconDeliver(
  options: RconOptions,
  command: string,
  onResponse?: (body: string) => void,
): Promise<void> {
  await rconExchange(options, command, 'delivery', onResponse);
}

/**
 * The socket work behind both entry points, written once.
 *
 * Two copies of a handshake is how the stop and the readiness check would come
 * to disagree about what a `-1` id means, or about the empty preamble, months
 * apart and in silence. The only thing that differs between them is when the
 * caller is answered, so that is the only thing the parameter carries.
 */
function rconExchange(
  options: RconOptions,
  command: string | undefined,
  settlement: Settlement,
  onResponse?: (body: string) => void,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000;

  return new Promise<string>((resolve, reject) => {
    let pending: Buffer = Buffer.alloc(0);
    let authenticated = false;
    let settled = false;

    const socket: Socket = connect({ host: options.host, port: options.port, timeout: timeoutMs });

    /**
     * Answers the caller, once, without touching the socket.
     *
     * Separate from hanging up because a delivered command settles while the
     * connection is still worth keeping: whatever the server says next has
     * somewhere to go, and nobody is waiting on it.
     */
    const settle = (error: Error | null, value = ''): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    /**
     * Answers the caller and hangs up. The hangup is unconditional: a socket
     * whose promise has already settled still has to be released, and this is
     * the path every end of the connection goes through.
     */
    const finish = (error: Error | null, value = ''): void => {
      settle(error, value);
      socket.destroy();
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

          const request = encodePacket({ id: REQUEST_ID, type: EXEC, body: command });

          if (settlement === 'response') {
            socket.write(request);
            continue;
          }

          // The write callback is the moment the bytes left this process, and
          // that is the whole of what "delivered" means here. A write that
          // fails still reports through it, and it is then a pre-delivery
          // failure like any other — the command is still in this process.
          socket.write(request, (error) => (error ? finish(error) : settle(null, '')));
          continue;
        }

        // Past the handshake, a body is the server's answer to the command.
        // On the delivery path it also settles the promise if the write
        // callback has not already: an answer is proof the command arrived, and
        // proof arriving early is no reason to keep waiting for the callback.
        if (settlement === 'delivery') {
          onResponse?.(packet.body);
          finish(null, '');
          return;
        }

        finish(null, packet.body);
        return;
      }
    });

    // All three are failures while the handshake is still going, and none of
    // them is one afterwards on the delivery path: `settle` has answered, so
    // these only release the socket. That asymmetry is the fix — a server told
    // to `quit` ends the exchange by one of these three, every time.
    socket.once('timeout', () => finish(new RconError('RCON timed out.')));
    socket.once('error', (error: Error) => finish(error));
    socket.once('close', () => finish(new RconError('RCON closed before answering.')));
  });
}

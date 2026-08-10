import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import websocket from '@fastify/websocket';
import {
  CONSOLE_BUFFER_LINES,
  PERMISSIONS,
  WS_ERROR_CODES,
  type Permission,
  type PowerAction,
  type ResourceUsage,
  type ServerState,
} from '@hopper/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, UnsecuredJWT, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonConfigSchema, type DaemonConfig } from '../config/schema.js';
import type { Logger } from '../logger.js';
import type { ServerInstance } from '../server/server-instance.js';
import type { ServerManager } from '../server/server-manager.js';
import { registerConsoleGateway } from './console-gateway.js';

/**
 * The console gateway, attacked rather than covered.
 *
 * This is the one place in Hopper where a **browser talks straight to the
 * daemon**: no panel in the path, no database lookup, no callback. Everything
 * the daemon is willing to believe about the person on the other end comes out
 * of a JWT it verifies on its own, and the daemon is the process with something
 * to lose — it runs as root and drives Docker. A signature check that can be
 * talked round here is not a bug in a web page, it is arbitrary command
 * execution on somebody's game server.
 *
 * So these tests are written from the outside, as an attacker has to work: a
 * real Fastify server with the real `@fastify/websocket` plugin, the real
 * gateway registered on it, and a hand-rolled WebSocket client speaking down a
 * raw TCP socket. Nothing calls a private method. The hand-rolled client is
 * deliberate on two counts — it can set (or omit) the `Origin` header the way a
 * non-browser attacker would, and it can decline to answer a close frame, which
 * is how the expiry window below is held open long enough to be measured.
 */

// ---------------------------------------------------------------------------
// The world the gateway believes in
// ---------------------------------------------------------------------------

const NODE_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_NODE_UUID = '99999999-9999-4999-8999-999999999999';
const SERVER_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_SERVER_UUID = '33333333-3333-4333-8333-333333333333';
const UNHOSTED_SERVER_UUID = '44444444-4444-4444-8444-444444444444';
const USER_UUID = '55555555-5555-4555-8555-555555555555';

const ISSUER = 'https://panel.example.com';
const OTHER_ISSUER = 'https://panel.attacker.example';

const JWT_SECRET = 'j'.repeat(64);
const WRONG_SECRET = 'k'.repeat(64);
const NODE_TOKEN_SECRET = 'z'.repeat(64);

const SIGNING_KEY = Buffer.from(JWT_SECRET, 'utf8');

const PANEL_ORIGIN = 'https://panel.example.com';
const EVIL_ORIGIN = 'https://minecraft-free-diamonds.example';

/** The claim set the panel actually mints, before any tampering. */
const HONEST_PERMISSIONS: Permission[] = [
  PERMISSIONS.WEBSOCKET_CONNECT,
  PERMISSIONS.CONTROL_CONSOLE,
  PERMISSIONS.CONTROL_START,
  PERMISSIONS.CONTROL_STOP,
];

// ---------------------------------------------------------------------------
// Minting tokens, honest and otherwise
// ---------------------------------------------------------------------------

type SigningKey = Parameters<InstanceType<typeof SignJWT>['sign']>[0];

interface MintOptions {
  /** Overrides merged over the honest claim set. */
  claims?: Record<string, unknown>;
  /** Claims to remove entirely, to probe what the verifier insists on. */
  without?: string[];
  /** Seconds until expiry; `null` mints a token with no `exp` at all. */
  ttlSeconds?: number | null;
  alg?: string;
  key?: SigningKey;
}

async function mintToken(options: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: NODE_UUID,
    sub: USER_UUID,
    jti: 'console-token-1',
    iat: now,
    serverUuid: SERVER_UUID,
    permissions: HONEST_PERMISSIONS,
    ...options.claims,
  };

  if (options.ttlSeconds !== null) {
    claims.exp = now + (options.ttlSeconds ?? 600);
  }

  for (const claim of options.without ?? []) {
    delete claims[claim];
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'HS256' })
    .sign(options.key ?? SIGNING_KEY);
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function splitToken(token: string): [string, string, string] {
  const [header, payload, signature] = token.split('.');
  return [header!, payload!, signature!];
}

/** Swaps the header while keeping the original signature bytes. */
function withHeader(token: string, header: Record<string, unknown>): string {
  const [, payload, signature] = splitToken(token);
  return `${encodeSegment(header)}.${payload}.${signature}`;
}

/** Rewrites the claims while keeping the signature the panel produced. */
function withTamperedPayload(
  token: string,
  mutate: (claims: Record<string, unknown>) => void,
): string {
  const [header, payload, signature] = splitToken(token);
  const claims = decodeSegment(payload);
  mutate(claims);
  return `${header}.${encodeSegment(claims)}.${signature}`;
}

function withFlippedSignatureBit(token: string): string {
  const [header, payload, signature] = splitToken(token);
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] = bytes[0]! ^ 0x01;
  return `${header}.${payload}.${bytes.toString('base64url')}`;
}

function withTruncatedSignature(token: string): string {
  const [header, payload, signature] = splitToken(token);
  const bytes = Buffer.from(signature, 'base64url');
  return `${header}.${payload}.${bytes.subarray(0, bytes.length - 1).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// A WebSocket client that does only what it is told
// ---------------------------------------------------------------------------

interface Frame {
  event?: unknown;
  [key: string]: unknown;
}

interface CloseFrame {
  code: number;
  reason: string;
}

/**
 * A WebSocket client written by hand over a TCP socket.
 *
 * The `ws` library would be shorter, but it is a well-behaved peer: it always
 * sets the headers a browser sets and always answers a close frame. Two of the
 * questions here are precisely about a peer that does neither.
 */
class AttackerSocket {
  private buffer = Buffer.alloc(0);
  private readonly received: Frame[] = [];
  private cursor = 0;
  private notify: (() => void) | null = null;
  private closeFrame: CloseFrame | null = null;

  /**
   * Whether to answer the server's close frame. A browser does, and the
   * connection then goes down at once. Nothing forces an attacker to.
   */
  politeClose = true;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('error', () => this.wake());
    socket.on('close', () => this.wake());
  }

  static open(
    port: number,
    path: string,
    options: { origin?: string } = {},
  ): Promise<AttackerSocket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1' });
      let head = Buffer.alloc(0);

      const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk]);
        const bodyAt = head.indexOf('\r\n\r\n');

        if (bodyAt === -1) {
          return;
        }

        socket.off('data', onData);
        const status = head.subarray(0, head.indexOf('\r\n')).toString('ascii');

        if (!status.includes('101')) {
          socket.destroy();
          reject(new Error(`Upgrade refused: ${status}`));
          return;
        }

        const client = new AttackerSocket(socket);
        const leftover = head.subarray(bodyAt + 4);

        if (leftover.length > 0) {
          client.consume(leftover);
        }

        resolve(client);
      };

      socket.on('data', onData);
      socket.on('error', reject);
      socket.on('connect', () => {
        const lines = [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
        ];

        if (options.origin !== undefined) {
          lines.push(`Origin: ${options.origin}`);
        }

        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
    });
  }

  send(message: unknown): void {
    this.sendText(JSON.stringify(message));
  }

  sendText(text: string): void {
    this.socket.write(frameForServer(Buffer.from(text, 'utf8'), 0x1));
  }

  /** Every frame received so far, for assertions about what was *not* sent. */
  all(): Frame[] {
    return [...this.received];
  }

  get closedWith(): CloseFrame | null {
    return this.closeFrame;
  }

  async next(timeoutMs = 3_000): Promise<Frame> {
    const frame = await this.until(() => this.received[this.cursor], 'a message', timeoutMs);
    this.cursor += 1;
    return frame;
  }

  /** Waits for a frame matching `predicate`, discarding what comes before it. */
  async waitFor(
    predicate: (frame: Frame) => boolean,
    description: string,
    timeoutMs = 3_000,
  ): Promise<Frame> {
    return this.until(
      () => {
        while (this.cursor < this.received.length) {
          const frame = this.received[this.cursor++]!;

          if (predicate(frame)) {
            return frame;
          }
        }

        return undefined;
      },
      description,
      timeoutMs,
    );
  }

  async waitForEvent(event: string, timeoutMs = 3_000): Promise<Frame> {
    return this.waitFor((frame) => frame.event === event, `event ${event}`, timeoutMs);
  }

  async waitForClose(timeoutMs = 3_000): Promise<CloseFrame> {
    return this.until(() => this.closeFrame ?? undefined, 'the close frame', timeoutMs);
  }

  /** Lets the server finish whatever it is doing, then stops listening. */
  async settle(milliseconds = 120): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  /**
   * Stops taking anything off the wire, without closing anything.
   *
   * The receive window fills, TCP stops the daemon writing, and whatever it
   * still wants to say accumulates in its own memory — which is the whole of
   * the attack the send-buffer ceiling exists to stop.
   */
  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private async until<T>(
    read: () => T | undefined,
    description: string,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const value = read();

      if (value !== undefined) {
        return value;
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for ${description}. Received: ${JSON.stringify(this.received)}`,
        );
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 20));
        this.notify = (): void => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 2) {
        return;
      }

      const opcode = this.buffer[0]! & 0x0f;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (this.buffer.length < offset + length) {
        return;
      }

      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(opcode, payload);
    }
  }

  private handleFrame(opcode: number, payload: Buffer): void {
    if (opcode === 0x1) {
      this.received.push(JSON.parse(payload.toString('utf8')) as Frame);
    } else if (opcode === 0x8) {
      this.closeFrame = {
        code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
        reason: payload.subarray(2).toString('utf8'),
      };

      if (this.politeClose) {
        this.socket.write(frameForServer(payload.subarray(0, 2), 0x8));
        this.socket.end();
      }
    } else if (opcode === 0x9) {
      this.socket.write(frameForServer(payload, 0xa));
    }

    this.wake();
  }
}

/** Builds a masked frame; every client-to-server frame has to be masked. */
function frameForServer(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const masked = Buffer.from(payload);

  for (let index = 0; index < masked.length; index += 1) {
    masked[index] = masked[index]! ^ mask[index % 4]!;
  }

  return Buffer.concat([header, mask, masked]);
}

// ---------------------------------------------------------------------------
// The daemon side, real gateway over a real server
// ---------------------------------------------------------------------------

const SNAPSHOT_LINES = ['[Server] Done (3.412s)!', '[Server] <op> whitelist add nobody'];

/** A sample shaped the way the stats stream produces one for a live server. */
const RUNNING_SAMPLE: ResourceUsage = {
  state: 'running',
  uptime: 12_000,
  memoryBytes: 512 * 1024 * 1024,
  memoryLimitBytes: 1024 * 1024 * 1024,
  cpuPercent: 37.5,
  diskBytes: 4_096,
  networkRxBytes: 10,
  networkTxBytes: 20,
};

class FakeServerInstance extends EventEmitter {
  currentState: ServerState = 'offline';

  readonly idleUsage: ResourceUsage = {
    state: 'offline',
    uptime: 0,
    memoryBytes: 0,
    memoryLimitBytes: 1024,
    cpuPercent: 0,
    diskBytes: 42,
    networkRxBytes: 0,
    networkTxBytes: 0,
  };

  readonly sendCommand = vi.fn((_command: string) => Promise.resolve());
  readonly power = vi.fn((_action: PowerAction) => Promise.resolve());
  readonly consoleSnapshot = vi.fn(() => [...SNAPSHOT_LINES]);
}

interface Harness {
  port: number;
  instance: FakeServerInstance;
  app: FastifyInstance;
}

function buildConfig(overrides: { allowedOrigins?: string[] } = {}): DaemonConfig {
  return daemonConfigSchema.parse({
    uuid: NODE_UUID,
    tokenId: 'abcdefghijklmnop',
    tokenSecret: NODE_TOKEN_SECRET,
    api: { allowedOrigins: overrides.allowedOrigins ?? [PANEL_ORIGIN] },
    panel: { url: ISSUER, jwtSecret: JWT_SECRET },
  });
}

async function startHarness(configOverrides: { allowedOrigins?: string[] } = {}): Promise<Harness> {
  const instance = new FakeServerInstance();

  const manager = {
    get: (uuid: string): ServerInstance | undefined =>
      uuid === SERVER_UUID ? (instance as unknown as ServerInstance) : undefined,
  } as unknown as ServerManager;

  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const app = Fastify({ logger: false });

  // The same payload ceiling the daemon's HTTP server applies, so a test that
  // sends something large fails here for the same reason it would in
  // production rather than for a reason peculiar to the harness.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  registerConsoleGateway(app, manager, buildConfig(configOverrides), logger);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }

  return { port: address.port, instance, app };
}

// ---------------------------------------------------------------------------

describe('registerConsoleGateway', () => {
  let harness: Harness;
  const opened: AttackerSocket[] = [];

  async function openSocket(
    options: { path?: string; origin?: string } = {},
  ): Promise<AttackerSocket> {
    const client = await AttackerSocket.open(
      harness.port,
      options.path ?? `/api/servers/${SERVER_UUID}/ws`,
      { origin: options.origin ?? PANEL_ORIGIN },
    );

    opened.push(client);
    return client;
  }

  /** Opens a connection and drives it to an authenticated state. */
  async function authenticated(token: string): Promise<AttackerSocket> {
    const client = await openSocket();
    client.send({ event: 'auth', token });
    await client.waitForEvent('auth_success');
    return client;
  }

  /**
   * Waits until the daemon has handled everything sent so far.
   *
   * A message the gateway is obliged to answer, used as a fence: frames are
   * handled in arrival order, so its reply means the ones before it are done.
   * It also moves the read cursor past every frame received up to that point,
   * which is what lets a test that follows assert on the *next* thing said.
   */
  async function fence(client: AttackerSocket): Promise<void> {
    client.send({ event: 'nonsense' });
    await client.waitFor(
      (frame) => frame.code === WS_ERROR_CODES.INVALID_MESSAGE,
      'the fence reply',
    );
  }

  /**
   * Presents `token` and asserts the daemon threw it out.
   *
   * The three assertions are one claim: the token bought nothing. A refusal
   * that still attached the session to the server would leak every console
   * line to the holder of a forged token even though `auth_success` never
   * arrived.
   */
  async function expectRefused(token: string, path?: string): Promise<void> {
    const client = await openSocket(path === undefined ? {} : { path });
    client.send({ event: 'auth', token });

    const error = await client.waitForEvent('error');
    expect(error.code).toBe(WS_ERROR_CODES.INVALID_TOKEN);

    const closed = await client.waitForClose();
    expect(closed.code).toBe(1008);

    expect(client.all().some((frame) => frame.event === 'auth_success')).toBe(false);
    expect(harness.instance.listenerCount('console')).toBe(0);
  }

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    for (const client of opened.splice(0)) {
      client.destroy();
    }

    await harness.app.close();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------

  describe('forging a token', () => {
    it('accepts the token the panel would really have signed', async () => {
      const client = await authenticated(await mintToken());
      const success = client.all().find((frame) => frame.event === 'auth_success')!;

      expect(success.permissions).toEqual(HONEST_PERMISSIONS);
    });

    it('refuses a token signed with a different secret', async () => {
      // The whole architecture is this line. If a signature made with anything
      // other than this node's secret opened a console, the panel's
      // authorisation model would be decoration.
      await expectRefused(await mintToken({ key: Buffer.from(WRONG_SECRET, 'utf8') }));
    });

    it('refuses a token signed with the node token secret instead of the JWT secret', async () => {
      // The daemon holds two secrets and they authenticate opposite
      // directions: `tokenSecret` proves the *panel* to the daemon,
      // `panel.jwtSecret` proves a *browser*. Verifying a console token
      // against the wrong one would mean a leaked node token — a value that
      // travels on every panel-to-daemon call — could mint console sessions.
      await expectRefused(await mintToken({ key: Buffer.from(NODE_TOKEN_SECRET, 'utf8') }));
    });

    it('refuses an unsecured token (alg: none)', async () => {
      const unsecured = new UnsecuredJWT({
        serverUuid: SERVER_UUID,
        permissions: HONEST_PERMISSIONS,
        sub: USER_UUID,
        jti: 'none-1',
      })
        .setIssuer(ISSUER)
        .setAudience(NODE_UUID)
        .setIssuedAt()
        .setExpirationTime('600s')
        .encode();

      await expectRefused(unsecured);
    });

    it('refuses an algorithm the verifier did not pin, even with the right secret', async () => {
      // HS512 with the correct key is a valid signature by any general
      // definition. Pinning `algorithms` is what stops the verifier being
      // steered by a header the attacker writes.
      await expectRefused(await mintToken({ alg: 'HS512' }));
    });

    it('refuses an RS256 signature wearing an HS256 header', async () => {
      // The classic confusion: the attacker signs asymmetrically and relabels
      // the header so the verifier reaches for its symmetric path. It cannot
      // work here — the key is a shared secret, not a published public key —
      // but the day someone swaps `jwtSecret` for a key pair, this is the test
      // that has to keep failing the forgery.
      const { privateKey } = await generateKeyPair('RS256');
      const rs256 = await mintToken({ alg: 'RS256', key: privateKey });

      await expectRefused(withHeader(rs256, { alg: 'HS256' }));
      await expectRefused(rs256);
    });

    it('refuses a signature with a single bit flipped', async () => {
      await expectRefused(withFlippedSignatureBit(await mintToken()));
    });

    it('refuses a signature one byte short', async () => {
      // A truncated MAC must not be compared prefix-wise. If it were, an
      // attacker could search the remaining bytes one at a time.
      await expectRefused(withTruncatedSignature(await mintToken()));
    });

    it('refuses a token with no signature at all', async () => {
      const [header, payload] = splitToken(await mintToken());
      await expectRefused(`${header}.${payload}.`);
    });

    it('refuses permissions escalated after signing', async () => {
      // The forgery a subuser with console-only access would actually try:
      // keep the panel's own signature, edit the claim list on the way past.
      const token = withTamperedPayload(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
        (claims) => {
          claims.permissions = [
            PERMISSIONS.WEBSOCKET_CONNECT,
            PERMISSIONS.CONTROL_CONSOLE,
            PERMISSIONS.CONTROL_STOP,
          ];
        },
      );

      await expectRefused(token);
    });

    it('refuses a payload swapped between two honestly signed tokens', async () => {
      // Cut-and-paste: two tokens the panel really issued, recombined. The
      // signature covers the payload, so neither half survives the other.
      const mine = await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } });
      const powerful = await mintToken({ claims: { jti: 'console-token-2' } });

      const [header, , signature] = splitToken(mine);
      const [, powerfulPayload] = splitToken(powerful);

      await expectRefused(`${header}.${powerfulPayload}.${signature}`);
    });

    it.each([
      ['empty-ish string', ' '],
      ['not a JWT', 'give-me-a-console'],
      ['two segments only', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0'],
      ['five segments', 'a.b.c.d.e'],
      ['header that is not JSON', `${Buffer.from('nope').toString('base64url')}.e30.sig`],
    ])('refuses a malformed token: %s', async (_label, token) => {
      await expectRefused(token);
    });
  });

  // -------------------------------------------------------------------------

  describe('pointing a valid token at the wrong place', () => {
    it("refuses a token minted for another node's audience", async () => {
      // `aud` is this node's UUID. Without that check, an operator of any
      // compromised node could take the tokens their own daemon receives and
      // replay them against every other node sharing the secret — which is
      // exactly what a shared-secret design has to rule out explicitly.
      await expectRefused(await mintToken({ claims: { aud: OTHER_NODE_UUID } }));
    });

    it('refuses a token issued by another panel', async () => {
      await expectRefused(await mintToken({ claims: { iss: OTHER_ISSUER } }));
    });

    it('refuses a token naming a different server than the URL', async () => {
      // The reason a subuser on one server cannot read the console of
      // another: the URL is attacker-chosen, `serverUuid` is signed, and the
      // two have to agree.
      await expectRefused(await mintToken({ claims: { serverUuid: OTHER_SERVER_UUID } }));
    });

    it('refuses a valid token presented on another server’s URL', async () => {
      await expectRefused(await mintToken(), `/api/servers/${OTHER_SERVER_UUID}/ws`);
    });

    it('does not confuse an unknown server with a bad token', async () => {
      // A token perfectly valid for a server this node does not host: the
      // daemon has to say so with its own code rather than call the token
      // invalid, or an operator debugging a migrated server chases a
      // signature problem that does not exist.
      const client = await openSocket({ path: `/api/servers/${UNHOSTED_SERVER_UUID}/ws` });
      client.send({
        event: 'auth',
        token: await mintToken({ claims: { serverUuid: UNHOSTED_SERVER_UUID } }),
      });

      const error = await client.waitForEvent('error');
      expect(error.code).toBe(WS_ERROR_CODES.INTERNAL);
      expect(await client.waitForClose()).toMatchObject({ code: 1011 });
    });
  });

  // -------------------------------------------------------------------------

  describe('time', () => {
    it('refuses a token that expired a second ago', async () => {
      await expectRefused(await mintToken({ ttlSeconds: -1 }));
    });

    it('refuses a token whose nbf has not arrived', async () => {
      // A token minted for later must not work now. `jose` enforces this with
      // no clock tolerance configured, and nothing in the contract schema
      // would catch it — so if the `nbf` default ever changed, this is the
      // only thing that would notice.
      await expectRefused(
        await mintToken({ claims: { nbf: Math.floor(Date.now() / 1000) + 300 } }),
      );
    });

    it('refuses a token with no exp, which jose alone would have accepted', async () => {
      const eternal = await mintToken({ ttlSeconds: null });

      // Proof that the signature layer is *not* what saves us here: with the
      // daemon's own verification options, `jwtVerify` resolves happily on a
      // token that never expires. An `exp`-less console token would be a
      // permanent, unrevocable key to a server's console.
      await expect(
        jwtVerify(eternal, SIGNING_KEY, {
          issuer: ISSUER,
          audience: NODE_UUID,
          algorithms: ['HS256'],
        }),
      ).resolves.toBeDefined();

      await expectRefused(eternal);
    });

    it('accepts a token inside its normal lifetime', async () => {
      const client = await authenticated(await mintToken({ ttlSeconds: 600 }));
      const success = client.all().find((frame) => frame.event === 'auth_success')!;

      expect(success.expiresAt).toBeGreaterThan(Date.now());
    });

    /**
     * Three seconds rather than one, and the difference is a race this test
     * used to run.
     *
     * The lifetime starts when the token is minted, and the handshake it has to
     * survive is a socket opened, a frame sent and a frame answered. One second
     * is enough for that on an idle laptop and not on a loaded CI runner: the
     * token expired before the connection was authenticated, the daemon
     * answered `invalid_token` — correctly — and the wait for `auth_success`
     * timed out on a fault that was in the clock and not in the gateway.
     *
     * Three seconds is headroom for the handshake, not a change to what is
     * asserted: the console still has to be closed by the expiry rather than by
     * anything else, and 1008 is still the code it has to close with.
     */
    it('closes the console when the token expires under it', async () => {
      const client = await authenticated(await mintToken({ ttlSeconds: 3 }));

      expect((await client.waitForEvent('token_expired', 10_000)).event).toBe('token_expired');
      expect(await client.waitForClose()).toMatchObject({ code: 1008 });
    });

    it('warns before expiry so the client can renew', async () => {
      // The renewal margin is 60 seconds, so a 61-second token asks for a new
      // one after about a second. Without this warning the console would drop
      // mid-session, which is the failure the whole renewal dance exists to
      // avoid.
      const client = await authenticated(await mintToken({ ttlSeconds: 61 }));

      expect((await client.waitForEvent('token_expiring', 4_000)).event).toBe('token_expiring');
    });

    it('puts no ceiling on how far ahead exp may be', async () => {
      // Nothing in the daemon compares `exp - iat` against the short
      // lifetime the design promises: `maxTokenAge` is not set and the schema
      // only requires `exp` to be an integer. A token good for a fortnight is
      // authenticated in full, and short lifetimes are the *only* revocation
      // this design has. It is the panel, and nothing here, that keeps them
      // short.
      const client = await authenticated(await mintToken({ ttlSeconds: 14 * 24 * 60 * 60 }));
      const success = client.all().find((frame) => frame.event === 'auth_success')!;

      expect(success.expiresAt).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
    });

    it('cannot hold a token valid beyond a 32-bit timer and closes at once', async () => {
      // Past about 24.8 days the expiry delay overflows `setTimeout`, which
      // clamps to 1ms — so an absurdly long token authenticates and is then
      // torn down immediately. Fail-closed, and worth pinning: an accidental
      // change to fail-open here would turn the previous test's observation
      // into an eternal session.
      const client = await authenticated(await mintToken({ ttlSeconds: 10 * 365 * 24 * 60 * 60 }));

      expect((await client.waitForEvent('token_expired')).event).toBe('token_expired');
      expect(await client.waitForClose()).toMatchObject({ code: 1008 });
    });
  });

  // -------------------------------------------------------------------------

  describe('the contract as a second gate', () => {
    /**
     * Payloads that `jwtVerify` is perfectly happy with.
     *
     * Each case asserts twice: that the signature layer lets it through, and
     * that the gateway does not. Delete the `consoleTokenPayloadSchema` check
     * from `authenticate` and every one of these turns into a live session —
     * which is the point of having the second gate at all.
     */
    const acceptedByJose: [string, MintOptions][] = [
      ['no exp', { ttlSeconds: null }],
      ['no jti', { without: ['jti'] }],
      ['no sub', { without: ['sub'] }],
      ['no serverUuid', { without: ['serverUuid'] }],
      ['no permissions', { without: ['permissions'] }],
      ['aud as an array containing this node', { claims: { aud: [NODE_UUID, OTHER_NODE_UUID] } }],
      ['permissions holding a value outside the enum', { claims: { permissions: ['control.*'] } }],
      ['permissions holding an object', { claims: { permissions: [{ all: true }] } }],
      ['permissions as a bare string', { claims: { permissions: PERMISSIONS.CONTROL_CONSOLE } }],
      [
        'exp that is not a whole number',
        { ttlSeconds: null, claims: { exp: Math.floor(Date.now() / 1000) + 600.5 } },
      ],
    ];

    it.each(acceptedByJose)('refuses a payload jose accepts: %s', async (_label, options) => {
      const token = await mintToken(options);

      await expect(
        jwtVerify(token, SIGNING_KEY, {
          issuer: ISSUER,
          audience: NODE_UUID,
          algorithms: ['HS256'],
        }),
      ).resolves.toBeDefined();

      await expectRefused(token);
    });

    it('refuses a serverUuid that is not a UUID, presented at its own URL', async () => {
      // Deliberately opened at the URL the claim names. The obvious version of
      // this test sends `serverUuid: '../../etc/passwd'` to the normal URL,
      // where the `claims.serverUuid !== this.serverUuid` comparison refuses it
      // before the schema is ever consulted — mutate `z.uuid()` to `z.string()`
      // and it stays green, which makes it a test of the comparison wearing the
      // schema's name.
      //
      // Matching the two makes the schema the only thing left that can object.
      // Weaken it and this token reaches `manager.get`, which refuses an
      // unknown server with `internal` and code 1011 — a different answer,
      // caught below.
      const serverUuid = 'not-a-uuid';
      const token = await mintToken({ claims: { serverUuid } });

      await expect(
        jwtVerify(token, SIGNING_KEY, {
          issuer: ISSUER,
          audience: NODE_UUID,
          algorithms: ['HS256'],
        }),
      ).resolves.toBeDefined();

      await expectRefused(token, `/api/servers/${serverUuid}/ws`);
    });

    it('ignores claims the contract does not know about', async () => {
      // Extra claims are stripped, not honoured and not fatal. A forged
      // `role: ADMIN` must buy nothing, and a claim the panel adds in a later
      // version must not break older daemons.
      const client = await authenticated(
        await mintToken({
          claims: {
            role: 'ADMIN',
            admin: true,
            scope: '*',
            permissions: [PERMISSIONS.WEBSOCKET_CONNECT],
          },
        }),
      );

      const success = client.all().find((frame) => frame.event === 'auth_success')!;
      expect(success.permissions).toEqual([PERMISSIONS.WEBSOCKET_CONNECT]);

      client.send({ event: 'send_command', command: 'op attacker' });
      const error = await client.waitForEvent('error');

      expect(error.code).toBe(WS_ERROR_CODES.FORBIDDEN);
      expect(harness.instance.sendCommand).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('what the token is allowed to do', () => {
    it('refuses a command from a session without control.console', async () => {
      const client = await authenticated(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
      );

      client.send({ event: 'send_command', command: 'op attacker' });
      const error = await client.waitForEvent('error');

      expect(error.code).toBe(WS_ERROR_CODES.FORBIDDEN);
      expect(error.message).toContain(PERMISSIONS.CONTROL_CONSOLE);
      expect(harness.instance.sendCommand).not.toHaveBeenCalled();
    });

    it('delivers a command from a session that holds control.console', async () => {
      const client = await authenticated(await mintToken());
      client.send({ event: 'send_command', command: 'say hello' });
      await client.settle();

      expect(harness.instance.sendCommand).toHaveBeenCalledWith('say hello');
    });

    it.each([
      ['start', PERMISSIONS.CONTROL_START],
      ['stop', PERMISSIONS.CONTROL_STOP],
      ['restart', PERMISSIONS.CONTROL_RESTART],
      // Killing is destructive but shares the stop permission, by design.
      ['kill', PERMISSIONS.CONTROL_STOP],
    ] satisfies [PowerAction, Permission][])(
      'refuses %s without %s and allows it with',
      async (action, required) => {
        const others = [
          PERMISSIONS.CONTROL_START,
          PERMISSIONS.CONTROL_STOP,
          PERMISSIONS.CONTROL_RESTART,
        ].filter((permission) => permission !== required);

        const denied = await authenticated(await mintToken({ claims: { permissions: others } }));
        denied.send({ event: 'set_state', action });

        const error = await denied.waitForEvent('error');
        expect(error.code).toBe(WS_ERROR_CODES.FORBIDDEN);
        expect(harness.instance.power).not.toHaveBeenCalled();

        const allowed = await authenticated(
          await mintToken({ claims: { permissions: [required] } }),
        );
        allowed.send({ event: 'set_state', action });
        await allowed.settle();

        expect(harness.instance.power).toHaveBeenCalledWith(action);
      },
    );

    it('never replays the console buffer to a session without control.console', async () => {
      // The buffer is 500 lines of whatever the server printed — chat,
      // command output, sometimes a token an operator pasted. `websocket.
      // connect` is implicit for every subuser, so this is the line between
      // "can see the server exists" and "can read everything said on it".
      const client = await authenticated(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
      );

      client.send({ event: 'request_logs' });

      // Refused out loud, not ignored: a client left waiting on a buffer that
      // is never coming cannot tell that from a server with nothing to say.
      const error = await client.waitForEvent('error');
      expect(error.code).toBe(WS_ERROR_CODES.FORBIDDEN);
      expect(error.message).toContain(PERMISSIONS.CONTROL_CONSOLE);

      expect(client.all().some((frame) => frame.event === 'console_output')).toBe(false);
      expect(harness.instance.consoleSnapshot).not.toHaveBeenCalled();
    });

    it('replays the console buffer to a session that holds control.console', async () => {
      const client = await authenticated(await mintToken());
      await client.waitFor(
        (frame) => frame.event === 'console_output' && frame.line === SNAPSHOT_LINES[1],
        'the end of the console snapshot',
      );

      expect(harness.instance.consoleSnapshot).toHaveBeenCalled();
    });

    it('never streams live output to a session without control.console either', async () => {
      // The replay gate was worth very little on its own: it held back the
      // buffer and then handed over everything printed from that second
      // onwards, which is the same secrets a minute later — the RCON password
      // an operator pastes, the key a plugin prints on load, the `op` that
      // names the next administrator. `websocket.connect` is implicit for
      // every subuser, so this was every subuser.
      const client = await authenticated(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
      );
      await fence(client);

      harness.instance.emit('console', 'rcon.password=hunter2');
      harness.instance.emit('install_output', 'curl https://cdn.example/egg?key=s3cret');
      await fence(client);

      const events = client.all().map((frame) => frame.event);
      expect(events).not.toContain('console_output');
      expect(events).not.toContain('install_output');
    });

    it('still tells a session without control.console what its server is doing', async () => {
      // The other half of the same decision, and the reason the gate is on the
      // output rather than on the subscription: a subuser who may not read the
      // console is still meant to watch the server go up and down, see what it
      // is consuming, and know an installation is running. Those say *that*
      // something happened; only the output says *what was said*.
      const client = await authenticated(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
      );
      await fence(client);

      harness.instance.emit('state', 'running');
      harness.instance.emit('stats', RUNNING_SAMPLE);
      harness.instance.emit('install_started');
      harness.instance.emit('install_completed', true);
      await fence(client);

      const frames = client.all();
      expect(frames).toContainEqual({ event: 'status', state: 'running' });
      expect(frames).toContainEqual({ event: 'stats', usage: RUNNING_SAMPLE });
      expect(frames).toContainEqual({ event: 'install_started' });
      expect(frames).toContainEqual({ event: 'install_completed', successful: true });
    });

    it('says so rather than showing an empty console for no stated reason', async () => {
      // A withheld console and a silent server look identical from the browser.
      // Whoever is handed a subuser account with no console permission should
      // read why their terminal is empty, not open a ticket about it.
      const client = await authenticated(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
      );
      const notice = await client.waitForEvent('daemon_message');

      expect(notice.message).toContain(PERMISSIONS.CONTROL_CONSOLE);
    });

    it('streams live output to a session that holds control.console', async () => {
      const client = await authenticated(await mintToken());
      await fence(client);

      harness.instance.emit('console', 'a line worth reading');
      harness.instance.emit('install_output', 'unpacking');

      expect((await client.waitForEvent('console_output')).line).toBe('a line worth reading');
      expect((await client.waitForEvent('install_output')).line).toBe('unpacking');
    });

    it('stops streaming the moment a renewal drops the permission, and resumes when it returns', async () => {
      // The permission is consulted when the line arrives, not when the
      // listener is attached — which is the only reading that makes the
      // short token lifetime mean anything. Attaching conditionally would have
      // frozen the session at the permissions it opened with, in both
      // directions.
      const client = await authenticated(await mintToken());
      await fence(client);

      client.send({
        event: 'auth',
        token: await mintToken({
          claims: { jti: 'narrowed-1', permissions: [PERMISSIONS.WEBSOCKET_CONNECT] },
        }),
      });
      await client.waitForEvent('auth_success');
      await fence(client);

      harness.instance.emit('console', 'said after the narrowing');
      await fence(client);

      expect(client.all().some((frame) => frame.line === 'said after the narrowing')).toBe(false);

      client.send({ event: 'auth', token: await mintToken({ claims: { jti: 'restored-1' } }) });
      await client.waitForEvent('auth_success');
      await fence(client);

      harness.instance.emit('console', 'said after the restoration');
      await fence(client);

      expect(client.all().some((frame) => frame.line === 'said after the restoration')).toBe(true);
    });

    it('answers request_stats with a stats sample rather than a status', async () => {
      // It replied with `status`: the client asked what the server is
      // consuming and was told what state it is in. `ResourceUsage` carries
      // the state too, so the right event says everything the wrong one did.
      const client = await authenticated(await mintToken());
      await fence(client);

      client.send({ event: 'request_stats' });
      const stats = await client.waitForEvent('stats');

      expect(stats.usage).toEqual(harness.instance.idleUsage);
    });

    it('answers request_stats with the latest sample, and forgets it when the state moves', async () => {
      const client = await authenticated(await mintToken());
      await fence(client);

      harness.instance.emit('stats', RUNNING_SAMPLE);
      await fence(client);

      client.send({ event: 'request_stats' });
      expect((await client.waitForEvent('stats')).usage).toEqual(RUNNING_SAMPLE);

      // A sample describes the state it was taken in. Once the server has left
      // it, reporting half a gigabyte of memory for a stopped process would be
      // worse than reporting nothing.
      harness.instance.emit('state', 'offline');
      await fence(client);

      client.send({ event: 'request_stats' });
      expect((await client.waitForEvent('stats')).usage).toEqual(harness.instance.idleUsage);
    });

    it('reads permissions from the token presented, not from anything cached', async () => {
      // Renewal happens over the same socket. If the session kept the
      // permissions it started with, a narrowed token would be cosmetic and
      // the short lifetime — the only revocation this design has — would
      // buy nothing at all.
      const client = await authenticated(await mintToken());
      client.send({ event: 'send_command', command: 'say still allowed' });
      await client.settle();
      expect(harness.instance.sendCommand).toHaveBeenCalledTimes(1);

      client.send({
        event: 'auth',
        token: await mintToken({
          claims: { jti: 'renewal-1', permissions: [PERMISSIONS.WEBSOCKET_CONNECT] },
        }),
      });
      await client.waitForEvent('auth_success');

      client.send({ event: 'send_command', command: 'op attacker' });
      const error = await client.waitForEvent('error');

      expect(error.code).toBe(WS_ERROR_CODES.FORBIDDEN);
      expect(harness.instance.sendCommand).toHaveBeenCalledTimes(1);
    });

    it('kills the session when a renewal token is forged', async () => {
      const client = await authenticated(
        await mintToken({ claims: { permissions: [PERMISSIONS.WEBSOCKET_CONNECT] } }),
      );

      client.send({
        event: 'auth',
        token: await mintToken({
          claims: { permissions: HONEST_PERMISSIONS },
          key: Buffer.from(WRONG_SECRET, 'utf8'),
        }),
      });

      const error = await client.waitForEvent('error');
      expect(error.code).toBe(WS_ERROR_CODES.INVALID_TOKEN);
      expect(await client.waitForClose()).toMatchObject({ code: 1008 });
    });

    it('does not multiply its output when a session re-authenticates repeatedly', async () => {
      // Renewal must not attach a second set of listeners. If it did, a client
      // re-authenticating in a loop would make the daemon serialise every
      // console line N times — a free amplifier pointed at its own memory.
      const client = await authenticated(await mintToken());

      for (let index = 0; index < 5; index += 1) {
        client.send({
          event: 'auth',
          token: await mintToken({ claims: { jti: `renew-${index}` } }),
        });
        await client.waitForEvent('auth_success');
      }

      expect(harness.instance.listenerCount('console')).toBe(1);

      harness.instance.emit('console', 'a single line');
      await client.settle();

      const lines = client.all().filter((frame) => frame.line === 'a single line');
      expect(lines).toHaveLength(1);
    });

    it('detaches from the server when the console closes', async () => {
      const client = await authenticated(await mintToken());
      expect(harness.instance.listenerCount('console')).toBe(1);

      client.destroy();
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      expect(harness.instance.listenerCount('console')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('the connection itself', () => {
    it('refuses every message sent before authentication', async () => {
      const client = await openSocket();

      client.send({ event: 'send_command', command: 'stop' });
      client.send({ event: 'set_state', action: 'kill' });
      client.send({ event: 'request_logs' });

      for (let index = 0; index < 3; index += 1) {
        expect((await client.next()).code).toBe(WS_ERROR_CODES.UNAUTHENTICATED);
      }

      expect(harness.instance.sendCommand).not.toHaveBeenCalled();
      expect(harness.instance.power).not.toHaveBeenCalled();
      expect(harness.instance.consoleSnapshot).not.toHaveBeenCalled();
    });

    it('answers a malformed message without dropping the connection', async () => {
      const client = await authenticated(await mintToken());

      client.sendText('{not json');
      expect((await client.waitForEvent('error')).code).toBe(WS_ERROR_CODES.INVALID_MESSAGE);

      client.send({ event: 'send_command' });
      expect((await client.waitForEvent('error')).code).toBe(WS_ERROR_CODES.INVALID_MESSAGE);

      client.send({ event: 'become_admin' });
      expect((await client.waitForEvent('error')).code).toBe(WS_ERROR_CODES.INVALID_MESSAGE);

      // Still alive and still obeying: the parser must not be a way to knock
      // other people's consoles over, nor a way to skip the switch.
      client.send({ event: 'send_command', command: 'say alive' });
      await client.settle();
      expect(harness.instance.sendCommand).toHaveBeenCalledWith('say alive');
      expect(client.closedWith).toBeNull();
    });

    it('costs a fresh connection per signature attempt', async () => {
      // A refused token closes the socket, so guessing a 64-byte HMAC secret
      // costs a TCP and WebSocket handshake per guess rather than a frame.
      const client = await openSocket();
      client.send({ event: 'auth', token: await mintToken({ key: Buffer.from(WRONG_SECRET) }) });
      await client.waitForClose();

      client.send({ event: 'auth', token: await mintToken() });
      await client.settle(200);

      expect(client.all().some((frame) => frame.event === 'auth_success')).toBe(false);
    });

    it('closes a connection that never authenticates, and only that one', async () => {
      // Ten seconds of real time, on purpose: the timeout is the only thing
      // bounding how many half-open sockets an unauthenticated stranger can
      // park on a daemon, and a fake clock would not prove the timer is
      // actually armed on the live socket. The second connection is here to
      // show the timer is cleared on success rather than merely late.
      const silent = await openSocket();
      const busy = await authenticated(await mintToken());

      const error = await silent.waitForEvent('error', 13_000);
      expect(error.code).toBe(WS_ERROR_CODES.UNAUTHENTICATED);
      expect(await silent.waitForClose()).toMatchObject({ code: 1008 });

      expect(busy.closedWith).toBeNull();
      busy.send({ event: 'send_command', command: 'say survived' });
      await busy.settle();
      expect(harness.instance.sendCommand).toHaveBeenCalledWith('say survived');
    }, 20_000);

    it('stops a console at sixty commands a minute', async () => {
      const client = await authenticated(await mintToken());

      for (let index = 0; index < 61; index += 1) {
        client.send({ event: 'send_command', command: `say ${index}` });
      }

      const error = await client.waitForEvent('error');
      expect(error.code).toBe(WS_ERROR_CODES.RATE_LIMITED);
      expect(harness.instance.sendCommand).toHaveBeenCalledTimes(60);
    });

    it('counts that quota per user and per server, so a second socket adds nothing', async () => {
      // The counter used to live on the session object, which made it
      // arithmetic rather than a limit: one token, two sockets, 120 commands a
      // minute, and nothing anywhere caps the sockets. The quota now hangs off
      // the identity the panel signed — this user, on this server — which the
      // holder of a token cannot multiply by opening connections.
      const token = await mintToken();
      const first = await authenticated(token);
      const second = await authenticated(token);

      for (const client of [first, second]) {
        for (let index = 0; index < 61; index += 1) {
          client.send({ event: 'send_command', command: `say ${index}` });
        }
      }

      await first.waitFor(
        (frame) => frame.code === WS_ERROR_CODES.RATE_LIMITED,
        'the first socket to be cut off',
      );
      await second.waitFor(
        (frame) => frame.code === WS_ERROR_CODES.RATE_LIMITED,
        'the second socket to be cut off',
      );
      await fence(first);
      await fence(second);

      expect(harness.instance.sendCommand).toHaveBeenCalledTimes(60);
    });

    it('does not let one subuser spend the quota of another', async () => {
      // The tempting key is the server, since the server is what the quota
      // protects. It would also mean a subuser with console access could burn
      // sixty commands and leave the owner unable to type `stop` — a denial of
      // service handed out with the console permission.
      const mine = await authenticated(await mintToken());
      const theirs = await authenticated(
        await mintToken({ claims: { sub: '66666666-6666-4666-8666-666666666666' } }),
      );

      for (let index = 0; index < 61; index += 1) {
        mine.send({ event: 'send_command', command: `say ${index}` });
      }

      await mine.waitFor(
        (frame) => frame.code === WS_ERROR_CODES.RATE_LIMITED,
        'my own quota running out',
      );

      theirs.send({ event: 'send_command', command: 'stop' });
      await fence(theirs);

      expect(harness.instance.sendCommand).toHaveBeenCalledWith('stop');
    });

    it('frees a used slot a minute after that use, not a minute after the first', async () => {
      // The window the comment called sliding was tumbling: it reset wholesale
      // once a minute had elapsed since it began, so sixty commands timed just
      // before that instant and sixty just after went through in a fifth of a
      // second — twice the advertised limit, exactly when someone is trying.
      //
      // The arithmetic below is written to tell the two apart precisely. One
      // command, then fifty-nine a moment before the minute is up, spends the
      // whole allowance. Two hundred milliseconds later exactly **one** slot
      // has come free — the one used at the start, and nothing else — so of
      // five further commands exactly one may pass. Any window that starts
      // over instead, whether it counts from the session or from the first
      // command, lets all five through.
      //
      // Only `Date` is faked: the sockets, the daemon's timers and this test's
      // own waits stay on real time, so what is measured is the quota's
      // arithmetic and nothing else.
      const client = await authenticated(await mintToken());
      await fence(client);

      vi.useFakeTimers({ toFake: ['Date'] });

      client.send({ event: 'send_command', command: 'say first' });
      await fence(client);

      vi.setSystemTime(Date.now() + 59_900);

      for (let index = 0; index < 59; index += 1) {
        client.send({ event: 'send_command', command: `say ${index}` });
      }

      await fence(client);
      expect(harness.instance.sendCommand).toHaveBeenCalledTimes(60);

      vi.setSystemTime(Date.now() + 200);

      for (let index = 0; index < 5; index += 1) {
        client.send({ event: 'send_command', command: `say over the boundary ${index}` });
      }

      await fence(client);

      expect(harness.instance.sendCommand).toHaveBeenCalledTimes(61);
      expect(client.all().some((frame) => frame.code === WS_ERROR_CODES.RATE_LIMITED)).toBe(true);
    });

    it('stops power actions well before it stops commands', async () => {
      // A start/kill loop is far more expensive than console chatter — every
      // iteration is container work on a daemon running as root — and this
      // path consulted no quota whatsoever: all two hundred reached
      // `ServerInstance.power`. Its own allowance, and a much smaller one,
      // rather than a share of the console's: an operator must never find
      // themselves unable to stop a server because a console was busy.
      const client = await authenticated(await mintToken());

      for (let index = 0; index < 200; index += 1) {
        client.send({ event: 'set_state', action: index % 2 === 0 ? 'start' : 'kill' });
      }

      await fence(client);

      expect(harness.instance.power).toHaveBeenCalledTimes(10);
      expect(client.all().some((frame) => frame.code === WS_ERROR_CODES.RATE_LIMITED)).toBe(true);

      // The console still works: the two allowances are separate.
      client.send({ event: 'send_command', command: 'say still here' });
      await fence(client);
      expect(harness.instance.sendCommand).toHaveBeenCalledWith('say still here');
    });

    it('rations console replays, which are the one amplifying request', async () => {
      // One thirty-byte frame asks the daemon to serialise the whole buffer —
      // up to 500 separate messages. Asked in a loop by a client that never
      // reads its socket, the replies pile up in the daemon's send buffer: a
      // cheap amplifier aimed at the memory of the process that owns every
      // container on the host.
      const before = harness.instance.consoleSnapshot.mock.calls.length;
      const client = await authenticated(await mintToken());

      // Counted from before the connection, deliberately: authenticating spends
      // one of the six. Leaving the connect path free would have priced the
      // whole quota at nothing, since fifty replays would then cost fifty
      // sockets rather than one.
      for (let index = 0; index < 50; index += 1) {
        client.send({ event: 'request_logs' });
      }

      await fence(client);

      expect(harness.instance.consoleSnapshot.mock.calls.length - before).toBe(6);
      expect(client.all().some((frame) => frame.code === WS_ERROR_CODES.RATE_LIMITED)).toBe(true);
    });

    it('spends a replay on the snapshot it sends at authentication', async () => {
      // The bypass this closes: the connect path called `sendConsoleSnapshot`
      // directly, so the allowance added against `request_logs` was avoidable
      // by opening another socket instead of asking again.
      const before = harness.instance.consoleSnapshot.mock.calls.length;

      for (let index = 0; index < 8; index += 1) {
        await authenticated(await mintToken());
      }

      expect(harness.instance.consoleSnapshot.mock.calls.length - before).toBe(6);
    });

    it('hangs up on a client that has stopped reading its socket', async () => {
      // The other half of the amplification: the quota bounds how often a
      // replay may be asked for, not what becomes of it. A client that asks
      // and then stops reading leaves the answer queued inside the daemon, and
      // a queue nobody drains is just a slower way of spending its memory.
      //
      // A buffer of maximum-length lines is the worst case the daemon can
      // legitimately be asked to write, so the ceiling has to sit above one of
      // them and below a pile.
      harness.instance.consoleSnapshot.mockReturnValue(
        Array.from({ length: CONSOLE_BUFFER_LINES }, (_, index) => `${index} ${'x'.repeat(8_000)}`),
      );

      const client = await authenticated(await mintToken());
      client.pause();

      for (let index = 0; index < 4; index += 1) {
        client.send({ event: 'request_logs' });
      }

      await client.settle(500);
      client.resume();

      expect(await client.waitForClose(10_000)).toMatchObject({ code: 1013 });
    }, 20_000);

    it('executes nothing more once it has told the client the token expired', async () => {
      // Expiry used to be enforced by closing the socket and by nothing else:
      // the session stayed marked authenticated, and `ws` keeps delivering
      // frames until the peer answers the close frame or the 30-second close
      // timer fires. A client that simply does not answer — this one — went on
      // driving a root-privileged daemon with a token already declared dead,
      // blind but perfectly effective, since a console command needs no reply
      // to do its work.
      const client = await authenticated(await mintToken({ ttlSeconds: 1 }));
      client.politeClose = false;

      await client.waitForEvent('token_expired', 4_000);
      harness.instance.sendCommand.mockClear();
      harness.instance.power.mockClear();

      // Well clear of the tick the close frame went out on, so this is the
      // handshake window and not a race with the timer.
      await client.settle(400);

      client.send({ event: 'send_command', command: 'op attacker' });
      client.send({ event: 'set_state', action: 'kill' });
      await client.settle(200);

      expect(harness.instance.sendCommand).not.toHaveBeenCalled();
      expect(harness.instance.power).not.toHaveBeenCalled();
    });

    it('executes nothing more once it has refused a renewal token', async () => {
      // The same handshake window, reached by the other door: a session
      // already authorised presents a forged renewal, and the socket takes as
      // long to shut as the peer cares to take. The refusal has to be of the
      // session, not merely of the token.
      const client = await authenticated(await mintToken());
      client.politeClose = false;

      client.send({
        event: 'auth',
        token: await mintToken({ key: Buffer.from(WRONG_SECRET, 'utf8') }),
      });

      await client.waitForEvent('error');
      harness.instance.sendCommand.mockClear();
      await client.settle(200);

      client.send({ event: 'send_command', command: 'op attacker' });
      await client.settle(200);

      expect(harness.instance.sendCommand).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('the origin check', () => {
    it('lets the panel through', async () => {
      const client = await openSocket({ origin: PANEL_ORIGIN });
      client.send({ event: 'auth', token: await mintToken() });

      expect((await client.waitForEvent('auth_success')).event).toBe('auth_success');
    });

    it('refuses another site before a token is even offered', async () => {
      // Browsers do not apply the same-origin policy to WebSockets. Without
      // this check any page a signed-in user visited could open a console on
      // to their servers using the session they already have.
      const client = await openSocket({ origin: EVIL_ORIGIN });
      const closed = await client.waitForClose();

      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('Origin not allowed.');
    });

    it('refuses another site even holding a perfectly valid token', async () => {
      const client = await openSocket({ origin: EVIL_ORIGIN });
      client.send({ event: 'auth', token: await mintToken() });
      await client.settle(200);

      expect(client.all().some((frame) => frame.event === 'auth_success')).toBe(false);
      expect(harness.instance.listenerCount('console')).toBe(0);
    });

    it.each([
      ['a trailing slash', `${PANEL_ORIGIN}/`],
      ['a different scheme', 'http://panel.example.com'],
      ['a different case', 'https://PANEL.example.com'],
      ['a subdomain', 'https://evil.panel.example.com'],
      ['a prefix match', 'https://panel.example.com.evil.test'],
      ['the null origin a sandboxed frame sends', 'null'],
    ])('refuses %s', async (_label, origin) => {
      const client = await openSocket({ origin });
      expect(await client.waitForClose()).toMatchObject({ reason: 'Origin not allowed.' });
    });

    it('lets a connection with no Origin header through', async () => {
      // Deliberate, and worth knowing: the check is `origin && !allowed`, so
      // anything that omits the header skips it. Browsers always send one, so
      // this is not a way back in from a web page — but it does mean the
      // origin check protects only browsers, and a script with a stolen token
      // is unaffected by it.
      const client = await AttackerSocket.open(harness.port, `/api/servers/${SERVER_UUID}/ws`, {});
      opened.push(client);

      client.send({ event: 'auth', token: await mintToken() });
      expect((await client.waitForEvent('auth_success')).event).toBe('auth_success');
    });

    it('blocks every browser when no origin is configured', async () => {
      const empty = await startHarness({ allowedOrigins: [] });

      try {
        const client = await AttackerSocket.open(empty.port, `/api/servers/${SERVER_UUID}/ws`, {
          origin: PANEL_ORIGIN,
        });

        expect(await client.waitForClose()).toMatchObject({ reason: 'Origin not allowed.' });
        client.destroy();
      } finally {
        await empty.app.close();
      }
    });
  });
});

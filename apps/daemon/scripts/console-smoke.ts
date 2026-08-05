/**
 * Manual end-to-end check of the console.
 *
 * Signs a console token as the panel would, opens the daemon's WebSocket,
 * starts the server, waits for it to come online, sends it a command, then
 * stops it cleanly.
 *
 * Usage:
 *   pnpm exec tsx scripts/console-smoke.ts <server-uuid>
 *
 * This script is not an automated test: it needs a running daemon, Docker, and
 * an already-populated volume. It validates the full browser → daemon →
 * container path without opening a browser.
 */
import { randomUUID } from 'node:crypto';
import {
  ALL_PERMISSIONS,
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
} from '@hopper/shared';
import { SignJWT } from 'jose';
import WebSocket from 'ws';

const NODE_UUID = '11111111-1111-4111-8111-111111111111';
const JWT_SECRET = 'dev-jwt-secret-not-for-production-0000000';
const PANEL_URL = 'http://localhost:8080';
const DAEMON_URL = 'ws://127.0.0.1:8443';

const serverUuid = process.argv[2];

if (!serverUuid) {
  process.stderr.write('Usage: tsx scripts/console-smoke.ts <server-uuid>\n');
  process.exit(2);
}

async function signConsoleToken(): Promise<string> {
  return new SignJWT({ serverUuid, permissions: [...ALL_PERMISSIONS] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('00000000-0000-4000-8000-000000000000')
    .setIssuer(PANEL_URL)
    .setAudience(NODE_UUID)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(Buffer.from(JWT_SECRET, 'utf8'));
}

function log(prefix: string, message: string): void {
  process.stdout.write(`${prefix} ${message}\n`);
}

async function main(): Promise<void> {
  const token = await signConsoleToken();
  const socket = new WebSocket(`${DAEMON_URL}/api/servers/${serverUuid}/ws`, {
    headers: { origin: 'http://localhost:8080' },
  });

  let startSent = false;
  let commandSent = false;
  let stopSent = false;

  const send = (message: ClientMessage): void => {
    // Validated before sending: the script also serves to check that the shared
    // contract really describes what the daemon accepts.
    socket.send(JSON.stringify(clientMessageSchema.parse(message)));
  };

  const timeout = setTimeout(() => {
    log('✖', 'Timed out: the server did not reach the expected state.');
    socket.close();
    process.exit(1);
  }, 300_000);

  socket.on('open', () => {
    log('→', 'Connection open, authenticating…');
    send({ event: 'auth', token });
  });

  socket.on('message', (raw: Buffer) => {
    const parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString('utf8')));

    if (!parsed.success) {
      log('✖', `Message outside the contract: ${raw.toString('utf8').slice(0, 200)}`);
      return;
    }

    const message = parsed.data;

    switch (message.event) {
      case 'auth_success':
        log('✓', `Authenticated, ${message.permissions.length} permissions`);
        break;

      case 'status':
        log('●', `State: ${message.state}`);

        if (message.state === 'offline' && !startSent) {
          startSent = true;
          log('→', 'Starting…');
          send({ event: 'set_state', action: 'start' });
        }

        if (message.state === 'running' && !commandSent) {
          commandSent = true;
          log('→', 'Sending "say Hello from Hopper"');
          send({ event: 'send_command', command: 'say Hello from Hopper' });

          setTimeout(() => {
            stopSent = true;
            log('→', 'Stopping cleanly…');
            send({ event: 'set_state', action: 'stop' });
          }, 3000);
        }

        if (message.state === 'offline' && stopSent) {
          clearTimeout(timeout);
          log('✓', 'Full cycle succeeded.');
          socket.close();
          process.exit(0);
        }
        break;

      case 'console_output':
        log('│', message.line);
        break;

      case 'stats':
        log(
          '▪',
          `CPU ${message.usage.cpuPercent}% · RAM ${Math.round(message.usage.memoryBytes / 1024 / 1024)} MiB`,
        );
        break;

      case 'error':
        log('✖', `${message.code}: ${message.message}`);
        break;

      default:
        break;
    }
  });

  socket.on('error', (error: Error) => {
    log('✖', `WebSocket: ${error.message}`);
    process.exit(1);
  });

  socket.on('close', (code: number) => log('←', `Connection closed (${code})`));
}

void main();

/**
 * Vérification manuelle de bout en bout de la console.
 *
 * Signe un jeton de console comme le ferait le panel, ouvre le WebSocket du
 * daemon, démarre le serveur, attend qu'il soit en ligne, lui envoie une
 * commande, puis l'arrête proprement.
 *
 * Usage :
 *   pnpm exec tsx scripts/console-smoke.ts <uuid-du-serveur>
 *
 * Ce script n'est pas un test automatisé : il exige un daemon lancé, Docker, et
 * un volume déjà peuplé. Il sert à valider le chemin complet navigateur →
 * daemon → conteneur sans ouvrir un navigateur.
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
  process.stderr.write('Usage : tsx scripts/console-smoke.ts <uuid-du-serveur>\n');
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
    // Validé avant envoi : le script sert aussi à vérifier que le contrat
    // partagé décrit bien ce que le daemon accepte.
    socket.send(JSON.stringify(clientMessageSchema.parse(message)));
  };

  const timeout = setTimeout(() => {
    log('✖', "Délai dépassé : le serveur n'a pas atteint l'état attendu.");
    socket.close();
    process.exit(1);
  }, 300_000);

  socket.on('open', () => {
    log('→', 'Connexion ouverte, authentification…');
    send({ event: 'auth', token });
  });

  socket.on('message', (raw: Buffer) => {
    const parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString('utf8')));

    if (!parsed.success) {
      log('✖', `Message hors contrat : ${raw.toString('utf8').slice(0, 200)}`);
      return;
    }

    const message = parsed.data;

    switch (message.event) {
      case 'auth_success':
        log('✓', `Authentifié, ${message.permissions.length} permissions`);
        break;

      case 'status':
        log('●', `État : ${message.state}`);

        if (message.state === 'offline' && !startSent) {
          startSent = true;
          log('→', 'Démarrage…');
          send({ event: 'set_state', action: 'start' });
        }

        if (message.state === 'running' && !commandSent) {
          commandSent = true;
          log('→', 'Envoi de « say Bonjour depuis Hopper »');
          send({ event: 'send_command', command: 'say Bonjour depuis Hopper' });

          setTimeout(() => {
            stopSent = true;
            log('→', 'Arrêt propre…');
            send({ event: 'set_state', action: 'stop' });
          }, 3000);
        }

        if (message.state === 'offline' && stopSent) {
          clearTimeout(timeout);
          log('✓', 'Cycle complet réussi.');
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
          `CPU ${message.usage.cpuPercent}% · RAM ${Math.round(message.usage.memoryBytes / 1024 / 1024)} Mio`,
        );
        break;

      case 'error':
        log('✖', `${message.code} : ${message.message}`);
        break;

      default:
        break;
    }
  });

  socket.on('error', (error: Error) => {
    log('✖', `WebSocket : ${error.message}`);
    process.exit(1);
  });

  socket.on('close', (code: number) => log('←', `Connexion fermée (${code})`));
}

void main();

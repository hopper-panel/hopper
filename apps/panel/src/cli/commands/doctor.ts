import { readdir, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Environment } from '../../config/environment.js';
import { NodeClientService } from '../../modules/nodes/node-client.service.js';
import { NodesService } from '../../modules/nodes/nodes.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PANEL_VERSION } from '../../version.js';
import { heading, line, report, type Level } from '../output.js';

/**
 * Diagnostic d'une installation.
 *
 * La commande répond à une question précise : « pourquoi ça ne marche pas ? ».
 * Elle vérifie donc les points qui se cassent réellement — secret par défaut,
 * base non migrée, node injoignable, socket Docker absent — et pas ce qui
 * ferait joli dans un rapport.
 *
 * Trois niveaux : un échec empêche le panel de fonctionner, un avertissement
 * signale une configuration qui marchera mais mordra plus tard (un secret
 * faible, un panel en clair sur l'extérieur). Seuls les échecs changent le code
 * de sortie, pour qu'un `hopper doctor` en fin d'installation puisse être
 * enchaîné à un `&&`.
 */

interface Check {
  level: Level;
  label: string;
  detail?: string;
}

const ok = (label: string, detail?: string): Check => ({ level: 'ok', label, detail });
const warn = (label: string, detail?: string): Check => ({ level: 'warn', label, detail });
const fail = (label: string, detail?: string): Check => ({ level: 'fail', label, detail });

export async function runDoctor(context: INestApplicationContext): Promise<number> {
  const config = context.get(ConfigService<Environment, true>);
  const prisma = context.get(PrismaService);

  const sections: { title: string; checks: Check[] }[] = [];

  sections.push({ title: 'Système', checks: await systemChecks() });
  sections.push({ title: 'Configuration', checks: await configurationChecks(config) });
  sections.push({ title: 'Base de données', checks: await databaseChecks(prisma) });
  sections.push({ title: 'Redis', checks: await redisChecks(config) });
  sections.push({ title: 'Nodes', checks: await nodeChecks(context) });
  sections.push({ title: 'Hôte Docker', checks: await dockerChecks() });

  line(`\nHopper ${PANEL_VERSION} — diagnostic`);

  for (const section of sections) {
    heading(section.title);

    for (const check of section.checks) {
      report(check.level, check.label, check.detail);
    }
  }

  const all = sections.flatMap((section) => section.checks);
  const failures = all.filter((check) => check.level === 'fail').length;
  const warnings = all.filter((check) => check.level === 'warn').length;

  heading('Résultat');

  if (failures > 0) {
    report('fail', `${failures} problème(s) bloquant(s), ${warnings} avertissement(s)`);
    return 1;
  }

  report(
    warnings > 0 ? 'warn' : 'ok',
    warnings > 0 ? `Aucun blocage, ${warnings} avertissement(s)` : 'Installation saine',
  );

  return 0;
}

// ---------------------------------------------------------------------------

async function systemChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

  checks.push(
    major >= 22
      ? ok('Node', `v${process.versions.node}`)
      : fail('Node', `v${process.versions.node} — la version 22 au moins est requise`),
  );

  // Sans cgroup v2, les limites mémoire posées sur les conteneurs sont
  // approximatives et un serveur peut emporter la machine entière.
  const controllers = await readTextFile('/sys/fs/cgroup/cgroup.controllers');

  if (controllers === null) {
    checks.push(
      process.platform === 'linux'
        ? warn('cgroup v2', 'non monté — les limites mémoire seront ignorées')
        : warn('cgroup v2', `absent sur ${process.platform}, normal hors Linux`),
    );
  } else {
    checks.push(
      controllers.includes('memory')
        ? ok('cgroup v2', 'contrôleur mémoire disponible')
        : fail('cgroup v2', 'contrôleur mémoire absent des contrôleurs délégués'),
    );
  }

  return checks;
}

async function configurationChecks(config: ConfigService<Environment, true>): Promise<Check[]> {
  const checks: Check[] = [];

  const environment = config.get('NODE_ENV', { infer: true });
  const appUrl = config.get('APP_URL', { infer: true });
  const secret = config.get('APP_SECRET', { infer: true });
  const host = config.get('HOST', { infer: true });
  const port = config.get('PORT', { infer: true });

  checks.push(
    environment === 'production'
      ? ok('Environnement', 'production')
      : warn(
          'Environnement',
          `${environment} — les cookies de session ne sont pas marqués « secure »`,
        ),
  );

  checks.push(
    secret.includes('changez-moi')
      ? fail('Secret d’application', 'la valeur d’exemple est encore en place')
      : secret.length < 43
        ? warn('Secret d’application', `${secret.length} caractères — 48 recommandés`)
        : ok('Secret d’application', `${secret.length} caractères`),
  );

  const url = safeUrl(appUrl);
  const localhost = url !== null && ['localhost', '127.0.0.1'].includes(url.hostname);

  checks.push(
    localhost && environment === 'production'
      ? fail('URL publique', `${appUrl} — les consoles WebSocket seront refusées`)
      : url?.protocol === 'http:' && !localhost
        ? warn('URL publique', `${appUrl} — sans TLS, les sessions circulent en clair`)
        : ok('URL publique', appUrl),
  );

  checks.push(ok('Écoute', `${host}:${port}`));
  checks.push(await environmentFileCheck());

  return checks;
}

/**
 * Droits du fichier `.env`.
 *
 * Il porte `APP_SECRET` et le mot de passe de la base : lisible par tous, il
 * donne à n'importe quel compte de la machine de quoi déchiffrer les jetons de
 * node et se connecter à la base. Le cas se présente après une installation
 * manuelle, ou quand le fichier a été recopié depuis une autre machine.
 */
async function environmentFileCheck(): Promise<Check> {
  const path = join(process.cwd(), '.env');

  // Les droits POSIX n'ont pas de sens sur Windows, où la valeur rendue par
  // `stat` est toujours 0666 : la vérification y crierait au loup.
  if (process.platform !== 'linux') {
    return ok('Fichier .env', `droits non vérifiés sur ${process.platform}`);
  }

  const info = await stat(path).catch(() => null);

  if (info === null) {
    return warn('Fichier .env', `${path} introuvable — la configuration vient de l’environnement`);
  }

  const mode = info.mode & 0o777;

  return (mode & 0o077) === 0
    ? ok('Fichier .env', `mode ${mode.toString(8).padStart(3, '0')}`)
    : fail(
        'Fichier .env',
        `mode ${mode.toString(8).padStart(3, '0')} — lisible au-delà de son propriétaire : chmod 600 ${path}`,
      );
}

async function databaseChecks(prisma: PrismaService): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push(ok('Connexion'));
  } catch (error: unknown) {
    checks.push(fail('Connexion', messageOf(error)));
    // Tout le reste dépend de la connexion : insister produirait cinq échecs
    // qui décrivent la même panne.
    return checks;
  }

  const pending = await pendingMigrations(prisma);

  if (pending === null) {
    checks.push(warn('Migrations', 'répertoire prisma/migrations introuvable'));
  } else {
    checks.push(
      pending.length === 0
        ? ok('Migrations', 'schéma à jour')
        : fail('Migrations', `${pending.length} en attente : ${pending.join(', ')}`),
    );
  }

  const [admins, servers, nodes] = await Promise.all([
    prisma.user.count({ where: { role: 'ADMIN' } }),
    prisma.server.count(),
    prisma.node.count(),
  ]);

  checks.push(
    admins > 0
      ? ok('Administrateurs', String(admins))
      : fail('Administrateurs', 'aucun compte administrateur — personne ne peut se connecter'),
  );

  checks.push(ok('Inventaire', `${nodes} node(s), ${servers} serveur(s)`));

  return checks;
}

/**
 * Migrations présentes sur disque mais absentes de la table de suivi.
 *
 * Comparer les noms plutôt que d'appeler `prisma migrate status` : la CLI de
 * Prisma n'est pas installée sur une machine de production, où seul le code
 * compilé est déployé.
 */
async function pendingMigrations(prisma: PrismaService): Promise<string[] | null> {
  const directory = join(process.cwd(), 'prisma', 'migrations');

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const onDisk = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const applied = await prisma.$queryRaw<
    { migration_name: string }[]
  >`SELECT migration_name FROM _prisma_migrations`.catch(() => null);

  if (applied === null) {
    return onDisk;
  }

  const names = new Set(applied.map((row) => row.migration_name));

  return onDisk.filter((name) => !names.has(name)).sort();
}

async function redisChecks(config: ConfigService<Environment, true>): Promise<Check[]> {
  const url = config.get('REDIS_URL', { infer: true });

  if (url === undefined) {
    return [
      warn('Redis', 'absent — la limitation de débit repart de zéro à chaque redémarrage du panel'),
    ];
  }

  // `lazyConnect` et un délai court : sans eux, ioredis réessaie indéfiniment
  // et le diagnostic ne rend jamais la main sur un Redis éteint.
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    await client.ping();
    return [ok('Redis', url.replace(/:[^:@/]*@/, ':***@'))];
  } catch (error: unknown) {
    return [fail('Redis', messageOf(error))];
  } finally {
    client.disconnect();
  }
}

async function nodeChecks(context: INestApplicationContext): Promise<Check[]> {
  const prisma = context.get(PrismaService);
  const nodes = context.get(NodesService);
  const client = context.get(NodeClientService);

  const declared = await prisma.node.findMany({
    select: { uuid: true, name: true, fqdn: true },
    orderBy: { createdAt: 'asc' },
  });

  if (declared.length === 0) {
    return [warn('Aucun node déclaré', 'aucun serveur ne peut être créé')];
  }

  // En parallèle : un node injoignable consomme son délai complet, et les
  // enchaîner ferait durer le diagnostic autant qu'il y a de machines mortes.
  return Promise.all(
    declared.map(async (node) => {
      const connection = await nodes.getConnection(node.uuid).catch(() => null);

      if (!connection) {
        return fail(
          node.name,
          'secrets illisibles — APP_SECRET a changé ? `hopper node:token` les régénère',
        );
      }

      const probe = await client.fetchSystemInformation(connection);

      return probe.reachable
        ? ok(node.name, `${node.fqdn} — hopperd ${probe.system.version}, ${probe.latencyMs} ms`)
        : fail(node.name, `${node.fqdn} — ${probe.reason}`);
    }),
  );
}

async function dockerChecks(): Promise<Check[]> {
  const socket = '/var/run/docker.sock';

  const exists = await stat(socket)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    // Le panel n'a aucune raison de parler à Docker : cette section ne concerne
    // que les machines qui hébergent aussi un daemon.
    return [ok('Docker', 'aucun socket ici — cette machine n’héberge pas de node')];
  }

  const checks: Check[] = [];
  const version = await dockerVersion(socket);

  checks.push(
    version === null
      ? fail('Docker', 'socket présent mais interrogation impossible — droits insuffisants ?')
      : ok('Docker', `moteur ${version}`),
  );

  const volumes = '/var/lib/hopper/volumes';
  const info = await stat(volumes).catch(() => null);

  checks.push(
    info === null
      ? warn('Volumes', `${volumes} absent — il sera créé au premier serveur`)
      : ok('Volumes', volumes),
  );

  return checks;
}

/** Interroge `/version` du moteur Docker sur son socket Unix. */
function dockerVersion(socketPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const call = request({ socketPath, path: '/version', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { Version?: string };
          resolve(parsed.Version ?? null);
        } catch {
          resolve(null);
        }
      });
    });

    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(null));
    call.end();
  });
}

// ---------------------------------------------------------------------------

async function readTextFile(path: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8').catch(() => null);
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}

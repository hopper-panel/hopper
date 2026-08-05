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
 * Diagnosing an installation.
 *
 * The command answers one precise question: "why is this not working?". It
 * therefore checks the points that actually break — default secret, unmigrated
 * database, unreachable node, missing Docker socket — and not what would look
 * good in a report.
 *
 * Three levels: a failure stops the panel from working, a warning flags a
 * configuration that will work but will bite later (a weak secret, a panel
 * exposed in the clear). Only failures change the exit code, so that a
 * `hopper doctor` at the end of an installation can be chained with `&&`.
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

  sections.push({ title: 'System', checks: await systemChecks() });
  sections.push({ title: 'Configuration', checks: await configurationChecks(config) });
  sections.push({ title: 'Database', checks: await databaseChecks(prisma) });
  sections.push({ title: 'Redis', checks: await redisChecks(config) });
  sections.push({ title: 'Nodes', checks: await nodeChecks(context) });
  sections.push({ title: 'Docker host', checks: await dockerChecks() });

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

  heading('Result');

  if (failures > 0) {
    report('fail', `${failures} blocking problem(s), ${warnings} warning(s)`);
    return 1;
  }

  report(
    warnings > 0 ? 'warn' : 'ok',
    warnings > 0 ? `Nothing blocking, ${warnings} warning(s)` : 'Installation healthy',
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
      : fail('Node', `v${process.versions.node} — version 22 at least is required`),
  );

  // Without cgroup v2, the memory limits set on the containers are
  // approximate and one server can take the whole machine down.
  const controllers = await readTextFile('/sys/fs/cgroup/cgroup.controllers');

  if (controllers === null) {
    checks.push(
      process.platform === 'linux'
        ? warn('cgroup v2', 'not mounted — the memory limits will be ignored')
        : warn('cgroup v2', `absent on ${process.platform}, normal outside Linux`),
    );
  } else {
    checks.push(
      controllers.includes('memory')
        ? ok('cgroup v2', 'memory controller available')
        : fail('cgroup v2', 'memory controller missing from the delegated controllers'),
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
      ? ok('Environment', 'production')
      : warn('Environment', `${environment} — the session cookies are not marked "secure"`),
  );

  checks.push(
    secret.includes('replace-me')
      ? fail('Application secret', 'the example value is still in place')
      : secret.length < 43
        ? warn('Application secret', `${secret.length} characters — 48 recommended`)
        : ok('Application secret', `${secret.length} characters`),
  );

  const url = safeUrl(appUrl);
  const localhost = url !== null && ['localhost', '127.0.0.1'].includes(url.hostname);

  checks.push(
    localhost && environment === 'production'
      ? fail('Public URL', `${appUrl} — the WebSocket consoles will be refused`)
      : url?.protocol === 'http:' && !localhost
        ? warn('Public URL', `${appUrl} — without TLS, sessions travel in the clear`)
        : ok('Public URL', appUrl),
  );

  checks.push(ok('Listening', `${host}:${port}`));
  checks.push(await environmentFileCheck());

  return checks;
}

/**
 * Permissions of the `.env` file.
 *
 * It carries `APP_SECRET` and the database password: world-readable, it gives
 * any account on the machine what it needs to decrypt the node tokens and
 * connect to the database. This happens after a manual installation, or when
 * the file was copied over from another machine.
 */
async function environmentFileCheck(): Promise<Check> {
  const path = join(process.cwd(), '.env');

  // POSIX permissions make no sense on Windows, where the value `stat` returns
  // is always 0666: the check would cry wolf there.
  if (process.platform !== 'linux') {
    return ok('.env file', `permissions not checked on ${process.platform}`);
  }

  const info = await stat(path).catch(() => null);

  if (info === null) {
    return warn('.env file', `${path} not found — the configuration comes from the environment`);
  }

  const mode = info.mode & 0o777;

  return (mode & 0o077) === 0
    ? ok('.env file', `mode ${mode.toString(8).padStart(3, '0')}`)
    : fail(
        '.env file',
        `mode ${mode.toString(8).padStart(3, '0')} — readable beyond its owner: chmod 600 ${path}`,
      );
}

async function databaseChecks(prisma: PrismaService): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push(ok('Connection'));
  } catch (error: unknown) {
    checks.push(fail('Connection', messageOf(error)));
    // Everything else depends on the connection: insisting would produce five
    // failures describing the same outage.
    return checks;
  }

  const pending = await pendingMigrations(prisma);

  if (pending === null) {
    checks.push(warn('Migrations', 'prisma/migrations directory not found'));
  } else {
    checks.push(
      pending.length === 0
        ? ok('Migrations', 'schema up to date')
        : fail('Migrations', `${pending.length} pending: ${pending.join(', ')}`),
    );
  }

  const [admins, servers, nodes] = await Promise.all([
    prisma.user.count({ where: { role: 'ADMIN' } }),
    prisma.server.count(),
    prisma.node.count(),
  ]);

  checks.push(
    admins > 0
      ? ok('Administrators', String(admins))
      : fail('Administrators', 'no administrator account — nobody can sign in'),
  );

  checks.push(ok('Inventory', `${nodes} node(s), ${servers} server(s)`));

  return checks;
}

/**
 * Migrations present on disk but absent from the tracking table.
 *
 * Comparing names rather than calling `prisma migrate status`: Prisma's CLI is
 * not installed on a production machine, where only the compiled code is
 * deployed.
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
    return [warn('Redis', 'absent — the rate limit restarts from zero on every panel restart')];
  }

  // `lazyConnect` and a short timeout: without them, ioredis retries forever
  // and the diagnostic never returns on a Redis that is switched off.
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
    return [warn('No node declared', 'no server can be created')];
  }

  // In parallel: an unreachable node burns its whole timeout, and chaining
  // them would make the diagnostic last as long as there are dead machines.
  return Promise.all(
    declared.map(async (node) => {
      const connection = await nodes.getConnection(node.uuid).catch(() => null);

      if (!connection) {
        return fail(
          node.name,
          'unreadable secrets — did APP_SECRET change? `hopper node:token` regenerates them',
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
    // The panel has no reason to talk to Docker: this section only concerns
    // machines that also host a daemon.
    return [ok('Docker', 'no socket here — this machine does not host a node')];
  }

  const checks: Check[] = [];

  checks.push(describeDockerProbe(await probeDocker(socket)));

  const volumes = '/var/lib/hopper/volumes';
  const info = await stat(volumes).catch(() => null);

  checks.push(
    info === null
      ? warn('Volumes', `${volumes} absent — it will be created with the first server`)
      : ok('Volumes', volumes),
  );

  return checks;
}

/** Outcome of asking the Docker engine for its version. */
export type DockerProbe =
  | { status: 'answered'; version: string }
  /** The socket is there, but this process is not allowed to open it. */
  | { status: 'forbidden' }
  /** The socket is there and nothing answers on it. */
  | { status: 'silent'; reason: string }
  /** It answered, but not with something we understand. */
  | { status: 'unreadable' };

/**
 * Turns a probe into a verdict.
 *
 * The distinction that matters is between *not allowed to look* and *nothing
 * there*. The panel runs as `hopper` and the Docker socket belongs to root: on
 * a single-machine install — by far the most common — the panel cannot open it,
 * and that is the correct configuration. Membership of the `docker` group is
 * equivalent to root on the host, and the panel is the process exposed to the
 * internet; it has no business holding that. `hopperd` runs as root and is the
 * one that talks to Docker.
 *
 * So a refusal is reported as healthy, not as a failure and not as a warning: a
 * warning every healthy installation carries forever is a warning people learn
 * to skip. A socket that answers nothing, in contrast, means the engine is down
 * — fatal on a machine that hosts servers, and worth the exit code.
 */
export function describeDockerProbe(probe: DockerProbe): Check {
  switch (probe.status) {
    case 'answered':
      return ok('Docker', `engine ${probe.version}`);
    case 'forbidden':
      return ok('Docker', 'socket not readable by the panel — normal, hopperd queries it as root');
    case 'silent':
      return fail(
        'Docker',
        `socket present but nothing answers (${probe.reason}) — is it running?`,
      );
    case 'unreadable':
      return warn('Docker', 'the socket answered something unexpected');
  }
}

/** Asks the Docker engine for its version over its Unix socket. */
function probeDocker(socketPath: string): Promise<DockerProbe> {
  return new Promise((resolve) => {
    const call = request({ socketPath, path: '/version', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { Version?: string };
          resolve(
            parsed.Version === undefined
              ? { status: 'unreadable' }
              : { status: 'answered', version: parsed.Version },
          );
        } catch {
          resolve({ status: 'unreadable' });
        }
      });
    });

    call.on('timeout', () => call.destroy());

    call.on('error', (error: NodeJS.ErrnoException) => {
      // EACCES is the panel being told off by the kernel, EPERM its
      // capability-based sibling. Neither says anything about Docker's health.
      resolve(
        error.code === 'EACCES' || error.code === 'EPERM'
          ? { status: 'forbidden' }
          : { status: 'silent', reason: error.code ?? error.message },
      );
    });

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

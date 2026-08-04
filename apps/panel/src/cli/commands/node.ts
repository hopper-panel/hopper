import { chmod, writeFile } from 'node:fs/promises';
import type { INestApplicationContext } from '@nestjs/common';
import { createNodeSchema } from '../../modules/nodes/nodes.dto.js';
import { NodesService } from '../../modules/nodes/nodes.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { textOf, type Flags } from '../flags.js';
import { bold, fatal, line } from '../output.js';

const CLI_CONTEXT = { ip: 'cli', userAgent: 'hopper-cli' } as const;

/**
 * Declares a node and writes its configuration.
 *
 * Exists for the installer: on a single machine — by far the most common case
 * in self-hosting — forcing the administrator to open the interface to create
 * the local node before anything works at all would be a pointless detour.
 */
export async function nodeCreate(context: INestApplicationContext, flags: Flags): Promise<void> {
  const nodes = context.get(NodesService);
  const output = textOf(flags, 'output');

  const parsed = createNodeSchema.safeParse({
    name: textOf(flags, 'name') ?? 'local',
    description: textOf(flags, 'description') ?? '',
    fqdn: textOf(flags, 'fqdn'),
    scheme: textOf(flags, 'scheme') ?? 'https',
    port: numberOf(flags, 'port') ?? 8443,
    sftpPort: numberOf(flags, 'sftp-port') ?? 2022,
    memoryBytes: numberOf(flags, 'memory') ?? 0,
    diskBytes: numberOf(flags, 'disk') ?? 0,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'valeur'} : ${issue.message}`)
      .join('\n  ');

    fatal(`Options invalides.\n  ${details}`);
  }

  const { node, configuration } = await nodes.create(parsed.data, null, CLI_CONTEXT);

  if (output === undefined) {
    process.stdout.write(configuration);
    return;
  }

  await writeFile(output, configuration, { mode: 0o600 });
  await chmod(output, 0o600);

  line(`\n${bold('Node declared')} — ${node.name} (${node.uuid})`);
  line(`  configuration written to ${output}`);
}

function numberOf(flags: Flags, key: string): number | undefined {
  const value = textOf(flags, key);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    fatal(`--${key} has to be a number.`);
  }

  return parsed;
}

/**
 * Renews a node's token and produces its `daemon.yml`.
 *
 * This is the panel's rescue command: it restores a node whose configuration
 * was lost, or whose secrets are no longer decryptable — which happens as soon
 * as `APP_SECRET` changes. Without it, the node and its servers have to be
 * deleted and recreated.
 *
 * The previous token stops being valid at once: the daemon stays unreachable
 * until the file is in place and the service restarted. Servers already running
 * keep running.
 */
export async function nodeToken(context: INestApplicationContext, flags: Flags): Promise<void> {
  const prisma = context.get(PrismaService);
  const nodes = context.get(NodesService);

  const identifier = textOf(flags, 'node');
  const output = textOf(flags, 'output');

  const matches = await prisma.node.findMany({
    where: identifier === undefined ? {} : { OR: [{ uuid: identifier }, { name: identifier }] },
    select: { uuid: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  if (matches.length === 0) {
    fatal(
      identifier === undefined
        ? 'No node declared. Create one from the administration first.'
        : `No node matches "${identifier}".`,
    );
  }

  // Refuse rather than pick: rotating the wrong node's token cuts a machine
  // off in production, and the mistake only shows when the daemon restarts.
  if (matches.length > 1) {
    fatal(
      `Several nodes match, narrow it down with --node:\n  ${matches
        .map((node) => `${node.name} (${node.uuid})`)
        .join('\n  ')}`,
    );
  }

  const node = matches[0]!;
  const { configuration } = await nodes.rotateToken(node.uuid, null, CLI_CONTEXT);

  if (output === undefined) {
    // On standard output, undecorated: the installer redirects the command
    // into a file, and a decorative header would make it invalid.
    process.stdout.write(configuration);
    return;
  }

  await writeFile(output, configuration, { mode: 0o600 });
  // The mode is only applied on creation: on an existing file `writeFile`
  // keeps its permissions, and a world-readable `daemon.yml` would make the
  // daemon refuse to start.
  await chmod(output, 0o600);

  line(`\n${bold('Token renewed')} — ${node.name}`);
  line(`  configuration written to ${output}`);
  line('  restart the daemon: systemctl restart hopperd');
}

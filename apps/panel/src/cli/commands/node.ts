import { chmod, writeFile } from 'node:fs/promises';
import type { INestApplicationContext } from '@nestjs/common';
import { createNodeSchema } from '../../modules/nodes/nodes.dto.js';
import { NodesService } from '../../modules/nodes/nodes.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { textOf, type Flags } from '../flags.js';
import { bold, fatal, line } from '../output.js';

const CLI_CONTEXT = { ip: 'cli', userAgent: 'hopper-cli' } as const;

/**
 * Déclare un node et écrit sa configuration.
 *
 * Existe pour l'installeur : sur une machine unique — le cas de loin le plus
 * courant en auto-hébergement — obliger l'administrateur à ouvrir l'interface
 * pour créer le node local avant que quoi que ce soit ne fonctionne serait un
 * détour inutile.
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

  line(`\n${bold('Node déclaré')} — ${node.name} (${node.uuid})`);
  line(`  configuration écrite dans ${output}`);
}

function numberOf(flags: Flags, key: string): number | undefined {
  const value = textOf(flags, key);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    fatal(`--${key} doit être un nombre.`);
  }

  return parsed;
}

/**
 * Renouvelle le jeton d'un node et produit son `daemon.yml`.
 *
 * C'est la commande de secours du panel : elle rétablit un node dont la
 * configuration a été perdue, ou dont les secrets ne sont plus déchiffrables —
 * ce qui arrive dès que `APP_SECRET` change. Sans elle, il faut supprimer le
 * node et ses serveurs pour le recréer.
 *
 * Le jeton précédent cesse aussitôt d'être valable : le daemon reste injoignable
 * tant que le fichier n'est pas en place et le service redémarré. Les serveurs
 * déjà lancés, eux, continuent de tourner.
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
        ? 'Aucun node déclaré. Créez-le d’abord dans l’administration.'
        : `Aucun node ne correspond à « ${identifier} ».`,
    );
  }

  // Refuser plutôt que de choisir : faire tourner le jeton du mauvais node
  // coupe une machine en production, et l'erreur ne se voit qu'au redémarrage
  // du daemon.
  if (matches.length > 1) {
    fatal(
      `Plusieurs nodes correspondent, précisez --node :\n  ${matches
        .map((node) => `${node.name} (${node.uuid})`)
        .join('\n  ')}`,
    );
  }

  const node = matches[0]!;
  const { configuration } = await nodes.rotateToken(node.uuid, null, CLI_CONTEXT);

  if (output === undefined) {
    // Sur la sortie standard, sans décor : l'installeur redirige la commande
    // dans un fichier, et un en-tête décoratif le rendrait invalide.
    process.stdout.write(configuration);
    return;
  }

  await writeFile(output, configuration, { mode: 0o600 });
  // Le mode n'est appliqué qu'à la création : sur un fichier déjà présent,
  // `writeFile` conserve ses droits, et un `daemon.yml` lisible par tous ferait
  // refuser le démarrage du daemon.
  await chmod(output, 0o600);

  line(`\n${bold('Jeton renouvelé')} — ${node.name}`);
  line(`  configuration écrite dans ${output}`);
  line('  redémarrez le daemon : systemctl restart hopperd');
}

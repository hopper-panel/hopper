import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { PANEL_VERSION } from '../version.js';
import { runDoctor } from './commands/doctor.js';
import { nodeCreate, nodeToken } from './commands/node.js';
import { createUser, resetPassword } from './commands/user.js';
import { parseFlags, type Flags } from './flags.js';
import { fatal, line } from './output.js';

/**
 * Ligne de commande d'administration — `hopper`.
 *
 * Elle vit **dans le paquet du panel**, et non dans un paquet à part comme le
 * prévoyait le plan. La raison est pratique : chaque commande a besoin du
 * client Prisma généré, du hachage argon2id et de la clé de chiffrement du
 * panel. Un paquet séparé en referait sa propre copie, et la moindre divergence
 * de réglage se solderait par un compte créé en ligne de commande que le panel
 * refuserait — un défaut long à diagnostiquer pour un gain d'architecture nul.
 *
 * Les commandes s'exécutent dans un contexte Nest sans serveur HTTP : elles
 * réutilisent donc les services du panel, avec leurs validations et leur
 * journal d'audit, plutôt que d'écrire en base derrière leur dos.
 */

interface Command {
  name: string;
  summary: string;
  usage?: string;
  run: (context: INestApplicationContext, flags: Flags) => Promise<number | void>;
}

const COMMANDS: Command[] = [
  {
    name: 'doctor',
    summary: 'Diagnostique l’installation : configuration, base, nodes, Docker.',
    run: (context) => runDoctor(context),
  },
  {
    name: 'user:create',
    summary: 'Crée un compte.',
    usage: 'hopper user:create --email a@b.c --username julien [--admin] [--password …]',
    run: (context, flags) => createUser(context, flags),
  },
  {
    name: 'user:password',
    summary: 'Réinitialise le mot de passe d’un compte.',
    usage: 'hopper user:password --username julien [--password …]',
    run: (context, flags) => resetPassword(context, flags),
  },
  {
    name: 'node:create',
    summary: 'Déclare un node et rend son daemon.yml.',
    usage: 'hopper node:create --name local --fqdn panel.example.com [--scheme http]',
    run: (context, flags) => nodeCreate(context, flags),
  },
  {
    name: 'node:token',
    summary: 'Renouvelle le jeton d’un node et rend son daemon.yml.',
    usage: 'hopper node:token --node <uuid ou nom> [--output /etc/hopper/daemon.yml]',
    run: (context, flags) => nodeToken(context, flags),
  },
];

function usage(): void {
  line(`Hopper ${PANEL_VERSION}\n`);
  line('Usage : hopper <commande> [options]\n');

  for (const command of COMMANDS) {
    line(`  ${command.name.padEnd(16)} ${command.summary}`);

    if (command.usage) {
      line(`  ${' '.repeat(16)} ${command.usage}`);
    }
  }

  line('\n  version          Affiche la version du panel.');
  line('  help             Affiche ce message.\n');
}

async function main(): Promise<void> {
  const [name = 'help', ...rest] = process.argv.slice(2);

  if (name === 'help' || name === '--help' || name === '-h') {
    usage();
    return;
  }

  if (name === 'version' || name === '--version') {
    line(PANEL_VERSION);
    return;
  }

  const command = COMMANDS.find((entry) => entry.name === name);

  if (!command) {
    usage();
    fatal(`Commande inconnue : ${name}`);
  }

  // Le contexte charge la configuration, donc `.env` : lancer la commande
  // depuis un autre répertoire que celui du panel échouerait ici, avec un
  // message plus clair qu'une erreur de connexion à la base.
  const context = await NestFactory.createApplicationContext(AppModule, {
    // Les journaux de démarrage de Nest n'ont rien à faire dans la sortie d'une
    // commande dont on capture parfois le résultat dans un fichier.
    logger: ['error'],
  });

  try {
    const code = await command.run(context, parseFlags(rest));
    await context.close();
    process.exit(typeof code === 'number' ? code : 0);
  } catch (error: unknown) {
    await context.close();
    fatal(error instanceof Error ? error.message : String(error));
  }
}

void main();

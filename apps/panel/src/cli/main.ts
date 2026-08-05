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
 * The administration command line — `hopper`.
 *
 * It lives **inside the panel's package**, not in a package of its own as the
 * plan called for. The reason is practical: every command needs the generated
 * Prisma client, argon2id hashing and the panel's encryption key. A separate
 * package would make its own copy of each, and the slightest divergence in
 * settings would end in an account created from the command line that the panel
 * refuses — a defect slow to diagnose for no architectural gain.
 *
 * The commands run in a Nest context with no HTTP server: they therefore reuse
 * the panel's services, with their validations and their audit log, rather than
 * write to the database behind their back.
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
    summary: 'Diagnoses the installation: configuration, database, nodes, Docker.',
    run: (context) => runDoctor(context),
  },
  {
    name: 'user:create',
    summary: 'Creates an account.',
    usage: 'hopper user:create --email a@b.c --username julien [--admin] [--password …]',
    run: (context, flags) => createUser(context, flags),
  },
  {
    name: 'user:password',
    summary: 'Resets an account password.',
    usage: 'hopper user:password --username julien [--password …]',
    run: (context, flags) => resetPassword(context, flags),
  },
  {
    name: 'node:create',
    summary: 'Declares a node and returns its daemon.yml.',
    usage: 'hopper node:create --name local --fqdn panel.example.com [--scheme http]',
    run: (context, flags) => nodeCreate(context, flags),
  },
  {
    name: 'node:token',
    summary: 'Renews a node token and returns its daemon.yml.',
    usage: 'hopper node:token --node <uuid or name> [--output /etc/hopper/daemon.yml]',
    run: (context, flags) => nodeToken(context, flags),
  },
];

function usage(): void {
  line(`Hopper ${PANEL_VERSION}\n`);
  line('Usage: hopper <command> [options]\n');

  for (const command of COMMANDS) {
    line(`  ${command.name.padEnd(16)} ${command.summary}`);

    if (command.usage) {
      line(`  ${' '.repeat(16)} ${command.usage}`);
    }
  }

  line('\n  version          Prints the panel version.');
  line('  help             Prints this message.\n');
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
    fatal(`Unknown command: ${name}`);
  }

  // The context loads the configuration, so `.env`: running the command from
  // a directory other than the panel's would fail here, with a message clearer
  // than a database connection error.
  const context = await NestFactory.createApplicationContext(AppModule, {
    // Nest's startup logs have no business in the output of a command whose
    // result is sometimes captured into a file.
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

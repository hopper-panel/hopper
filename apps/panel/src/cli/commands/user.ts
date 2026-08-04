import { randomBytes } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasswordService } from '../../modules/auth/password.service.js';
import { UsersService } from '../../modules/users/users.service.js';
import { createUserSchema } from '../../modules/users/users.dto.js';
import { textOf, type Flags } from '../flags.js';
import { bold, fatal, line } from '../output.js';

/**
 * Audit context for the commands.
 *
 * The address `cli` is not an IP: that is precisely the point. An action
 * launched from the machine has no network origin, and inventing `127.0.0.1`
 * would make it indistinguishable from a request coming through the local
 * proxy.
 */
const CLI_CONTEXT = { ip: 'cli', userAgent: 'hopper-cli' } as const;

/** Readable password, shown once only. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export async function createUser(context: INestApplicationContext, flags: Flags): Promise<void> {
  const users = context.get(UsersService);

  const password = textOf(flags, 'password') ?? generatePassword();
  const generated = textOf(flags, 'password') === undefined;

  // Validated by the same schema as the API: a password that is too short or
  // an invalid username has to be refused here too, otherwise the command would
  // serve as a back door around the panel's rules.
  const parsed = createUserSchema.safeParse({
    email: textOf(flags, 'email'),
    username: textOf(flags, 'username'),
    password,
    role: flags.get('admin') === true ? 'ADMIN' : 'USER',
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'valeur'} : ${issue.message}`)
      .join('\n  ');

    fatal(`Options invalides.\n  ${details}`);
  }

  const user = await users.create(parsed.data, null, CLI_CONTEXT);

  line(`\n${bold('Account created')}`);
  line(`  identifiant : ${user.username}`);
  line(`  e-mail      : ${user.email}`);
  line(`  role        : ${user.role === 'ADMIN' ? 'administrator' : 'user'}`);

  if (generated) {
    line(`  mot de passe : ${password}`);
    line('\n  This password is not kept in the clear: write it down now.');
  }
}

export async function resetPassword(context: INestApplicationContext, flags: Flags): Promise<void> {
  const prisma = context.get(PrismaService);
  const passwords = context.get(PasswordService);

  const identifier = textOf(flags, 'username') ?? textOf(flags, 'email');

  if (identifier === undefined) {
    fatal('Give --username or --email.');
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier.toLowerCase() }] },
  });

  if (!user) {
    fatal(`No account matches "${identifier}".`);
  }

  const password = textOf(flags, 'password') ?? generatePassword();
  const generated = textOf(flags, 'password') === undefined;

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await passwords.hash(password) },
  });

  // Open sessions would survive the change: whoever stole the password would
  // keep their access, when this command is exactly what one runs in that
  // case.
  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });

  line(`\n${bold('Password changed')} — ${user.username}`);
  line(`  sessions closed : ${count}`);

  if (generated) {
    line(`  nouveau mot de passe : ${password}`);
  }
}

import { randomBytes } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasswordService } from '../../modules/auth/password.service.js';
import { UsersService } from '../../modules/users/users.service.js';
import { createUserSchema } from '../../modules/users/users.dto.js';
import { textOf, type Flags } from '../flags.js';
import { bold, fatal, line } from '../output.js';

/**
 * Contexte d'audit des commandes.
 *
 * L'adresse `cli` n'est pas une IP : c'est justement l'intérêt. Une action
 * lancée depuis la machine n'a pas d'origine réseau, et inventer `127.0.0.1`
 * la rendrait indiscernable d'une requête passée par le proxy local.
 */
const CLI_CONTEXT = { ip: 'cli', userAgent: 'hopper-cli' } as const;

/** Mot de passe lisible, montré une seule fois. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export async function createUser(context: INestApplicationContext, flags: Flags): Promise<void> {
  const users = context.get(UsersService);

  const password = textOf(flags, 'password') ?? generatePassword();
  const generated = textOf(flags, 'password') === undefined;

  // Validé par le même schéma que l'API : un mot de passe trop court ou un
  // nom d'utilisateur invalide doit être refusé ici aussi, sinon la commande
  // servirait de porte dérobée aux règles du panel.
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

  line(`\n${bold('Compte créé')}`);
  line(`  identifiant : ${user.username}`);
  line(`  e-mail      : ${user.email}`);
  line(`  rôle        : ${user.role === 'ADMIN' ? 'administrateur' : 'utilisateur'}`);

  if (generated) {
    line(`  mot de passe : ${password}`);
    line('\n  Ce mot de passe n’est pas conservé en clair : notez-le maintenant.');
  }
}

export async function resetPassword(context: INestApplicationContext, flags: Flags): Promise<void> {
  const prisma = context.get(PrismaService);
  const passwords = context.get(PasswordService);

  const identifier = textOf(flags, 'username') ?? textOf(flags, 'email');

  if (identifier === undefined) {
    fatal('Précisez --username ou --email.');
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier.toLowerCase() }] },
  });

  if (!user) {
    fatal(`Aucun compte ne correspond à « ${identifier} ».`);
  }

  const password = textOf(flags, 'password') ?? generatePassword();
  const generated = textOf(flags, 'password') === undefined;

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await passwords.hash(password) },
  });

  // Les sessions ouvertes survivraient au changement : quelqu'un qui a volé le
  // mot de passe garderait son accès, alors que la commande est justement ce
  // qu'on lance dans ce cas.
  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });

  line(`\n${bold('Mot de passe changé')} — ${user.username}`);
  line(`  sessions fermées : ${count}`);

  if (generated) {
    line(`  nouveau mot de passe : ${password}`);
  }
}

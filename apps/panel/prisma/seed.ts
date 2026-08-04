import { randomBytes } from 'node:crypto';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { TEMPLATE_CATALOG } from '@hopper/templates';
import { ENCRYPTION_INFO, deriveKey, encryptWithKey } from '../src/common/crypto/cipher.js';

/**
 * Seeding the database.
 *
 * Idempotent: rerunning the seed on an existing instance must break nothing and
 * reset no password. That is what makes it safe to call without thinking after
 * a migration.
 *
 * The administrator account can be supplied through environment variables,
 * which is how the installer creates the account without interaction:
 *   HOPPER_ADMIN_EMAIL, HOPPER_ADMIN_USERNAME, HOPPER_ADMIN_PASSWORD
 */

const prisma = new PrismaClient();

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Readable random password, shown once only. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function seedAdmin(): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

  if (existing) {
    console.log(`✓ Administrator account already present (${existing.email}) — unchanged.`);
    return;
  }

  const email = (process.env.HOPPER_ADMIN_EMAIL ?? 'admin@hopper.local').toLowerCase();
  const username = process.env.HOPPER_ADMIN_USERNAME ?? 'admin';
  const password = process.env.HOPPER_ADMIN_PASSWORD ?? generatePassword();
  const generated = !process.env.HOPPER_ADMIN_PASSWORD;

  await prisma.user.create({
    data: {
      email,
      username,
      role: 'ADMIN',
      passwordHash: await hash(password, ARGON2_OPTIONS),
    },
  });

  console.log('\n✓ Administrator account created');
  console.log(`   email    : ${email}`);
  console.log(`   username : ${username}`);

  if (generated) {
    console.log(`   password : ${password}`);
    console.log('\n   ⚠ This password will not be shown again. Write it down now.\n');
  }

  // Machine-readable marker, read by install.sh. Not prose: do not translate it
  // and do not reword it. The installer used to grep the sentence above, and
  // translating that sentence silently stopped it from showing the generated
  // password at the end of an installation.
  console.log('HOPPER_SEED_ADMIN_CREATED=1');
}

/**
 * Installs the catalogue shipped with Hopper.
 *
 * Replicates `TemplateSyncService`'s logic: the seed runs outside NestJS's
 * injection container and therefore cannot reuse the service. The two have to
 * stay in agreement — which is why both take their definitions from
 * `@hopper/templates`, never from a local copy.
 */
async function seedTemplates(): Promise<void> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const definition of TEMPLATE_CATALOG) {
    const group = await prisma.templateGroup.upsert({
      where: { name: definition.group },
      update: {},
      create: { name: definition.group },
    });

    const existing = await prisma.template.findUnique({
      where: { key: definition.key },
      select: { id: true, modifiedByAdmin: true },
    });

    const data = {
      groupId: group.id,
      name: definition.name,
      description: definition.description,
      author: definition.author,
      dockerImages: definition.dockerImages,
      startup: definition.startup,
      stopCommand: definition.stopCommand,
      startupDetection: definition.startupDetection ?? null,
      configFiles: definition.configFiles,
      fileDenylist: definition.fileDenylist,
      installContainer: definition.installContainer,
      installEntrypoint: definition.installEntrypoint,
      installScript: definition.installScript,
    };

    const variables = definition.variables.map((variable) => ({
      name: variable.name,
      description: variable.description,
      envVariable: variable.envVariable,
      defaultValue: variable.defaultValue,
      userViewable: variable.userViewable,
      userEditable: variable.userEditable,
      rules: variable.rules,
    }));

    if (!existing) {
      await prisma.template.create({
        data: { ...data, key: definition.key, variables: { create: variables } },
      });
      created += 1;
      continue;
    }

    // A template edited by an administrator is never overwritten: their
    // customisation survives Hopper's updates.
    if (existing.modifiedByAdmin) {
      skipped += 1;
      continue;
    }

    await prisma.$transaction([
      prisma.template.update({ where: { id: existing.id }, data }),
      prisma.templateVariable.deleteMany({ where: { templateId: existing.id } }),
      prisma.templateVariable.createMany({
        data: variables.map((variable) => ({ ...variable, templateId: existing.id })),
      }),
    ]);
    updated += 1;
  }

  console.log(
    `✓ Catalogue: ${created} template(s) created, ${updated} updated, ${skipped} kept.`,
  );
}

/**
 * Development node, aligned with `apps/daemon/daemon.dev.yml`.
 *
 * Without it, the panel signs console tokens with a random secret drawn when
 * the node is created, while the development daemon expects a fixed one: the
 * console fails in a loop on "Invalid or expired token", with nothing to say
 * where the disagreement comes from.
 *
 * These values are public and harmless — they only serve a daemon listening on
 * the loopback. In production it is the other way round: the panel generates
 * the secrets and the installer writes the matching `daemon.yml`.
 */
async function seedDevNode(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  const DEV_NODE_UUID = '11111111-1111-4111-8111-111111111111';
  const DEV_TOKEN_ID = 'devdevdevdevdev0';
  const DEV_TOKEN_SECRET = 'devsecret'.repeat(7) + '0';
  const DEV_JWT_SECRET = 'dev-jwt-secret-not-for-production-0000000';

  const appSecret = process.env.APP_SECRET;

  if (!appSecret) {
    console.log('• APP_SECRET missing: development node skipped.');
    return;
  }

  const key = deriveKey(appSecret, ENCRYPTION_INFO);

  const node = await prisma.node.upsert({
    where: { uuid: DEV_NODE_UUID },
    update: {
      // Reapplied on every seed: if APP_SECRET changed, the secrets encrypted
      // in the database have become unreadable and have to be rewritten.
      daemonTokenId: DEV_TOKEN_ID,
      daemonTokenEncrypted: encryptWithKey(key, DEV_TOKEN_SECRET),
      jwtSecret: encryptWithKey(key, DEV_JWT_SECRET),
    },
    create: {
      uuid: DEV_NODE_UUID,
      name: 'node-dev',
      description: 'Local development node, defined by apps/daemon/daemon.dev.yml.',
      fqdn: '127.0.0.1',
      scheme: 'http',
      port: 8443,
      sftpPort: 2022,
      memoryBytes: BigInt(32 * 1024 ** 3),
      diskBytes: BigInt(200 * 1024 ** 3),
      daemonTokenId: DEV_TOKEN_ID,
      daemonTokenEncrypted: encryptWithKey(key, DEV_TOKEN_SECRET),
      jwtSecret: encryptWithKey(key, DEV_JWT_SECRET),
    },
  });

  const ports = Array.from({ length: 10 }, (_, index) => 25565 + index);

  await prisma.allocation.createMany({
    data: ports.map((port) => ({ nodeId: node.id, ip: '0.0.0.0', port })),
    skipDuplicates: true,
  });

  console.log(`✓ Development node "${node.name}" ready, ports 25565-25574.`);
}

async function main(): Promise<void> {
  await seedAdmin();
  await seedTemplates();
  await seedDevNode();
}

main()
  .catch((error: unknown) => {
    console.error('✖ Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

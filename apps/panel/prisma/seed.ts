import { randomBytes } from 'node:crypto';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { TEMPLATE_CATALOG } from '@hopper/templates';
import { ENCRYPTION_INFO, deriveKey, encryptWithKey } from '../src/common/crypto/cipher.js';

/**
 * Amorçage de la base.
 *
 * Idempotent : relancer le seed sur une instance existante ne doit rien casser
 * ni réinitialiser un mot de passe. C'est ce qui permet de l'appeler sans
 * réfléchir après une migration.
 *
 * Le compte administrateur peut être fourni par variables d'environnement, ce
 * dont l'installeur se sert pour créer le compte sans interaction :
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

/** Mot de passe aléatoire lisible, affiché une seule fois. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function seedAdmin(): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

  if (existing) {
    console.log(`✓ Compte administrateur déjà présent (${existing.email}) — inchangé.`);
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

  console.log('\n✓ Compte administrateur créé');
  console.log(`   e-mail       : ${email}`);
  console.log(`   utilisateur  : ${username}`);

  if (generated) {
    console.log(`   mot de passe : ${password}`);
    console.log('\n   ⚠ Ce mot de passe ne sera plus affiché. Notez-le maintenant.\n');
  }
}

/**
 * Installe le catalogue livré avec Hopper.
 *
 * Réplique la logique de `TemplateSyncService` : le seed tourne hors du
 * conteneur d'injection de NestJS et ne peut donc pas réutiliser le service.
 * Les deux doivent rester d'accord — c'est pourquoi les définitions viennent
 * toutes deux de `@hopper/templates`, jamais d'une copie locale.
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

    // Un template retouché par un administrateur n'est jamais écrasé : sa
    // personnalisation survit aux mises à jour de Hopper.
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
    `✓ Catalogue : ${created} template(s) créé(s), ${updated} mis à jour, ${skipped} conservé(s).`,
  );
}

/**
 * Node de développement, aligné sur `apps/daemon/daemon.dev.yml`.
 *
 * Sans lui, le panel signe les jetons de console avec un secret aléatoire tiré
 * à la création du node, tandis que le daemon de développement en attend un
 * fixe : la console échoue en boucle sur « Jeton invalide ou expiré », sans que
 * rien n'indique d'où vient le désaccord.
 *
 * Ces valeurs sont publiques et sans danger — elles ne servent qu'à un daemon
 * qui écoute sur la boucle locale. En production, c'est l'inverse : le panel
 * génère les secrets et l'installeur écrit le `daemon.yml` correspondant.
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
    console.log('• APP_SECRET absent : node de développement ignoré.');
    return;
  }

  const key = deriveKey(appSecret, ENCRYPTION_INFO);

  const node = await prisma.node.upsert({
    where: { uuid: DEV_NODE_UUID },
    update: {
      // Réappliqué à chaque amorçage : si APP_SECRET a changé, les secrets
      // chiffrés en base sont devenus illisibles et doivent être réécrits.
      daemonTokenId: DEV_TOKEN_ID,
      daemonTokenEncrypted: encryptWithKey(key, DEV_TOKEN_SECRET),
      jwtSecret: encryptWithKey(key, DEV_JWT_SECRET),
    },
    create: {
      uuid: DEV_NODE_UUID,
      name: 'node-dev',
      description: 'Node local de développement, défini par apps/daemon/daemon.dev.yml.',
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

  console.log(`✓ Node de développement « ${node.name} » prêt, ports 25565-25574.`);
}

async function main(): Promise<void> {
  await seedAdmin();
  await seedTemplates();
  await seedDevNode();
}

main()
  .catch((error: unknown) => {
    console.error("✖ Échec de l'amorçage :", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

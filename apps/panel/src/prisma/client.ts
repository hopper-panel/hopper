/**
 * The generated Prisma client, named in one place.
 *
 * Prisma 7 generates its client into the source tree instead of into
 * node_modules, so `@prisma/client` is no longer an import path — it is a
 * relative one, and a relative path that appears in twenty files is twenty
 * files to edit the day the output directory moves. Everything imports the
 * client through here instead; `prisma/schema.prisma` and this file are the
 * only two places that know where it lands.
 *
 * The directory itself is not committed: it is rebuilt by `prisma generate`,
 * which runs on `postinstall` and again in the installer before the panel is
 * built.
 */
export * from '../generated/prisma/client.js';

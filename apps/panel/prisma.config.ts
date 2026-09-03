import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Read here rather than through Prisma's `env()` helper, which throws while the
 * configuration file is being loaded — that is, before the command is known.
 *
 * `prisma generate` needs no database at all, and the installer runs it during
 * the build, several steps before it writes `.env`. An eager `env()` there
 * fails a fresh installation on a variable the command was never going to use.
 * Absent, the key is left out entirely, and the commands that do open a
 * connection say so themselves.
 */
const databaseUrl = process.env.DATABASE_URL;

/**
 * Configuration of the Prisma command line.
 *
 * Prisma 7 no longer reads a `prisma` key from package.json, and no longer
 * loads `.env` on its own — two conveniences that are gone on purpose, since
 * both made the CLI behave differently from the application it configures.
 * Everything the CLI needs is therefore stated here.
 *
 * This file is read by `prisma generate`, `migrate deploy` and `db seed`, all
 * three of which the installer runs from `apps/panel`. It is not read by the
 * running panel: the client receives its connection through an adapter, built
 * in `src/prisma/prisma.service.ts` from the configuration the panel already
 * has.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',

  migrations: {
    path: 'prisma/migrations',

    // What `prisma db seed` runs. The installer calls it to create the first
    // administrator, and reads the account it reports back on stdout.
    seed: 'tsx prisma/seed.ts',
  },

  // Migrate opens its own connection, and it is the only thing here that does.
  ...(databaseUrl === undefined ? {} : { datasource: { url: databaseUrl } }),
});

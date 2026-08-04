import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  // Le daemon est déployé comme un dossier avec ses node_modules : on ne bundle
  // pas les dépendances natives (dockerode, ssh2) qui arrivent aux phases 2 et 4.
  bundle: true,
  skipNodeModulesBundle: true,
  outExtension: () => ({ js: '.js' }),
});

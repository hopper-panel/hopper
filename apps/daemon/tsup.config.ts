import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  dts: false,
  // The daemon ships as a folder with its node_modules: the native
  // dependencies (dockerode, ssh2) are not bundled.
  bundle: true,
  skipNodeModulesBundle: true,
  outExtension: () => ({ js: '.js' }),
});

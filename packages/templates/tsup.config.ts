import { defineConfig } from 'tsup';

// Double build ESM + CJS : le front (Vite) consomme l'ESM, le panel et le daemon
// (NestJS / Node) consomment le CJS.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2023',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});

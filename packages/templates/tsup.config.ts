import { defineConfig } from 'tsup';

// Dual ESM + CJS build: the front (Vite) consumes the ESM, the panel and the
// daemon (NestJS / Node) consume the CJS.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2023',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});

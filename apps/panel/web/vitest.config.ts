import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Node by default, a DOM where a file asks for one.
 *
 * This used to say that none of what broke had needed a DOM. That stopped being
 * true: two tabs of the administration threw on their first render, because
 * they declared a response shape the API does not return and nothing ever
 * rendered them to find out. TypeScript checked the components against those
 * types; the types were the thing that was wrong, so the check passed and the
 * page went down.
 *
 * Component tests are in, but only where they earn it — a file opts into a DOM
 * with `@vitest-environment jsdom`, and standing one up for a pure function
 * stays as pointless as it was.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'node',
  },
});

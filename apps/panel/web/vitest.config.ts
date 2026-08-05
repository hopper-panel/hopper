import { defineConfig } from 'vitest/config';

/**
 * Node, not jsdom.
 *
 * The tests here cover decisions and generated files, not rendering: whether
 * Kill should be offered, whether an error message can be read, whether the
 * icon set still holds what it claims. Standing up a DOM would let component
 * tests in, which is a larger commitment than the gap being closed — and none
 * of what broke this far needed one.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'node',
  },
});

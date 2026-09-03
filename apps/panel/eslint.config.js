const base = require('@hopper/config/eslint');

module.exports = [
  ...base,
  // The Prisma client is generated, carries its own `eslint-disable` and is
  // 2 MB of it: linting it costs seconds and can report nothing worth acting on.
  {
    ignores: ['src/generated/**'],
  },
  {
    files: ['**/*.ts'],
    rules: {
      // NestJS's decorators rely on constructor parameters whose type carries
      // the injection information: removing them would break the container,
      // even when ESLint believes they are unused.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
];

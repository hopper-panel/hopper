const base = require('@hopper/config/eslint');

module.exports = [
  ...base,
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

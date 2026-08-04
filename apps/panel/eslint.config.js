const base = require('@hopper/config/eslint');

module.exports = [
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      // Les décorateurs de NestJS reposent sur des paramètres de constructeur
      // dont le type porte l'information d'injection : les retirer casserait le
      // conteneur, même quand ESLint les croit inutilisés.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
];

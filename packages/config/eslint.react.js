const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');
// 0.5 ships as ESM and moved the plugin behind a named export: the default
// export is no longer the plugin object, so registering it left ESLint unable
// to find `only-export-components` and refusing to run at all. The rule itself
// did not change.
const { reactRefresh } = require('eslint-plugin-react-refresh');
const base = require('./eslint.base.js');

/** ESLint configuration for the React front (apps/panel/web). */
module.exports = [
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh.plugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-globals': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];

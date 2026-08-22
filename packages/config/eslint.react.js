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
      // Named one by one rather than spread from `configs.recommended`.
      //
      // Up to version 5 that config *was* these two rules. Version 7 adds
      // fourteen more — the React Compiler's — and spreading it would have
      // turned them all on as a side effect of a dependency bump, which is not
      // a thing a dependency bump gets to decide.
      //
      // They are worth a deliberate look one day; they are not obviously right
      // here. Run against this front they report eight problems, and at least
      // two are patterns this codebase adopted on purpose and documented at the
      // spot: `Modal`'s latest-ref assignment during render, which exists
      // because the alternative replayed the effect on every parent render and
      // moved the caret out of a textarea, and `ServerFiles` assigning
      // `window.location.href` to start a download, which `immutability` reads
      // as writing to a value from outside the component. Adopting the set
      // means answering each of the eight, not silencing the rule that found
      // it.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-globals': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];

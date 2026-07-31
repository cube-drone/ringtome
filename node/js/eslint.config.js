// The JS lint gate, run by `just ui-check` (and so by CI). Deliberately narrow: esbuild
// cannot tell a typo from a browser global, so an undefined identifier ships silently and
// detonates at render time (field-found 2026-07-30: a free `itemNoun` in doc/tree.js threw on
// the first section a user ever created, and every re-render aborted mid-diff - orphaned
// panels piling up in the DOM). `no-undef` is the load-bearing rule; the recommended set rides
// along for the cheap correctness catches (unused vars, unreachable code, comparison typos).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
    { ignores: ['node_modules/**', 'target/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: globals.browser,
        },
        plugins: { 'react-hooks': reactHooks },
        rules: {
            // `_`-prefixed is the house idiom for deliberately-unused.
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // Preact hooks obey the same laws; the existing eslint-disable comments in the
            // codebase were written against exactly this rule. Warn, not error: the standing
            // findings are ledgered (REFACTOR.md, hooks-lint debt) and gate when paid down -
            // the ERROR-level rules above are the actual CI gate this config exists for.
            'react-hooks/rules-of-hooks': 'warn',
            'react-hooks/exhaustive-deps': 'warn',
        },
    },
];

// Flat ESLint config (ESLint v9+/v10). Sigil is ESM Node; the GUI under
// src/gui/web is vanilla browser JS. We lint for real bugs (recommended) and
// stay deliberately style-agnostic — formatting is not enforced here.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // Generated / vendored / non-source trees never get linted.
    ignores: [
      'dist/**',
      'node_modules/**',
      'brag-output/**',
      'output/**',
      'docs-screenshots/**',
      'web-redirect/**',
      'eval/**',
      'benchmarks/**',
    ],
  },

  js.configs.recommended,

  // Node source (the bulk of src/).
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The codebase leans on best-effort `try { … } catch { /* ignore */ }`
      // throughout (hooks, snapshots, socket teardown); an empty catch is
      // intentional there, so only an empty BLOCK elsewhere is a smell.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Allow deliberately-unused args/vars prefixed with `_` (e.g. Proxy traps,
      // `(_t, prop) => …`), and caught errors that are intentionally swallowed.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Off by design (not bug-catching, and at odds with this codebase's
      // idioms). no-useless-assignment fires on the ubiquitous defensive-init
      // pattern (`let x = null;` then assigned inside a try). preserve-caught-error
      // wants `{ cause }` on every re-thrown error — a worthwhile but separate,
      // focused error-chaining pass, not part of introducing the config.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },

  // CommonJS migrations (knex .cjs files) — module.exports + require + console.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Browser-side GUI: different global environment (window, document, fetch…).
  {
    files: ['src/gui/web/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Tests: vitest functions are imported explicitly, so no extra globals are
  // needed — but allow the common test conveniences if any sneak in.
  {
    files: ['**/*.test.js', 'test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];

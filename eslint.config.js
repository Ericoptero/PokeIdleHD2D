/**
 * Lint: generic correctness only — undefined names, unused imports and variables, loose
 * equality, empty blocks. The project's own contracts (no Math.random, no deep imports,
 * descriptor shape, event agreement) stay in tools/seams/run.js, which derives them from the
 * tree; this file must never restate one of those rules, or the two drift apart.
 *
 *   npx eslint .            # what the `lint` gate stage runs
 */
import js from '@eslint/js';
import globals from 'globals';

const nodeAndBrowser = { ...globals.node, ...globals.browser };

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'assets/**', 'shots/**', 'docs/**'] },
  js.configs.recommended,
  {
    rules: {
      // `== null` is the one loose comparison this codebase uses on purpose (49 sites).
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // `ignoreRestSiblings`: `const { h, ...rest } = obj` names `h` precisely to leave it out.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // Every `catch {}` here carries a comment saying why; an empty catch is a decision.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Game code runs in the browser.
  { files: ['src/**/*.js'], languageOptions: { globals: globals.browser } },
  // The Map Studio (studio/**) is a separate site, outside src/ on purpose — see
  // tools/seams/run.js's own header, which only walks src/. It runs in the browser too.
  { files: ['studio/**/*.js'], languageOptions: { globals: globals.browser } },
  // The heartbeat is a dedicated worker.
  { files: ['src/idle/worker.js'], languageOptions: { globals: globals.worker } },
  // Selftests and the data builders run under plain Node.
  { files: ['src/**/selftest.js', 'src/pokemon/tools/**/*.js'], languageOptions: { globals: globals.node } },
  // Tools run under Node; the screenshot harness and the flow tests also hand functions to
  // `page.evaluate`, whose bodies run in the page.
  { files: ['tools/**/*.js', '*.config.js', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  { files: ['tools/shots/**/*.js', 'tools/mapstudio/**/*.js', 'tests/**/*.js'], languageOptions: { globals: nodeAndBrowser } },
  // `*.test.js` run under vitest (Node) and import game modules; nothing browser-only.
  { files: ['src/**/*.test.js', 'tools/**/*.test.js'], languageOptions: { globals: globals.node } },
];

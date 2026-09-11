/**
 * Vitest runs the `*.test.js` files — the fine-grained tests written since the harness landed.
 * The `selftest.js` files are NOT vitest tests: the seams discover and run them under plain
 * Node (tools/seams/run.js rule 6), and they stay there. Vitest is for new tests that want
 * `expect` diffs, fixtures and watch mode.
 *
 * This file is read INSTEAD of vite.config.js, which is a feature: the dev server's
 * `port 5173 / strictPort` never collides with a running `npm run dev`. Playwright's specs are
 * matched by `tests/flows/**\/*.spec.js` in playwright.config.js and by nothing here, so the two
 * runners never pick up each other's files.
 *
 *   npx vitest run                 # what the `unit` gate stage runs
 *   npx vitest --watch src/idle    # while writing one
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js', 'tools/**/*.test.js'],
    environment: 'node',
  },
});

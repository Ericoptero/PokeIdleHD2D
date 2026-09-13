/**
 * The flow tests: real user flows at `/`, driven through `window.__HOOKS__` and `__CTX__`
 * and asserted on bus events and module state — never on pixels (that is `tools/shots/`).
 * DOM selectors are fair game for the Códice UI (`src/ui/dom/`, `src/ui/screens/`) via the
 * `[data-ui="…"]` tags `harness.js`'s `click()`/`probe()` walk — what stays off-limits is the
 * world canvas (`src/ui/screen.js`), which has no selectors at all to assert on.
 *
 *   npx playwright test                              # what the `flows` gate stage runs
 *   npx playwright test tests/flows/hunt.spec.js --headed
 *
 * The same real Chrome `tools/shots/shoot.js` uses, launched with the same flags
 * (`tools/shots/chrome.js`). One vite for the whole gate: `webServer` probes 127.0.0.1 on
 * `GATE_PORT` (vite binds 127.0.0.1, so a `localhost` probe would miss it and start a second
 * one) and reuses the server `tools/gate.js` already started.
 */
import { defineConfig } from '@playwright/test';
import { CHROME, chromeArgs, assertChrome } from './tools/shots/chrome.js';

// The same refusal `tools/shots/shoot.js` makes, before Playwright reports its own.
assertChrome();

const PORT = Number(process.env.GATE_PORT ?? 5173);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests/flows',
  testMatch: '**/*.spec.js',
  // Flows drive a shared dev server and a real GPU; one at a time keeps the fps and the
  // event order honest, and the whole suite is a few minutes.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  outputDir: 'shots/out/flows',
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { executablePath: CHROME, args: chromeArgs() },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `${baseURL}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

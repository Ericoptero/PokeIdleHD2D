/**
 * The few helpers every flow needs. Everything goes through what the page already exposes for
 * the screenshot harness (`window.__HOOKS__`, src/main.js) and the ctx it exposes for
 * diagnostics (`window.__CTX__`); nothing here adds a hook to the app.
 */
import { expect } from '@playwright/test';

/** Events that fire on a timer and would make any order assertion flaky. */
const NOISE = new Set(['perf:sample']);

/**
 * Installs an event log BEFORE the page runs: `boot:ready` is emitted before `__READY__` flips
 * (src/main.js), so a subscriber installed after ready never sees it. The init script polls
 * for `window.__CTX__`, which main.js sets synchronously before `registry.init`, and wraps
 * `bus.emit` — the object every module holds — so every event is captured with no list of
 * names to keep up (and no 256-entry ring to evict them).
 */
export async function installEventLog(page) {
  await page.addInitScript(() => {
    window.__EVLOG__ = [];
    const arm = () => {
      const bus = window.__CTX__?.bus;
      if (!bus) { setTimeout(arm, 0); return; }
      const emit = bus.emit;
      bus.emit = (type, payload) => {
        window.__EVLOG__.push({ type, payload, at: window.__EVLOG__.length });
        return emit.call(bus, type, payload);
      };
    };
    arm();
  });
}

/**
 * Opens a URL, waits for the first frame, and freezes the frame loop so the only thing that
 * moves the world is `step()`. Returns the console errors seen so far (the budget is zero).
 */
export async function boot(page, params = {}) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const q = new URLSearchParams({ seed: '1337', timeFrozen: '1', debug: '0', ...params });
  await page.goto(`/?${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 45_000, polling: 100 });
  const fatal = await page.evaluate(() => window.__FATAL__ ?? null);
  expect(fatal, 'the page reached __READY__ through fatal()').toBeNull();
  await page.evaluate(() => window.__HOOKS__.pause());
  return errors;
}

/** Advances the world by `n` sim ticks through the harness hook. */
export const step = (page, n) => page.evaluate((k) => window.__HOOKS__.step(k), n);

/** The event log so far, noise removed. */
export const events = async (page) =>
  (await page.evaluate(() => window.__EVLOG__ ?? [])).filter((e) => !NOISE.has(e.type));

/**
 * Steps in `chunk`-tick increments until an event of `type` has been logged, or `maxTicks`
 * have passed — in which case the assertion fails WITH the log in the message. A test must
 * never end by timing out: a timeout says nothing about which step did not happen.
 */
export async function stepUntil(page, type, { chunk = 20, maxTicks = 3000, after = 0 } = {}) {
  let ticks = 0;
  for (;;) {
    const log = await events(page);
    const hit = log.find((e) => e.type === type && e.at >= after);
    if (hit) return { hit, ticks, log };
    if (ticks >= maxTicks) {
      const seen = [...new Set(log.filter((e) => e.at >= after).map((e) => e.type))].join(', ');
      expect(null, `no ${type} within ${maxTicks} ticks; events since ${after}: ${seen || '(none)'}`).not.toBeNull();
    }
    await step(page, chunk);
    ticks += chunk;
  }
}

/**
 * Presses (or releases, `down: false`) a key the way a player would: a real KeyboardEvent
 * through `ui/input.js`. `down` defaults `true` so every existing single-arg call site keeps
 * dispatching `keydown` exactly as before.
 */
export const key = (page, code, down = true) =>
  page.evaluate(({ c, d }) => window.__HOOKS__.key(c, d), { c: code, d: down });

/**
 * Clicks a Códice DOM element by its `data-ui` tag — the DOM layer's own diagnostic
 * attribute (`ui/dom/layer.js`'s `probe()`). A real `page.click()`, not a dispatched event, so
 * it exercises the browser's own hit-testing (an element covered by something else fails the
 * way a real click would).
 */
export const click = (page, tag) => page.click(`[data-ui="${tag}"]`);

/** The Códice DOM layer's hit-region list (`ui/dom/layer.js`'s `probe()`) — the DOM
 *  successor to `ui._screen.regions()` for anything converted off the canvas. */
export const probe = (page) => page.evaluate(() => window.__CTX__.get('ui')?.probe?.() ?? []);

/** Calls a module's API method through the ctx the page exposes. */
export const call = (page, id, method, ...args) =>
  page.evaluate(([m, f, a]) => {
    const api = window.__CTX__.get(m);
    if (typeof api?.[f] !== 'function') throw new Error(`${m}.${f} is not a function on the live API`);
    return api[f](...a);
  }, [id, method, args]);

/** Reads a plain property off a module's API (e.g. `offline.keys`). */
export const prop = (page, id, name) =>
  page.evaluate(([m, k]) => window.__CTX__.get(m)?.[k], [id, name]);

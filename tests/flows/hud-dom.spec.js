/**
 * The always-on HUD chrome (`src/ui/dom/hud.js`, Stage 3a): the wallet/clock row and the
 * dock. The party list's own click/drag behaviour has its own file
 * (`tests/flows/party-bar.spec.js`); this one covers the rest of the chrome — real wallet
 * figures, the dock opening the right panel, and the settings button's current (Stage 4 not
 * landed yet) no-op.
 */
import { test, expect } from '@playwright/test';
import { boot, call, key } from './harness.js';

const paintNow = (page, dt = 0.25) => call(page, 'ui', '_frame', dt);
const text = (page, tag) => page.locator(`[data-ui="${tag}"]`).innerText();

test('the wallet chips show the real balance, not a placeholder', async ({ page }) => {
  const errors = await boot(page);
  await call(page, 'economy', 'add', 'money', 12345, 'test:hud');
  await paintNow(page);

  expect((await text(page, 'hud-wallet-money')).replace(/\s/g, '')).toContain('12,345');
  expect(errors, 'no console error rendering the wallet').toEqual([]);
});

test('the clock chip shows the current time and phase', async ({ page }) => {
  await boot(page, { tod: '9' });
  await paintNow(page);

  expect(await text(page, 'hud-clock')).toMatch(/09:00/);
});

test('the dock opens the matching panel; Escape closes it, now that the panel is a real DOM modal covering the dock', async ({ page }) => {
  const errors = await boot(page);
  await paintNow(page);

  await page.click('[data-ui="dock-shop"]');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('shop');

  // Shop is a full-screen Códice DOM modal (`screens/shop.js`, Stage 5) in the same `#ui-dom`
  // layer as the dock, stacked above it (`screens.css`'s `.ci-offline-scrim`) so a real click
  // never falls through to whatever it covers — the dock button underneath is genuinely
  // unreachable now, not merely painted over the way a canvas panel's own scrim left it.
  // `elementFromPoint` proves that without paying a real click's actionability timeout for one
  // that would never land.
  const coveredBy = await page.evaluate(() => {
    const dock = document.querySelector('[data-ui="dock-shop"]');
    const r = dock.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-ui]')?.dataset.ui;
  });
  expect(coveredBy, 'the dock button must not be the topmost element while Shop is open').not.toBe('dock-shop');

  await key(page, 'Escape');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBeNull();
  expect(errors, 'no console error opening shop from the dock and closing it with Escape').toEqual([]);
});

test('every dock destination is reachable, matching the old strip\'s full functionality', async ({ page }) => {
  const errors = await boot(page);
  for (const [dockId, panelId] of [
    ['automation', 'automation'], ['inventory', 'inventory'], ['shop', 'shop'],
    ['travel', 'travel'], ['menu', 'menu'],
  ]) {
    await page.click(`[data-ui="dock-${dockId}"]`);
    await paintNow(page);
    expect(await call(page, 'ui', 'openPanel'), `dock-${dockId} should open ${panelId}`).toBe(panelId);
    await call(page, 'ui', 'close');
    await paintNow(page);
  }
  expect(errors, 'no console error cycling every dock destination').toEqual([]);
});

test('the Auto dock button reflects a real running automation, not a fixed "on"', async ({ page }) => {
  const errors = await boot(page);
  await paintNow(page);

  // A fresh save has nothing unlocked yet (every automation gates on real progress —
  // `dexCaught`/`battlesWon` — well beyond a fresh save) — the dock must not claim otherwise.
  const activeBefore = await page.locator('[data-ui="dock-automation"]').getAttribute('data-active');
  expect(activeBefore).toBe('false');

  // `automation.list()` is the one call `dom/hud.js` reads for this; stubbing its return
  // is the direct way to prove the dock's own reactivity to a real "something is running"
  // answer without also re-proving automation's own unlock economy (dex/battle progress
  // gates), which belongs to that module's own tests.
  await page.evaluate(() => {
    const auto = window.__CTX__.get('automation');
    auto.list = () => [{ id: 'stub', unlocked: true, enabled: true }];
  });
  await paintNow(page);

  const activeAfter = await page.locator('[data-ui="dock-automation"]').getAttribute('data-active');
  expect(activeAfter).toBe('true');
  expect(errors, 'no console error reflecting a running automation').toEqual([]);
});

test('the settings button opens the real Settings screen (Stage 4); its own close button closes it', async ({ page }) => {
  const errors = await boot(page);
  await page.click('[data-ui="hud-settings"]');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('settings');

  // Settings is the same kind of full-screen DOM modal as Shop/Bag (Stages 4/5) — it now
  // stacks above the gear button in `#ui-dom` (`screens.css`'s `.ci-offline-scrim`), so a
  // second click on `hud-settings` can no longer reach it; the modal's own close button is
  // the real affordance a player has to use instead.
  await page.click('[data-ui="settings-close"]');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBeNull();
  expect(errors, 'no console error opening Settings from the gear button and closing it with its own close button').toEqual([]);
});

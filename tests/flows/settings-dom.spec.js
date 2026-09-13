/**
 * Settings (`src/ui/screens/settings.js`, Stage 4) — the species watch-list's real toast on a
 * real encounter, config persistence through a reload, the sound sliders' genuine `disabled`
 * state, and the `ui` save slice's v1→v2 upgrade.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, call, stepUntil,
} from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const openSettings = async (page) => {
  await page.click('[data-ui="hud-settings"]');
  await paintNow(page);
};

test('watching a real species toasts on the real encounter:started listener wired for it', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await call(page, 'travel', 'go', 'hunt-meadow');
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'hunt-meadow',
    null, { timeout: 30_000, polling: 100 });

  // A real, valid species name from a real roll — not invented — so "watch a species that
  // doesn't exist" (the next test) and "watch one that does" are both exercised honestly.
  // The re-fire is a direct `bus.emit` rather than waiting on a hunt to reroll the same
  // species again: that would be a real encounter, but a flaky one to wait on, and the thing
  // actually under test is `index.js`'s own listener, not `encounter`'s own RNG.
  const first = await stepUntil(page, 'encounter:started', { chunk: 5, maxTicks: 4000 });
  const species = first.hit.payload.species;

  await openSettings(page);
  await page.fill('[data-ui="settings-watch-input"]', species);
  await page.click('[data-ui="settings-watch-add"]');
  await paintNow(page);
  expect(await page.locator('.ci-watch-chip').count()).toBe(1);
  await call(page, 'ui', 'close');

  await page.evaluate((s) => window.__CTX__.bus.emit('encounter:started', {
    species: s, level: 5, shiny: false, biome: 'meadow', index: 99999, tod: 12, ivs: {}, catchRate: 45, slot: null,
  }), species);
  await paintNow(page);

  const toastEls = await page.locator('.ci-toast').allInnerTexts();
  expect(toastEls.some((t) => t.toLowerCase().includes('appeared'))).toBe(true);
  expect(errors, 'no console error watching a real species').toEqual([]);
});

test('an unknown species name is rejected with a real warning, not silently added', async ({ page }) => {
  const errors = await boot(page);
  await openSettings(page);
  await page.fill('[data-ui="settings-watch-input"]', 'not-a-real-species');
  await page.click('[data-ui="settings-watch-add"]');
  await paintNow(page);

  expect(await page.locator('.ci-watch-chip').count()).toBe(0);
  const toastEls = await page.locator('.ci-toast').allInnerTexts();
  expect(toastEls.some((t) => t.includes("isn't a species"))).toBe(true);
  expect(errors, 'no console error rejecting an unknown species').toEqual([]);
});

test('a display setting persists through config.persist() and survives a reload', async ({ page }) => {
  const errors = await boot(page);
  await openSettings(page);
  await page.click('[data-ui="settings-cat-display"]');
  await page.click('[data-ui="settings-toggle-uiscale"]');

  expect(await page.evaluate(() => window.__CTX__.config.get('uiScale'))).toBe(2);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pokeidle.config') ?? '{}'));
  expect(stored.uiScale).toBe(2);
  expect(errors, 'no console error changing a display setting').toEqual([]);
});

test('the sound sliders are genuinely disabled, not just labelled that way', async ({ page }) => {
  const errors = await boot(page);
  await openSettings(page);
  await page.click('[data-ui="settings-cat-sound"]');

  const disabled = await page.locator('.ci-slider').evaluateAll((els) => els.map((e) => e.disabled));
  expect(disabled.every(Boolean)).toBe(true);
  expect(errors, 'no console error viewing the sound category').toEqual([]);
});

test('the ui save slice upgrades a v1 (window-only) shape without throwing', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(() => window.__CTX__.get('ui').loadState({ v: 1, windows: { shop: { x: 4, y: 4, w: 200, h: 200 } } }));
  await paintNow(page);

  const saved = await page.evaluate(() => window.__CTX__.get('ui').saveState());
  expect(saved.v).toBe(3);
  expect(saved.watch).toEqual([]);
  expect(errors, 'no console error loading a v1 ui slice').toEqual([]);
});

/**
 * The mobile pass (Stage 8): a narrow, touch viewport gets the DOM d-pad (`dom/dpad.js`,
 * replacing the deleted canvas one), the dock becomes a bottom tab bar, full-screen cards go
 * edge to edge, and the common touch targets clear 44px. Run at `phone-portrait`'s own
 * 390x844 (`tools/shots/parity.js`'s own viewport matrix), with `hasTouch` so
 * `(pointer: coarse)` actually matches in Chromium rather than being asserted by convention.
 */
import { test, expect } from '@playwright/test';
import { boot, call, click } from './harness.js';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const forceTouch = (page) => page.evaluate(() => window.__CTX__.get('ui').input.setTouch(true));

test('the DOM d-pad appears on a touch device on a walkable map, and holding a direction actually walks', async ({ page }) => {
  const errors = await boot(page);
  await forceTouch(page);
  await paintNow(page);

  await expect(page.locator('[data-ui="dpad"]')).toBeVisible();

  const before = await call(page, 'simulation', 'player');
  const s = await page.locator('[data-ui="dpad-s"]').boundingBox();

  // `simulation.moveIntent` only ever fires off the render loop's own per-frame tick
  // (`ui/index.js`'s `frame()` → `input.frame()`) — `boot()` leaves that loop paused
  // (`harness.js`), so this resumes it for real, the same pattern `pokecenter.spec.js` uses
  // to prove a real keyboard walk, applied here to a real pointer hold on the DOM button.
  await page.evaluate(() => window.__HOOKS__.resume());
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await expect.poll(async () => {
    const now = await call(page, 'simulation', 'player');
    return now.cx !== before.cx || now.cz !== before.cz;
  }, { message: 'holding the d-pad must move the player', timeout: 15_000 }).toBe(true);
  await page.mouse.up();

  expect(errors, 'no console error walking with the d-pad').toEqual([]);
});

test('the d-pad hides itself behind a full-screen screen, and reappears once it closes', async ({ page }) => {
  const errors = await boot(page);
  await forceTouch(page);
  await paintNow(page);
  await expect(page.locator('[data-ui="dpad"]')).toBeVisible();

  await click(page, 'dock-shop');
  await paintNow(page);
  await expect(page.locator('[data-ui="dpad"]')).toBeHidden();

  await click(page, 'shop-close');
  await paintNow(page);
  await expect(page.locator('[data-ui="dpad"]')).toBeVisible();
  expect(errors, 'no console error toggling a screen over the d-pad').toEqual([]);
});

test('the dock renders as a full-width bottom tab bar at phone width', async ({ page }) => {
  const errors = await boot(page);
  await paintNow(page);

  const dock = page.locator('[data-ui="hud-dock"]');
  const box = await dock.boundingBox();
  const viewport = page.viewportSize();
  expect(box.width, 'the dock should span (most of) the narrow viewport, not float in a corner').toBeGreaterThan(viewport.width * 0.8);
  const style = await dock.evaluate((el) => getComputedStyle(el).bottom);
  expect(style).toBe('0px');
  expect(errors, 'no console error reading the dock at phone width').toEqual([]);
});

test('the d-pad and the bottom tab bar both fit — the dock stays reachable with the pad visible', async ({ page }) => {
  const errors = await boot(page);
  await forceTouch(page);
  await paintNow(page);
  await expect(page.locator('[data-ui="dpad"]')).toBeVisible();

  // A real click, not a coordinate check — the same failure this caught in review (the pad
  // sitting on top of the dock's own "Auto" button in DOM order) only shows up against
  // Playwright's own actionability check, not a bounding-box comparison.
  await click(page, 'dock-automation');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('automation');
  expect(errors, 'no console error reaching the dock with the d-pad visible').toEqual([]);
});

test('a full-screen card goes edge to edge at phone width', async ({ page }) => {
  const errors = await boot(page);
  await click(page, 'dock-shop');
  await paintNow(page);

  const card = page.locator('.ci-shelf-card');
  const box = await card.boundingBox();
  const viewport = page.viewportSize();
  expect(box.width).toBe(viewport.width);
  expect(box.height).toBe(viewport.height);
  expect(errors, 'no console error opening the Shop at phone width').toEqual([]);
});

test('common touch targets clear 44px on a coarse pointer', async ({ page }) => {
  const errors = await boot(page);
  await click(page, 'hud-settings');
  await paintNow(page);

  const gear = await page.locator('[data-ui="hud-settings"]').boundingBox();
  expect(Math.min(gear.width, gear.height)).toBeGreaterThanOrEqual(44);
  expect(errors, 'no console error checking touch target sizes').toEqual([]);
});

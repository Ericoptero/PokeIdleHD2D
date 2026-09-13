/**
 * Economy mode (`src/ui/screens/economy.js`, `core/render.js`'s `setPaused`, Stage 7): the
 * toggle in Settings really stops the WebGL draw calls and hides the canvas, the simulation
 * keeps ticking regardless, another screen still opens correctly on top of the board, and
 * Escape/the board's own button both leave the mode.
 */
import { test, expect } from '@playwright/test';
import {
  boot, call, click, step, key,
} from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const canvasHidden = (page) => page.evaluate(() => window.__CTX__.three.view.canvas.style.visibility === 'hidden');
const rendererPaused = (page) => page.evaluate(() => window.__CTX__.three.view.paused === true);

async function enableEconomyMode(page) {
  await click(page, 'hud-settings');
  await paintNow(page);
  await click(page, 'settings-cat-display');
  await paintNow(page);
  await click(page, 'settings-toggle-economy');
  await paintNow(page);
  await click(page, 'settings-close');
  await paintNow(page);
}

test('the Settings toggle pauses the renderer, hides the canvas, and mounts the board', async ({ page }) => {
  const errors = await boot(page);
  expect(await call(page, 'ui', 'isEconomyMode')).toBe(false);
  expect(await rendererPaused(page)).toBe(false);

  await enableEconomyMode(page);

  expect(await call(page, 'ui', 'isEconomyMode')).toBe(true);
  expect(await rendererPaused(page)).toBe(true);
  expect(await canvasHidden(page)).toBe(true);
  await expect(page.locator('[data-ui="economy-board"]')).toBeVisible();
  expect(errors, 'no console error entering economy mode').toEqual([]);
});

test('the simulation keeps ticking while economy mode is active — a hunt still pays out', async ({ page }) => {
  const errors = await boot(page, { scene: 'hunt-meadow' });
  await enableEconomyMode(page);

  const before = await call(page, 'economy', 'balance', 'money');
  await step(page, 400);
  await paintNow(page);
  const after = await call(page, 'economy', 'balance', 'money');

  expect(after, 'idle accrual must not stop just because the world stopped rendering').toBeGreaterThan(before);
  expect(errors, 'no console error while ticking in economy mode').toEqual([]);
});

test('another screen still opens on top of the board, and its own button leaves the mode', async ({ page }) => {
  const errors = await boot(page);
  await enableEconomyMode(page);

  await click(page, 'dock-shop');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('shop');
  await expect(page.locator('[data-ui="shop-scrim"]')).toBeVisible();
  await click(page, 'shop-close');
  await paintNow(page);

  await click(page, 'economy-exit');
  await paintNow(page);
  expect(await call(page, 'ui', 'isEconomyMode')).toBe(false);
  expect(await rendererPaused(page)).toBe(false);
  expect(await canvasHidden(page)).toBe(false);
  expect(errors, 'no console error opening a screen over the board and then leaving economy mode').toEqual([]);
});

test('Escape leaves economy mode when no other screen is open', async ({ page }) => {
  const errors = await boot(page);
  await enableEconomyMode(page);

  await key(page, 'Escape');
  await paintNow(page);

  expect(await call(page, 'ui', 'isEconomyMode')).toBe(false);
  expect(errors, 'no console error leaving economy mode with Escape').toEqual([]);
});

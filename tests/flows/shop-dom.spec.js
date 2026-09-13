/**
 * The Shop (`src/ui/screens/shop.js`, Stage 5): the real shelves (Poké Mart, and the
 * synthesized Upgrades shelf), a real purchase reaching `economy.buy`, and the screen
 * updating live off `economy.onChange()` — the gap the old canvas panel did not need to close
 * (a canvas repaints from live data every frame regardless; a DOM screen only redraws when
 * told to).
 */
import { test, expect } from '@playwright/test';
import { boot, call, click } from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const openShop = async (page) => { await click(page, 'dock-shop'); await paintNow(page); };

test('the Poké Mart shelf lists real stock, and the wallet chips show real balances', async ({ page }) => {
  const errors = await boot(page);
  await openShop(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('shop');

  await expect(page.locator('[data-ui="shop-shop-mart"]')).toBeVisible();
  await expect(page.locator('[data-ui="shop-row-pokeball"]')).toBeVisible();

  const money = await call(page, 'economy', 'balance', 'money');
  const expected = await call(page, 'economy', 'format', 'money', money);
  const text = await page.locator('[data-ui="shop-wallet-money"]').innerText();
  expect(text).toBe(expected);
  expect(errors, 'no console error opening the Shop').toEqual([]);
});

test('buying a Poké Ball reaches economy.buy and the shelf reflects it with no reopen', async ({ page }) => {
  const errors = await boot(page);
  await openShop(page);
  const before = await call(page, 'economy', 'count', 'pokeball');

  await click(page, 'shop-row-pokeball');
  await paintNow(page);
  await click(page, 'shop-buy');
  await paintNow(page);

  expect(await call(page, 'economy', 'count', 'pokeball')).toBe(before + 1);
  await expect(page.locator('[data-ui="shop-row-pokeball"] .ci-shelf-row__sub')).toHaveText(`own ×${before + 1}`);
  expect(await call(page, 'ui', 'openPanel'), 'the screen never closed').toBe('shop');
  expect(errors, 'no console error buying a Poké Ball').toEqual([]);
});

test('the Upgrades shelf buys a real upgrade through economy.buyUpgrade', async ({ page }) => {
  const errors = await boot(page);
  await openShop(page);

  await click(page, 'shop-shop-upgrades');
  await paintNow(page);
  await expect(page.locator('[data-ui="shop-row-payday"]')).toBeVisible();

  const levelBefore = await call(page, 'economy', 'upgradeLevel', 'payday');
  await click(page, 'shop-row-payday');
  await paintNow(page);
  await click(page, 'shop-buy');
  await paintNow(page);

  expect(await call(page, 'economy', 'upgradeLevel', 'payday')).toBe(levelBefore + 1);
  expect(errors, 'no console error buying an upgrade').toEqual([]);
});

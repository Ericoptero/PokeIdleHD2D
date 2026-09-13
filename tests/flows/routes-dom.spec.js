/**
 * Routes (`src/ui/screens/travel.js`, Stage 6): the real destination list survives the DOM
 * conversion untouched (`../models/travel.js`'s `travelRows`), a locked hunt still lets
 * `travel.go()` refuse it out loud instead of swallowing the click, picking an unlocked one
 * actually travels there and closes the screen, and a hunt row carries a real relative-yield
 * line off `idle.catalog().biomes` (the plan's own note: a route's absolute coins/hour has no
 * source today, so this shows the real relative multiplier instead of inventing one).
 */
import { test, expect } from '@playwright/test';
import { boot, call, click } from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const openRoutes = async (page) => { await click(page, 'dock-travel'); await paintNow(page); };

test('the real destinations render, with the locked hunts shown and greyed, and a yield line on a hunt row', async ({ page }) => {
  const errors = await boot(page);
  await openRoutes(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('travel');

  await expect(page.locator('[data-ui="route-demo-city"]')).toBeVisible();
  await expect(page.locator('[data-ui="route-hunt-meadow"]')).toBeVisible();

  const forestRow = page.locator('[data-ui="route-hunt-forest"]');
  await expect(forestRow).toBeVisible();
  await expect(forestRow).toHaveClass(/ci-routes-row--locked/);
  // `.ci-routes-row__status` is `text-transform: uppercase` in CSS — `innerText` reflects the
  // rendered case, not the string the screen actually built ('Lv 5').
  expect((await forestRow.locator('.ci-routes-row__status').innerText())).toBe('LV 5');

  const meadowYield = await page.locator('[data-ui="route-hunt-meadow"] .ci-routes-row__yield').first().innerText();
  expect(meadowYield.length).toBeGreaterThan(0);
  expect(errors, 'no console error opening Routes').toEqual([]);
});

test('picking a locked route lets travel.go() refuse it out loud, and the screen stays open', async ({ page }) => {
  const errors = await boot(page);
  await openRoutes(page);

  await click(page, 'route-hunt-forest');
  await paintNow(page);

  expect(await call(page, 'ui', 'openPanel'), 'a refused travel must not close the screen').toBe('travel');
  const toastEls = await page.locator('.ci-toast').allInnerTexts();
  expect(toastEls.some((t) => t.includes('Lv5'))).toBe(true);
  expect(errors, 'no console error picking a locked route').toEqual([]);
});

test('picking an unlocked route actually travels there and closes the screen', async ({ page }) => {
  const errors = await boot(page);
  await openRoutes(page);

  await click(page, 'route-hunt-meadow');
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'hunt-meadow',
    null, { timeout: 30_000, polling: 100 });
  await paintNow(page);

  expect(await call(page, 'ui', 'openPanel'), 'a successful travel must close the screen').toBeNull();
  expect(errors, 'no console error travelling to the meadow').toEqual([]);
});

/**
 * The Bag (`src/ui/screens/inventory.js`, Stage 5): the starting kit renders exactly, a
 * purchase updates it live with no reopen, the sell-lock toggle reaches automation's own sell
 * preview, and — new this stage — `economy.useItem()` gets its first real caller anywhere in
 * the codebase, wired here to `pokemon.revive()`.
 */
import { test, expect } from '@playwright/test';
import { boot, call, click } from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const openBag = async (page) => { await click(page, 'dock-inventory'); await paintNow(page); };
const rowValue = (page, id) => page.locator(`[data-ui="bag-row-${id}"] .ci-shelf-row__value`).innerText();

test('a fresh save\'s Bag tab lists exactly the starting kit, and Stash is empty', async ({ page }) => {
  const errors = await boot(page);
  await openBag(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('inventory');

  const kit = { pokeball: 20, potion: 10, superpotion: 3, revive: 2, ether: 3 };
  for (const [id, n] of Object.entries(kit)) {
    await expect(page.locator(`[data-ui="bag-row-${id}"]`)).toBeVisible();
    expect(await rowValue(page, id)).toBe(`×${n}`);
  }

  await click(page, 'bag-tab-stash');
  await paintNow(page);
  await expect(page.locator('.ci-shelf-empty')).toBeVisible();
  expect(errors, 'no console error opening the Bag').toEqual([]);
});

test('a purchase updates the Bag live, with no reopen', async ({ page }) => {
  const errors = await boot(page);
  await openBag(page);
  const before = (await rowValue(page, 'potion')).replace(/\D/g, '');

  expect(await call(page, 'economy', 'buy', 'potion', 1)).toBe(true);
  await paintNow(page);

  const after = (await rowValue(page, 'potion')).replace(/\D/g, '');
  expect(Number(after)).toBe(Number(before) + 1);
  expect(await call(page, 'ui', 'openPanel'), 'the screen never closed').toBe('inventory');
  expect(errors, 'no console error buying an item with the Bag open').toEqual([]);
});

test('the sell-lock toggle, clicked in the Bag, reaches automation\'s own sell preview', async ({ page }) => {
  const errors = await boot(page);

  const SPECIES = ['zubat', 'geodude', 'rattata', 'pidgey', 'magikarp', 'caterpie', 'weedle',
    'psyduck', 'machop', 'tentacool', 'gastly', 'onix'];
  await call(page, 'collection', 'importBatch', SPECIES.map((s) => ({ species: s })));
  await call(page, 'economy', 'add', 'research', 200, 'grant');
  await call(page, 'economy', 'give', 'nugget', 3, 'test:loot');
  const unlocked = await call(page, 'automation', 'unlock', 'sell');
  expect(unlocked.ok, `automation.unlock('sell') refused: ${unlocked.why}`).toBe(true);

  const before = await call(page, 'automation', 'preview', 'sell');
  expect(before.plan.map((r) => r.id)).toContain('nugget');

  await openBag(page);
  await click(page, 'bag-tab-stash');
  await paintNow(page);
  await click(page, 'bag-row-nugget');
  await paintNow(page);
  await click(page, 'bag-lock');
  await paintNow(page);

  expect(await call(page, 'economy', 'sellLocked', 'nugget'),
    'clicking the Bag\'s own button must reach economy.setSellLock').toBe(true);

  const after = await call(page, 'automation', 'preview', 'sell');
  expect(after.plan.map((r) => r.id), 'the locked item must not appear in a fresh sell preview')
    .not.toContain('nugget');
  expect(errors, 'no console error toggling the sell lock from the Bag').toEqual([]);
});

test('using a Revive on a fainted party member is economy.useItem()\'s first real caller, wired to pokemon.revive()', async ({ page }) => {
  const errors = await boot(page);
  const lead = (await call(page, 'pokemon', 'party'))[0];
  expect(lead.hp, 'a fresh party starts conscious').toBeGreaterThan(0);
  await call(page, 'pokemon', 'damage', lead.instanceId, lead.maxHp);
  expect((await call(page, 'pokemon', 'instance', lead.instanceId)).hp).toBe(0);

  await openBag(page);
  await click(page, 'bag-row-revive');
  await paintNow(page);
  await click(page, 'bag-use');
  await paintNow(page);
  await click(page, `bag-picker-${lead.instanceId}`);
  await paintNow(page);

  const revived = await call(page, 'pokemon', 'instance', lead.instanceId);
  expect(revived.hp, 'a Revive must actually raise the fainted lead').toBeGreaterThan(0);
  expect(await call(page, 'economy', 'count', 'revive'), 'the Revive must be spent').toBe(1);
  expect(errors, 'no console error using a Revive from the Bag').toEqual([]);
});

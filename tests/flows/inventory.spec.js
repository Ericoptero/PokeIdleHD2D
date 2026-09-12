/**
 * The inventory panel: a grid of every held item, split BAG / STASH, built on
 * `economy.bag()`/`stash()` and the window/pointer primitives 015/016 landed.
 *
 * Driven through real `PointerEvent`s at real buffer coordinates (`tests/flows/hud-windows.spec.js`'s
 * `regions()`/`click()` pattern) for the one write action this panel has — the sell-lock toggle —
 * because clicking the panel's own button is what proves the control reaches `economy`, not a
 * direct call to `economy.setSellLock` standing in for it.
 */
import { test, expect } from '@playwright/test';
import {
  boot, call, key, pointer,
} from './harness.js';

/** The hit regions of the last paint, boxes and all — the same shape `g.hit()` builds. */
const regions = (page) => page.evaluate(() => window.__CTX__.get('ui')._screen.regions());

/** Forces one UI frame so a state change is actually painted and registered. */
const paintNow = (page, dt = 0) => call(page, 'ui', '_frame', dt);

/** The centre point of a region's box, in UI buffer pixels. */
const centre = (r) => ({ x: Math.round(r.box.x + r.box.w / 2), y: Math.round(r.box.y + r.box.h / 2) });

/** A real click: down then up at the same point, the way `screen.js`'s listeners see one. */
async function click(page, point) {
  await pointer(page, { type: 'pointerdown', ...point });
  await pointer(page, { type: 'pointerup', ...point });
}

/** `panel.rows(tab, category)` — `travel.js`'s `rows()` precedent, exposed off the live panel
 *  object at `ui._state.panel` while `inventory` is the open one. */
const invRows = (page, tab, category = null) => page.evaluate(
  ([t, c]) => window.__CTX__.get('ui')._state.panel.rows(t, c),
  [tab, category],
);

test('a fresh save\'s BAG tab lists exactly the starting kit, and STASH is empty', async ({ page }) => {
  const errors = await boot(page);
  await key(page, 'KeyI');
  await paintNow(page);

  expect(await call(page, 'ui', 'openPanel')).toBe('inventory');
  const bag = await invRows(page, 'bag');
  // Every id and count from the starting kit (`economy/index.js:137-141`) is here — the
  // order is `economy.bag()`'s own tier-ascending/value-descending sort, not this test's
  // to assert on (tier 1: pokeball ₽2,000 stack > potion ₽1,000; tier 2: ether ₽1,800 >
  // superpotion ₽1,050; tier 3: revive alone).
  expect(bag.map((r) => r.id).sort()).toEqual(
    ['ether', 'pokeball', 'potion', 'revive', 'superpotion'].sort());
  const byId = Object.fromEntries(bag.map((r) => [r.id, r.n]));
  expect(byId).toEqual({
    pokeball: 20, potion: 10, superpotion: 3, revive: 2, ether: 3,
  });
  expect(await invRows(page, 'stash')).toEqual([]);
  expect(errors, 'no console error opening the inventory panel').toEqual([]);
});

test('a purchase updates the panel\'s count while it stays open, with no reopen', async ({ page }) => {
  const errors = await boot(page);
  await key(page, 'KeyI');
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('inventory');

  const before = (await invRows(page, 'bag')).find((r) => r.id === 'potion').n;

  // One UI frame with nothing dirty resets the flag `economy.onChange` is about to flip —
  // proving what follows is that subscription firing, not a stale `true` left over from
  // opening the panel.
  await paintNow(page, 0.25);
  expect(await page.evaluate(() => window.__CTX__.get('ui')._screen.dirty)).toBe(false);

  expect(await call(page, 'economy', 'buy', 'potion', 1)).toBe(true);

  // `economy` has no bus event for a bare item-count change (see its own `economy:changed` is
  // currency-only) — this is `economy.onChange(fn)` marking the screen dirty with the panel
  // still the one open, never a fresh `open()` call.
  expect(await page.evaluate(() => window.__CTX__.get('ui')._screen.dirty),
    'buying an item must dirty the screen while the inventory panel is open').toBe(true);

  await paintNow(page);
  const after = (await invRows(page, 'bag')).find((r) => r.id === 'potion').n;
  expect(after).toBe(before + 1);
  expect(await call(page, 'ui', 'openPanel'), 'the panel never closed').toBe('inventory');
  expect(errors, 'no console error buying an item with the inventory panel open').toEqual([]);
});

test('the sell-lock toggle, clicked in the panel, reaches automation\'s own sell preview', async ({ page }) => {
  const errors = await boot(page);

  // `automation.unlock('sell')` costs 200 research and requires 10 species caught
  // (`automation/automations.js`) — research cannot be minted from a fresh save
  // (see `src/idle/unlock.test.js`), so it is granted directly, the same
  // workaround `src/automation/showcase.js` uses (`eco.add('research', …, 'grant')`).
  const SPECIES = ['zubat', 'geodude', 'rattata', 'pidgey', 'magikarp', 'caterpie', 'weedle',
    'psyduck', 'machop', 'tentacool', 'gastly', 'onix'];
  await call(page, 'collection', 'importBatch', SPECIES.map((s) => ({ species: s })));
  await call(page, 'economy', 'add', 'research', 200, 'grant');
  await call(page, 'economy', 'give', 'nugget', 3, 'test:loot');
  const unlocked = await call(page, 'automation', 'unlock', 'sell');
  expect(unlocked.ok, `automation.unlock('sell') refused: ${unlocked.why}`).toBe(true);

  // Treasure sells by default (`automation/automations.js`'s `sell-treasure` rule, keep 0) —
  // the nugget just given is on the plan before anything is locked.
  const before = await call(page, 'automation', 'preview', 'sell');
  expect(before.plan.map((r) => r.id)).toContain('nugget');

  await key(page, 'KeyI');
  await paintNow(page);
  let regs = await regions(page);
  const stash = regs.find((r) => r.tag === 'inv-tab-stash');
  expect(stash, 'no inv-tab-stash region; is the BAG/STASH switch still called "inv-tab"?').toBeTruthy();
  await click(page, centre(stash));
  await paintNow(page);

  regs = await regions(page);
  const row = regs.find((r) => r.tag === 'inv-row-0');
  expect(row, 'no inv-row-0 region on the STASH tab').toBeTruthy();
  await click(page, centre(row));
  await paintNow(page);

  regs = await regions(page);
  const lock = regs.find((r) => r.tag === 'sell-lock');
  expect(lock, 'no sell-lock region — is a stash row actually selected?').toBeTruthy();
  await click(page, centre(lock));
  await paintNow(page);

  expect(await call(page, 'economy', 'sellLocked', 'nugget'),
    'clicking the panel\'s own button must reach economy.setSellLock').toBe(true);

  const after = await call(page, 'automation', 'preview', 'sell');
  expect(after.plan.map((r) => r.id), 'the locked item must not appear in a fresh sell preview')
    .not.toContain('nugget');

  expect(errors, 'no console error toggling the sell lock from the panel').toEqual([]);
});

/**
 * Automation (`src/ui/screens/automation.js`, Stage 6): unlocking and switching an automation
 * on, drag-reordering its rules (`../dom/dnd.js` replacing the canvas panel's ^/v buttons —
 * this file's own header explains why), toggling one rule, and cycling an enum setting.
 *
 * Reorder is driven through real `page.mouse` input, `party-bar.spec.js`'s own precedent: a
 * `pointerdown`/`pointermove`/`pointerup` sequence at real screen coordinates proves the drag a
 * player actually makes reaches `automation.moveRule()`, not merely that the primitive works.
 */
import { test, expect } from '@playwright/test';
import { boot, call, click } from './harness.js';

const paintNow = (page) => call(page, 'ui', '_frame', 0);
const openAutomation = async (page) => { await click(page, 'dock-automation'); await paintNow(page); };

async function centre(page, tag) {
  const box = await page.locator(`[data-ui="${tag}"]`).boundingBox();
  expect(box, `no [data-ui="${tag}"] element on screen`).toBeTruthy();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** `hunt`'s own unlock (`automation/automations.js`): 120 research, 1 species caught — granted
 *  directly the way `bag-dom.spec.js`'s sell-lock test grants automation's `sell` unlock. */
async function unlockHunt(page) {
  await call(page, 'collection', 'importBatch', [{ species: 'zubat' }]);
  await call(page, 'economy', 'add', 'research', 500, 'grant');
}

test('a fresh save shows every automation locked, and unlocking one through the screen really unlocks it', async ({ page }) => {
  const errors = await boot(page);
  await openAutomation(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('automation');

  expect((await call(page, 'automation', 'get', 'hunt')).unlocked).toBe(false);
  await click(page, 'auto-item-hunt');
  await paintNow(page);
  await expect(page.locator('[data-ui="auto-unlock"]')).toBeDisabled();

  await unlockHunt(page);
  await paintNow(page);
  await click(page, 'auto-unlock');
  await paintNow(page);

  expect((await call(page, 'automation', 'get', 'hunt')).unlocked).toBe(true);
  expect(errors, 'no console error unlocking an automation from the screen').toEqual([]);
});

test('switching an automation on, reordering its rules by drag, and toggling one rule all reach the real engine', async ({ page }) => {
  const errors = await boot(page);
  await unlockHunt(page);
  await call(page, 'automation', 'unlock', 'hunt');

  await openAutomation(page);
  await click(page, 'auto-item-hunt');
  await paintNow(page);

  await click(page, 'auto-toggle');
  await paintNow(page);
  expect((await call(page, 'automation', 'get', 'hunt')).enabled).toBe(true);

  const before = (await call(page, 'automation', 'get', 'hunt')).rules.map((r) => r.id);
  expect(before).toEqual(['hunt-boxpressure', 'hunt-all']);

  const first = await centre(page, 'auto-rule-hunt-boxpressure');
  const second = await centre(page, 'auto-rule-hunt-all');
  await drag(page, first, second);
  await paintNow(page);

  const after = (await call(page, 'automation', 'get', 'hunt')).rules.map((r) => r.id);
  expect(after, 'dragging the first rule below the second must reorder them').toEqual(['hunt-all', 'hunt-boxpressure']);

  await click(page, 'auto-rule-toggle-hunt-all');
  await paintNow(page);
  const rule = (await call(page, 'automation', 'get', 'hunt')).rules.find((r) => r.id === 'hunt-all');
  expect(rule.enabled).toBe(false);

  expect(errors, 'no console error toggling and reordering rules').toEqual([]);
});

test('an enum setting cycles through its real values and writes through automation.configure', async ({ page }) => {
  const errors = await boot(page);
  await unlockHunt(page);
  await call(page, 'automation', 'unlock', 'hunt');

  await openAutomation(page);
  await click(page, 'auto-item-hunt');
  await paintNow(page);
  await click(page, 'auto-view-settings');
  await paintNow(page);

  expect(await call(page, 'automation', 'settings', 'hunt')).toMatchObject({ biome: 'auto' });
  await click(page, 'auto-set-biome');
  await paintNow(page);
  expect(await call(page, 'automation', 'settings', 'hunt')).toMatchObject({ biome: 'city' });

  expect(errors, 'no console error cycling an enum setting').toEqual([]);
});

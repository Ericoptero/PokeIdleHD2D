/**
 * The save round-trips through a real reload. The offline selftest covers the migrations and
 * the quarantine paths under Node; this covers what only a browser can: a write to real
 * localStorage, a fresh page, and the slices coming back.
 *
 * The state written has to be one a fresh save cannot have: at a fixed seed a new game deals
 * the same starter (same instanceId) and the same opening purse, so "the lead came back"
 * proves nothing on its own — the first version of this test passed with localStorage wiped
 * before the reload. Money credited through the API and an item given are not reproducible
 * from the seed, so those are what is asserted.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, call, prop } from './harness.js';

test('what the player had is there after a reload', async ({ page }) => {
  await installEventLog(page);
  expect(await boot(page)).toEqual([]);

  await step(page, 200);
  const lead = await call(page, 'pokemon', 'lead');
  expect(lead?.instanceId, 'a starter is in the party').toBeTruthy();
  const fresh = await call(page, 'economy', 'balance', 'money');
  expect(fresh).toBeGreaterThan(0);

  // State no fresh save has: a credit and a bag item, through the public API.
  const CREDIT = 4321;
  await call(page, 'economy', 'add', 'money', CREDIT, 'flow-test');
  const potionsBefore = await call(page, 'economy', 'count', 'potion');
  await call(page, 'economy', 'give', 'potion', 7, 'flow-test');
  const money = await call(page, 'economy', 'balance', 'money');
  expect(money).toBe(fresh + CREDIT);
  expect(await call(page, 'economy', 'count', 'potion')).toBe(potionsBefore + 7);

  // Writes are wall-clock debounced (src/offline/save.js) and step() moves sim ticks only, so
  // the flush is asked for explicitly — the same call `pagehide` makes.
  await call(page, 'offline', 'persist', 'flow-test');
  const keys = await prop(page, 'offline', 'keys');
  const raw = await page.evaluate((k) => localStorage.getItem(k), keys.save);
  expect(raw, 'a save was written').toBeTruthy();
  const doc = JSON.parse(raw);
  expect(doc.v, 'the current save version').toBe(4);
  expect(Object.keys(doc.slices ?? {})).toEqual(expect.arrayContaining(['pokemon', 'economy', 'offline']));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 45_000, polling: 100 });
  expect(await page.evaluate(() => window.__FATAL__ ?? null)).toBeNull();

  const info = await call(page, 'offline', 'info');
  expect(info.restored, 'the slices were restored').toEqual(expect.arrayContaining(['pokemon', 'economy']));
  // `simulation`'s slice is deferred to the first world:loaded on purpose (the player cell needs
  // a map to stand on); anything unrestored must say why, or it is a refusal.
  for (const u of info.unrestored ?? []) expect(u.why, `${u.id} unrestored without a reason`).toBeTruthy();
  expect((info.unrestored ?? []).map((u) => u.id)).toEqual(['simulation']);

  expect((await call(page, 'pokemon', 'lead'))?.instanceId).toBe(lead.instanceId);
  expect(await call(page, 'economy', 'balance', 'money'), 'the credited money survived the reload').toBe(money);
  expect(await call(page, 'economy', 'count', 'potion'), 'the given item survived the reload').toBe(potionsBefore + 7);
});

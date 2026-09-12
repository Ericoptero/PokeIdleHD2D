/**
 * `?break=pokecenter` checks failure isolation. `pokecenter` is reached through `ctx.get` at
 * runtime — nothing declares it in a `needs` array (confirmed by reading every module's
 * `needs` in `src/`) — so failing it on purpose should cost the game exactly its Center: no cascade to
 * `blocked`, no console error, the city and travel otherwise unaffected, and the door tile
 * inert rather than throwing.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, call } from './harness.js';

test('?break=pokecenter costs the game its Center and nothing else', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { break: 'pokecenter' });
  expect(errors, 'a deliberate ?break= quarantine logs warn, never error').toEqual([]);

  const mods = await page.evaluate(() => window.__HOOKS__.modules());
  const pc = mods.find((m) => m.id === 'pokecenter');
  expect(pc?.status).toBe('failed');
  // Nothing declares `pokecenter` in its own `needs` — only `ctx.get` at runtime — so nothing
  // should cascade to `blocked` the way it would for a real dependency.
  const blocked = mods.filter((m) => m.status === 'blocked').map((m) => m.id);
  expect(blocked, `blocked modules: ${blocked.join(', ') || '(none)'}`).toEqual([]);

  // The city still boots and travel still works; the Center is just gone from the map.
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');
  const dests = await call(page, 'travel', 'destinations');
  expect(dests.map((d) => d.id)).not.toContain('pokecenter');

  // Walking onto the city's own door tile does nothing now: there is no listener left to hear
  // it (`pokecenter/index.js`'s `init` never ran), and no scene change should occur.
  const marker = await call(page, 'city', 'marker', 'pokecenter-door');
  expect(marker, 'the city draft still mints the door marker on its own').not.toBeNull();
  await call(page, 'simulation', 'teleport', marker.cx, marker.cz, 2); // NORTH, facing the door

  const before = await page.evaluate(() => window.__EVLOG__.length);
  await page.evaluate(() => window.__HOOKS__.resume());
  await page.evaluate((c) => window.__HOOKS__.key(c, true), 'KeyW');
  // Bounded wait for an event that must NOT happen: 2s is 8x config.walkSecondsPerTile (0.25s),
  // ample headroom for a headless page to have taken the one step onto the door cell and,
  // were the listener still alive, to have finished the async `terrain.load()` it would kick
  // off. There is no "wait for absence" primitive that isn't a bounded timeout.
  await page.waitForTimeout(2000);
  await page.evaluate((c) => window.__HOOKS__.key(c, false), 'KeyW');
  await page.evaluate(() => window.__HOOKS__.pause());

  const after = await page.evaluate((n) => window.__EVLOG__.slice(n), before);
  expect(after.some((e) => e.type === 'scene:entered'), 'no scene change from a dead listener')
    .toBe(false);
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');
  expect(await page.evaluate(() => window.__FATAL__ ?? null)).toBeNull();
});

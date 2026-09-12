/**
 * Three things `tests/flows/pokecenter.spec.js` never checks
 * because it only ever walks through the door once, in one direction at a time:
 *
 *  1. `terrain.handle().biome === 'city'` and `encounter.tablesFor('city', 12)` is `[]` — read
 *     live off a real boot standing inside the room, not asserted only by reading
 *     `pokecenter/index.js`'s `enter()` and `encounter/tables.js`.
 *  2. `travel.go()` racing itself from the console — the shape a rapid double-step on the
 *     door tile produces (`pokecenter/index.js`'s door listener fires `nav.go()` off
 *     `player:enteredTile`, which is not debounced) — never wedges `travel` and never builds
 *     the room twice.
 *  3. A save whose last scene was `pokecenter` survives a real page reload: `travel`'s own
 *     `sceneId` slice puts the player back in the room. (`pokecenter` has its own
 *     save slice too, but it carries only the cure's cooldown timestamp — not scene state —
 *     so this is still `travel`'s own `sceneId` doing the work here.)
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, call, prop } from './harness.js';

async function goTo(page, sceneId) {
  const ok = await call(page, 'travel', 'go', sceneId);
  expect(ok, `travel.go('${sceneId}') refused`).toBe(true);
}

test('terrain.handle().biome and encounter.tablesFor(), read live from inside the room', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  await goTo(page, 'pokecenter');
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');

  const handle = await call(page, 'terrain', 'handle');
  expect(handle?.id).toBe('pokecenter');
  // The regression: 'interior' is not in encounter's BIOMES
  // list and silently falls back to the meadow table — this is the regression guard for it,
  // exercised against the actual live `terrain`/`encounter` modules, not just read from source.
  expect(handle?.biome, 'the room reports the city biome, not "interior"').toBe('city');

  const table = await call(page, 'encounter', 'tablesFor', 'city', 12);
  expect(table).toEqual([]);

  expect(errors).toEqual([]);
});

test('travel.go() racing itself from the console never wedges travel or double-builds the room', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  // Two `go('pokecenter')` calls fired without awaiting the first — the exact race a rapid
  // double-step onto the city's door tile produces via `pokecenter/index.js`'s
  // `player:enteredTile` listener, which does not debounce.
  const [r1, r2] = await page.evaluate(() => Promise.all([
    window.__CTX__.get('travel').go('pokecenter'),
    window.__CTX__.get('travel').go('pokecenter'),
  ]));
  expect([r1, r2].filter(Boolean), 'exactly one of the two racing calls wins').toHaveLength(1);
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');
  expect(await call(page, 'travel', 'busy'), 'not left wedged mid-transition').toBe(false);

  // Not wedged for the rest of the session: an ordinary hop still works right after.
  await goTo(page, 'demo-city');
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');

  // And the opposite race — a hunt racing the Center — only ever builds one of them.
  const [r3, r4] = await page.evaluate(() => Promise.all([
    window.__CTX__.get('travel').go('pokecenter'),
    window.__CTX__.get('travel').go('hunt-meadow'),
  ]));
  expect([r3, r4].filter(Boolean)).toHaveLength(1);
  expect(await call(page, 'travel', 'busy')).toBe(false);
  const here = (await call(page, 'travel', 'current'))?.id;
  expect(['pokecenter', 'hunt-meadow']).toContain(here);
  expect(r3).toBe(here === 'pokecenter');
  expect(r4).toBe(here === 'hunt-meadow');

  expect(errors).toEqual([]);
});

test('a save whose last scene was the Pokemon Center survives a real reload', async ({ page }) => {
  await installEventLog(page);
  expect(await boot(page)).toEqual([]);

  await goTo(page, 'pokecenter');
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');

  await call(page, 'offline', 'persist', 'flow-test');
  const keys = await prop(page, 'offline', 'keys');
  const raw = await page.evaluate((k) => localStorage.getItem(k), keys.save);
  expect(raw, 'a save was written').toBeTruthy();
  const doc = JSON.parse(raw);
  expect(doc.slices?.travel?.sceneId, 'the hidden destination is a legal save value').toBe('pokecenter');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 45_000, polling: 100 });
  expect(await page.evaluate(() => window.__FATAL__ ?? null)).toBeNull();

  // `travel.boot()` must not have bounced the saved scene to the lobby: `hidden` is a
  // panel-only flag and must not read as `locked` (the "saved scene no longer enterable"
  // guard travel/selftest.js #26 exercises for a real gate, not this panel-only one).
  expect((await call(page, 'travel', 'current'))?.id, 'reboots straight back into the Center').toBe('pokecenter');
  const handle = await call(page, 'terrain', 'handle');
  expect(handle?.id).toBe('pokecenter');
  expect(handle?.biome).toBe('city');
});

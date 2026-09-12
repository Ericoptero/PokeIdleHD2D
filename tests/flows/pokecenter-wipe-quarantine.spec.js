/**
 * `travel`'s `party:wiped` listener has two destinations, in order: `go('pokecenter')`, and —
 * only if that returns `false` — the old marker-teleport onto the city's own `pokecenter-door`
 * pavement marker (`src/travel/index.js`). Every other test of the wipe path
 * (`tests/flows/hunt-recovers.spec.js`) exercises the success branch only. `?break=pokecenter`
 * is the one quarantine that forces the failure branch for real (`go('pokecenter')` fails
 * because `pokecenter` never registered a `travel` destination at all — confirmed by reading
 * `travel/index.js`'s `destinations()`, which only pushes the row when `isLive(pokecenterApi())`
 * — not because the destination exists and refuses), this exercises the fallback when the destination is unavailable.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, events, stepUntil, call,
} from './harness.js';

const mark = (page) => page.evaluate(() => window.__EVLOG__.length);
const conscious = (page) => page.evaluate(() =>
  !!window.__CTX__.get('pokemon').firstConscious());

async function goTo(page, sceneId) {
  await call(page, 'travel', 'go', sceneId);
  await page.waitForFunction((id) => window.__CTX__.get('travel').current()?.id === id,
    sceneId, { timeout: 30_000, polling: 100 });
}

/** Empties the party in the window after `writeBack` and before `resolve()`, so `wipe()` runs. */
async function forceWipe(page) {
  const before = await mark(page);
  await stepUntil(page, 'battle:ended', { chunk: 5, maxTicks: 900, after: before });
  await page.evaluate(() => {
    const pk = window.__CTX__.get('pokemon');
    for (const m of pk.party()) pk.damage(m.instanceId, m.maxHp);
  });
  return stepUntil(page, 'encounter:resolved', { chunk: 5, maxTicks: 300, after: before });
}

test('?break=pokecenter: a hunt wipe falls back to the city pavement instead of stranding the party', async ({ page }) => {
  // Every console message, not only errors: the one signal that proves `travel`'s
  // `party:wiped` listener actually TRIED `go('pokecenter')` (and got refused) rather than
  // jumping straight to the old fallback the way the previous listener always did — the two
  // are otherwise indistinguishable from the outside, since the previous code landed in
  // exactly the same place on the pavement unconditionally. `travel/index.js`'s `find()` logs
  // exactly `travel: no destination "pokecenter"` on a failed `go()`; this line does not exist
  // in any code path the previous listener could reach.
  const consoleText = [];
  page.on('console', (m) => consoleText.push(m.text()));

  await installEventLog(page);
  const errors = await boot(page, { break: 'pokecenter' });
  expect(errors, 'a deliberate quarantine logs warn, never error, even before the wipe').toEqual([]);

  // The room really is gone: no destination, no door.
  const dests = await call(page, 'travel', 'destinations');
  expect(dests.map((d) => d.id)).not.toContain('pokecenter');

  await goTo(page, 'hunt-meadow');
  const before = await mark(page);
  await forceWipe(page);
  const since = (await events(page)).filter((e) => e.at >= before);
  expect(since.some((e) => e.type === 'party:wiped'), 'the wipe still fires party:wiped').toBe(true);
  expect(await conscious(page), 'encounter.wipe()\'s own reviveAll() still runs — the room being down never blocks it').toBe(true);

  // `travel`'s listener's own `go('pokecenter')` must have failed (returned false, not thrown)
  // and fallen through to the marker-teleport branch: back at `demo-city`, on or beside the
  // `pokecenter-door` marker, facing north (dir 2) into where the door would be.
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'demo-city',
    null, { timeout: 15_000, polling: 100 });
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');

  const marker = await call(page, 'city', 'marker', 'pokecenter-door');
  expect(marker, 'the city draft still mints its own door marker with pokecenter quarantined').not.toBeNull();
  const player = await call(page, 'simulation', 'player');
  expect(player.cx, 'the fallback teleport lands exactly on the door marker cx').toBe(marker.cx);
  expect(player.cz, 'the fallback teleport lands exactly on the door marker cz').toBe(marker.cz);
  expect(player.dir, 'the fallback teleport faces north (2), toward the (quarantined) door').toBe(2);

  // The distinguishing signal: `go('pokecenter')` was really attempted and really refused —
  // this is the line the previous `party:wiped` listener could never produce, because it
  // never called `go('pokecenter')` at all.
  expect(consoleText.some((t) => t.includes('no destination "pokecenter"')),
    `expected a "no destination \\"pokecenter\\"" warning proving go('pokecenter') was tried and refused; console seen: ${JSON.stringify(consoleText.slice(-40))}`)
    .toBe(true);

  expect(errors, 'no console error falling back to the pavement with the Center quarantined').toEqual([]);
});

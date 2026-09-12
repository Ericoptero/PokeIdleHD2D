/**
 * The Pokemon Center's door, both ways: walking onto the city's `door:pokecenter` tile warps
 * into the room, and walking onto the room's own exit tile warps back out onto the pavement.
 * Healing is handled separately by the cure to Nurse Joy at the counter
 * (`tests/flows/hunt-recovers.spec.js` exercises the cure itself) and deleted `city.enter()`'s
 * free lobby heal, so walking the door alone still changes nothing about the party's HP.
 *
 * Movement goes through a real `KeyboardEvent` (`__HOOKS__.key`, `ui/input.js`), which only
 * reaches `simulation.moveIntent` from the render loop's own per-frame tick
 * (`ui/index.js`'s `frame()` → `input.frame()`) — `__HOOKS__.step()` drives `registry.tick`
 * directly and never touches it. `boot()` leaves the render loop paused (`harness.js`), so
 * this file resumes it around each walk and pauses nothing after: the door listener
 * (`src/pokecenter/index.js`) fires from `simulation`'s own tick regardless.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, events, key, call } from './harness.js';

/** The raw event count, so a wait started here only ever sees events after it. */
const mark = (page) => page.evaluate(() => window.__EVLOG__.length);

/**
 * Holds `code` down, resumes the frame loop, and polls real wall-clock time for an event of
 * `type` logged after `after` — bounded, and failing with the log rather than a bare timeout
 * message. `config.walkSecondsPerTile` is 0.25s (`core/config.js`); `maxMs` gives that many
 * multiples of headroom for a headless page's own throttling.
 */
async function walkOnto(page, code, type, { after, maxMs = 15_000, pollMs = 100 } = {}) {
  await page.evaluate(() => window.__HOOKS__.resume());
  await key(page, code, true);
  const t0 = Date.now();
  try {
    for (;;) {
      const log = await events(page);
      const hit = log.find((e) => e.type === type && e.at >= after);
      if (hit) return hit;
      if (Date.now() - t0 > maxMs) {
        const seen = [...new Set(log.filter((e) => e.at >= after).map((e) => e.type))].join(', ');
        expect(null, `no ${type} within ${maxMs}ms of walking ${code}; events since: ${seen || '(none)'}`)
          .not.toBeNull();
      }
      await page.waitForTimeout(pollMs);
    }
  } finally {
    await key(page, code, false);
  }
}

test('walking through the door enters the Pokemon Center, and its own door leaves it', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  // The marker sits one cell south of the door itself (`city/map.js`), and carries the
  // door's own cell as `.cell` — read while `city`'s own map is still the live draft, since
  // `city.marker()` answers off whatever map `terrain` currently holds.
  const marker = await call(page, 'city', 'marker', 'pokecenter-door');
  expect(marker, 'the city draft mints a pokecenter-door marker').not.toBeNull();

  await call(page, 'simulation', 'teleport', marker.cx, marker.cz, 2); // NORTH, facing the door
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');

  const before = await mark(page);
  await walkOnto(page, 'KeyW', 'scene:entered', { after: before });
  const entered = (await events(page)).filter((e) => e.type === 'scene:entered' && e.at >= before);
  expect(entered).toHaveLength(1);
  expect(entered[0].payload.sceneId).toBe('pokecenter');
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');

  // Spawn faces the counter (north); the room's own door is one cell south of it.
  const at = await mark(page);
  await walkOnto(page, 'KeyS', 'scene:entered', { after: at });
  const back = (await events(page)).filter((e) => e.type === 'scene:entered' && e.at >= at);
  expect(back).toHaveLength(1);
  expect(back[0].payload.sceneId).toBe('demo-city');
  expect((await call(page, 'travel', 'current'))?.id).toBe('demo-city');

  // Landed on the marker cell itself or immediately next to it.
  const player = await call(page, 'simulation', 'player');
  const dx = Math.abs(player.cx - marker.cx), dz = Math.abs(player.cz - marker.cz);
  expect(dx <= 1 && dz <= 1 && (dx + dz) <= 1, `player at ${player.cx},${player.cz} vs marker ${marker.cx},${marker.cz}`)
    .toBe(true);

  await page.evaluate(() => window.__HOOKS__.pause());
  expect(errors, 'no console error walking the door both ways').toEqual([]);
});

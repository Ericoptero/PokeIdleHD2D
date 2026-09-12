/**
 * Nurse Joy is spawned in `pokecenter.enter()` after every `terrain.load()`, and
 * `world:unloaded` resets the module's own `nurseId` to `null` first (`src/pokecenter/index.js`).
 * Nothing in the cure flow tests walks the door twice in a real boot and asks
 * `simulation.npcs()` whether she came back doubled — `index.test.js` calls `enter()` at most
 * once per `makeWorld()`, and the flow specs that do walk the door twice
 * (`tests/flows/pokecenter.spec.js`, `tests/flows/pokecenter-scene.spec.js`) never look at
 * `simulation.npcs()` at all. This does, against the real module chain, across three visits.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, call } from './harness.js';

async function goTo(page, sceneId) {
  const ok = await call(page, 'travel', 'go', sceneId);
  expect(ok, `travel.go('${sceneId}') refused`).toBe(true);
}

const nurses = async (page) => (await call(page, 'simulation', 'npcs'))
  .filter((n) => n.name === 'pokecenter/nurse');

test('re-entering the Pokemon Center never leaves a second Nurse Joy standing at the counter', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);

  await goTo(page, 'pokecenter');
  let cast = await nurses(page);
  expect(cast, `first visit: ${JSON.stringify(cast)}`).toHaveLength(1);
  const firstPos = { cx: cast[0].cx, cz: cast[0].cz };

  await goTo(page, 'demo-city');
  await goTo(page, 'pokecenter');
  cast = await nurses(page);
  expect(cast, `second visit (one round trip later): ${JSON.stringify(cast)}`).toHaveLength(1);
  expect({ cx: cast[0].cx, cz: cast[0].cz }, 'she respawns at the same fixed spot, not drifting').toEqual(firstPos);

  await goTo(page, 'demo-city');
  await goTo(page, 'pokecenter');
  cast = await nurses(page);
  expect(cast, `third visit (two round trips later): ${JSON.stringify(cast)}`).toHaveLength(1);

  // Total npcs at the Center is exactly one — Nurse Joy, and nothing else `simulation` spawned
  // for this room (no wild Pokemon: `biome:'city'` resolves to an empty encounter table).
  const all = await call(page, 'simulation', 'npcs');
  expect(all, `all npcs in the room: ${JSON.stringify(all)}`).toHaveLength(1);

  expect(errors, 'no console error across three visits to the Center').toEqual([]);
});

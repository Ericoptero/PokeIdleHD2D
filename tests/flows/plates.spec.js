/**
 * Nameplates (`src/ui/plates.js`) read the live world at paint time, and the one property
 * worth pinning end to end — because `src/ui/plates.test.js`'s vitest suite proves `draw()`'s
 * geometry with a fake painter and cannot reach `read()`'s `ctx.get` chain at all — is the one
 * DECISIONS #72 already warns a UI can get wrong: HP is written back to a party instance only
 * when a duel *ends*, so a plate reading `pokemon.lead()` mid-fight would show a full bar over
 * a Pokémon about to faint. `panels/battle.js` solved this once already; `plates.js` copies the
 * fix rather than re-deriving it, and this is the flow that keeps them from drifting apart.
 *
 * `window.__HOOKS__.step()` only drives `registry.tick` (the sim), never `registry.frame`/
 * `lateFrame` — so plates, which are gathered and painted at render rate, do not update from
 * stepping alone. `ui`'s `_lateFrame()` is the same seam `_frame`/`_draw` already expose for
 * exactly this reason; calling it directly here is not a workaround, it is the sanctioned way
 * to force one paint without a real animation frame.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events, call, prop } from './harness.js';

/** Forces one plates read+paint and hands back what was gathered. */
const plates = async (page) => {
  await call(page, 'ui', '_lateFrame');
  const state = await prop(page, 'ui', '_state');
  return state?.plates ?? [];
};

test('a plate over the party tracks the live duel, not the stale party record', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  // 1. Before any fight: the lead already carries a plate, at full HP.
  const before = (await plates(page)).find((p) => p.name !== 'Trainer' && p.bar);
  expect(before, 'the lead carries a plate before any encounter').toBeTruthy();
  expect(before.bar.hp).toBe(before.bar.maxHp);

  // 2. Walk to an encounter and let the duel run a few turns, so the ally has taken damage.
  let ticks = 0;
  for (;;) {
    const log = await events(page);
    if (log.some((e) => e.type === 'battle:started')) break;
    expect(ticks, 'no battle:started within 3000 ticks').toBeLessThan(3000);
    await step(page, 20);
    ticks += 20;
  }
  await step(page, 90); // a few turns in

  // 3. The plate's HP must match the live duel state, not the untouched party record.
  const active = await call(page, 'encounter', 'active');
  const liveState = active?.duel?.run?.state;
  expect(liveState, 'a duel is actually running').toBeTruthy();

  const list = await plates(page);
  const lead = list.find((p) => p.name === (active.duel.ally.display ?? active.duel.ally.species));
  expect(lead, 'the fighting ally has a plate').toBeTruthy();
  expect(lead.bar.hp, "the plate's HP is the live duel's, not the party record's").toBe(Math.max(0, liveState.a.hp));
  expect(lead.bar.maxHp).toBe(Math.max(1, liveState.a.maxHp));

  // And the record itself has NOT been written back yet mid-duel (DECISIONS #72) — the whole
  // reason `plates.js` cannot simply read `pokemon.lead()`.
  const stillFighting = await call(page, 'encounter', 'active');
  expect(stillFighting.battle.win, 'the duel has not ended yet').toBeNull();

  // 4. The wild being fought also carries a live plate, at the slot's level — matched by
  // world cell rather than by name, because a *wandering* wild of the same species elsewhere
  // on the map would otherwise be an ambiguous match.
  const scene = await call(page, 'encounter', 'scene');
  const wild = list.find((p) => p.bar && Math.floor(p.x) === scene.at.cx && Math.floor(p.z) === scene.at.cz);
  expect(wild, 'the wild being fought has a plate on its own cell').toBeTruthy();
  expect(wild.level).toBe(active.level);
  expect(wild.bar.hp).toBe(Math.max(0, liveState.b.hp));

  expect(errors, 'no console error while plates read a live duel').toEqual([]);
});


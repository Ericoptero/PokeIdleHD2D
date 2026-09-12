/**
 * A party that runs out of conscious members gets back up, and the hunt keeps producing battles.
 *
 * `hunt.spec.js` covers a healthy party meeting a wild at `?scene=hunt-meadow`. This covers the
 * state that used to be a one-way door: `encounter.slotNear` refuses a party with no conscious
 * member (src/encounter/index.js), so no encounter could start, so no `resolve()` could run, so
 * the only `reviveAll()` in the game — inside `wipe()` — was unreachable. `wipe()` itself opened
 * with a latch above that revive, so the second wipe with no surviving encounter between paid
 * nothing and healed nobody, and the save was silent and battle-free from then on.
 *
 * Three independent ways back out, one case each, plus the route a player actually walks.
 * Everything drives `__HOOKS__` and `__CTX__`; nothing reads a pixel.
 */
import { test, expect } from '@playwright/test';
import {
  installEventLog, boot, events, stepUntil, call, key,
} from './harness.js';

/**
 * The raw log length, which is what `harness.js` stamps each event's `at` from. `events()`
 * filters `perf:sample` out *before* measuring, so its length drifts below `at` by one per
 * wall-clock second — enough, on a slow machine, for an `after:` mark to admit an event from
 * before it and quietly make an assertion vacuous.
 */
const mark = (page) => page.evaluate(() => window.__EVLOG__.length);

/** Sim steps per tile: config.walkSecondsPerTile 0.25 x SIM_HZ 20 (src/core/clock.js). */
const STEPS_PER_TILE = 5;

const partyHp = (page) => page.evaluate(() =>
  window.__CTX__.get('pokemon').party().map((p) => p.hp));
const partyMaxHp = (page) => page.evaluate(() =>
  window.__CTX__.get('pokemon').party().map((p) => p.maxHp));
const conscious = (page) => page.evaluate(() =>
  !!window.__CTX__.get('pokemon').firstConscious());

async function goTo(page, sceneId) {
  await call(page, 'travel', 'go', sceneId);
  await page.waitForFunction((id) => window.__CTX__.get('travel').current()?.id === id,
    sceneId, { timeout: 30_000, polling: 100 });
}

/**
 * Holds `code` down, resumes the frame loop, and polls real wall-clock time for an event of
 * `type` logged after `after` — the same technique `tests/flows/pokecenter.spec.js` proved for
 * walking a real `KeyboardEvent` through `ui/input.js` onto a door tile. Bounded, and failing
 * with the log rather than a bare timeout message.
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

/**
 * Holds `code` down until `simulation.player()` reports `predicate(player)`, then releases.
 * Movement is tile-locked (`ui/input.js`) and the counter blocks further steps, so walking
 * north into it cannot overshoot the row this waits for.
 */
async function walkUntil(page, code, predicate, { maxMs = 15_000, pollMs = 100 } = {}) {
  await page.evaluate(() => window.__HOOKS__.resume());
  await key(page, code, true);
  const t0 = Date.now();
  try {
    for (;;) {
      const player = await call(page, 'simulation', 'player');
      if (predicate(player)) return player;
      if (Date.now() - t0 > maxMs) {
        expect(null, `walking ${code} never reached the target cell; last at ${JSON.stringify(player)}`)
          .not.toBeNull();
      }
      await page.waitForTimeout(pollMs);
    }
  } finally {
    await key(page, code, false);
  }
}

/** One full lap plus the two-step detour and a margin — 17 s of real play in the meadow. */
async function lapBound(page) {
  const lap = (await call(page, 'hunts', 'loop'))?.length ?? 0;
  expect(lap, 'the biome was given a circuit to walk').toBeGreaterThan(0);
  return lap * STEPS_PER_TILE + 60;
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

test('a wiped party is revived every time, not only the first', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await goTo(page, 'hunt-meadow');

  for (const nth of ['first', 'second']) {
    if ((await call(page, 'travel', 'current'))?.id !== 'hunt-meadow') await goTo(page, 'hunt-meadow');
    const at = await mark(page);
    const money = await call(page, 'economy', 'balance', 'money');
    await forceWipe(page);

    const since = (await events(page)).filter((e) => e.at >= at);
    expect(since.some((e) => e.type === 'party:wiped'), `the ${nth} wipe emits party:wiped`).toBe(true);
    expect(await conscious(page), `the ${nth} wipe revives the party`).toBe(true);
    expect(await call(page, 'economy', 'balance', 'money'),
      `the ${nth} wipe charges the toll`).toBeLessThan(money);
  }
  expect(errors, 'no console error while wiping twice').toEqual([]);
});

test('a lap of the circuit brings a fainted party back and the hunt resumes', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await goTo(page, 'hunt-meadow');
  const bound = await lapBound(page);

  await page.evaluate(() => {
    const pk = window.__CTX__.get('pokemon');
    for (const m of pk.party()) pk.damage(m.instanceId, m.maxHp);
  });
  expect(await conscious(page), 'the party starts this case with nothing to fight with').toBe(false);

  const at = await mark(page);
  const lap = await stepUntil(page, 'hunt:lap', { chunk: 10, maxTicks: bound, after: at });
  expect(await conscious(page), 'a lap is a rest a fainted party can reach').toBe(true);
  expect((await partyHp(page)).some((h) => h > 0)).toBe(true);

  const met = await stepUntil(page, 'encounter:started', { chunk: 10, maxTicks: bound, after: lap.hit.at });
  expect(met.hit.payload.biome).toBe('meadow');
  expect(errors, 'no console error while recovering on the circuit').toEqual([]);
});

test('the city no longer heals — Nurse Joy does, once you walk in and face the counter', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await goTo(page, 'hunt-meadow');

  // `travel.go` calls `encounter.cancel()`, which resolves nothing — this is the route that
  // writes an unconscious party to the save (STATUS travel-mid-encounter-silent).
  await stepUntil(page, 'battle:started', { chunk: 10, maxTicks: await lapBound(page) });
  await page.evaluate(() => {
    const pk = window.__CTX__.get('pokemon');
    for (const m of pk.party()) pk.damage(m.instanceId, m.maxHp);
  });
  await goTo(page, 'demo-city');
  // Inverted from slice 013: `city.enter()`'s free lobby heal is gone (DECISIONS #83, revising
  // #81's third net) — a fainted party arriving in the lobby is still fainted.
  expect(await conscious(page), 'arriving in the city no longer heals the party').toBe(false);

  // `encounter.cancel()` (called from inside `travel.go()`) resolves nothing, so `ui`'s battle
  // card — opened on the meadow's `encounter:started` and never told the fight is over — is
  // still open here (STATUS `travel-mid-encounter-silent`; confirmed live: `ui.openPanel()`
  // reads `'battle'` at this point). `Escape`/`X` closes ANY open panel that does not consume
  // the key itself (`ui/input.js`'s panel branch) — the same key a player already has for this,
  // out of scope for this slice to change (the *prompt* itself is untouched).
  expect(await call(page, 'ui', 'openPanel'), 'the stale battle card is still up').toBe('battle');
  await key(page, 'Escape');
  await key(page, 'Escape', false);
  expect(await call(page, 'ui', 'openPanel')).toBeNull();

  // Walk to the Center's door, in, up to the counter, and press Z.
  const marker = await call(page, 'city', 'marker', 'pokecenter-door');
  expect(marker, 'the city draft mints a pokecenter-door marker').not.toBeNull();
  await call(page, 'simulation', 'teleport', marker.cx, marker.cz, 2); // NORTH, facing the door

  const before = await mark(page);
  await walkOnto(page, 'KeyW', 'scene:entered', { after: before });
  const entered = (await events(page)).filter((e) => e.type === 'scene:entered' && e.at >= before);
  expect(entered.at(-1)?.payload.sceneId).toBe('pokecenter');
  expect((await call(page, 'travel', 'current'))?.id).toBe('pokecenter');
  expect(await conscious(page), 'walking in the door does not itself heal').toBe(false);

  // Spawn already faces the counter (north, `layout.js SPAWN.dir`); walk up next to it —
  // the counter blocks further steps, so holding north cannot overshoot the row.
  const atCounter = await walkUntil(page, 'KeyW', (p) => p.cz <= 3);
  expect(atCounter.cz).toBe(3);
  expect(atCounter.dir).toBe(2); // still facing north, into the counter

  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  // Back to deterministic ticking (`stepUntil` below drives `registry.tick` directly through
  // `__HOOKS__.step()`; leaving the real render loop running would double-advance sim time).
  await page.evaluate(() => window.__HOOKS__.pause());

  expect(await conscious(page), 'Nurse Joy revives the party').toBe(true);
  expect(await partyHp(page)).toEqual(await partyMaxHp(page));

  // And the hunt it goes back to still produces a fight. (What the *save* holds after a reload is
  // save.spec.js's job; persisting here only proves the write does not throw on a healed party.)
  await call(page, 'offline', 'persist', 'flow');
  await goTo(page, 'hunt-meadow');
  const met = await stepUntil(page, 'encounter:started', { chunk: 10, maxTicks: await lapBound(page) });
  expect(met.hit.payload.species).toEqual(expect.any(String));
  expect(errors, 'no console error on the city + Pokemon Center round trip').toEqual([]);
});

test('a wipe lands the player inside the Pokemon Center, already healed, with no cooldown armed', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  await goTo(page, 'hunt-meadow');

  const before = await mark(page);
  await forceWipe(page);
  const since = (await events(page)).filter((e) => e.at >= before);
  expect(since.some((e) => e.type === 'party:wiped'), 'the wipe emits party:wiped').toBe(true);

  // `travel`'s `party:wiped` listener hops to `pokecenter` a microtask later — wait for it
  // rather than asserting on the very next tick.
  await page.waitForFunction(() => window.__CTX__.get('travel').current()?.id === 'pokecenter',
    null, { timeout: 15_000, polling: 100 });
  const scene = since.find((e) => e.type === 'scene:entered' && e.payload.sceneId === 'pokecenter')
    ?? (await events(page)).find((e) => e.type === 'scene:entered' && e.payload.sceneId === 'pokecenter');
  expect(scene, 'a scene:entered names the Pokemon Center as the wipe destination').toBeTruthy();
  expect(await conscious(page), 'encounter.wipe()\'s own reviveAll() already cured the party').toBe(true);

  // The wipe never arms the cooldown — read directly off `pokecenter`'s own save slice rather
  // than inferring it from HP (the party is already full by construction here, so a no-op and
  // a real cure would look identical on HP alone).
  expect((await call(page, 'pokecenter', 'saveState')).lastHealMs,
    'a wipe never stamps lastHealMs').toBeNull();

  // Pressing Z at the counter right after arriving must still succeed — proving "unconditional
  // once off cooldown" (it heals a party that is, by construction, already full) rather than a
  // no-op the party's own full HP would otherwise make indistinguishable from a refusal.
  const atCounter = await walkUntil(page, 'KeyW', (p) => p.cz <= 3);
  expect(atCounter.cz).toBe(3);
  await key(page, 'KeyZ');
  await key(page, 'KeyZ', false);
  await page.evaluate(() => window.__HOOKS__.pause());
  expect(await conscious(page)).toBe(true);
  expect(await partyHp(page)).toEqual(await partyMaxHp(page));
  expect((await call(page, 'pokecenter', 'saveState')).lastHealMs,
    'the manual cure DID run — it stamped the cooldown this time').not.toBeNull();

  expect(errors, 'no console error wiping into the Pokemon Center').toEqual([]);
});

test('a hunt entered the way a player enters it produces a battle', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page);
  expect((await call(page, 'travel', 'current'))?.id, 'a fresh boot lands in the lobby').toBe('demo-city');

  await goTo(page, 'hunt-meadow');
  const slots = await call(page, 'hunts', 'slots');
  expect(slots.filter((s) => s.occupied).length, 'the grass has huntable creatures in it')
    .toBeGreaterThan(0);

  const met = await stepUntil(page, 'encounter:started', { chunk: 10, maxTicks: await lapBound(page) });
  test.info().annotations.push({ type: 'path', description:
    `city -> travel -> meadow: ${met.hit.payload.species} L${met.hit.payload.level} after ${met.ticks} ticks` });
  expect(errors, 'no console error walking from the city into a fight').toEqual([]);
});

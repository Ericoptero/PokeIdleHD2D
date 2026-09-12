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
import { installEventLog, boot, events, stepUntil, call } from './harness.js';

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
const conscious = (page) => page.evaluate(() =>
  !!window.__CTX__.get('pokemon').firstConscious());

async function goTo(page, sceneId) {
  await call(page, 'travel', 'go', sceneId);
  await page.waitForFunction((id) => window.__CTX__.get('travel').current()?.id === id,
    sceneId, { timeout: 30_000, polling: 100 });
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

test('the city heals, so a party fainted outside a resolve is never stranded', async ({ page }) => {
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
  expect(await conscious(page), 'arriving in the city heals the party').toBe(true);

  // And the hunt it goes back to still produces a fight. (What the *save* holds after a reload is
  // save.spec.js's job; persisting here only proves the write does not throw on a healed party.)
  await call(page, 'offline', 'persist', 'flow');
  await goTo(page, 'hunt-meadow');
  const met = await stepUntil(page, 'encounter:started', { chunk: 10, maxTicks: await lapBound(page) });
  expect(met.hit.payload.species).toEqual(expect.any(String));
  expect(errors, 'no console error on the city round trip').toEqual([]);
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

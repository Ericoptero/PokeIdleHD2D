/**
 * The Tibia-style meeting: the creature that fights is the same body that was
 * walking the map, at the level its plate was advertising, on the cell it is actually standing
 * on — not the slot's authored anchor, which a tether lets it drift a tile away from — and
 * nothing announces its arrival, because it did not arrive.
 *
 * Everything here is read off the bus and off the live module APIs; nothing reads a pixel.
 *
 * **Why the position check reads `simulation.npcs()`, and not `hunts.slots()`.**
 * `hunts.slots()`'s `cx,cz` is the slot's *authored* anchor (`compose.slotsForLoop`'s output) —
 * it never moves, occupied or not, because it names a place on the map rather than a creature.
 * The property this file has to prove is that the fight lands on the creature's **current**
 * cell, which can differ from that anchor by the tether's radius (`hunts/index.js`,
 * `tether: { radius: 1 }`) — so the ground truth for "where it actually was" has to come from
 * `simulation.npcs()`, sampled for the slot's own `npcId` while it is still walking. Comparing
 * against the anchor instead would pass identically whether `encounter` used the live cell or
 * reverted to teleporting onto the anchor, which breaks actor continuity
 * — so this file also asserts, across the encounters it watches, that at least one of them
 * actually drifted off its anchor, or the live-position check above would be proving nothing.
 *
 * The sample is not racy: `hunts`' own `player:enteredTile` listener holds the target
 * (`sim.holdNpc(id, true)`) the instant the party commits to the two-step detour that reaches
 * it, before the walk there even starts, so its cell cannot change between any tick sampled
 * from that commit onward and the moment `engage()` reads it.
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events, key, call } from './harness.js';

/** Small chunks: the properties are about the tick an encounter starts on, not about the lap. */
const CHUNK = 4;
const MAX_TICKS = 3000;
/** How many encounters to watch. Two is enough to make the anti-anchor check non-vacuous
 *  (this seed's first hunt-meadow slots drift within the first two, confirmed empirically) and
 *  small enough that the flow stays fast. */
const WATCH = 2;

/**
 * Walks to the next `encounter:started`, sampling the live world just before it.
 *
 * `battleStarted` is resolved **here**, bound below by the same `after` as `encounter:started`
 * — a search with no lower bound would, on the second watched encounter, still be sitting on
 * the *first* one's `battle:started` (chronologically earlier, and `Array.find` returns the
 * first match), a bug this file caught in its own first draft.
 */
async function nextEncounter(page, after, budget) {
  /** @type {{k:number, species:string, level:number, npcId:number, anchor:{cx:number,cz:number}, live:{cx:number,cz:number}}[]} */
  let before = [];
  let ticks = 0;
  for (;;) {
    const slots = await call(page, 'hunts', 'slots');
    const npcs = await call(page, 'simulation', 'npcs');
    const log = await events(page);
    const started = log.find((e) => e.type === 'encounter:started' && e.at >= after);
    if (started) {
      const battleStarted = log.find((e) => e.type === 'battle:started' && e.at >= after && e.at <= started.at);
      return { started, battleStarted, before, log };
    }
    before = slots.filter((s2) => s2.occupied).map((s2) => ({
      k: s2.k, species: s2.species, level: s2.level, npcId: s2.npcId,
      anchor: { cx: s2.cx, cz: s2.cz },
      live: npcs.find((n) => n.id === s2.npcId) ?? null,
    }));
    expect(ticks, `no encounter:started within ${budget} ticks`).toBeLessThan(budget);
    await step(page, CHUNK);
    ticks += CHUNK;
  }
}

/** Plays a started encounter out to `encounter:resolved`, throwing on a win like a player would. */
async function resolveEncounter(page, started) {
  const ended = await (async () => {
    let ticks = 0;
    for (;;) {
      const log = await events(page);
      const hit = log.find((e) => e.type === 'battle:ended' && e.at >= started.at);
      if (hit) return hit;
      expect(ticks, 'no battle:ended within 2400 ticks').toBeLessThan(2400);
      await step(page, 12);
      ticks += 12;
    }
  })();
  if (ended.payload.won) {
    await step(page, 4);
    await key(page, 'KeyZ');
  }
  let ticks = 0;
  for (;;) {
    const log = await events(page);
    const hit = log.find((e) => e.type === 'encounter:resolved' && e.at >= ended.at);
    if (hit) return hit;
    expect(ticks, 'no encounter:resolved within 2400 ticks').toBeLessThan(2400);
    await step(page, 12);
    ticks += 12;
  }
}

test('the wild fights on the cell it was actually standing on, at the level it was wearing', async ({ page }) => {
  await installEventLog(page);
  const errors = await boot(page, { scene: 'hunt-meadow' });
  expect(errors).toEqual([]);

  const seen = [];
  let after = 0;
  let budget = MAX_TICKS;
  for (let n = 0; n < WATCH; n++) {
    const { started, battleStarted, before } = await nextEncounter(page, after, budget);
    const k = started.payload.slot;
    expect(typeof k, 'the encounter came from a slot').toBe('number');
    const was = before.find((s2) => s2.k === k);
    expect(was, `slot ${k} was occupied in the tick before the encounter`).toBeTruthy();
    expect(was.live, `slot ${k}'s npc was resolvable in simulation.npcs()`).toBeTruthy();
    expect(was.level, 'a wandering wild carries a level').toEqual(expect.any(Number));

    // 1. The level is the creature's, not a fresh roll at the moment of contact.
    expect(battleStarted, 'battle:started precedes encounter:started, for this encounter').toBeTruthy();
    expect(started.payload.level, 'the fight is at the level the slot advertised').toBe(was.level);
    expect(battleStarted.payload.level).toBe(was.level);
    expect(started.payload.species, 'and it is the species that was standing there').toBe(was.species);

    // 2. The fight is on the creature's live cell — not a teleport to the slot's anchor.
    const scene = await call(page, 'encounter', 'scene');
    expect(scene, 'a scene is live').toBeTruthy();
    const at = { cx: scene.at.cx, cz: scene.at.cz };
    expect(at, 'the wild fights where it was actually standing').toEqual({ cx: was.live.cx, cz: was.live.cz });

    seen.push({ k, species: was.species, level: was.level, at, anchor: was.anchor });

    const resolved = await resolveEncounter(page, started);
    after = resolved.at;
    budget = MAX_TICKS; // fresh budget for the next lap of the circuit
  }

  // 3. Not a vacuous check: at least one watched encounter actually drifted off the slot's
  // authored anchor, or step 2 above would pass identically whether `encounter` used the live
  // cell or reverted to teleporting onto the anchor.
  const drifted = seen.filter((s2) => s2.at.cx !== s2.anchor.cx || s2.at.cz !== s2.anchor.cz);
  expect(drifted.length, `at least one of ${seen.length} watched encounters drifted off its slot's anchor — ${JSON.stringify(seen)}`).toBeGreaterThan(0);

  // 4. Nobody announced an arrival, across the whole watch.
  const allEvents = await events(page);
  const toasts = allEvents.filter((e) => e.type === 'ui:toast').map((e) => String(e.payload?.text ?? ''));
  expect(toasts.filter((t) => /appeared/i.test(t)), 'no "a wild X appeared" banner').toEqual([]);

  test.info().annotations.push({ type: 'path', description: `watched: ${JSON.stringify(seen)}` });
  expect(errors, 'no console error during the meeting').toEqual([]);
});

/**
 * Regression coverage for the hunt-loop movement rework (`src/hunts/index.js`'s `huntPilot` /
 * `patrolStep` / `approachStep`, driven by `hunts/patrol.js`'s `makePatrol`/`chooseTarget`):
 * a party re-plans a fresh `aStar` step toward a sparse waypoint (`WAYPOINT_STRIDE = 7` cells
 * apart) every tick, rather than walking a fixed pre-rotated route string or every literal
 * ring cell. `hunt.spec.js` proves ONE encounter resolves cleanly at `hunt-meadow`; this proves
 * the walk itself stays healthy — lapping, exploring, and producing encounters at a normal
 * rate, with detours that always let go — over a long unattended stretch, for all four biomes,
 * against the REAL shipped tileset (not the stub tileset `src/hunts/selftest.js` builds
 * against).
 *
 * **Why this is no longer "% of enteredTile landed on hunts.loop().cells".** That measure was
 * a health signal for the OLD scripted route, which only ever advanced one ring cell at a
 * time. The new pilot re-plans toward a waypoint every `WAYPOINT_STRIDE` cells and takes
 * whatever `aStar` step actually closes that distance — a perfectly healthy walk legitimately
 * spends real time on cells that are not literal `loop.cells` members (the ring is one cell
 * wide; `aStar` over open ground beside it is not obligated to hug it), so the old percentage
 * would flag a healthy run as unhealthy. What still matters, and what this file measures
 * instead: the party keeps lapping (`hunt:lap`), keeps exploring (distinct cells visited, since
 * there is no exposed waypoint index to read directly — `hunts`' public API has no such field,
 * confirmed by reading `src/hunts/index.js` in full), keeps meeting wildlife
 * (`encounter:started`), and — the specific regression this rework's own `huntState` doc
 * names — never falls into the old `triedThisLap`-blacklist failure mode of repeatedly
 * ping-ponging into the same small neighbourhood (measured directly at 216 detours in 2000
 * ticks before the fix, per `src/hunts/index.js`'s `huntState` comment).
 *
 * Driven the same tick-stepping way `tests/flows/hunt-recovers.spec.js`'s `lapBound` pattern
 * drives its own long unattended walk: `window.__HOOKS__.step()` through a manual chunked loop,
 * never real wall-clock time. `?seed=1337&timeFrozen=1` (harness.js's `boot()` default) is the
 * deterministic map every biome's `loop.via` was measured against (per the sibling biome
 * reports).
 */
import { test, expect } from '@playwright/test';
import { installEventLog, boot, step, events, call } from './harness.js';

const BIOMES = ['forest', 'meadow', 'cave', 'coast'];

/** "a few thousand sim ticks", per the task — enough for several full laps of the shortest
 *  loop (cave, ~22 cells, a lap every ~110 ticks at 5 sim ticks/tile —
 *  config.walkSecondsPerTile 0.25 x SIM_HZ 20, src/core/clock.js, matching
 *  hunt-recovers.spec.js's own STEPS_PER_TILE) and the longest (meadow, ~102 cells, a lap every
 *  ~510 ticks) alike, with room for encounters and their fights along the way. */
const TOTAL_TICKS = 9000;
/**
 * Small on purpose: this doubles as how often the party's consciousness is checked (below), not
 * just the step granularity. A starting level-5 party can and does lose a fight outright on a
 * fixed seed — measured directly, `hunt-meadow` at seed 1337 wipes after its 3rd encounter with
 * no intervention, and `encounter`'s own wipe() (already covered end to end by
 * hunt-recovers.spec.js) immediately travels the party to `pokecenter`, which would silently
 * truncate the walk this test is trying to measure onto an unrelated scene. A large chunk here
 * checks too rarely to catch that before `resolve()` has already fired the travel, so this stays
 * tick-sized rather than lap-sized.
 */
const CHUNK = 10;

/**
 * A sliding window over consecutive `player:enteredTile` cells, sized to the footprint the task
 * that removed `triedThisLap` names (~50 consecutive landings, ~12-cell neighbourhood): for
 * every window of this many consecutive landings, the metric below is the count of the single
 * most-repeated cell inside it. `hunts/patrol.js`'s `standTiles` gives a spawn at most 4 stand
 * tiles, and an ordinary APPROACH-then-RETURN round trip crosses a handful of DISTINCT cells on
 * the way there and the way back — so a healthy walk repeats any one cell only a small, bounded
 * number of times inside 50 consecutive landings. A ping-ponging approach/return cycle that
 * never lets go (the deleted blacklist's own failure mode, replaced by the `huntState` gate
 * documented on `src/hunts/index.js`'s own `huntState` declaration) instead hammers the same
 * one or two cells over and over within exactly this kind of window.
 */
const REPEAT_WINDOW = 50;

/** The worst (largest) same-cell repeat count seen in any `REPEAT_WINDOW`-sized sliding window
 *  of consecutive `player:enteredTile` landings — see `REPEAT_WINDOW`'s own comment. */
function maxCellRepeatInWindow(entered, windowSize) {
  let worst = 0;
  for (let i = 0; i + windowSize <= entered.length; i++) {
    const counts = new Map();
    for (let j = i; j < i + windowSize; j++) {
      const key = `${entered[j].payload.cx},${entered[j].payload.cz}`;
      const c = (counts.get(key) ?? 0) + 1;
      counts.set(key, c);
      if (c > worst) worst = c;
    }
  }
  return worst;
}

for (const biome of BIOMES) {
  test(`hunt-${biome}: stays healthy, laps, and keeps producing encounters`, async ({ page }) => {
    // The old scripted-route `walk:stalled` console warning (src/simulation/index.js's
    // `onRouteStall`) is emitted ONLY by `makeScriptedRoute`/`setRoute` — confirmed by reading
    // `src/simulation/route.js`'s `makePilotRoute` in full, which never calls `onStall` and
    // never emits it. `hunts.enter()` installs its pilot exclusively via `sim.setPilot()`
    // (never `setRoute`/a scripted route string), so that event is not expected to fire at all
    // on a hunt scene any more. What the new pilot warns about instead is its OWN stall —
    // `patrolStep`'s "found no reachable waypoint in a full pass of its circuit" — which this
    // listener tracks in its place.
    const stalledWarnings = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' && /found no reachable waypoint/i.test(m.text())) stalledWarnings.push(m.text());
    });

    await installEventLog(page);
    const errors = await boot(page, { scene: `hunt-${biome}` });
    expect(errors, `${biome}: no console error during boot`).toEqual([]);

    const entry = (await events(page)).find((e) => e.type === 'scene:entered');
    expect(entry?.payload.sceneId, `${biome}: booted straight into its own hunt scene`).toBe(`hunt-${biome}`);
    const start = entry.at;

    // A long unattended walk, ticked deterministically rather than waited on in real time —
    // the same technique hunt-recovers.spec.js's lapBound-based tests use for their own
    // multi-lap walks, just run to a fixed tick budget instead of stopping at the first event.
    //
    // Topped up between fights exactly the way hunt-recovers.spec.js's own fixtures reach in
    // and revive the party directly (`pokemon.reviveAll()`) rather than scripting a walk to the
    // Pokemon Center — this test is measuring the walk/loop/encounter machinery, and a party
    // wipe's own travel-to-pokecenter (a different, already-covered mechanism) would otherwise
    // cut a biome's walk short for a reason that has nothing to do with the loop it is on.
    for (let t = 0; t < TOTAL_TICKS; t += CHUNK) {
      const conscious = await call(page, 'pokemon', 'firstConscious');
      if (!conscious) await call(page, 'pokemon', 'reviveAll');
      await step(page, CHUNK);
    }

    const log = (await events(page)).filter((e) => e.at >= start);

    const loop = await call(page, 'hunts', 'loop');
    expect(loop, `${biome}: the biome built a loop`).not.toBeNull();

    const entered = log.filter((e) => e.type === 'player:enteredTile');

    // Distinct-cell coverage: the stand-in health signal for "the waypoint index actually
    // advances" now that there is nothing on `hunts`' public API to read it from directly
    // (confirmed by reading `src/hunts/index.js`'s `api` object in full — `loop()`, `slots()`,
    // `stats()` and the rest expose no patrol index or waypoint list). A party stuck circling a
    // couple of tiles — the exact shape of the ping-pong this file's `maxRepeat` check below
    // targets directly — would show up here too, as a small number of distinct cells relative
    // to a long walk; a party actually advancing along a `WAYPOINT_STRIDE`-spaced circuit racks
    // up many distinct cells over the whole tick budget.
    const distinctCells = new Set(entered.map((e) => `${e.payload.cx},${e.payload.cz}`)).size;

    // THE KEY NEW REGRESSION TEST. See `REPEAT_WINDOW`'s and `maxCellRepeatInWindow`'s own
    // header comments, above, for what this measures and exactly which deleted mechanism
    // (`triedThisLap`) and which measured regression (216 detours in 2000 ticks) it replaces.
    const maxRepeat = maxCellRepeatInWindow(entered, REPEAT_WINDOW);

    const laps = log.filter((e) => e.type === 'hunt:lap');
    const encounters = log.filter((e) => e.type === 'encounter:started');

    // Observed measurement, in the test output regardless of pass/fail — exactly the kind of
    // number the plan document used to diagnose the original wedge-solid bug.
    test.info().annotations.push({
      type: 'measurement',
      description: `${biome}: ${entered.length} enteredTile, ${distinctCells} distinct cells, `
        + `worst same-cell repeat in any ${REPEAT_WINDOW}-landing window: ${maxRepeat}, `
        + `${laps.length} hunt:lap, ${encounters.length} encounter:started, `
        + `${stalledWarnings.length} patrol-stall warning(s), loop.source=${loop.source}, `
        + `loop.length=${loop.length}, ${TOTAL_TICKS} ticks`,
    });

    expect(laps.length, `${biome}: at least one hunt:lap fired over ${TOTAL_TICKS} ticks`)
      .toBeGreaterThanOrEqual(1);

    // A healthy walk keeps covering new ground — a party wedged into a corner or ping-ponging
    // between two cells would never rack up more than a handful of distinct cells no matter how
    // long it ran. `loop.length` is the ring's own cell count (the shortest, cave, is ~22); a
    // healthy walk that actually laps its circuit visits at least that many distinct cells many
    // times over across the whole tick budget, so a floor of half the loop's own length is well
    // below anything a genuinely advancing patrol produces and still catches a walk that is
    // truly stuck in place.
    expect(distinctCells, `${biome}: at least half the loop's own cell count (${loop.length}) `
      + `in distinct cells visited over ${TOTAL_TICKS} ticks (got ${distinctCells})`)
      .toBeGreaterThanOrEqual(Math.ceil(loop.length / 2));

    // Generous headroom over the measured worst case: a real run of all four biomes at this
    // seed measured 3 (forest), 5 (meadow), 11 (cave — its loop is the shortest at 22 cells and
    // carries the densest slot packing of the four, so a 50-landing window legitimately spans
    // several laps' worth of near-simultaneous approach/return round trips) and 4 (coast).
    // MAX_REPEAT is set well above the worst of those (11) rather than tuned to just clear it —
    // a genuine reversion to ping-ponging (the old, deleted `triedThisLap`-blacklist failure
    // mode, measured at 216 detours in 2000 ticks) would hammer the same one or two cells for
    // most of a 50-landing window, nowhere near this generous a ceiling.
    const MAX_REPEAT = 40;
    expect(maxRepeat, `${biome}: no cell repeated more than ${MAX_REPEAT} times in any `
      + `${REPEAT_WINDOW}-landing window over ${TOTAL_TICKS} ticks (worst was ${maxRepeat}) — `
      + 'the party is not ping-ponging in a small neighbourhood').toBeLessThanOrEqual(MAX_REPEAT);

    // An occasional patrol stall-and-recover is not itself a failure — `patrolStep` (src/hunts/
    // index.js) already retries from scratch the very next tick, and `maxRepeat` above is what
    // actually distinguishes "healthy, bounded detours" from "wedged". This only catches a
    // circuit that stalls CONSTANTLY, which would mean something is actually broken rather than
    // an occasional transient block near a dense slot.
    expect(stalledWarnings.length, `${biome}: at most a handful of "found no reachable waypoint" `
      + `warnings over ${TOTAL_TICKS} ticks (got ${stalledWarnings.length}) — occasional is a `
      + 'recoverable, designed occurrence; constant stalling is not').toBeLessThanOrEqual(5);

    expect(encounters.length, `${biome}: at least 5 encounter:started fired over ${TOTAL_TICKS} ticks `
      + `(got ${encounters.length})`).toBeGreaterThanOrEqual(5);

    // Every biome's descriptor declares `loop.via`, and all four have been verified (directly,
    // against this real shipped tileset, not just the stub one src/hunts/selftest.js builds
    // against) to stitch cleanly — so the loop built here is expected to be the authored one. A
    // hard assertion, not a soft one: a via list that silently regresses to the found fallback on
    // a future map/tileset change is exactly the kind of drift `hunts.audit()` is also watching
    // for, and this is the other place that should say so out loud.
    expect(loop.source, `${biome}: hunts.loop().source is "authored" (was "${loop.source}")`)
      .toBe('authored');

    expect(errors, `${biome}: no console error over the whole walk`).toEqual([]);
  });
}

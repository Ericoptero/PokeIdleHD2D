/**
 * Regression coverage for the bug the authored-loop change (this whole multi-stage change)
 * fixed: before it, every hunt biome wedged itself solid within a few dozen tiles of walking
 * and never recovered, so `player:enteredTile` almost never fired off-loop and battles became
 * rare or stopped entirely. `hunt.spec.js` proves ONE encounter resolves cleanly at
 * `hunt-meadow`; this proves the walk itself stays healthy — on the loop, lapping, and
 * producing encounters at a normal rate — over a long unattended stretch, for all four biomes,
 * against the REAL shipped tileset (not the stub tileset `src/hunts/selftest.js` builds
 * against).
 *
 * Driven the same tick-stepping way `tests/flows/hunt-recovers.spec.js`'s `lapBound` pattern
 * drives its own long unattended walk: `window.__HOOKS__.step()` through `stepUntil`/a manual
 * chunked loop, never real wall-clock time. `?seed=1337&timeFrozen=1` (harness.js's `boot()`
 * default) is the deterministic map every biome's `loop.via` was measured against
 * (per the sibling biome reports).
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

for (const biome of BIOMES) {
  test(`hunt-${biome}: stays on its authored loop, laps, and keeps producing encounters`, async ({ page }) => {
    // installEventLog/boot only watch console *errors* — a separate listener here also catches
    // the "route stalled" warning (src/simulation/index.js's `walk:stalled`, log.warn ->
    // console.warn). A stall is NOT itself a failure: `strict` mode is designed to stand still
    // and say so rather than silently drift off its own route (src/simulation/route.js's own
    // "a stall you can see beats a drift you cannot"), and `hunts`' `resyncToLoop()` backstop
    // (src/hunts/index.js) exists precisely to recover from one — measured directly, cave's own
    // loop legitimately hits one around tick 8750 on this seed (a transient block near one of
    // its 8 densely-packed slots) and recovers cleanly every time. What WOULD be a failure is a
    // stall with no recovery, which is exactly what maxOffRun below is watching for.
    const stalledWarnings = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' && /route stalled/i.test(m.text())) stalledWarnings.push(m.text());
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
    const onLoop = new Set(loop.cells.map((c) => `${c.cx},${c.cz}`));

    const entered = log.filter((e) => e.type === 'player:enteredTile');
    const onLoopCount = entered.filter((e) => onLoop.has(`${e.payload.cx},${e.payload.cz}`)).length;
    const pct = entered.length ? onLoopCount / entered.length : 0;

    // The longest unbroken run of consecutive off-loop landings — the direct measure of
    // whether a detour always comes home. A slot sits at Chebyshev exactly 2 off the path
    // (compose.js's slotsForLoop), so a normal aggro round trip is a handful of tiles; the bug
    // this whole change fixed (`detourHome()` discarding the return leg) instead left the party
    // permanently off its own loop after the FIRST encounter, which shows up here as a run that
    // never closes for the rest of the walk — categorically different from a bounded detour.
    let run = 0;
    let maxOffRun = 0;
    for (const e of entered) {
      if (onLoop.has(`${e.payload.cx},${e.payload.cz}`)) { run = 0; } else { run += 1; if (run > maxOffRun) maxOffRun = run; }
    }

    const laps = log.filter((e) => e.type === 'hunt:lap');
    const encounters = log.filter((e) => e.type === 'encounter:started');

    // Observed measurement, in the test output regardless of pass/fail — exactly the kind of
    // number the plan document used to diagnose the original wedge-solid bug.
    test.info().annotations.push({
      type: 'measurement',
      description: `${biome}: ${entered.length} enteredTile (${onLoopCount}/${entered.length} = `
        + `${(pct * 100).toFixed(1)}% on-loop, longest off-loop run ${maxOffRun}), ${laps.length} `
        + `hunt:lap, ${encounters.length} encounter:started, ${stalledWarnings.length} stall(s), `
        + `loop.source=${loop.source}, ${TOTAL_TICKS} ticks`,
    });

    // The floor here is deliberately below what a healthy walk actually measures (76-85% across
    // the four biomes on the shipped map) rather than tuned to just clear it: an AUTHORED loop
    // is often much shorter than the old discovered ones (cave's is 22 cells, down from 56), so
    // the same 9 spawn slots sit proportionally denser along it and legitimate slot-detour time
    // is a bigger share of the walk — that is a property of a tighter, better-authored circuit,
    // not a defect. 60% still sits far above the documented pre-fix baseline (8-44%, with a
    // PERMANENT stall after the first encounter in every biome) and the maxOffRun check below is
    // what actually distinguishes "healthy, bounded detours" from "wedged."
    expect(pct, `${biome}: at least 60% of enteredTile landed on hunts.loop().cells `
      + `(got ${onLoopCount}/${entered.length} = ${(pct * 100).toFixed(1)}%)`).toBeGreaterThanOrEqual(0.6);

    // Generous headroom over the measured worst case (9 tiles) — this is the check that would
    // actually have failed before this change: a wedged party's off-loop run only grows, for the
    // rest of the walk, and would blow past this within the first lap rather than ever resetting.
    expect(maxOffRun, `${biome}: no off-loop run over ${TOTAL_TICKS} ticks exceeded 60 tiles `
      + `(longest was ${maxOffRun}) — the party always found its way back to the loop`)
      .toBeLessThanOrEqual(60);

    expect(laps.length, `${biome}: at least one hunt:lap fired over ${TOTAL_TICKS} ticks`)
      .toBeGreaterThanOrEqual(1);

    // An occasional stall-and-recover is not itself a failure (see the header comment on
    // `stalledWarnings`, above) — `maxOffRun` already proves recovery held every time one fired.
    // This only catches a route that stalls CONSTANTLY, which would mean something is actually
    // broken rather than an occasional transient block near a dense slot.
    expect(stalledWarnings.length, `${biome}: at most a handful of "route stalled" warnings over `
      + `${TOTAL_TICKS} ticks (got ${stalledWarnings.length}) — occasional is a recoverable, `
      + 'designed occurrence; constant stalling is not').toBeLessThanOrEqual(5);

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

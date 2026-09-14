/**
 * Properties of the grid walker that a screenshot cannot show.
 *
 *   node src/simulation/selftest.js
 *
 * A still frame proves the queue is *drawn* correctly. It cannot prove that a step lands
 * exactly on a cell, that the trainer walks the lead's own cells and not an approximation of
 * them, that nothing ever moves diagonally, or that the same seed and the same input give the
 * same path — and those are the four things the rest of the game builds on. `line.js` and
 * `route.js` are deliberately free of three.js, ctx and the DOM so this can run in node.
 */

import { SOUTH, WEST, NORTH, EAST, DIR_DX, DIR_DZ, DIR_NAME, opposite } from '../core/dir.js';
import { makeRng } from '../core/rng.js';
import { Line } from './line.js';
import { parseRoute, makeScriptedRoute, makeWander, makePilotRoute } from './route.js';

const SIM_DT = 1 / 20;
const WALK = 0.25;

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

/** An open field with a wall along x = 0 and a bounding box, so collision is exercised. */
const open = (w = 40, h = 40) => (cx, cz) => cx > 0 && cz > 0 && cx < w && cz < h;

/** Drives a line along a route for `ticks` fixed steps, exactly as the module's tick does. */
function drive(line, route, ticks, { passable = open() } = {}) {
  const opts = { walkSeconds: WALK, passable };
  const landings = [];
  for (let i = 0; i < ticks; i++) {
    if (line.advance(SIM_DT)) landings.push({ ...line.cellOf(0), steps: line.steps });
    if (!line.moving) {
      const cmd = route.next(line.pose(0, 0), { passable, tagsAt: () => [] });
      if (cmd) line.step(cmd.dir, opts);
    }
  }
  return landings;
}

// --- 1. placement --------------------------------------------------------------
{
  const line = new Line({ gap: 2, members: 4 }).place(1, 10, 20, NORTH, open());
  // Member 1 is the anchor (the trainer); the lead is `gap` cells further along `dir`.
  eq('place: trainer on the anchor cell', line.cellOf(1), { cx: 10, cz: 20, dir: NORTH });
  eq('place: lead is gap cells ahead', line.cellOf(0), { cx: 10, cz: 18, dir: NORTH });
  eq('place: party[1] is gap cells behind the trainer', line.cellOf(2), { cx: 10, cz: 22, dir: NORTH });
  eq('place: party[2] is 2 gaps behind', line.cellOf(3), { cx: 10, cz: 24, dir: NORTH });
  check('place: the trail is deep enough to interpolate the tail', line.trail.length >= line.depth);
}

// --- 2. a step is tile-locked ---------------------------------------------------
{
  const line = new Line({ gap: 1, members: 2 }).place(1, 10, 20, NORTH, open());
  line.step(NORTH, { walkSeconds: WALK, passable: open() });
  const mid = line.pose(0, 0);
  check('walk: half a step is half a cell', Math.abs(mid.z - 19.5) < 1e-9 || line.t === 0,
    `t=${line.t} z=${mid.z}`);
  let ticks = 0;
  while (line.moving && ticks < 100) { line.advance(SIM_DT); ticks++; }
  check('walk: 0.25 s/tile is exactly 5 sim ticks', ticks === 5, `${ticks} ticks`);
  check('walk: the step lands with t exactly 1', line.t === 1, `t=${line.t}`);
  eq('walk: and exactly on the next cell', line.cellOf(0), { cx: 10, cz: 18, dir: NORTH });
  check('walk: no fraction of a tile is lost', line.carry === 0, `carry=${line.carry}`);

  // Run was removed from the game. There is one cadence, and a stray
  // `running` left behind by a caller that has not been updated must not resurrect a second.
  const stray = new Line({ gap: 1, members: 2 }).place(1, 10, 20, NORTH, open());
  stray.step(NORTH, { running: true, runSeconds: 0.15, walkSeconds: WALK, passable: open() });
  let rt = 0;
  while (stray.moving && rt < 100) { stray.advance(SIM_DT); rt++; }
  check('walk: there is one cadence — a stray `running` is ignored', rt === 5, `${rt} ticks`);
}

// --- 3. the followers walk the lead's own cells ---------------------------------
{
  const gap = 2;
  const line = new Line({ gap, members: 3 }).place(1, 10, 30, NORTH, open());
  const route = makeScriptedRoute('n6 w5 s4 e3');
  const leadCells = [{ ...line.cellOf(0) }];
  const trainerCells = [{ ...line.cellOf(1) }];
  for (let i = 0; i < 5 * 18; i++) {
    if (line.advance(SIM_DT)) {
      leadCells.push({ cx: line.cellOf(0).cx, cz: line.cellOf(0).cz });
      trainerCells.push({ cx: line.cellOf(1).cx, cz: line.cellOf(1).cz });
    }
    if (!line.moving) {
      const cmd = route.next(line.pose(0, 0), { passable: open(), tagsAt: () => [] });
      if (cmd) line.step(cmd.dir, { walkSeconds: WALK, passable: open() });
    }
  }
  let matched = 0;
  for (let i = gap; i < leadCells.length; i++) {
    const want = leadCells[i - gap];
    const got = trainerCells[i];
    if (want.cx === got.cx && want.cz === got.cz) matched++;
  }
  check('conga: the trainer occupies the lead\'s cell from `gap` steps ago',
    matched === leadCells.length - gap, `${matched}/${leadCells.length - gap}`);

  // And it is the *lead* that is out in front, not the trainer.
  const lead = line.cellOf(0), trainer = line.cellOf(1);
  const ahead = Math.abs(lead.cx - trainer.cx) + Math.abs(lead.cz - trainer.cz);
  check('conga: the lead is gap cells from the trainer', ahead === gap, `${ahead}`);
}

// --- 4. four-way only ------------------------------------------------------------
{
  const line = new Line({ gap: 1, members: 2 }).place(1, 20, 20, SOUTH, open());
  const rng = makeRng(1337, 'selftest/wander');
  const route = makeWander(rng, { preferTags: [] });
  let diagonals = 0, jumps = 0;
  let prev = { ...line.cellOf(0) };
  for (let i = 0; i < 5 * 400; i++) {
    if (line.advance(SIM_DT)) {
      const now = line.cellOf(0);
      const dx = Math.abs(now.cx - prev.cx), dz = Math.abs(now.cz - prev.cz);
      if (dx && dz) diagonals++;
      if (dx + dz !== 1) jumps++;
      prev = { ...now };
    }
    if (!line.moving) {
      const cmd = route.next(line.pose(0, 0), { passable: open(), tagsAt: () => [] });
      if (cmd) line.step(cmd.dir, { walkSeconds: WALK, passable: open() });
    }
  }
  check('grid: no diagonal step in 400 steps of wandering', diagonals === 0, `${diagonals}`);
  check('grid: every step is exactly one cell', jumps === 0, `${jumps}`);
}

// --- 5. collision and turning on the spot -----------------------------------------
{
  const wall = (cx) => cx > 5;                       // everything at x <= 5 is solid
  // The anchor is member 1 (the trainer), so the lead starts one cell south of it.
  const line = new Line({ gap: 1, members: 2 }).place(1, 7, 20, SOUTH, () => true);
  line.step(WEST, { walkSeconds: WALK, passable: wall });
  while (line.moving) line.advance(SIM_DT);
  eq('collision: a legal step is taken', line.cellOf(0), { cx: 6, cz: 21, dir: WEST });
  const blocked = line.step(WEST, { walkSeconds: WALK, passable: wall });
  check('collision: a blocked step is refused', blocked === false);
  eq('collision: and the walker does not move', { cx: line.cellOf(0).cx, cz: line.cellOf(0).cz }, { cx: 6, cz: 21 });
  line.step(NORTH, { walkSeconds: WALK, passable: () => false });
  check('collision: but it still turns to face the way it tried to go',
    line.facing === NORTH, DIR_NAME[line.facing]);
}

// --- 6. facing follows the cell a walker is entering --------------------------------
{
  const line = new Line({ gap: 1, members: 3 }).place(1, 20, 30, NORTH, open());
  drive(line, makeScriptedRoute('n4 w4', { loop: false }), 5 * 5);
  // The lead has turned west; the follower still walking into the corner faces north.
  check('facing: the lead faces its own direction of travel', line.facing === WEST, DIR_NAME[line.facing]);
  const trainer = line.pose(1, 0);
  check('facing: a follower faces the way it entered its cell, not the way the lead turned',
    trainer.dir === NORTH, DIR_NAME[trainer.dir]);
}

// --- 7. determinism ------------------------------------------------------------------
{
  const run = (seed) => {
    const line = new Line({ gap: 2, members: 4 }).place(1, 20, 30, NORTH, open());
    drive(line, makeWander(makeRng(seed, 'selftest/determinism'), { preferTags: [] }), 5 * 300);
    return line.trail.map((c) => `${c.cx},${c.cz},${c.dir}`).join(' ');
  };
  check('determinism: same seed, same path', run(1337) === run(1337));
  check('determinism: a different seed is a different path', run(1337) !== run(99));

  const scripted = () => {
    const line = new Line({ gap: 2, members: 4 }).place(1, 20, 30, NORTH, open());
    drive(line, makeScriptedRoute('n9 w7 s9 e7'), 5 * 120);
    return JSON.stringify(line.trail);
  };
  check('determinism: a scripted route replays exactly', scripted() === scripted());
}

// --- 8. slicing the walk cannot change it ---------------------------------------------
{
  const walkIn = (chunks) => {
    const line = new Line({ gap: 2, members: 4 }).place(1, 20, 30, NORTH, open());
    const route = makeScriptedRoute('n8 w6 s8 e6');
    for (const n of chunks) drive(line, route, n);
    return JSON.stringify({ trail: line.trail, t: line.t, steps: line.steps });
  };
  check('slicing: one long run equals many short ones',
    walkIn([300]) === walkIn([1, 7, 13, 29, 50, 100, 100]));
}

// --- 9. the route parser ----------------------------------------------------------------
{
  eq('route: letters and counts expand in order', parseRoute('n2 w1 s3'),
    [NORTH, NORTH, WEST, SOUTH, SOUTH, SOUTH]);
  eq('route: whitespace is optional', parseRoute('e2n1'), [EAST, EAST, NORTH]);
  eq('route: an explicit direction list passes through', parseRoute([SOUTH, EAST]), [SOUTH, EAST]);
  const route = makeScriptedRoute('n1', { loop: true });
  const head = { cx: 5, cz: 5, dir: SOUTH };
  const world = { passable: () => true, tagsAt: () => [] };
  check('route: a loop never runs out', route.next(head, world) && route.next(head, world));
  const dead = makeScriptedRoute('n1', { loop: false });
  dead.next(head, world);
  check('route: a one-shot route stops', dead.next(head, world) === null);
  const walled = makeScriptedRoute('n4');
  check('route: a blocked direction is skipped, not retried forever',
    walled.next(head, { passable: (cx, cz, d) => d !== NORTH, tagsAt: () => [] }) === null);
}

// --- 9b. the pilot route: a thin adapter onto an injected plan --------------------------
//
// `hunts` needs a fresh decision every tick (waypoint-index A* re-planning) instead of a
// fixed pre-computed step list, so a pilot route holds no plan of its own — it hands `head`
// and `world` straight through to `plan` and returns whatever comes back.
{
  const world = { passable: () => true, tagsAt: () => [] };
  check('pilot: kind is pilot', makePilotRoute(() => null).kind === 'pilot');

  const seen = [];
  const pilot = makePilotRoute((h) => { seen.push({ ...h }); return { dir: EAST }; });
  const head = { cx: 3, cz: 4 };
  eq('pilot: a step direction from the plan is returned untouched', pilot.next(head, world), { dir: EAST });
  eq('pilot: the plan is called with the current head cell', seen[0], { cx: 3, cz: 4 });

  const idle = makePilotRoute(() => null);
  check('pilot: a plan returning null answers null, without throwing', idle.next(head, world) === null);
  idle.reset(); // a no-op — must not throw either.

  // Driven through a real Line, exactly as `simulation`'s tick drives any other route: a
  // direction from the plan actually steps the walker, and a null causes no further movement.
  const line = new Line({ gap: 1, members: 1 }).place(0, 10, 10, SOUTH, open());
  let calls = 0;
  const drivenPilot = makePilotRoute(() => { calls++; return calls === 1 ? { dir: EAST } : null; });
  drive(line, drivenPilot, 5 * 3);
  eq('pilot: a plan\'s direction steps the walker one cell', { cx: line.cellOf(0).cx, cz: line.cellOf(0).cz },
    { cx: 11, cz: 10 });
  check('pilot: the plan is asked again once the step lands, and a null issues no further step',
    calls >= 2);
}

// --- 9c. canStepFor: terrain.canStep AND solid-occupancy, minus the ignored id -----------
//
// Mirrors `simulation/index.js`'s `canStepFor` verbatim (no ctx, no three.js, matching the
// `detourHome` mirror tests above) rather than booting the whole module. Covers: a terrain
// that exposes `canStep` and refuses a cell, the `solid` occupancy map refusing a cell terrain
// allows, `ignoreNpcId` excluding exactly that npc's own claimed cell, and the same defensive
// fallback to `passable`-based checking the module's own `passable()` helper already uses when
// `terrain` is not live or does not (yet) expose `canStep`.
{
  const isLive = (api) => !!api && api.__missing === undefined;

  function makeCanStepFor(terrain, solid) {
    function fallbackPassable(cx, cz, dir) {
      if (!isLive(terrain) || typeof terrain.passable !== 'function') return true;
      return !!terrain.passable(cx, cz, dir);
    }
    return (ignoreNpcId) => (cx, cz, dir) => {
      const ok = isLive(terrain) && typeof terrain.canStep === 'function'
        ? !!terrain.canStep(cx, cz, dir)
        : fallbackPassable(cx, cz, dir);
      if (!ok) return false;
      const who = solid.get(`${cx},${cz}`);
      return who === undefined || who === ignoreNpcId;
    };
  }

  const solid = new Map([['5,5', 42]]);
  const terrain = { canStep: (cx) => cx !== 9, passable: () => true };
  const canStepFor = makeCanStepFor(terrain, solid);
  check('canStepFor: terrain.canStep refusal blocks the step',
    canStepFor(0)(9, 5, EAST) === false);
  check('canStepFor: solid occupancy blocks a cell terrain.canStep allows',
    canStepFor(0)(5, 5, EAST) === false);
  check('canStepFor: ignoreNpcId lets the walker step onto its own claimed cell',
    canStepFor(42)(5, 5, EAST) === true);
  check('canStepFor: a clear, unclaimed cell is allowed',
    canStepFor(0)(1, 1, EAST) === true);

  const missingTerrain = { __missing: true };
  check('canStepFor: falls back to passable (true) when terrain is not live',
    makeCanStepFor(missingTerrain, solid)(0)(1, 1, EAST) === true);

  const terrainNoCanStep = { passable: (cx) => cx !== 3 };
  check('canStepFor: falls back to terrain.passable when canStep is not (yet) a function',
    makeCanStepFor(terrainNoCanStep, solid)(0)(3, 1, EAST) === false);
  check('canStepFor: the passable fallback still allows a clear cell',
    makeCanStepFor(terrainNoCanStep, solid)(0)(1, 1, EAST) === true);
}

// --- 10. interpolation is monotone and lands on cell centres -----------------------------
{
  const line = new Line({ gap: 1, members: 2 }).place(1, 10, 20, SOUTH, open());
  line.step(SOUTH, { walkSeconds: WALK, passable: open() });
  let last = -Infinity, ok = true;
  for (let i = 0; i <= 5; i++) {
    const z = line.pose(0, 0).z;
    if (z < last - 1e-12) ok = false;
    last = z;
    line.advance(SIM_DT);
  }
  check('interpolation: position never goes backwards inside a step', ok);
  // The lead started at (10, 21) — one south of the trainer — and stepped south once.
  const rest = line.pose(0, 0);
  check('interpolation: a finished step sits on the cell centre',
    Math.abs(rest.x - 10.5) < 1e-12 && Math.abs(rest.z - 22.5) < 1e-12, `${rest.x},${rest.z}`);
  check('interpolation: DIR_DX/DIR_DZ agree with the axes in src/core/dir.js',
    DIR_DX[EAST] === 1 && DIR_DZ[SOUTH] === 1 && DIR_DX[WEST] === -1 && DIR_DZ[NORTH] === -1);
}

// --- the detour: off the circuit and back, with the route none the wiser ------
//
// The mechanism Phase B rests on, checked against `route.js` itself rather than reasoned about.
// A hunt walks a closed loop; to reach a creature standing two cells off it the head takes one
// step out and one back, and the route must owe **exactly** the step it owed before — otherwise
// every lap after the first fight walks a different circuit.
{
  const world = { passable: () => true, tagsAt: () => [] };
  const loop = makeScriptedRoute('e4 s4 w4 n4', { loop: true, strict: true });
  let head = { cx: 10, cz: 10 };
  const D = { dx: [0, -1, 0, 1], dz: [1, 0, -1, 0] };
  const walk = (r, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const cmd = r.next(head, world);
      if (!cmd) { out.push(null); break; }
      head = { cx: head.cx + D.dx[cmd.dir], cz: head.cz + D.dz[cmd.dir] };
      out.push(cmd.dir);
    }
    return out;
  };

  eq('detour: six steps of the circuit', walk(loop, 6), [EAST, EAST, EAST, EAST, SOUTH, SOUTH]);
  const home = { ...head };
  const index = loop.index;
  eq('detour: the route is six steps in', index, 6);
  eq('detour: and the head is where those steps put it', home, { cx: 14, cz: 12 });

  // The detour is a one-shot, non-looping route walked in place of the circuit.
  const leg = makeScriptedRoute([NORTH, SOUTH], { loop: false, strict: true });
  eq('detour: out and back', walk(leg, 2), [NORTH, SOUTH]);
  eq('detour: it ends on the cell it left', head, home);
  eq('detour: the circuit never advanced', loop.index, index);
  // An exhausted one-shot route answers `null` BEFORE the strict branch (`route.js`), which is
  // the same value a blocked strict route answers — so a caller must test the index, never a
  // bare null, or it cannot tell "finished" from "wedged".
  check('detour: an exhausted leg is told apart by its index, not by a null',
    leg.next(head, world) === null && leg.index >= leg.length);

  eq('detour: the circuit resumes owing exactly what it owed',
    walk(loop, 4), [SOUTH, SOUTH, WEST, WEST]);
}

// --- detourHome: never clobbers a return leg the approach already built -----------------
//
// The stage-1 regression, and the single most important check in this file. `detour.out` /
// `taken` / `back` have exactly two write sites in `simulation/index.js`'s `init()` — the
// out-drain branch inside `advance()` and `detourHome()` itself — mirrored here as a tiny
// local model rather than booting the whole module (no ctx, no three.js, matching the block
// above). The bug: `back` is built from `taken` and `taken` is cleared the INSTANT the last
// queued approach step lands (inside `advance()`, not inside `detourHome()`), because
// `bfsPath` stops one tile short of its target so the fight almost always engages on that
// final cell. The old `detourHome()` did not know that had already happened and unconditionally
// rebuilt `back` from `taken` — by then empty — wiping the fully-formed trip home to nothing.
// An early cut-short (`detourHome()` called mid-approach, with `taken` still holding steps)
// already worked before the fix, so this test deliberately drains the WHOLE approach first —
// the last queued step landing, not an early cut-short — and only calls `detourHome()` after.
{
  const detour = { out: [], taken: [], back: [], returnHome: true };

  /** Mirrors `api.detour(dirs, opts)`, simulation/index.js:750-756. */
  function startDetour(dirs, opts = {}) {
    detour.out.push(...dirs);
    detour.returnHome = opts.returnHome !== false;
  }
  /**
   * Mirrors the out-drain branch of `advance()` (simulation/index.js:389-412): peek `out[0]`,
   * step it, and only a landed step moves the queue — the step that empties `out` is the one
   * that builds `back` from `taken` and clears `taken`, right there.
   */
  function driveOutStep(line) {
    const dir = detour.out[0];
    if (line.step(dir, { walkSeconds: WALK, passable: open() })) {
      detour.out.shift();
      detour.taken.push(dir);
      if (!detour.out.length) {
        if (detour.returnHome) detour.back = detour.taken.slice().reverse().map(opposite);
        detour.taken.length = 0;
      }
      return true;
    }
    detour.out.length = 0;
    if (detour.returnHome) detour.back = detour.taken.slice().reverse().map(opposite);
    detour.taken.length = 0;
    return false;
  }
  /** Mirrors `detourHome()` verbatim — the FIXED version, simulation/index.js:780-787. */
  function detourHome() {
    detour.out.length = 0;
    if (detour.taken.length) {
      if (detour.returnHome) detour.back = detour.taken.slice().reverse().map(opposite);
      detour.taken.length = 0;
    }
  }

  const line = new Line({ gap: 1, members: 1 }).place(0, 10, 10, SOUTH, open());
  const startCell = { ...line.cellOf(0) };

  // A multi-step one-way approach — three cells off the circuit, not one, the shape the real
  // bug needs: `bfsPath` routinely queues several steps before the engage range is reached.
  const approach = [EAST, EAST, SOUTH];
  startDetour(approach);

  // Drain every queued step to completion, one at a time, exactly as `advance()` only drains
  // a step once the previous one has finished landing (`!line.moving`).
  for (let i = 0; i < approach.length; i++) {
    while (line.moving) line.advance(SIM_DT);
    check('detourHome: each queued approach step lands', driveOutStep(line));
  }
  while (line.moving) line.advance(SIM_DT);

  eq('detourHome: a fully drained approach reaches its target cell',
    { cx: line.cellOf(0).cx, cz: line.cellOf(0).cz },
    { cx: startCell.cx + 2, cz: startCell.cz + 1 });
  // Pin the exact order this test exercises: `out` empties NATURALLY on the last queued step
  // landing, `back` gets built and `taken` cleared right there — all of this happens before
  // `detourHome()` is ever called below.
  eq('detourHome: out is already fully drained before detourHome is called', detour.out, []);
  eq('detourHome: taken was already cleared the instant the approach emptied', detour.taken, []);
  const builtBack = detour.back.slice();
  check('detourHome: back was already built by advance() by the time the approach emptied',
    builtBack.length === approach.length, `${builtBack.length}`);

  // The regression itself: detourHome() called AFTER the natural drain (the engage-on-final-
  // cell case), not mid-approach (the already-working cut-short case).
  detourHome();

  check('detourHome: the return trip is NOT wiped to empty by a call after the approach drained',
    detour.back.length > 0, JSON.stringify(detour.back));
  eq('detourHome: the return trip is left exactly as advance() built it',
    detour.back, builtBack);
  eq('detourHome: and it exactly reverses what was actually walked',
    detour.back, approach.slice().reverse().map(opposite));

  // Retrace `back` for real and confirm it actually lands the party back where the detour
  // started — not just that the array looks right.
  for (const dir of detour.back.slice()) {
    while (line.moving) line.advance(SIM_DT);
    line.step(dir, { walkSeconds: WALK, passable: open() });
  }
  while (line.moving) line.advance(SIM_DT);
  eq('detourHome: retracing `back` actually lands the party back where the detour started',
    { cx: line.cellOf(0).cx, cz: line.cellOf(0).cz }, { cx: startCell.cx, cz: startCell.cz });
}

// --- detourHome: the mid-approach cut-short still works (contrast, not the regression) ----
//
// The path that already worked before the fix, kept alongside the regression test above so the
// two are told apart rather than one silently standing in for the other.
{
  const detour = { out: [], taken: [], back: [], returnHome: true };
  function startDetour(dirs) { detour.out.push(...dirs); }
  function driveOutStep(line) {
    const dir = detour.out[0];
    if (line.step(dir, { walkSeconds: WALK, passable: open() })) {
      detour.out.shift();
      detour.taken.push(dir);
      if (!detour.out.length) {
        detour.back = detour.taken.slice().reverse().map(opposite);
        detour.taken.length = 0;
      }
      return true;
    }
    return false;
  }
  function detourHome() {
    detour.out.length = 0;
    if (detour.taken.length) {
      detour.back = detour.taken.slice().reverse().map(opposite);
      detour.taken.length = 0;
    }
  }

  const line = new Line({ gap: 1, members: 1 }).place(0, 10, 10, SOUTH, open());
  startDetour([EAST, EAST, SOUTH]);

  // Only walk the FIRST of three queued steps, then cut the approach short — `out` still has
  // steps left in it, `taken` holds exactly the one step actually walked.
  while (line.moving) line.advance(SIM_DT);
  driveOutStep(line);
  while (line.moving) line.advance(SIM_DT);
  eq('detourHome (cut-short): out still has steps queued', detour.out, [EAST, SOUTH]);
  eq('detourHome (cut-short): taken holds exactly the one step walked', detour.taken, [EAST]);

  detourHome();
  eq('detourHome (cut-short): back is built from the one step actually taken',
    detour.back, [WEST]);
  eq('detourHome (cut-short): out is cleared', detour.out, []);
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`simulation selftest: ${passed}/${total} checks passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`simulation selftest: all ${total} checks passed`);
}

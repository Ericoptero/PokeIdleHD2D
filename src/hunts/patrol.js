/**
 * patrol.js — the waypoint-index + nearest-wild-by-path brain for a hunt's roaming trainer
 * (or any future walker that needs both "which of several idle spawns is worth a detour to"
 * and "where am I in my beat, and when have I finished a lap").
 *
 * Pure, like `hunts/compose.js`'s `stitchLoop`: no `ctx`, no `bus`, no `rng`, no terrain
 * import. `canStep` and `aStar` are handed in by the caller (`MapDraft.canStep` in
 * production, a hand-built predicate in tests) exactly the way `stitchLoop` takes its own
 * `passable`-shaped callback, so this file can be pinned against a hand-built `MapDraft`
 * the way `hunts/loop.test.js` already pins `stitchLoop` — no simulation, no encounter
 * system, no live map required to prove the index/lap bookkeeping or the "which spawn wins"
 * arithmetic is right.
 *
 * Two separate jobs live here, deliberately kept apart:
 *
 * - `chooseTarget` (with its helper `standTiles`) picks, among several ACTIVE wild spawns,
 *   the one actually worth a detour to — "closest by real walking distance", not closest as
 *   the crow flies, because a spawn that looks near on a straight ruler can sit behind a
 *   wall that makes the honest walk to it longer than a spawn that looks farther. This is
 *   the one behavior the whole module exists for; see the "headline case" test.
 * - `makePatrol` is unrelated index/lap bookkeeping for a fixed authored circuit of
 *   waypoints — advancing, wrapping, counting laps. It never calls `aStar` or `canStep`
 *   itself; a later integration step drives it by pathing toward `current()` and calling
 *   `arrived()` / `advance()` / `skip()` on the outcome. Keeping pathing out of it is what
 *   lets its lap arithmetic be tested with zero terrain at all.
 */

import { manhattan, aStar } from '../core/path.js';
import { SOUTH, WEST, NORTH, EAST, DIR_DX, DIR_DZ, opposite } from '../core/dir.js';

/** Fixed, deterministic neighbour order — `core/dir.js`'s own south, west, north, east. */
const ORTHOGONAL = [SOUTH, WEST, NORTH, EAST];

/**
 * The orthogonal neighbours of `spawn` a walker could stand on to fight whatever occupies
 * it, kept only when the approach is legal in **both** directions: `canStep(neighbour ->
 * spawn)` (so the wild is actually reachable from there) and `canStep(spawn -> neighbour)`
 * (so a wild that drifts is not handed a stand tile it could never itself have entered from
 * the spawn side — the same bidirectional-legality rule `hunts/compose.js`'s `slotsForLoop`
 * already applies at its own approach-cell check, just expressed against `canStep` instead
 * of `passable` since a one-way ledge is exactly the case a single-direction check would
 * miss). The spawn's own cell is never a candidate.
 *
 * Order is fixed (south, west, north, east) rather than sorted by distance — there is no
 * "from" cell at this stage to measure distance against; `chooseTarget` is what orders these
 * by estimated distance from the walker once it has one.
 *
 * @param {{cx:number, cz:number}} spawn
 * @param {(cx:number, cz:number, dir:number) => boolean} canStep FROM-cell semantics, matching
 *   `core/path.js`'s `aStar` — "may I leave (cx,cz) heading dir?".
 * @returns {{cx:number, cz:number}[]}
 */
export function standTiles(spawn, canStep) {
  const out = [];
  for (const dir of ORTHOGONAL) {
    const nx = spawn.cx + DIR_DX[dir];
    const nz = spawn.cz + DIR_DZ[dir];
    if (!canStep(nx, nz, opposite(dir))) continue; // neighbour -> spawn
    if (!canStep(spawn.cx, spawn.cz, dir)) continue; // spawn -> neighbour
    out.push({ cx: nx, cz: nz });
  }
  return out;
}

/**
 * Picks the ACTIVE wild spawn genuinely worth walking to from `at`, by real walking distance
 * rather than by straight-line distance — the entire point of routing this through `aStar`
 * instead of just sorting spawns by `manhattan`. A spawn that reads closer on a ruler can sit
 * behind a wall that makes the honest walk to it longer than a spawn that reads farther but
 * has open ground; picking the ruler-closest one would send a walker on a long detour past a
 * wild it could have reached in three steps.
 *
 * **Caller contract:** `spawns` must already be filtered down to ACTIVE spawns only (not
 * empty, not respawning) — this function does not check spawn state, only geometry. Each
 * spawn needs at least `{cx, cz}`; any extra fields (a slot key, a species id, ...) are
 * treated as opaque and passed back untouched on the winning entry so the caller can recover
 * them.
 *
 * @param {{cx:number, cz:number}} at the walker's current cell.
 * @param {Array<{cx:number, cz:number}>} spawns ACTIVE spawns only, in the caller's own order
 *   — that order is significant, see rule 4 below.
 * @param {(cx:number, cz:number, dir:number) => boolean} canStep FROM-cell semantics.
 * @param {{maxManhattan?:number, maxSteps?:number}} [opts] overridable rather than hard-coded
 *   since `core/config.js` will likely want to reach these; wiring that is a later step, not
 *   this one.
 * @returns {{spawn:object, path:{cx:number,cz:number,dir:number}[]}|null} `spawn` is the
 *   actual element from `spawns` (never a copy). `path` is the `aStar` step list toward the
 *   winning stand tile — it never enters the spawn's own cell, since `aStar` was only ever
 *   asked to reach a stand tile, not the spawn.
 */
export function chooseTarget(at, spawns, canStep, opts = {}) {
  const { maxManhattan = 6, maxSteps = 6 } = opts;

  let bestSpawn = null;
  let bestPath = null;

  for (let i = 0; i < spawns.length; i++) {
    const spawn = spawns[i];

    // Rule 1: reject anything farther than maxManhattan before any pathing is attempted —
    // the cheapest possible prefilter, and it must run before standTiles/aStar touch canStep
    // at all (see the "rejected before any pathing" test, which makes canStep throw for a
    // spawn beyond this radius to prove it is never called).
    if (manhattan(at, spawn) > maxManhattan) continue;

    // Rule 2: order this spawn's stand tiles by estimated distance from `at`, then take the
    // path to the FIRST one `aStar` can actually reach — not the globally shortest of the
    // four. Ties in estimated distance keep `standTiles`' own fixed south/west/north/east
    // order (an explicit index tie-break, not `Array.prototype.sort`'s incidental stability —
    // matching `core/path.js`'s own reasoning for why `aStar`'s open set isn't a re-sorted
    // array either).
    const tiles = standTiles(spawn, canStep)
      .map((tile, ti) => ({ tile, ti, dist: manhattan(at, tile) }))
      .sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.ti - b.ti));

    let path = null;
    for (const { tile } of tiles) {
      const found = aStar(at, tile, canStep);
      if (found) { path = found; break; }
    }
    if (!path) continue;

    // Rule 3: discard a path longer than maxSteps even though the spawn itself passed rule 1.
    if (path.length > maxSteps) continue;

    // Rule 4: shortest accepted path wins; a tie keeps the earlier index in the ORIGINAL
    // `spawns` array. Tracked explicitly (not via Array.prototype.sort) for the same
    // determinism reason as the stand-tile ordering above — `i` only ever increases as this
    // loop runs, so "first spawn seen with this path length" already IS "earliest index",
    // and `<` (not `<=`) below is what keeps the first winner from being displaced by a later
    // spawn with an equal-length path.
    if (!bestPath || path.length < bestPath.length) {
      bestSpawn = spawn;
      bestPath = path;
    }
  }

  return bestPath ? { spawn: bestSpawn, path: bestPath } : null;
}

/**
 * Pure index/lap bookkeeping for an authored, ordered circuit of waypoints. Holds mutable
 * state (`index`, `laps`) and nothing else live — no `aStar`, no `canStep`, no terrain. The
 * caller (a later integration step) is the one that paths toward `current()` with `aStar`
 * and then reports the outcome back via `arrived()` / `advance()` / `skip()`; this module
 * never looks at the map, which is what makes its lap arithmetic testable with zero terrain.
 *
 * @param {{waypoints: {cx:number, cz:number}[]}} args an ordered, non-empty list of waypoints.
 * @returns {{
 *   index: number,
 *   laps: number,
 *   current: () => {cx:number, cz:number},
 *   arrived: (at:{cx:number,cz:number}) => boolean,
 *   advance: () => {laps:number, wrapped:boolean},
 *   skip: () => {laps:number, wrapped:boolean},
 * }}
 */
export function makePatrol({ waypoints }) {
  const self = {
    index: 0,
    laps: 0,

    /** The waypoint the walker is currently heading toward. */
    current() {
      return waypoints[self.index];
    },

    /**
     * Rule: a waypoint counts as visited within Manhattan 3 of it, not only by stepping onto
     * its exact cell — the character need not land pixel-perfect on the authored point.
     */
    arrived(at) {
      return manhattan(at, self.current()) <= 3;
    },

    /**
     * Moves to the next waypoint, wrapping to 0 past the end. `laps` increments by exactly
     * one each time the index wraps from `waypoints.length - 1` back to 0 — one lap is one
     * full pass of the ordered list, never a per-waypoint counter in disguise. Returns
     * `{laps, wrapped}` so a caller can react to a completed lap without polling `self.laps`
     * before and after.
     */
    advance() {
      const wrapped = self.index === waypoints.length - 1;
      self.index = wrapped ? 0 : self.index + 1;
      if (wrapped) self.laps++;
      return { laps: self.laps, wrapped };
    },

    /**
     * Rule 6 of the patrol spec: "if a waypoint is the current tile or cannot be reached, it
     * tries the following waypoint instead." That is exactly `advance()`'s own index/wrap/lap
     * step — the two never need different bookkeeping, only different callers (an arrival
     * bumps the index because the walker succeeded; a skip bumps it because the walker gave
     * up on this one) — so `skip()` is `advance()` under another name. A skip that happens to
     * wrap past the last waypoint back to the first still counts as one full pass, the same
     * as an ordinary arrival-driven wrap would: there is no separate "half lap" concept here.
     */
    skip() {
      return self.advance();
    },
  };
  return self;
}

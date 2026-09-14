/**
 * path.js — a grid BFS, for the one thing `simulation/route.js`'s scripted/wander/tether
 * routes were never asked to do: get from an arbitrary cell to another one, respecting
 * collision, without a fixed circuit to walk. Written for the hunt's own aggro trigger
 * (`hunts/index.js`) — "go to the closer wild, respecting collision in the map" — which the
 * old fixed-slot detour (`sim.detour([slot.step, back])`, a hard-coded two-step pair) could
 * not do for a target that is not exactly two cells off the party's own path.
 *
 * Lives in `core/` rather than `simulation/` because its only caller, `hunts`, is a sibling
 * module — cross-module access goes through `ctx.get(id)`, not a deep import into another
 * module's own folder (`tools/seams/run.js`'s `no-deep-imports` rule; `ARCHITECTURE.md`'s own
 * "Shared utilities come from `src/core/`"). Pure: no `ctx`, no `terrain` import, no
 * randomness — `passable(cx, cz, dir)` is handed in, matching every other pathing/route
 * helper's own discipline.
 */

import { DIR_DX, DIR_DZ } from './dir.js';

const key = (cx, cz) => `${cx},${cz}`;

/**
 * Shortest walk from `from` to a cell **adjacent** (Chebyshev 1) to `to` — stopping one tile
 * short on purpose, since that is the reach a contact trigger already fires at
 * (`config.slotEngageTiles`, `encounter/index.js`'s `slotNear`) and pathing onto the target's
 * own cell would walk through whatever it is.
 *
 * @param {{cx:number, cz:number}} from
 * @param {{cx:number, cz:number}} to
 * @param {(cx:number, cz:number, dir:number) => boolean} passable
 * @param {number} [maxTiles] a search budget, in cells visited — not a straight-line distance
 *   cap, so a winding-but-short real route is not refused for looking far as the crow flies.
 * @returns {number[]|null} an ordered list of `core/dir.js` directions, or `null` if `to` is
 *   already adjacent (nothing to walk) or no route was found within budget.
 */
export function bfsPath(from, to, passable, maxTiles = 200) {
  const chebyshev = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
  if (chebyshev(from.cx, from.cz, to.cx, to.cz) <= 1) return null;

  const start = key(from.cx, from.cz);
  const cameFrom = new Map([[start, null]]); // cell key -> {dir, from key} | null (start)
  const queue = [{ cx: from.cx, cz: from.cz, k: start }];
  let visited = 1;

  while (queue.length) {
    const cur = queue.shift();
    if (chebyshev(cur.cx, cur.cz, to.cx, to.cz) <= 1) {
      // Walk the `cameFrom` chain back to the start, collecting directions in reverse.
      const dirs = [];
      let at = cur.k;
      while (at !== start) {
        const step = cameFrom.get(at);
        dirs.unshift(step.dir);
        at = step.from;
      }
      return dirs;
    }
    if (visited >= maxTiles) break;
    for (let dir = 0; dir < 4; dir++) {
      const nx = cur.cx + DIR_DX[dir];
      const nz = cur.cz + DIR_DZ[dir];
      const nk = key(nx, nz);
      if (cameFrom.has(nk)) continue;
      if (!passable(nx, nz, dir)) continue;
      cameFrom.set(nk, { dir, from: cur.k });
      visited++;
      queue.push({ cx: nx, cz: nz, k: nk });
    }
  }
  return null;
}

/**
 * Shortest 4-directional walk from `from` to `to`, **inclusive** of both ends — unlike
 * `bfsPath`, which stops one cell short for the contact-trigger use case this file was
 * originally written for. Used by `hunts/compose.js`'s `stitchLoop` to join authored
 * waypoints into a continuous ring.
 *
 * @param {{cx:number, cz:number}} from
 * @param {{cx:number, cz:number}} to
 * @param {(cx:number, cz:number, dir:number) => boolean} passable destination-cell semantics —
 *   the cell being entered, matching every other passability caller in this repo.
 * @param {{maxTiles?: number}} [opts] a search budget, in cells visited — not a straight-line
 *   distance cap, so a winding-but-short real route is not refused for looking far as the crow
 *   flies.
 * @returns {{cx:number, cz:number}[]|null} an ordered list of cells from `from` to `to`
 *   inclusive, or `null` if `from` and `to` are the same cell, or no route was found within
 *   budget.
 */
/** Manhattan distance — admissible for unit-cost 4-directional movement (never overestimates
 * the true step count, since every real step changes exactly one of cx/cz by 1). */
export const manhattan = (a, b) => Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz);

/**
 * Binary min-heap keyed on (f, seq): f first, then insertion order as the tie-break. A plain
 * array with indexOf/sort per pop would also work but is O(n log n) per pop instead of
 * O(log n); more importantly, `Array.prototype.sort` is not guaranteed stable in every engine
 * for arbitrary comparators, and `aStar`'s determinism requirement (same input -> byte-identical
 * output, always) can't rest on an engine's incidental stability. The `seq` field pins the
 * ordering explicitly instead.
 */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this._less(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        let smallest = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < n && this._less(items[l], items[smallest])) smallest = l;
        if (r < n && this._less(items[r], items[smallest])) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }

  _less(a, b) {
    return a.f !== b.f ? a.f < b.f : a.seq < b.seq;
  }
}

/**
 * Shortest 4-directional walk from `from` to `goal` by A* — same destination and inclusivity
 * shape as `bfsCells` (a step list to enter, not a cell list including the start) but with a
 * Manhattan-distance heuristic instead of a blind frontier, for the same graphs `bfsCells`
 * already searches when they are large enough that an admissible heuristic actually saves work.
 *
 * `canStep` is a **FROM-cell** predicate: `canStep(cx, cz, dir)` asks "may I leave (cx,cz)
 * heading `dir`?" — this is the opposite convention from `bfsPath`/`bfsCells`'s `passable`,
 * which is a **destination-cell** predicate ("may I enter the cell `dir` leads to?"). The two
 * are easy to swap by mistake because both take `(cx, cz, dir)`: a `bfsCells`-style passable
 * checks the cell being entered, so a one-way ledge that can be dropped into but not entered
 * from the side is expressed as a property of the *landing* cell; `aStar`'s `canStep` instead
 * expresses it as a property of the cell being *left*, which is what lets a caller model rules
 * like "you may step off this ledge but not back up onto it" without needing to know which
 * direction the ledge cell is being approached from before it is even reached.
 *
 * @param {{cx:number, cz:number}} from
 * @param {{cx:number, cz:number}} goal
 * @param {(cx:number, cz:number, dir:number) => boolean} canStep FROM-cell semantics — see above.
 * @param {{maxTiles?: number}} [opts] a search budget, in cells discovered — not a straight-line
 *   distance cap, so a winding-but-short real route is not refused for looking far as the crow
 *   flies.
 * @returns {{cx:number, cz:number, dir:number}[]|null} the tiles to enter, in order, excluding
 *   the start cell (so `result.length` is the step count) — `null` if `from` and `goal` are the
 *   same cell (nothing to walk, matching `bfsCells`'s own convention) or no route was found
 *   within budget.
 *
 * Determinism is load-bearing here (callers may re-derive the same route twice and expect the
 * same answer): neighbours are always examined in the fixed order 0..3 on every expansion, and
 * the open set is a `MinHeap` keyed on (f, discovery sequence) rather than a plain array
 * re-sorted per iteration or a `Map`, so two nodes tied on f=g+h always break the tie in favour
 * of whichever was discovered first — never by incidental array or iteration order.
 */
export function aStar(from, goal, canStep, opts = {}) {
  const { maxTiles = 4096 } = opts;
  if (from.cx === goal.cx && from.cz === goal.cz) return null;

  const start = key(from.cx, from.cz);
  const goalKey = key(goal.cx, goal.cz);
  const gScore = new Map([[start, 0]]);
  const cameFrom = new Map(); // cell key -> {dir, from key, cx, cz}
  const open = new MinHeap();
  let seq = 0;
  open.push({ cx: from.cx, cz: from.cz, k: start, g: 0, f: manhattan(from, goal), seq: seq++ });
  let visited = 1;

  while (open.size) {
    const cur = open.pop();
    // A cheaper route to `cur.k` was found after this entry was pushed — stale, skip it.
    if (cur.g > gScore.get(cur.k)) continue;
    if (cur.k === goalKey) {
      // Walk the `cameFrom` chain back to the start, collecting steps in reverse.
      const steps = [];
      let at = cur.k;
      while (at !== start) {
        const step = cameFrom.get(at);
        steps.unshift({ cx: step.cx, cz: step.cz, dir: step.dir });
        at = step.from;
      }
      return steps;
    }
    if (visited >= maxTiles) break;
    for (let dir = 0; dir < 4; dir++) {
      if (!canStep(cur.cx, cur.cz, dir)) continue;
      const nx = cur.cx + DIR_DX[dir];
      const nz = cur.cz + DIR_DZ[dir];
      const nk = key(nx, nz);
      const tentativeG = cur.g + 1;
      if (tentativeG >= (gScore.get(nk) ?? Infinity)) continue;
      gScore.set(nk, tentativeG);
      cameFrom.set(nk, { dir, from: cur.k, cx: nx, cz: nz });
      visited++;
      const f = tentativeG + manhattan({ cx: nx, cz: nz }, goal);
      open.push({ cx: nx, cz: nz, k: nk, g: tentativeG, f, seq: seq++ });
    }
  }
  return null;
}

export function bfsCells(from, to, passable, opts = {}) {
  const { maxTiles = 4096 } = opts;
  if (from.cx === to.cx && from.cz === to.cz) return null;

  const start = key(from.cx, from.cz);
  const goal = key(to.cx, to.cz);
  const cameFrom = new Map([[start, null]]); // cell key -> {dir, from key} | null (start)
  const queue = [{ cx: from.cx, cz: from.cz, k: start }];
  let visited = 1;

  while (queue.length) {
    const cur = queue.shift();
    if (cur.k === goal) {
      // Walk the `cameFrom` chain back to the start, collecting cells in reverse.
      const cells = [];
      let at = cur.k;
      while (at !== start) {
        const step = cameFrom.get(at);
        cells.unshift({ cx: step.cx, cz: step.cz });
        at = step.from;
      }
      cells.unshift({ cx: from.cx, cz: from.cz });
      return cells;
    }
    if (visited >= maxTiles) break;
    for (let dir = 0; dir < 4; dir++) {
      const nx = cur.cx + DIR_DX[dir];
      const nz = cur.cz + DIR_DZ[dir];
      const nk = key(nx, nz);
      if (cameFrom.has(nk)) continue;
      if (!passable(nx, nz, dir)) continue;
      cameFrom.set(nk, { dir, from: cur.k, cx: nx, cz: nz });
      visited++;
      queue.push({ cx: nx, cz: nz, k: nk });
    }
  }
  return null;
}

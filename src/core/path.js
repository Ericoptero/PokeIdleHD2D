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
      if (!passable(cur.cx, cur.cz, dir)) continue;
      cameFrom.set(nk, { dir, from: cur.k });
      visited++;
      queue.push({ cx: nx, cz: nz, k: nk });
    }
  }
  return null;
}

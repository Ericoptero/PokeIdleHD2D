/**
 * Autopilot. An idle game walks itself, so `simulation` needs something to ask "which way
 * next" every time the head of the line lands on a cell.
 *
 * Two kinds, both deterministic:
 *
 *   - a **scripted route**, written as a compact string (`'n6 w4 s3'`) so a showcase or a
 *     scene can author an exact path and get the same pixels back tomorrow;
 *   - a **wander**, driven by a seeded stream from `ctx.rng.fork` (never `Math.random`),
 *     biased to carry straight on and to prefer whatever tags the caller names — a walker
 *     that prefers `path` stays on the road instead of trampling the flowerbeds.
 *
 * Both answer `next(head, world)` with a direction or `null` for "stand still", and neither
 * knows anything about sprites, three.js or the trail.
 */

import { DIR_DX, DIR_DZ, SOUTH, WEST, NORTH, EAST, opposite, turnLeft, turnRight } from '../core/dir.js';

const LETTER_TO_DIR = { s: SOUTH, w: WEST, n: NORTH, e: EAST };

/**
 * Expands `'n6 w4 s3'` (or `'n6w4s3'`) into a flat list of directions.
 * @returns {number[]}
 */
export function parseRoute(spec) {
  if (Array.isArray(spec)) return spec.map((d) => d & 3);
  const out = [];
  for (const m of String(spec ?? '').toLowerCase().matchAll(/([nsew])\s*(\d*)/g)) {
    const dir = LETTER_TO_DIR[m[1]];
    const n = m[2] ? parseInt(m[2], 10) : 1;
    for (let i = 0; i < n; i++) out.push(dir);
  }
  return out;
}

/**
 * A fixed path. A blocked step is skipped rather than retried, so a route written against a
 * map that later grew a fence stumbles once instead of wedging the whole game.
 *
 * @param {string|number[]} spec
 * @param {{loop?:boolean}} [opts]
 */
export function makeScriptedRoute(spec, { loop = true, strict = false, onStall } = {}) {
  const dirs = parseRoute(spec);
  let i = 0;
  let stalled = false;
  return {
    kind: 'route',
    length: dirs.length,
    get index() { return i; },
    get stalled() { return stalled; },
    reset() { i = 0; stalled = false; },
    next(head, world) {
      if (!dirs.length) return null;
      if (i >= dirs.length) { if (!loop) return null; i = 0; }
      const dir = dirs[i];

      if (world.passable(head.cx + DIR_DX[dir], head.cz + DIR_DZ[dir], dir)) {
        i++;
        stalled = false;
        return { dir };
      }

      // **A stall you can see beats a drift you cannot.** The lenient branch below skips a
      // blocked step and carries on with the next heading — which silently walks a route off
      // its own path, and is a defect three separate places in `hunts` have had to document
      // (`compose.js`, `hunts/selftest.js`). A hunt's loop must close, so it asks for `strict`
      // and stands still instead, once, loudly.
      if (strict) {
        if (!stalled) { stalled = true; onStall?.({ cx: head.cx, cz: head.cz, dir, index: i }); }
        return null;
      }

      for (let tries = 1; tries < dirs.length; tries++) {
        if (i >= dirs.length) { if (!loop) return null; i = 0; }
        const d = dirs[i++];
        if (world.passable(head.cx + DIR_DX[d], head.cz + DIR_DZ[d], d)) return { dir: d };
      }
      return null;
    },
  };
}

/**
 * A wild Pokemon that stays where it was put.
 *
 * A spawn slot is a fixed cell (src/hunts/index.js) and the creature standing on it may drift **one tile**
 * around it and no further — far enough that the map is alive, near enough that the slot is
 * still where the player learned it was. Chebyshev, not Manhattan, so a diagonal drift is
 * inside the box rather than being two steps out of it.
 *
 * Mostly it does nothing: `idleWeight` is the chance of standing still on any given decision,
 * and it is high, because eleven creatures all pacing at once reads as a fairground rather
 * than as a wood.
 *
 * @param {{next:() => number}} rng  a `ctx.rng.fork(label)` stream
 * @param {{cx:number, cz:number, radius?:number, idleWeight?:number}} anchor
 */
export function makeTether(rng, { cx, cz, radius = 1, idleWeight = 0.72 } = {}) {
  const inside = (x, z) => Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= radius;
  return {
    kind: 'tether',
    anchor: { cx, cz, radius },
    reset() {},
    next(head, world) {
      if (rng.next() < idleWeight) return null;
      const options = [];
      for (let dir = 0; dir < 4; dir++) {
        const nx = head.cx + DIR_DX[dir];
        const nz = head.cz + DIR_DZ[dir];
        if (!inside(nx, nz)) continue;
        if (!world.passable(nx, nz, dir)) continue;
        options.push(dir);
      }
      if (!options.length) return null;
      return { dir: options[Math.floor(rng.next() * options.length)] };
    },
  };
}

/**
 * A seeded stroll. Straight on is heavily favoured, so the walk reads as purposeful rather
 * than as a drunk.
 *
 * Turning back is not an option at all until nothing else is left. A 180-degree turn walks
 * the head into its own follower and the queue passes through itself for the next
 * `gap · members` steps (see `Line.step`) — correct, and how the mainline games behave, but
 * not something a stroll should choose when a left turn was available. In a dead end it is
 * the only way out, and then it is taken.
 *
 * @param {{next:() => number}} rng  a `ctx.rng.fork(label)` stream
 */
export function makeWander(rng, {
  straight = 6, side = 1.6, preferTags = ['path'], preferWeight = 3.2,
} = {}) {
  return {
    kind: 'wander',
    reset() {},
    next(head, world) {
      const facing = head.dir & 3;
      const options = [
        [facing, straight],
        [turnLeft(facing), side],
        [turnRight(facing), side],
      ];
      let total = 0;
      const weights = options.map(([dir, base]) => {
        const cx = head.cx + DIR_DX[dir], cz = head.cz + DIR_DZ[dir];
        if (!world.passable(cx, cz, dir)) return 0;
        const tags = world.tagsAt(cx, cz) ?? [];
        const liked = preferTags.some((t) => tags.includes(t));
        const w = base * (liked ? preferWeight : 1);
        total += w;
        return w;
      });
      if (total <= 0) {
        const back = opposite(facing);
        return world.passable(head.cx + DIR_DX[back], head.cz + DIR_DZ[back], back)
          ? { dir: back }
          : null;
      }
      let r = rng.next() * total;
      for (let i = 0; i < options.length; i++) {
        r -= weights[i];
        if (r < 0) return { dir: options[i][0] };
      }
      return { dir: options[options.length - 1][0] };
    },
  };
}

/**
 * A route that asks someone else. `hunts` needs to re-plan a waypoint-index A* path against a
 * map that can change between ticks (a wild's tether drift, another hunt's detour claiming a
 * cell) — a fixed, pre-computed step list the way `makeScriptedRoute` walks is the wrong shape
 * for that, because a plan built once goes stale the moment the world it was planned against
 * moves. A pilot route carries no plan of its own at all: it hands `head` and `world` straight
 * to the injected `plan` function and returns whatever it says, every tick. Re-planning is then
 * just asking again next tick — there is no special re-sync protocol to get wrong, because
 * there is nothing here to resync.
 *
 * The state a real planner needs (the waypoint index, the in-flight A* path) lives entirely on
 * the `hunts` side, closed over by `plan` itself — this object is a thin, stateless adapter and
 * `reset()` has nothing of its own to clear.
 *
 * @param {(head:{cx:number,cz:number}, world:{passable:Function, tagsAt:Function}) => ({dir:number}|null)} plan
 */
export function makePilotRoute(plan) {
  return {
    kind: 'pilot',
    reset() {},
    next(head, world) { return plan(head, world); },
  };
}

/** Stands still. The default, so a scene has to ask for motion rather than inherit it. */
export const STILL = { kind: 'still', reset() {}, next: () => null };

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
export function makeScriptedRoute(spec, { loop = true } = {}) {
  const dirs = parseRoute(spec);
  let i = 0;
  return {
    kind: 'route',
    length: dirs.length,
    reset() { i = 0; },
    next(head, world) {
      if (!dirs.length) return null;
      for (let tries = 0; tries < dirs.length; tries++) {
        if (i >= dirs.length) {
          if (!loop) return null;
          i = 0;
        }
        const dir = dirs[i++];
        if (world.passable(head.cx + DIR_DX[dir], head.cz + DIR_DZ[dir], dir)) return { dir };
      }
      return null;
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

/** Stands still. The default, so a scene has to ask for motion rather than inherit it. */
export const STILL = { kind: 'still', reset() {}, next: () => null };

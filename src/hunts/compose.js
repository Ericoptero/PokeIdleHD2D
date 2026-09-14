/**
 * compose.js — the patrol-loop stitcher for a hunt map (src/hunts/index.js).
 *
 * Everything generative this file used to hold — noise fields, region falloffs, prop
 * scattering, tint blending — belonged to procedural terrain generation, which left when
 * every map became Studio-authored. What remains is the one piece nothing else replaces:
 * turning a hunt map's own markers into a closed circuit the party can walk forever.
 *
 * `stitchLoop` is authored-first: a map that declares an ordered list of its own marker
 * names in `loop.via` gets a circuit stitched through them, in that order, on the draft that
 * was actually built. `findLoop` is the fallback for a map with no authored list, or whose
 * list could not be stitched — a rectangle grown around the map's own markers/spawn, because
 * a rectangle's perimeter is closed by construction and easy to check cell by cell.
 *
 * `src/hunts/index.js` runs one of these once per map, when its `loop.resolved` has not
 * already been stitched and saved (a fresh Studio map). Once stitched, the result round-trips
 * through `.map.json` (`src/terrain/mapfile.js`) exactly, so a live re-stitch never happens
 * for a map whose author has already saved its loop.
 */

import { bfsCells } from '../core/path.js';

/** `core/dir.js`'s numbers, spelled out locally so this file keeps its single core import. */
const SOUTH_ = 0; const WEST_ = 1; const NORTH_ = 2; const EAST_ = 3;
const DX = [0, -1, 0, 1];
const DZ = [1, 0, -1, 0];
/** Offsets tried around an anchor, nearest first. */
const NUDGES = (() => {
  const out = [];
  for (let r = 0; r <= 6; r++) {
    for (let ox = -r; ox <= r; ox++) {
      for (let oz = -r; oz <= r; oz++) {
        if (Math.max(Math.abs(ox), Math.abs(oz)) === r) out.push([ox, oz]);
      }
    }
  }
  return out;
})();

/**
 * Finds a **closed** circuit the party can walk forever, on the map that was actually built.
 *
 * This is the fallback, not the plan. `stitchLoop` (below) is authored-first: a biome that
 * declares an ordered list of its own markers gets a circuit stitched through them, in the
 * order asked, on the draft that was actually built. Hand-written route *strings* are still
 * the wrong way to do it — a route is a list of relative directions with no idea where it is,
 * `makeScriptedRoute` skips a blocked step, and three separate places in this module already
 * document routes drifting off their own path when the map grew an obstacle — but a list of
 * marker names has none of that problem, because it is resolved against the draft on every
 * build rather than baked in once.
 *
 * `findLoop` is what runs when there is no authored list, or when stitching one fails: a
 * rectangle, because a rectangle's perimeter is closed by construction and can be checked cell
 * by cell in one pass. The search walks candidate sizes from large to small and returns the
 * first perimeter that is passable the whole way round, so a biome gets the biggest circuit
 * its terrain allows rather than the one somebody guessed at — a floor under the authored path,
 * not a replacement for it.
 *
 * @param {import('../terrain/index.js').MapDraft} draft
 * @param {{cx:number, cz:number}} around  the marker to centre on
 * @param {{min?:number, max?:number, step?:number}} [opts]
 * @returns {{start:{cx:number,cz:number,dir:number}, route:string, cells:{cx:number,cz:number}[],
 *            w:number, h:number}|null}
 */
export function findLoop(draft, around, {
  min = 7, max = 20, step = 1, margin = 11,
  corners = 12, depth = 3, preferTags = ['path'], rng = null, straightLead = 4,
} = {}) {
  // `around` may be one cell or a list of them. A cave is a system of galleries and its
  // showcase marker sits in one of them; searching only there found nothing at all and left
  // the biome standing still, so every marker on the draft gets a turn.
  const anchors = (Array.isArray(around) ? around : [around])
    .filter(Boolean)
    .map((a) => ({ cx: Math.round(a.cx ?? draft.w / 2), cz: Math.round(a.cz ?? draft.h / 2) }));
  if (!anchors.length) anchors.push({ cx: draft.w >> 1, cz: draft.h >> 1 });

  const base = findRectangle(draft, anchors, { min, max, step, margin, preferTags });
  if (!base) return null;

  // **The rectangle is the FLOOR, not the shape.** It is what can be guaranteed — a
  // perimeter that is closed by construction and checkable in one pass — and a circuit that
  // turns four square corners does not read as a trail through a wood. So it is bent: each
  // `bump` displaces a straight run one cell sideways, which adds four corners and **cannot
  // open the ring**, because it replaces a path between two cells with another path between
  // the same two cells. Every bump is verified against the draft before it is kept, and a map
  // with no room for any of them keeps the rectangle rather than failing.
  const cells = growCorners(draft, base.cells, {
    corners, depth, preferTags, rng, margin,
  });

  // **The ring must START on a straight, and long enough for the whole queue.**
  //
  // `hunts.enter` stands the trainer on `cells[0]` and the lead Pokemon — the walker that
  // follows the route — lands `gap` cells ahead of it. That is only on the ring when the first
  // `gap` steps all go the same way, which a rectangle gives for free at a corner and a bent
  // circuit does not: the coast at twelve corners started one cell before a turn, put the head
  // off the path, and spent 690 of 800 ticks away from its own loop while `audit` called the
  // loop clean — because it was. Nobody was standing on it.
  const ordered = rotateToStraight(cells, straightLead);

  return {
    start: { cx: ordered[0].cx, cz: ordered[0].cz, dir: dirBetween(ordered[0], ordered[1]) },
    route: routeOf(ordered),
    cells: ordered,
    corners: cornerCount(ordered),
    w: base.w,
    h: base.h,
  };
}

/**
 * Stitches a **closed** circuit through an ordered list of waypoints — the authored
 * counterpart to `findLoop` above, and the one that actually gets tried first: a biome that
 * declares its own markers in the order it wants them visited gets a circuit through exactly
 * those markers, on the draft that was actually built, rather than one `findRectangle` happened
 * to grow near them. `findLoop` is what a caller falls back to when this fails.
 *
 * `points` is a plain list of cells — the ring is implicitly closed, the last point connecting
 * back to the first — and this function knows nothing about marker *names*; resolving a name to
 * a cell is the caller's job (`hunts/index.js`), exactly as `findLoop`'s own `around` is already
 * cells, not names.
 *
 * One **leg** per consecutive pair of points (`a -> b`, including the wraparound), built by
 * trying, in order:
 *
 *   1. An **X-then-Z elbow** — straight along X at `a`'s row, then straight along Z at `b`'s
 *      column — and its mirror, a **Z-then-X elbow**. Whichever is fully passable and crosses
 *      more `preferTags` ground wins; tied, X-first wins, so the result has no hidden rng.
 *   2. `bfsCells`, when *neither* elbow is fully passable, followed by one straightening pass:
 *      a raw BFS leg is shortest but shaped like a staircase, and a staircase inflates
 *      `cornerCount` and can leave the ring with no straight run at all — the coast defect
 *      `findLoop`'s own header used to document. The pass looks for the two most distant
 *      indices on a shared row or column and, if the direct segment between them is passable,
 *      splices it in — a cosmetic repair, not a shortest-path guarantee.
 *
 * A leg that cannot be built by any of the above fails the **whole ring** — `onLegFailed` is
 * told which pair and `stitchLoop` returns `null` — because silently routing around a waypoint
 * hands back a circuit nobody authored, in a shape nobody reviewed.
 *
 * The assembled ring is then held to exactly the standard `findLoop`'s own bumps already meet:
 * closed and passable (`isClosedWalk`), every cell distinct (a folded-back ring sterilises its
 * own shoulders — see `applyBump`'s overlap check above, and `Line.step`'s own comment in
 * `src/simulation/line.js` on why a 180-degree reversal is never special-cased), every cell at
 * least `margin` from the map edge (the stitched cells between authored markers may not satisfy
 * the camera framing the markers themselves were snapped for), and an opening straight run at
 * least `straightLead` long — checked independently of `rotateToStraight`, because that helper
 * silently returns the ring **unchanged** when nothing qualifies rather than reporting failure.
 *
 * @param {import('../terrain/index.js').MapDraft} draft
 * @param {{cx:number, cz:number}[]} points  ordered waypoints; the ring closes last -> first
 * @param {{straightLead?:number, preferTags?:string[], margin?:number, maxTiles?:number,
 *          onLegFailed?:(info:{index:number, from:object, to:object}) => void,
 *          onReject?:(reason:string) => void}} [opts]
 * @returns {{start:{cx:number,cz:number,dir:number}, route:string, cells:{cx:number,cz:number}[],
 *            corners:number, w:number, h:number, source:'authored'}|null}
 */
export function stitchLoop(draft, points, opts = {}) {
  const {
    straightLead = 4,
    preferTags = ['path', 'tallgrass'],
    margin = 11,
    maxTiles = 4096,
    onLegFailed = null,
    onReject = null,
  } = opts;

  const reject = (reason) => {
    if (onReject) onReject(reason);
    return null;
  };

  if (!Array.isArray(points) || points.length < 3) {
    return reject('need at least 3 waypoints');
  }

  // One leg per consecutive pair, wrapping the last point back to the first — the ring is
  // implicitly closed, never asked for as an explicit N+1th point.
  const legs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const leg = buildLeg(draft, a, b, { preferTags, maxTiles });
    if (!leg) {
      if (onLegFailed) onLegFailed({ index: i, from: a, to: b });
      return null;
    }
    legs.push(leg);
  }

  // Concatenate: the first leg in full, then every later leg minus its first cell (which
  // duplicates the previous leg's last cell). The final cell of the last leg duplicates
  // `points[0]` again — the ring closing — so it is popped rather than kept twice.
  const cells = legs[0].slice();
  for (let i = 1; i < legs.length; i++) cells.push(...legs[i].slice(1));
  cells.pop();

  // Held to exactly the standard the found loop already meets, first failure wins.
  if (!isClosedWalk(draft, cells)) return reject('stitched ring is not a valid closed walk');

  const seen = new Set();
  for (const c of cells) {
    const k = `${c.cx},${c.cz}`;
    if (seen.has(k)) return reject(`stitched ring revisits cell (${k})`);
    seen.add(k);
  }

  for (const c of cells) {
    if (c.cx < margin || c.cz < margin || c.cx > draft.w - margin || c.cz > draft.h - margin) {
      return reject(`cell (${c.cx},${c.cz}) is within ${margin} of the map edge`);
    }
  }

  // `rotateToStraight` silently returns the ring UNCHANGED when nothing qualifies, so its
  // result has to be independently checked rather than trusted — the same check
  // `hunts/index.js`'s own `stageOnLoop`/`straightAt` makes on the ring it is handed.
  const ordered = rotateToStraight(cells, straightLead);
  const n = ordered.length;
  const dir0 = dirBetween(ordered[0], ordered[1]);
  let lead = 0;
  while (lead < straightLead
    && dirBetween(ordered[lead % n], ordered[(lead + 1) % n]) === dir0) lead++;
  if (lead < straightLead) return reject('no opening straight run long enough');

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const c of ordered) {
    if (c.cx < minX) minX = c.cx;
    if (c.cx > maxX) maxX = c.cx;
    if (c.cz < minZ) minZ = c.cz;
    if (c.cz > maxZ) maxZ = c.cz;
  }

  return {
    start: { cx: ordered[0].cx, cz: ordered[0].cz, dir: dirBetween(ordered[0], ordered[1]) },
    route: routeOf(ordered),
    cells: ordered,
    corners: cornerCount(ordered),
    w: maxX - minX + 1,
    h: maxZ - minZ + 1,
    source: 'authored',
  };
}

/** One straight-line step, checked in the direction of travel — `dirBetween`'s own rule. */
function stepDir(dCx, dCz) {
  if (dCx === 1) return EAST_;
  if (dCx === -1) return WEST_;
  return dCz === 1 ? SOUTH_ : NORTH_;
}

/**
 * Walks a straight run of `steps` unit steps from `from` along `(dCx, dCz)` — exactly one of
 * which is non-zero — pushing each new cell onto `out`. Returns the final cell, or `null` the
 * moment a step is not passable in the direction it is taken.
 */
function walkStraight(draft, from, dCx, dCz, steps, out) {
  const dir = stepDir(dCx, dCz);
  let cx = from.cx; let cz = from.cz;
  for (let i = 0; i < steps; i++) {
    const nx = cx + dCx; const nz = cz + dCz;
    if (!draft.passable(nx, nz, dir)) return null;
    out.push({ cx: nx, cz: nz });
    cx = nx; cz = nz;
  }
  return { cx, cz };
}

/**
 * One elbow leg from `a` to `b`, inclusive: straight along X then straight along Z (`xFirst`),
 * or the mirror. `null` the instant either arm is not fully passable.
 */
function elbowLeg(draft, a, b, xFirst) {
  const cells = [{ cx: a.cx, cz: a.cz }];
  const dCx = Math.sign(b.cx - a.cx);
  const dCz = Math.sign(b.cz - a.cz);
  if (xFirst) {
    if (dCx !== 0 && !walkStraight(draft, a, dCx, 0, Math.abs(b.cx - a.cx), cells)) return null;
    const mid = { cx: b.cx, cz: a.cz };
    if (dCz !== 0 && !walkStraight(draft, mid, 0, dCz, Math.abs(b.cz - a.cz), cells)) return null;
  } else {
    if (dCz !== 0 && !walkStraight(draft, a, 0, dCz, Math.abs(b.cz - a.cz), cells)) return null;
    const mid = { cx: a.cx, cz: b.cz };
    if (dCx !== 0 && !walkStraight(draft, mid, dCx, 0, Math.abs(b.cx - a.cx), cells)) return null;
  }
  return cells;
}

/** How many of a leg's cells carry any tag in `preferTags`. */
function legTagScore(draft, cells, preferTags) {
  if (!preferTags?.length) return 0;
  let n = 0;
  for (const c of cells) {
    const tags = draft.tagsAt(c.cx, c.cz);
    if (tags && tags.some((t) => preferTags.includes(t))) n++;
  }
  return n;
}

/** The direct line between two cells that share a row or column, inclusive of `b`, or `null`. */
function straightSegment(draft, a, b) {
  const dCx = Math.sign(b.cx - a.cx);
  const dCz = Math.sign(b.cz - a.cz);
  const steps = Math.max(Math.abs(b.cx - a.cx), Math.abs(b.cz - a.cz));
  const out = [];
  const end = walkStraight(draft, a, dCx, dCz, steps, out);
  return end ? out : null;
}

/**
 * One cosmetic repair pass over a raw BFS leg: a grid BFS staircases around obstacles one cell
 * at a time, and every one of those steps is a corner `cornerCount` will later count. Repeatedly
 * finds the most distant pair of indices that share a row or column and whose direct segment is
 * passable, and splices the staircase between them for the straight line — not a shortest-path
 * guarantee, just enough to stop a BFS leg from reading as a zigzag.
 */
function straightenLeg(draft, cells) {
  let list = cells;
  for (let pass = 0; pass < 6; pass++) {
    let bestI = -1; let bestJ = -1; let bestSeg = null; let bestLen = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = list.length - 1; j > i + 1; j--) {
        if (j - i <= bestLen) break;                 // nothing left this row can beat the best
        if (list[i].cx !== list[j].cx && list[i].cz !== list[j].cz) continue;
        const seg = straightSegment(draft, list[i], list[j]);
        if (!seg) continue;
        bestI = i; bestJ = j; bestSeg = seg; bestLen = j - i;
      }
    }
    if (bestI < 0) break;
    list = [...list.slice(0, bestI + 1), ...bestSeg, ...list.slice(bestJ + 1)];
  }
  return list;
}

/**
 * One leg of a stitched ring: the better of the two elbows when both are passable, whichever
 * one is when only one is, or a straightened BFS walk when neither is.
 */
function buildLeg(draft, a, b, { preferTags, maxTiles }) {
  const legXZ = elbowLeg(draft, a, b, true);
  const legZX = elbowLeg(draft, a, b, false);
  if (legXZ && legZX) {
    const scoreXZ = legTagScore(draft, legXZ, preferTags);
    const scoreZX = legTagScore(draft, legZX, preferTags);
    return scoreZX > scoreXZ ? legZX : legXZ;         // tie -> X-then-Z, deterministic
  }
  if (legXZ) return legXZ;
  if (legZX) return legZX;

  const passable = (cx, cz, dir) => draft.passable(cx, cz, dir);
  const bfs = bfsCells(a, b, passable, { maxTiles });
  if (!bfs) return null;
  return straightenLeg(draft, bfs);
}

/**
 * Rotates a closed ring so it begins at the start of a run of at least `minRun` steps.
 *
 * Prefers the longest run, so the queue has the most room to string itself out before the
 * first turn. Returns the ring unchanged when nothing is long enough — which can only happen
 * on a circuit bent past the point of having any straights, and is then correctly the caller's
 * problem rather than silently the wrong start.
 */
export function rotateToStraight(cells, minRun = 3) {
  const runs = straightRuns(cells).filter((r) => r.len >= minRun);
  if (!runs.length) return cells;
  const best = runs.reduce((a, b) => (b.len > a.len ? b : a));
  const n = cells.length;
  return Array.from({ length: n }, (_, i) => cells[(best.start + i) % n]);
}

/** The guaranteed circuit: the largest passable rectangle perimeter that fits. */
function findRectangle(draft, anchors, { min, max, step, margin, preferTags = [] }) {
  const perimeter = (x, z, w, h) => {
    const cells = [];
    const legs = [[EAST_, w - 1], [SOUTH_, h - 1], [WEST_, w - 1], [NORTH_, h - 1]];
    let cx = x; let cz = z;
    for (const [dir, n] of legs) {
      for (let i = 0; i < n; i++) {
        cells.push({ cx, cz });
        const nx = cx + DX[dir];
        const nz = cz + DZ[dir];
        // `passable` is asked in the direction of travel, because a ledge is one-way and a
        // loop that can only be walked anticlockwise is not a loop.
        if (!draft.passable(nx, nz, dir)) return null;
        cx = nx; cz = nz;
      }
    }
    // It has to come home. A rectangle always does, but asserting it here is what makes this
    // function's promise checkable rather than merely intended.
    return (cx === x && cz === z) ? cells : null;
  };

  /**
   * **Every fitting rectangle is scored; the best one wins.**
   *
   * This used to return the FIRST rectangle that fit, walking height-major — `size` from `max`
   * down, and for each `size` a width from `size` down to `min`. So a **6x22 corridor** was
   * found and accepted before a 21x21 square was ever tried, because the whole width sweep at
   * size 22 runs before size 21 begins. Measured on the shipped meadow: the circuit came out a
   * 6x17 corridor at x 38-43, fifty cells of a 64x60 map, hugging one edge — with the campfire
   * that is the biome's only night practical **14 cells away** and the marker every showcase
   * frames 23 away. The party walked a corner of a map it never saw.
   *
   * Three things decide it now, and each is there for a reason a picture shows:
   *
   *   - **area**, because a bigger ring walks more of the map and holds more spawn slots;
   *   - **squareness**, because a corridor reads as a corridor and, at Chebyshev 2, its two
   *     sides compete for the same cells — which is why a narrow ring thins its own slots;
   *   - **composed ground**, the share of the ring standing on `preferTags`. This is what pulls
   *     the circuit onto the trail the biome laid, and with it past the lamps and props that
   *     make a frame worth looking at.
   *
   * Anchors keep their order as a gentle tie-break, so a biome's own `showcaseDefault` still
   * pulls the ring toward the place it wanted framed without being able to buy a bad shape.
   */
  const tagsOf = (cx, cz) => (typeof draft.tagsAt === 'function' ? draft.tagsAt(cx, cz) ?? [] : []);
  const wanted = new Set(preferTags ?? []);
  const composedFraction = (cells) => {
    if (!wanted.size || !cells.length) return 0;
    let n = 0;
    for (const c of cells) if (tagsOf(c.cx, c.cz).some((t) => wanted.has(t))) n++;
    return n / cells.length;
  };

  let best = null;
  for (let h = max; h >= min; h -= step) {
    for (let w = max; w >= min; w -= step) {
      for (let a = 0; a < anchors.length; a++) {
        const anchor = anchors[a];
        for (const [ox, oz] of NUDGES) {
          const x = anchor.cx - ((w / 2) | 0) + ox;
          const z = anchor.cz - ((h / 2) | 0) + oz;
          // **A camera-width clear of every edge.** The camera follows the trainer and the
          // trainer is ON the loop, so a circuit that runs near a border walks the frame off
          // the end of the world — the first meadow capture had a third of the screen in flat
          // sky. At ppu 32 a 640-wide buffer sees twenty cells across and about sixteen deep,
          // so eleven is the half-width plus a tile of slack.
          if (x < margin || z < margin) continue;
          if (x + w > draft.w - margin || z + h > draft.h - margin) continue;
          // Cheap rejections first: the score is only worth computing for a ring that closes.
          if (best && w * h <= best.floor) continue;
          const cells = perimeter(x, z, w, h);
          if (!cells) continue;
          const squareness = Math.min(w, h) / Math.max(w, h);
          const score = w * h
            * (0.45 + 0.55 * squareness)
            * (1 + 0.60 * composedFraction(cells))
            * (1 - 0.01 * Math.min(a, 20));
          if (!best || score > best.score) {
            // `floor` is the area below which no later candidate can possibly beat this one:
            // every multiplier above is at most `1 * 1.6 * 1`, so an area under `score / 1.6`
            // is hopeless. It turns an exhaustive sweep into one that stops looking early.
            best = { cells, w, h, x, z, score, floor: score / 1.6 };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Bends a closed ring until it has about `corners` corners.
 *
 * One **bump** takes a straight run of the ring and pushes it `d` cells sideways. The run's
 * two end cells stay where they are, so the result is still one closed circuit through the
 * same cells as before plus the displaced middle — closure is structural, not checked
 * afterwards and hoped for.
 *
 * Bumps that would leave the map, cross the ring, land on impassable ground or come within a
 * cell of the ring elsewhere are rejected. Among the survivors the one that puts the most
 * `preferTags` cells under the party wins, so a circuit drifts onto the composed trail rather
 * than ignoring it.
 */
function growCorners(draft, ring, { corners, depth, preferTags, rng, margin }) {
  let cells = ring.slice();
  const want = Math.max(4, corners | 0);
  const next = rng ? () => rng.next() : () => 0.5;
  const tagged = (c) => (preferTags.some((t) => draft.tagsAt(c.cx, c.cz).includes(t)) ? 1 : 0);
  const score = (list) => list.reduce((a, c) => a + tagged(c), 0);

  // **A circuit may not balloon into the whole room.** Without this the same bump wins every
  // pass — the highest-scoring one is always the deepest on the longest run — and it just
  // deepens one notch over and over: a 92-cell rectangle became a 216-cell one, still with six
  // corners, because deepening a notch adds none after the first.
  const cap = Math.round(ring.length * 1.55);

  for (let pass = 0; pass < 64 && cornerCount(cells) < want; pass++) {
    const runs = straightRuns(cells).filter((r) => r.len >= 6);
    if (!runs.length) break;
    // Shuffled, so bumps land all round the ring instead of stacking on the longest run.
    for (let k = runs.length - 1; k > 0; k--) {
      const q = Math.floor(next() * (k + 1));
      [runs[k], runs[q]] = [runs[q], runs[k]];
    }

    const before = cornerCount(cells);
    const baseScore = score(cells);
    const candidates = [];
    for (const run of runs) {
      for (const side of [1, -1]) {
        for (let d = Math.max(1, depth | 0); d >= 1; d--) {
          const bumped = applyBump(draft, cells, run, side, d, margin);
          if (!bumped) continue;
          if (bumped.length > cap) continue;
          // The point of a bump is a corner. One that adds none is a longer walk for nothing.
          if (cornerCount(bumped) <= before) continue;
          candidates.push({ cells: bumped, gain: score(bumped) - baseScore, d });
          break;                       // deepest that fits on this run and side
        }
      }
      // Eight is plenty to choose between and keeps a 200-cell ring from being O(n^2) a pass.
      if (candidates.length >= 8) break;
    }
    if (!candidates.length) break;

    // Whichever puts the most `preferTags` ground under the party — the composed trail, in
    // practice — and the shallower one when they tie, because a shallow bend reads as a bend
    // and a deep one reads as a detour.
    candidates.sort((a, b) => b.gain - a.gain || a.d - b.d);
    cells = candidates[0].cells;
  }
  return cells;
}

/** Contiguous runs of the ring that travel in one direction. */
function straightRuns(cells) {
  const n = cells.length;
  const dirs = cells.map((c, i) => dirBetween(c, cells[(i + 1) % n]));
  const runs = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && dirs[i] === dirs[start]) continue;
    if (i - start >= 3) runs.push({ start, len: i - start, dir: dirs[start] });
    start = i;
  }
  return runs;
}

/**
 * Displaces the middle of one run sideways by `d`, keeping both ends anchored.
 *
 * Returns a new ring, or `null` when any of the new ground is unusable. The rejection tests
 * are the ones that keep a bump from turning a circuit into a figure of eight: the displaced
 * cells may not touch the rest of the ring, and every step of the new path is checked in the
 * direction it is walked.
 */
function applyBump(draft, cells, run, side, d, margin) {
  const n = cells.length;
  const dir = run.dir;
  // Left or right of travel, in the 4-way basis.
  const perp = side > 0 ? (dir + 1) & 3 : (dir + 3) & 3;

  // The two cells that stay put. Everything between them is replaced, so the ring is still one
  // path between the same two points and closure is structural rather than hoped for.
  //
  // **One cell in from each end of the run, not right at the corners.** At a corner the
  // perpendicular to this run is parallel to the adjacent one, so the ladder's first step
  // lands exactly ON the neighbouring side — every one of the eight candidates a pass
  // produced was rejected as an overlap, and the corner count never moved off four.
  const from = run.start + 2;
  const to = run.start + run.len - 2;
  if (to - from < 1) return null;
  const A = cells[(from - 1) % n];
  const L = to - from + 2;                      // steps along `dir` from A to B
  const at = (a, b) => ({ cx: A.cx + DX[perp] * a + DX[dir] * b, cz: A.cz + DZ[perp] * a + DZ[dir] * b });

  // A -> out to depth d -> along the run -> back in, landing exactly on B.
  //
  // The first cut stitched straight from A to the displaced run and the two are a knight's
  // move apart (one along `dir`, d along `perp`), so every candidate failed the closed-walk
  // check and NO bump was ever applied — four corners on every biome at every setting. The
  // ladder out and the ladder back are what make the two ends meet.
  const inserted = [];
  for (let a = 1; a <= d; a++) inserted.push(at(a, 0));
  for (let b = 1; b <= L; b++) inserted.push(at(d, b));
  for (let a = d - 1; a >= 1; a--) inserted.push(at(a, L));

  const keep = [];
  for (let i = 0; i < n; i++) if (i < from || i > to) keep.push(cells[i]);
  const occupied = new Set(keep.map((c) => `${c.cx},${c.cz}`));

  for (const c of inserted) {
    if (c.cx < margin || c.cz < margin) return null;
    if (c.cx > draft.w - margin || c.cz > draft.h - margin) return null;
    if (!draft.passable(c.cx, c.cz, 0)) return null;
    // Overlap only, not adjacency: the ladder's first cell is a diagonal step from A, which is
    // *supposed* to be beside the ring. What must not happen is the bump landing ON the ring
    // somewhere else and turning one circuit into a figure of eight.
    if (occupied.has(`${c.cx},${c.cz}`)) return null;
  }

  const out = [];
  for (let i = 0; i < from; i++) out.push(cells[i]);
  out.push(...inserted);
  for (let i = to + 1; i < n; i++) out.push(cells[i]);

  return isClosedWalk(draft, out) ? out : null;
}


/** Every consecutive pair one 4-way step apart, passable, and the last pair closing the ring. */
export function isClosedWalk(draft, cells) {
  const n = cells.length;
  if (n < 8) return false;
  for (let i = 0; i < n; i++) {
    const a = cells[i];
    const b = cells[(i + 1) % n];
    const dx = b.cx - a.cx;
    const dz = b.cz - a.cz;
    if (Math.abs(dx) + Math.abs(dz) !== 1) return false;
    const dir = dx === 1 ? EAST_ : dx === -1 ? WEST_ : dz === 1 ? SOUTH_ : NORTH_;
    if (!draft.passable(b.cx, b.cz, dir)) return false;
  }
  return true;
}

const dirBetween = (a, b) => {
  if (b.cx > a.cx) return EAST_;
  if (b.cx < a.cx) return WEST_;
  return b.cz > a.cz ? SOUTH_ : NORTH_;
};

/** How many times the walk turns. Four for a rectangle, and the number this file is about. */
export function cornerCount(cells) {
  const n = cells.length;
  let turns = 0;
  for (let i = 0; i < n; i++) {
    const a = dirBetween(cells[i], cells[(i + 1) % n]);
    const b = dirBetween(cells[(i + 1) % n], cells[(i + 2) % n]);
    if (a !== b) turns++;
  }
  return turns;
}

/** Run-length encodes a ring back into the `'e8 s10 w8 n10'` spelling `parseRoute` reads. */
export function routeOf(cells) {
  const n = cells.length;
  const letter = ['s', 'w', 'n', 'e'];
  const out = [];
  let run = 0;
  let dir = dirBetween(cells[0], cells[1]);
  for (let i = 0; i < n; i++) {
    const d = dirBetween(cells[i], cells[(i + 1) % n]);
    if (d === dir) { run++; continue; }
    out.push(`${letter[dir]}${run}`);
    dir = d; run = 1;
  }
  out.push(`${letter[dir]}${run}`);
  return out.join(' ');
}


/**
 * Sunlit Meadow — open, gentle, and given a spine by things a farmer would have put there.
 *
 * The brief asks for "tall-grass patches with ragged edges rather than rectangles, flowers,
 * a fence line or a stream to give the eye somewhere to go". It gets both lines, crossing:
 *
 *  - a **brook** running roughly east-west, cut into the lawn (DECISIONS #28a — a lake
 *    palette digs in to −0.75, so the ground has to be cut out from under it or the whole
 *    thing is buried under its own grass with a clean console and nothing on screen);
 *  - a **fence line** running east-west along the field boundary. East-west is not a taste
 *    call: `fence_side_edge_w`'s rail panel lies in the plane x = 0.5, which is edge-on to
 *    a camera whose yaw never changes, and renders as a bare dark line (DECISIONS #29). The
 *    north-south boundaries are hedgerows instead.
 *
 * Trees appear only as a copse on the far northern edge, where they close the top of the
 * frame; the middle of a meadow is meant to be empty, and an isolated AdAstra tree at a
 * 45-degree camera shows the vertical sliver DECISIONS #29 measured.
 */

import {
  Field, fbm2, valueNoise, warpedFbm, scatterSpaced, clamp01, snug, walkableNear,
} from '../compose.js';
import { distanceField } from './forest.js';

export const MEADOW = {
  id: 'meadow',
  name: 'Sunlit Meadow',
  preset: 'meadow',
  tileset: 'bw2-adastra',
  w: 64,
  h: 60,
  weather: null,
  presets: {
    brook: { marker: 'brook', distance: 30, dir: 2 },
    bridge: { marker: 'bridge', distance: 22, dir: 2 },
    fence: { marker: 'fence', distance: 30, dir: 2 },
    grass: { marker: 'grass', distance: 30, dir: 2 },
    copse: { marker: 'copse', distance: 32, dir: 2 },
    wide: { marker: 'brook', distance: 46, dir: 2 },
    close: { marker: 'grass', distance: 16, dir: 2 },
    /** The judge plan asks every biome for `route`; here it is the track and the crossing. */
    route: { marker: 'bridge', distance: 26, dir: 2 },
  },
  showcaseDefault: 'brook',
};

export function buildMeadow(draft, ctx, palette, rng, log) {
  const W = draft.w, H = draft.h;
  const seed = draft.seed;

  const grass = palette.all({ category: 'ground', tags: ['grass'] }, 'the meadow');
  const tallGrass = palette.all({ category: 'plant', tags: ['tallgrass'] }, 'encounter grass');
  const tallTall = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) > 0.55);
  const tallLow = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) > 0.3 && (m.bounds?.max?.[1] ?? 0) <= 0.55);
  const tallFlat = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) <= 0.3);
  const bridges = palette.all({ category: 'bridge' }, 'a crossing over the brook');
  const flowers = palette.all({ category: 'plant', tags: ['flower'] });
  const hedges = palette.all({ category: 'plant', tags: ['hedge'] });
  const wideHedges = hedges.filter((m) => m.w > 1 && m.h === 1).sort((a, b) => b.w - a.w);
  const hedge1 = hedges.filter((m) => m.w === 1 && m.h === 1);
  const trees = palette.all({ category: 'tree', tags: ['tree'], maxCells: 4 }, 'the copse');
  const dirtPatch = palette.all({ category: 'path', tags: ['dirt'] })
    .filter((m) => !m.autotile && !m.tags.includes('sunken') && snug(m));

  // --------------------------------------------------------------- the brook
  //
  // Two sines again, but shallow: a stream that wanders too hard stops reading as water
  // finding the low ground and starts reading as a doodle.
  const brookAt = (cx) => 22 + Math.sin(cx * 0.075) * 5.5 + Math.sin(cx * 0.028 + 2.4) * 3;
  const brookHalf = (cx) => 1.2 + valueNoise(cx, 0, seed ^ 0x71c9, 7) * 1.1;
  const brook = new Field(W, H, (cx, cz) => Math.abs(cz + 0.5 - brookAt(cx)) < brookHalf(cx));
  brook.ragged(seed ^ 0x4d31, { amount: 0.22, period: 3 }).despeckle(3);

  // ---------------------------------------------------------- the field lines
  // The run reaches the **map edge**, and the gap in it is a gate rather than a hole. Round 1
  // stopped the fence at cx 6 and cx W-6, so on screen it ended in mid-air twice with nothing
  // to explain either end, and the gap where the track crosses read as a third break rather
  // than as a way through. A field boundary either leaves the frame or it is a gate.
  const FENCE_Z = 41;
  const GATE = [26, 32];
  const fenceRow = new Field(W, H, (cx, cz) => cz === FENCE_Z && cx >= 0 && cx < W
    && !(cx > GATE[0] && cx < GATE[1]));

  // --------------------------------------------------------------- the track
  const trackAt = (cz) => Math.round(29 + Math.sin(cz * 0.06 + 1.1) * 2.5);
  const track = new Field(W, H, (cx, cz) => Math.abs(cx - trackAt(cz)) <= 1 && !brook.get(cx, cz));
  track.despeckle(3).closeCorners();

  // ----------------------------------------------------------------- the copse
  const copse = new Field(W, H, (cx, cz) => cz < 7 + valueNoise(cx, 0, seed ^ 0x33aa, 9) * 5);

  // ------------------------------------------------------------------- ground
  //
  // The lawn is cut out under the brook. A lake palette runs from y 0 at the bank down to
  // −0.75 and its water is a sheet at −0.5, so a lawn laid across it hides all thirteen
  // slots and the water is invisible with nothing at all in the console.
  draft.fill({ x: 0, z: 0, w: W, h: H },
    (cx, cz) => (brook.get(cx, cz) ? null : palette.pick(grass, cx, cz)),
    { collision: 'walk', layer: 0 });

  palette.draw(draft, 'set1', brook, {
    underlay: true, collision: 'water', layer: 2, tags: ['water'],
  });

  palette.draw(draft, 'set0', track, { collision: 'walk', layer: 1, tags: ['path'] });
  if (dirtPatch.length) {
    track.forEach((cx, cz) => {
      if (valueNoise(cx, cz, seed ^ 0x915, 3) < 0.2) {
        draft.place(palette.pick(dirtPatch, cx, cz), cx, cz, { collision: 'walk', layer: 1 });
      }
    });
  }

  // --------------------------------------------------------------- tall grass
  //
  // Ragged blobs on their own lattice, thinned near the track and never in the water. The
  // ragged pass is what stops a threshold from producing rounded rectangles.
  const distToTrack = distanceField(track, W, H, 8);
  //
  // Round 1 thresholded plain `fbm2` at period 7 and then ran `ragged` over it. Dumping the
  // field itself (not the screenshot) showed why that fails: cells 2..17 x 39..55 came out a
  // solid 15x16 block whose right edge wobbled by exactly one cell, because `ragged` can only
  // flip *boundary* cells and a period-7 lattice has long straight level sets. One cell at
  // 35 screen pixels is not a shape, so the field shipped as a literal rectangle with a
  // vertical edge at x=520 (DECISIONS #37). Three changes, in order of effect: the sample
  // position is domain-warped by up to three cells, so the level set *bends*; the lattice
  // drops from 7 to 5 so a mass is a patch and not a field; and the boundary is fringed with
  // scattered outliers so it ends in speckle instead of in a line.
  const patches = new Field(W, H, (cx, cz) => {
    if (brook.get(cx, cz) || track.get(cx, cz) || copse.get(cx, cz)) return false;
    if (cx < 2 || cz < 2 || cx > W - 3 || cz > H - 3) return false;
    const near = clamp01(distToTrack[cz * W + cx] / 5);
    return warpedFbm(cx, cz, seed ^ 0x2b7f, { period: 5, detail: 0.4, amp: 3.2, warpPeriod: 6 })
      > 0.56 - near * 0.12;
  });
  patches.ragged(seed ^ 0x6611, { amount: 0.5, period: 2 }).despeckle(4);
  patches.fringe(seed ^ 0x6612, { reach: 2, density: 0.55, period: 2 });
  patches.subtract(brook).subtract(track).subtract(copse);
  // Core and edge, as in the wood: standing blades in the middle, flat decals on the rim, so
  // a patch fades into the field instead of ending in a wall of identical 0.6-tall cubes.
  const patchCore = patches.clone().shrink(1);
  patches.forEach((cx, cz) => {
    const core = patchCore.get(cx, cz);
    const pool = core && tallTall.length ? tallTall
      : (core && tallLow.length ? tallLow : (tallFlat.length ? tallFlat : tallGrass));
    const model = palette.pick(pool, cx, cz);
    if (model) draft.place(model, cx, cz, { collision: 'walk', layer: 5, tags: ['tallgrass', 'encounter'] });
  });

  // ------------------------------------------------------------------ flowers
  //
  // Drifts along the water, where they would actually be, rather than a field of confetti.
  const distToBrook = distanceField(brook, W, H, 10);
  if (flowers.length) {
    for (let cz = 1; cz < H - 1; cz++) {
      for (let cx = 1; cx < W - 1; cx++) {
        if (brook.get(cx, cz) || track.get(cx, cz) || patches.get(cx, cz) || copse.get(cx, cz)) continue;
        const d = distToBrook[cz * W + cx];
        if (d > 5) continue;
        if (fbm2(cx, cz, seed ^ 0xa5e1, 4, 0.55) < 0.55 + d * 0.06) continue;
        draft.place(palette.pick(flowers, cx, cz), cx, cz, { collision: 'walk', layer: 5 });
      }
    }
  }

  // ------------------------------------------------------------- the boundary
  //
  // `fence_corner` is a `line` set: a run is only the cells it passes through and each
  // piece's arms resolve from its own geometry, so a straight east-west run needs nothing
  // but the row itself.
  const fences = palette.set('set9') ? 'set9' : null;
  if (fences) palette.draw(draft, fences, fenceRow, { collision: 'block', layer: 4 });
  // Gate posts. `fence_cross` is the four-armed piece and is not in either autotile set, so
  // it is placed by hand at the two cells that flank the opening: the run now reads as a
  // fence with a gate in it, which is what a track through a field boundary actually is.
  const crossPost = palette.all({ category: 'fence' }).filter((m) => /cross/.test(m.name))[0] ?? null;
  if (crossPost) {
    for (const gx of [GATE[0], GATE[1]]) {
      if (gx > 0 && gx < W - 1) draft.place(crossPost, gx, FENCE_Z, { collision: 'block', layer: 4 });
    }
  }

  // Hedgerows close the north-south boundaries, where a fence would render as a line.
  const hedgeRuns = [
    { cx: 12, cz: 30, len: 9 },
    { cx: 44, cz: 26, len: 11 },
    { cx: 20, cz: 50, len: 7 },
  ];
  let laid = 0;
  for (const run of hedgeRuns) {
    let x = run.cx;
    while (x < run.cx + run.len) {
      const room = run.cx + run.len - x;
      const model = wideHedges.find((m) => m.w <= room) ?? hedge1[0];
      if (!model) break;
      if (!brook.get(x, run.cz) && !track.get(x, run.cz)) {
        draft.place(model, x, run.cz, { collision: 'block', layer: 4 });
        laid++;
      }
      x += model.w;
    }
  }

  // -------------------------------------------------------------- the copse
  //
  // Only at the far north edge: it closes the top of the frame so no shot ends in sky, and
  // it is far enough away that no single crown is read on its own.
  const copseCells = scatterSpaced(rng.fork('copse'), {
    rect: { x: 1, z: 0, w: W - 2, h: 12 },
    spacing: 2.1,
    accept: (cx, cz) => copse.get(cx, cz) && copse.get(cx + 1, cz) && copse.get(cx, cz + 1)
      && !track.get(cx, cz) && !track.get(cx + 1, cz),
  });
  for (const [cx, cz] of copseCells) {
    const model = palette.pick(trees, cx, cz, { salt: 3, baseWeight: 1 });
    if (model) draft.place(model, cx, cz, { collision: 'block', layer: 3, claim: false });
  }
  // A skirt of bushes so the copse meets the grass instead of ending in mid-air.
  if (hedge1.length) {
    for (let cx = 1; cx < W - 1; cx++) {
      for (let cz = 1; cz < 16; cz++) {
        if (!copse.get(cx, cz) || copse.get(cx, cz + 1)) continue;
        if (valueNoise(cx, cz, seed ^ 0x77c1, 3) > 0.45) {
          draft.place(palette.pick(hedge1, cx, cz), cx, cz + 1, { collision: 'block', layer: 4 });
        }
      }
    }
  }

  // --------------------------------------------------------------- the crossing
  //
  // The track walks straight into the water otherwise. A brook a walker cannot cross is the
  // one thing in this map that would read as unfinished rather than as pastoral, and
  // AdAstra ships the plank bridge for exactly this: `bridge_v2` is 1x3, sunken, and spans
  // a north-south crossing of an east-west stream in one piece.
  let bridgeAt = null;
  const nsBridge = bridges.filter((b) => b.h >= b.w).sort((a, b) => b.h - a.h)[0] ?? null;
  if (nsBridge) {
    const cx = trackAt(Math.round(brookAt(trackAt(30))));
    let z0 = 0, span = 0;
    for (let cz = 4; cz < H - 4; cz++) {
      if (brook.get(cx, cz)) { if (!span) z0 = cz; span++; } else if (span) break;
    }
    if (span) {
      const start = Math.max(1, z0 - Math.floor((nsBridge.h - span) / 2));
      // **Three of them, side by side.** `bridge_v2` is 1x3 — one cell wide — and the track it
      // carries is three, so a single plank necked a 190-pixel road down to 72 and back and
      // the crossing read as a fault in the map rather than as a bridge. The track's own
      // half-width is 1, so the deck runs cx-1..cx+1 and the road stays the road.
      for (let dx = -1; dx <= 1; dx++) {
        const bx = cx + dx;
        if (bx < 1 || bx >= W - 1) continue;
        draft.place(nsBridge, bx, start, { collision: 'walk', layer: 3, tags: ['path', 'bridge'], claim: false });
        for (let cz = start; cz < start + nsBridge.h; cz++) draft.setCollision(bx, cz, 'walk');
      }
      bridgeAt = { cx, cz: start + Math.floor(nsBridge.h / 2) };
    }
  }

  const mark = (name, cx, cz) => { const a = walkableNear(draft, cx, cz, 10); draft.mark(name, a.cx, a.cz); return a; };
  const spawnAt = walkableNear(draft, trackAt(H - 10), H - 10, 10);
  draft.spawn = { cx: spawnAt.cx, cz: spawnAt.cz, dir: 2 };
  mark('brook', bridgeAt?.cx ?? trackAt(30), (bridgeAt?.cz ?? 24) + 8);
  mark('bridge', bridgeAt?.cx ?? trackAt(30), (bridgeAt?.cz ?? 24) + 6);
  mark('fence', 20, FENCE_Z + 6);
  mark('grass', 46, 34);
  mark('copse', 30, 19);
  mark('spawn', draft.spawn.cx, draft.spawn.cz);

  return {
    stats: {
      brook: brook.count(), track: track.count(), tallGrass: patches.count(),
      hedges: laid, copse: copseCells.length,
    },
  };
}

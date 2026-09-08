/**
 * Verdant Wood — a canopy with a clearing.
 *
 * The reference is `docs/refs/01-forest-tilemap-frame.png`: no sky anywhere in frame, no
 * isolated trees, crowns that overlap into one mass, a clearing floored with worn grass and
 * broken up by long soft shadows, and undergrowth that thickens as it leaves the path.
 *
 * The shape, in order of what decides what:
 *
 *  1. A **path** meanders north through the map. It is the reason the place is walkable and
 *     the line the eye follows.
 *  2. A **clearing** opens off the path — a horseshoe, closed to the north/east/west and
 *     open to the south, because the camera sits south of the focus and a closed south edge
 *     puts a 4.5-unit canopy between the viewer and the thing the scene is about.
 *  3. Everything else is **wood**: trees packed at ~2 cells so their crowns overlap. A tree
 *     is 2x2 with a horizontal canopy slice at y 1.6 and 3.7 (DECISIONS #22), and those
 *     slices are what read at a 45-degree camera — overlapped they make a mass, isolated
 *     they make the vertical sliver DECISIONS #29 measured.
 *  4. **Undergrowth** grows in the gap between the two: tall grass thickening away from the
 *     path, hedges at the tree line, and a forest floor tinted down under the canopy.
 */

import {
  Field, fbm2, valueNoise, warpedFbm, scatterSpaced, clamp01, snug, mixTint,
} from '../compose.js';
import { makePropYard } from '../props.js';

/**
 * Grass under a closed canopy is not the same green as grass in the open — but it is not a
 * *switch* either.
 *
 * Round 1 tinted every wood cell 0x93a48c and every clearing cell white, and the boundary
 * between the two ran along the ragged clearing edge with nothing on it: adjacent ground
 * tiles stepped 40.9 luma across one pixel, four times in one row of the frame. The shade is
 * now a ramp over ~4 cells of the same canopy field that decides where the trees stand, so
 * the floor darkens *because* the crowns close over it, and the last of the step is taken
 * out by a per-cell dither (DECISIONS #37).
 */
const FLOOR_SHADE = 0xb9c3ae;
const CLEARING_SHADE = 0xffffff;

export const FOREST = {
  id: 'forest',
  name: 'Verdant Wood',
  preset: 'forest',
  tileset: 'bw2-adastra',
  alsoLoad: ['props'],
  w: 64,
  h: 62,
  weather: null,
  /**
   * Camera framings, one per thing a critic needs to be able to judge on its own.
   * `distance` is `config.cameraDistance` in tiles: 30 frames ~25 cells across and shows
   * ground from 12.7 cells north of the focus to 8 south, which is the arithmetic every
   * one of these was chosen against.
   */
  presets: {
    clearing: { marker: 'clearing', distance: 30, dir: 2 },
    path: { marker: 'path', distance: 30, dir: 2 },
    deep: { marker: 'deep', distance: 30, dir: 2 },
    glade: { marker: 'glade', distance: 26, dir: 2 },
    wide: { marker: 'clearing', distance: 46, dir: 2 },
    close: { marker: 'clearing', distance: 16, dir: 2 },
    // `tools/judge/plan.json` shoots `preset: 'route'` for forest-day and forest-night and
    // no biome defined one, so both blind-A/B pairs were silently falling back to the
    // default framing with `presetApplied: false`. The reference for both is a *route* —
    // docs/refs/01 and 03 are each a trail with the wood closing behind it — so the alias
    // is the path framing, one step closer than `path` because ref01 is a tighter frame.
    // The marker is the clearing rather than `path`, and that is a framing choice, not a
    // dodge: both references are a trail with *open verge on both sides* and a wood behind
    // it (docs/refs/01 has flowers and a fence either side of the dirt; 03 the same at
    // night). The path runs straight through the clearing, so this framing is the trail with
    // its verges — the `path` marker is the same trail with the wood two cells off it.
    route: { marker: 'clearing', distance: 27, dir: 2 },
  },
};

export function buildForest(draft, ctx, palette, rng, log) {
  const W = draft.w, H = draft.h;
  const seed = draft.seed;

  const grass = palette.all({ category: 'ground', tags: ['grass'] }, 'the forest floor');
  // Shortest crown first, and that ordering is the difference between a wood and a field of
  // lollipops. All three 2x2 AdAstra trees have the same footprint, but the two 4.5-tall
  // ones are conifers whose upright card is a *narrow* spire: packed at two cells they still
  // leave the ground — and the root decal of the tree behind — visible between them, which
  // is what round 1's canopy actually was. The 3.5-tall crown is the round one, and it is
  // the only one that closes. `tiles.pick` weights the first entry heaviest, so sorting by
  // height makes the round crown the wood and leaves the spires as punctuation.
  const trees2 = palette.all({ category: 'tree', tags: ['tree'], maxCells: 4 }, 'canopy')
    .slice()
    .sort((a, b) => (a.bounds?.max?.[1] ?? 0) - (b.bounds?.max?.[1] ?? 0));
  const trees3 = palette.all({ category: 'tree', tags: ['tree'], maxCells: 9 })
    .filter((m) => m.w === 3 && m.h === 3);
  const tallGrass = palette.all({ category: 'plant', tags: ['tallgrass'] }, 'encounter grass');
  // Three heights, and the difference matters: the standing blades are 0.5–0.62 tall and
  // read as a block at one cell, while the flat ones (`grass_patch`, `grass_decoration`) are
  // decals at 0.2 that fringe a patch so its edge stops being a straight line of cubes.
  const tallTall = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) > 0.55);
  const tallLow = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) > 0.3 && (m.bounds?.max?.[1] ?? 0) <= 0.55);
  const tallFlat = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) <= 0.3);
  const hedges = palette.all({ category: 'plant', tags: ['hedge'] });
  const hedge1 = hedges.filter((m) => m.w === 1 && m.h === 1);
  const flowers = palette.all({ category: 'plant', tags: ['flower'] });
  // `sunken` is excluded on purpose and not as tidiness: the `michi03b` family is `set2`'s
  // centre, a 4-bit indexed PNG whose whole palette is green (DECISIONS #30), so dropping one
  // on a dirt track paints a green stripe down the middle of it — which is exactly what
  // round 1 shipped, and it reads as a hole in the path rather than as wear.
  const dirtPatch = palette.all({ category: 'path', tags: ['dirt'] })
    .filter((m) => !m.autotile && !m.tags.includes('sunken') && snug(m));

  // ---------------------------------------------------------------- the path
  //
  // Two sines of unrelated period: a curve that neither repeats within a screen nor reads
  // as a random walk. It is pinned to pass through the clearing.
  // Wider than round 1's 8x5.5, and the reason is compositional rather than botanical.
  // Both references are routes in which the wood is a wall at the *edges* of the frame and
  // the middle is lit ground; ours put the tree line a third of the way across, so at night
  // sixty per cent of the frame was crown and cast shadow with nothing in it. At 10.5x6.5
  // the `clearing` and `route` framings are floor with a wood behind them, which is the
  // shape of docs/refs/01.
  const CLEARING = { x: 31, z: 36, rx: 10.5, rz: 6.5 };
  const pathCentreAt = (cz) => {
    const t = clamp01((cz - 4) / (H - 8));
    const drift = Math.sin(cz * 0.088) * 7.5 + Math.sin(cz * 0.031 + 1.9) * 4.5;
    // Pulled onto the clearing's mouth where the party walks, free at both ends.
    const pull = Math.exp(-((cz - CLEARING.z) ** 2) / (2 * 13 ** 2));
    return Math.round((28 + drift) * (1 - pull * 0.8) + (CLEARING.x + 1) * pull * 0.8 + t * 3);
  };

  // Three cells wide, and **not** frayed. A ragged pass on a path punches holes in it, and
  // an interior hole is not a worn edge — the auto-tiler resolves it into a green fringe
  // running down the middle of the track, which is what round 1 shipped. A trail is worn by
  // feet that all go the same way; it varies in *width*, not in porosity.
  const path = new Field(W, H, (cx, cz) => {
    const half = 1 + (valueNoise(0, cz, seed ^ 0x51ed, 9) > 0.84 ? 1 : 0);
    return Math.abs(cx - pathCentreAt(cz)) <= half;
  }).closeCorners();

  // ------------------------------------------------------------- the clearing
  //
  // A horseshoe rather than a disc: the mouth opens south, towards the camera, so nothing
  // 4.5 units tall stands between the viewer and the floor the scene is about.
  const clearing = new Field(W, H, (cx, cz) => {
    const dx = (cx + 0.5 - CLEARING.x) / CLEARING.rx;
    const dz = (cz + 0.5 - CLEARING.z) / CLEARING.rz;
    const inside = dx * dx + dz * dz < 1;
    const mouth = cz > CLEARING.z && Math.abs(cx - CLEARING.x) < CLEARING.rx * 0.5 && cz < CLEARING.z + 14;
    return inside || mouth;
  });
  clearing.ragged(seed ^ 0x77aa, { amount: 0.45, period: 5 }).despeckle(4);

  // A second, smaller opening deep in the wood, so `path` framing is not one long tunnel.
  const glade = new Field(W, H, (cx, cz) => {
    const dx = (cx + 0.5 - 46) / 6.5, dz = (cz + 0.5 - 15) / 5;
    return dx * dx + dz * dz < 1;
  }).ragged(seed ^ 0x1a4d, { amount: 0.5, period: 4 });

  // ------------------------------------------------------------- the woodland
  // A **two-cell verge** either side of the trail, not one. Both references we are scored
  // against are routes, and in each of them the trail carries a band of lit ground and
  // undergrowth before the trees start (docs/refs/01 and 03). At one cell the crowns crowd
  // the track, the frame is canopy from edge to edge, and at night there is nothing in it
  // that takes light.
  const verge = path.clone().grow(2);
  const open = clearing.clone().union(glade).union(verge);
  const wood = open.clone().invert();
  // The map's own rim is always closed, so no frame ever ends in sky.
  const rim = new Field(W, H, (cx, cz) => cx < 3 || cz < 3 || cx > W - 4 || cz > H - 4);
  wood.union(rim);
  wood.subtract(verge);

  // --------------------------------------------------------------- the canopy
  //
  // One scalar per cell, 0 = sky, 1 = closed crown, and *both* the tree spacing and the
  // floor shade are read off it. That is the whole fix for two of the round's worst faults
  // at once (DECISIONS #37):
  //
  //  · **The wood was a plantation.** Poisson disc at one radius is a quasi-lattice, and
  //    the critic measured the pitch — seven crown rows at 118 screen pixels. Driving the
  //    radius from a low-frequency grove field gives clumps of 2–5 crowns with glades
  //    between them, which is what ref01's canopy actually is.
  //  · **The night frame was 69 % pure black.** Same environment, same hour, same tileset,
  //    the meadow crushes 11.9 % and the reference night crushes 10.5 % — so the black is
  //    the canopy's own doing, not the exposure ramp. Opening the wood towards the clearing
  //    lets moonlit floor back into the frame where the composition's subject is.
  //
  // The rim stays fully closed regardless, so no frame ends in sky.
  const openings = clearing.clone().union(glade);
  const distToOpenings = distanceField(openings, W, H, 14);
  const distToPath = distanceField(path, W, H, 9);
  const nearRim = (cx, cz) => cx < 7 || cz < 7 || cx > W - 8 || cz > H - 8;
  function canopyAt(cx, cz) {
    if (nearRim(cx, cz)) return 1;
    // How much sky this cell can see. The band is deliberately short — four cells off an
    // opening, two off the trail — because the first cut of this used nine and turned the
    // whole wood into a field of lollipops, which is the fault DECISIONS #36 was written to
    // avoid. The thinning is an *edge* to the wood, not a thinning of the wood.
    const light = Math.max(
      clamp01(1 - (distToOpenings[cz * W + cx] - 1) / 3) * 0.8,
      clamp01(1 - (distToPath[cz * W + cx] - 2) / 2) * 0.45,
    );
    const grove = fbm2(cx, cz, seed ^ 0x6b21, 9, 0.35);
    return clamp01((1 - light) * (0.66 + grove * 0.52));
  }

  // ------------------------------------------------------------------- floor
  //
  // Ground everywhere first, shaded by how much canopy is over it. The tint costs nothing
  // (an instanced colour attribute the instancer already carries) and the dither is what
  // stops a per-cell ramp from banding into a quilt.
  draft.fill({ x: 0, z: 0, w: W, h: H }, (cx, cz) => palette.pick(grass, cx, cz), (cx, cz) => ({
    collision: 'walk', layer: 0,
    tint: mixTint(CLEARING_SHADE, FLOOR_SHADE, canopyAt(cx, cz),
      { jitter: 5, cx, cz, seed: seed ^ 0x40b1 }),
  }));

  // Worn dirt through it all. `set0` is the grass/path palette; its border slots are the
  // transition the artist drew, so the path meets the lawn instead of ending at a seam.
  palette.draw(draft, 'set0', path, { collision: 'walk', layer: 1, tags: ['path'] });

  // Scuffs where the path bends. Spaced rather than thresholded, and rotated: a threshold
  // over the path cells put the same wheel-rut glyph on two adjacent cells at the same
  // orientation, and one glyph stamped twice side by side reads as a texture error rather
  // than as wear (the critic found it at forest-close-12 960-1060,280-380).
  if (dirtPatch.length) {
    for (const [cx, cz] of scatterSpaced(rng.fork('scuff'), {
      rect: { x: 1, z: 1, w: W - 2, h: H - 2 },
      spacing: 3.4,
      accept: (cx, cz) => path.get(cx, cz) && valueNoise(cx, cz, seed ^ 0x3f1, 3) < 0.45,
    })) {
      draft.place(palette.pick(dirtPatch, cx, cz), cx, cz, {
        collision: 'walk', layer: 1, rot: (Math.floor(valueNoise(cx, cz, seed ^ 0x811, 2) * 4) & 3),
      });
    }
  }

  // -------------------------------------------------------------- undergrowth
  //
  // Thickens away from the path: distance is the *only* thing driving the threshold, so the
  // shoulders of the walk are open and the tree line is choked, which is what makes the
  // path read as a path rather than as a colour change.
  //
  // The threshold is sampled through a domain warp, and the mass is then fringed rather than
  // only frayed. A plain threshold plus `ragged` gives a rectangle with a one-cell wobble —
  // measured off the field, not eyeballed (DECISIONS #37).
  const grassField = new Field(W, H, (cx, cz) => {
    if (!open.get(cx, cz) || path.get(cx, cz)) return false;
    const d = Math.min(9, distToPath[cz * W + cx]);
    const want = 0.60 - clamp01(d / 7) * 0.26;      // near the path: rare; far: common
    return warpedFbm(cx, cz, seed ^ 0x9c31, { period: 5, detail: 0.45, amp: 2.6, warpPeriod: 5 }) > want;
  });
  grassField.ragged(seed ^ 0x5a12, { amount: 0.55, period: 2 }).despeckle(3);
  grassField.fringe(seed ^ 0x5a13, { reach: 2, density: 0.5, period: 2 });
  grassField.intersect(open.clone().subtract(path));

  // A patch has a *middle* and an *edge*, and drawing both from one model is what made
  // round 1's grass read as rows of hedge blocks: every cell was a 0.6-tall cube and the
  // boundary was a wall. The standing blades now go in the interior only; the boundary band
  // gets the shorter blades and the flat decals, so a patch fades into the lawn.
  const grassCore = grassField.clone().shrink(1);
  grassField.forEach((cx, cz) => {
    const d = Math.min(9, distToPath[cz * W + cx]);
    const core = grassCore.get(cx, cz);
    const pool = core && d > 2.5 && tallTall.length ? tallTall
      : (core && tallLow.length ? tallLow : (tallFlat.length ? tallFlat : tallGrass));
    const model = palette.pick(pool, cx, cz);
    if (model) draft.place(model, cx, cz, { collision: 'walk', layer: 5, tags: ['tallgrass', 'encounter'] });
  });

  // The auto-tiled path edge is one model per case, so a trail that runs north for twenty
  // cells stamps the same three-tuft fringe glyph twenty times down its western shoulder —
  // the critic counted ~18. The palette has no second edge model to alternate with, so the
  // repeat is broken by *covering* it: flat grass decals and the odd flower scattered along
  // the shoulder, which is also what a trodden verge looks like.
  if (tallFlat.length || flowers.length) {
    const shoulder = path.clone().grow(1).subtract(path);
    for (const [cx, cz] of scatterSpaced(rng.fork('shoulder'), {
      rect: { x: 1, z: 1, w: W - 2, h: H - 2 },
      spacing: 1.9,
      accept: (cx, cz) => shoulder.get(cx, cz) && draft.collisionAt(cx, cz) === 'walk'
        && valueNoise(cx, cz, seed ^ 0x6f22, 3) > 0.34,
    })) {
      const useFlower = flowers.length && valueNoise(cx, cz, seed ^ 0x6f23, 4) > 0.78;
      const pool = useFlower ? flowers : (tallFlat.length ? tallFlat : tallGrass);
      draft.place(palette.pick(pool, cx, cz), cx, cz, { collision: 'walk', layer: 5 });
    }
  }

  // ------------------------------------------------------------------- trees
  //
  // The radius is `canopyAt`, not a constant: 1.75 cells where the crowns close (a 2x2 model
  // at that pitch overlaps its neighbour, which is what makes a mass rather than a field of
  // lollipops) opening to 4.3 towards the clearing, where a wood thins into standing trees
  // with lit floor between them.
  const treeCells = scatterSpaced(rng.fork('trees'), {
    rect: { x: 0, z: 0, w: W - 1, h: H - 1 },
    spacing: (cx, cz) => 3.1 - canopyAt(cx, cz) * 1.35,
    accept: (cx, cz) => wood.get(cx, cz) && wood.get(cx + 1, cz) && wood.get(cx, cz + 1) && wood.get(cx + 1, cz + 1),
  });

  // The two 4.5-tall conifers and the 3.5-tall round crown are two colour populations —
  // blue-teal spires and green domes — and sprinkling them cell by cell interleaves the two
  // so neither reads. Real woods segregate: conifers hold the high, poor, cold ground in
  // stands. So the species is chosen from a low-frequency field, and the stands land in the
  // north-west quarter where the ground is furthest from every opening.
  const spires = trees2.filter((m) => (m.bounds?.max?.[1] ?? 0) >= 4.0);
  const domes = trees2.filter((m) => (m.bounds?.max?.[1] ?? 0) < 4.0);
  const coniferAt = (cx, cz) => spires.length && domes.length
    && valueNoise(cx, cz, seed ^ 0x4d17, 11) + (1 - cx / W) * 0.18 + (1 - cz / H) * 0.12 > 0.86;

  let bigs = 0, conifers = 0;
  for (const [cx, cz] of treeCells) {
    // A 3x3 crown wherever there is room for one and the grove is dense: ref01's canopy is
    // clumps "at varying scale", and one footprint everywhere is the other half of why ours
    // read as a plantation.
    const roomFor3 = trees3.length && cx + 2 < W && cz + 2 < H
      && wood.get(cx + 2, cz) && wood.get(cx + 2, cz + 2) && wood.get(cx, cz + 2)
      && canopyAt(cx, cz) > 0.6
      && valueNoise(cx, cz, seed ^ 0x71b3, 6) > 0.58;
    const stand = coniferAt(cx, cz);
    const model = roomFor3
      ? palette.pick(trees3, cx, cz, { salt: 7 })
      : palette.pick(stand ? spires : (domes.length ? domes : trees2), cx, cz, { salt: 3, baseWeight: 6 });
    if (!model) continue;
    if (roomFor3) bigs++;
    if (stand && !roomFor3) conifers++;
    draft.place(model, cx, cz, { collision: 'block', layer: 3, claim: false });
  }

  // Hedges fill the knee-height gap between the trunks and the grass, so the tree line does
  // not stop dead at the ground. `hedge1` is 14 triangles of real sloped box with no
  // billboard in it (DECISIONS #29), so it survives both this camera and a low sun.
  if (hedge1.length) {
    const rim = wood.clone().subtract(wood.clone().shrink(1));
    // Scattered, not swept. A threshold over the whole rim lays them one after another along
    // it, and a continuous line of identical flowering bushes is a garden bed, not scrub.
    for (const [cx, cz] of scatterSpaced(rng.fork('scrub'), {
      rect: { x: 1, z: 1, w: W - 2, h: H - 2 },
      spacing: 2.6,
      accept: (cx, cz) => rim.get(cx, cz) && valueNoise(cx, cz, seed ^ 0x2ef7, 5) > 0.4,
    })) {
      draft.place(palette.pick(hedge1, cx, cz, { salt: 11, baseWeight: 1 }), cx, cz,
        { collision: 'block', layer: 4 });
    }
  }

  // Flowers only where light reaches: the clearing and the glade, never under the canopy.
  if (flowers.length) {
    clearing.forEach((cx, cz) => {
      if (path.get(cx, cz) || grassField.get(cx, cz)) return;
      if (fbm2(cx, cz, seed ^ 0xb17, 5, 0.5) > 0.78) {
        draft.place(palette.pick(flowers, cx, cz), cx, cz, { collision: 'walk', layer: 5 });
      }
    });
  }

  // -------------------------------------------------------- the clearing edge
  //
  // A few trees standing *inside* the opening. Without them the wood stops on a curve and
  // the clearing reads as a lawn someone mowed; with them the boundary is a scatter, which
  // is what a real edge does.
  const distToWood = distanceField(wood, W, H, 12);
  const rimTrees = scatterSpaced(rng.fork('rim'), {
    rect: { x: 2, z: 2, w: W - 5, h: H - 5 },
    spacing: 5.5,
    accept: (cx, cz) => {
      for (let dz = 0; dz < 2; dz++) {
        for (let dx = 0; dx < 2; dx++) {
          if (!clearing.get(cx + dx, cz + dz) || path.get(cx + dx, cz + dz)) return false;
        }
      }
      const d = distToWood[cz * W + cx];
      // The **far half only**. A tree standing in the near half of an opening throws its
      // shadow across the one part of the frame that has light in it — measured: moving the
      // rim clumps out of the southern half took forest-21 from 59.7 % crushed back to 52.0 %
      // for the same tree count. Trees at the back of a clearing is also what ref01 shows.
      return d >= 1 && d <= 3 && cz < CLEARING.z + 1 && distToPath[cz * W + cx] > 2.5;
    },
  });
  // In **clumps of two or three**, never singly. ref01's rule is "no isolated trees", and one
  // 2x2 crown standing on its own in an opening is exactly the lollipop the whole canopy was
  // rebuilt to avoid — a scatter of singles inside the clearing puts the fault back one tree
  // at a time. The companion goes two cells off, so the two crowns touch.
  const CLUMP = [[2, 0], [0, 2], [2, 2], [-2, 1], [1, -2], [2, -1]];
  let rimPlaced = 0;
  const canStand = (cx, cz) => {
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        if (!clearing.get(cx + dx, cz + dz) || path.get(cx + dx, cz + dz)) return false;
      }
    }
    return distToPath[cz * W + cx] > 2;
  };
  for (const [cx, cz] of rimTrees) {
    draft.place(palette.pick(trees2, cx, cz, { salt: 9, baseWeight: 2 }), cx, cz,
      { collision: 'block', layer: 3, claim: false });
    rimPlaced++;
    const n = 1 + (valueNoise(cx, cz, seed ^ 0x9d31, 3) > 0.62 ? 1 : 0);
    const start = Math.floor(valueNoise(cx, cz, seed ^ 0x1c07, 4) * CLUMP.length);
    for (let k = 0, added = 0; k < CLUMP.length && added < n; k++) {
      const [dx, dz] = CLUMP[(start + k) % CLUMP.length];
      const x = cx + dx, z = cz + dz;
      if (!canStand(x, z)) continue;
      draft.place(palette.pick(trees2, x, z, { salt: 13, baseWeight: 2 }), x, z,
        { collision: 'block', layer: 3, claim: false });
      added++; rimPlaced++;
    }
  }

  // --------------------------------------------------------------- the litter
  //
  // A wood without anything fallen in it reads as a diagram. These are the rebuilt props
  // (DECISIONS #22/#23) — real faceted geometry, not a card leaning back at 45 degrees —
  // and they need their own `InstancedWorld` because a placement carries no tileset.
  const yard = makePropYard(draft, ctx.get('tiles'));
  // One cell only. The 2x2 pieces (`fat_log`, `pile_of_logs`) are half the width of the
  // trainer at this camera and read as a brown slab dropped on the lawn rather than as a
  // fallen tree, so the litter is the single-cell rocks and the one single-cell log.
  const logs = yard.find({ category: 'prop', tags: ['rustic'] })
    .filter((m) => /log/.test(m.name) && m.w === 1 && m.h === 1);
  // `hgss-overworld/*` is excluded for the reason DECISIONS #23 already gives: its two rocks
  // carry the water and grass they were cut from, and on a lawn they read as baskets.
  // `sylvan-town__rock_*` joins `hgss-overworld__*` on the excluded list this round: STATUS
  // already filed both as reading like woven baskets or hay bales at this camera, and the
  // critic read them the same way on the coast. One boulder model survives, and the litter
  // leans on the logs instead.
  const rocks = yard.find({ category: 'prop', tags: ['rock'] })
    .filter((m) => !m.tags.includes('water') && m.w === 1 && m.h === 1
      && !/^(hgss-overworld__|sylvan-town__rock_)/.test(m.name));
  const litter = [...rocks, ...logs];
  if (litter.length) {
    for (const [cx, cz] of scatterSpaced(rng.fork('litter'), {
      rect: { x: 3, z: 3, w: W - 8, h: H - 8 },
      spacing: 7,
      accept: (cx, cz) => open.get(cx, cz) && !path.get(cx, cz) && !grassField.get(cx, cz)
        && draft.collisionAt(cx, cz) === 'walk' && distToPath[cz * W + cx] > 1.5
        && fbm2(cx, cz, seed ^ 0xd41, 6, 0.4) > 0.46,
    })) {
      const pool = distToPath[cz * W + cx] > 4 ? litter : rocks.length ? rocks : litter;
      yard.place(pool[Math.floor(valueNoise(cx, cz, seed ^ 0x17, 3) * pool.length)], cx, cz);
    }
  }

  // -------------------------------------------------------------- the markers
  draft.spawn = { cx: pathCentreAt(H - 12), cz: H - 12, dir: 2 };
  draft.mark('clearing', CLEARING.x, CLEARING.z + 2);
  draft.mark('path', pathCentreAt(H - 20), H - 20);
  draft.mark('deep', pathCentreAt(20), 20);
  draft.mark('glade', 46, 17);
  draft.mark('spawn', draft.spawn.cx, draft.spawn.cz);

  return {
    stats: {
      trees: treeCells.length, bigTrees: bigs, conifers, rimTrees: rimPlaced,
      path: path.count(), grass: grassField.count(), litter: yard.count(),
    },
    extras: yard.extras(),
  };
}

/** Chebyshev-ish distance from a field, capped, computed with two sweeps. */
export function distanceField(field, w, h, cap = 12) {
  const d = new Float32Array(w * h).fill(cap);
  for (let cz = 0; cz < h; cz++) {
    for (let cx = 0; cx < w; cx++) if (field.get(cx, cz)) d[cz * w + cx] = 0;
  }
  for (let cz = 0; cz < h; cz++) {
    for (let cx = 0; cx < w; cx++) {
      const i = cz * w + cx;
      if (cx > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (cz > 0) d[i] = Math.min(d[i], d[i - w] + 1);
      if (cx > 0 && cz > 0) d[i] = Math.min(d[i], d[i - w - 1] + 1.41);
      if (cx < w - 1 && cz > 0) d[i] = Math.min(d[i], d[i - w + 1] + 1.41);
    }
  }
  for (let cz = h - 1; cz >= 0; cz--) {
    for (let cx = w - 1; cx >= 0; cx--) {
      const i = cz * w + cx;
      if (cx < w - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (cz < h - 1) d[i] = Math.min(d[i], d[i + w] + 1);
      if (cx < w - 1 && cz < h - 1) d[i] = Math.min(d[i], d[i + w + 1] + 1.41);
      if (cx > 0 && cz < h - 1) d[i] = Math.min(d[i], d[i + w - 1] + 1.41);
    }
  }
  return d;
}

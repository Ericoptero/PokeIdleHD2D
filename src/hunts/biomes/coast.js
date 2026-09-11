/**
 * Saltspray Coast — the sea meets the land, and the two are different water.
 *
 * The measurement that decides the whole map: `set7 walk_edge` is the **shallows**
 * (`walkable_water_center`, tagged `wadeable`, a sheet at −0.65 with a surf border), while
 * the model named `sea` is the **deep** water — two flat quads, a translucent surface at
 * +0.3125 over an opaque bed at −0.5. Using the shallows for open sea makes a whole ocean
 * of ankle-deep sand-coloured water, so they are drawn as two regions that meet, not as
 * one.
 *
 * The sea is to the **north**. The camera's yaw never changes and it shows ground from
 * about 12.7 cells north of the focus to 8 south, so north is the far half of every frame:
 * putting the water there is what lets a shot read as "standing on the beach looking out",
 * and it is the one biome where sky at the top of the frame is correct.
 */

import {
  Field, valueNoise, fbm2, warpedFbm, scatterSpaced, clamp01, snug, mixTint, wildCells,
  laneNear,
} from '../compose.js';
import { distanceField } from './forest.js';
import { set0Outward } from '../palette.js';

export const COAST = {
  id: 'coast',
  name: 'Saltspray Coast',
  preset: 'coast',
  tileset: 'bw2-adastra',
  alsoLoad: ['props'],
  w: 66,
  h: 54,
  /**
   * The trainer level `travel` asks for before it will come here (ARCHITECTURE §5.16).
   *
   * Authored HERE and not in `travel`, because what a destination *is* stays with the
   * scene that owns it. deeper water rows and a table that starts to bite.
   */
  requiredLevel: 12,
  weather: null,
  presets: {
    // Three cells of camera toward the sea. The marker stands eight cells inland of
    // `shoreAt(cx)`, which put the shoreline and the water in the top third of the frame when
    // the perspective camera showed 20.7 cells of ground depth; the orthographic one shows
    // 15.9 (DECISIONS #60), which left the biome named for the sea with a sliver of it against
    // the top edge. The zoom is not the lever here — 16 would halve the detail of a shot that
    // exists to show shoreline autotiles — so the camera moves instead.
    shore: { marker: 'shore', ppu: 32, offset: [0, -3] },
    dunes: { marker: 'dunes', ppu: 32 },
    point: { marker: 'point', ppu: 32 },
    sea: { marker: 'sea', ppu: 32 },
    wide: { marker: 'shore', ppu: 16 },
    close: { marker: 'shore', ppu: 64 },
    /** Every biome answers `route` (the blind-A/B framing); here it is the strand along the bay. */
    route: { marker: 'shore', ppu: 32 },
  },
  showcaseDefault: 'shore',
  /**
   * The strand runs east-west, which is why this is the one biome three blind rounds said
   * read correctly: the party files across the frame instead of up it. Everything else in
   * `hunts` is now built to do the same.
   */
};

/** Where the sea's surface sits, so the deep water is flush with the shallows sheet. */
const SHALLOW_Y = -0.65;
const SEA_SURFACE_DY = 0.3125;      // `sea`'s translucent top, above its own placement y

export function buildCoast(draft, ctx, palette, rng, _log) {
  const W = draft.w, H = draft.h;
  const seed = draft.seed;

  const grass = palette.all({ category: 'ground', tags: ['grass'] }, 'the dunes');
  const seaDeep = palette.all({ category: 'water' })
    .filter((m) => m.name === 'sea' || (m.tags.includes('water') && !m.tags.includes('shallows')
      && !m.tags.includes('surf') && (m.bounds?.max?.[1] ?? 0) > 0.2))[0] ?? null;
  const tallGrass = palette.all({ category: 'plant', tags: ['tallgrass'] });
  const flowers = palette.all({ category: 'plant', tags: ['flower'] });
  const hedges = palette.all({ category: 'plant', tags: ['hedge'] }).filter((m) => m.w === 1 && m.h === 1);
  const trees = palette.all({ category: 'tree', tags: ['tree'], maxCells: 4 });
  const dirtPatch = palette.all({ category: 'path', tags: ['dirt'] })
    .filter((m) => !m.autotile && !m.tags.includes('sunken') && snug(m));

  // ------------------------------------------------------------ the coastline
  //
  // One bay and one point. A straight shoreline reads as a map edge; a curve reads as a
  // coast, and the point gives the eye a place to stop.
  //
  // The point was a **symmetric Gaussian**, and a symmetric Gaussian quantised onto a grid is
  // a symmetric zigzag pyramid — which is exactly what the critic measured at coast-point-12
  // and it cannot read as a headland. A headland is not symmetric: the windward side is cut
  // steep and the lee side trails off into a spit. So the two halves get different sigmas,
  // and the whole line is warped by noise rather than only frayed one cell at a time.
  const point = (cx) => {
    const d = cx - 50;
    const sigma = d < 0 ? 9.5 : 4.5;                 // long approach, short steep nose
    return Math.exp(-(d * d) / (2 * sigma * sigma)) * (d < 0 ? 8.5 : 10.5);
  };
  const shoreAt = (cx) => 26
    + Math.sin(cx * 0.072 + 0.6) * 5.5              // the bay
    + Math.sin(cx * 0.031 + 2.1) * 3.2
    + Math.sin(cx * 0.19 + 0.9) * 1.4               // the small stuff, so it is never a ruler
    + (valueNoise(cx, 0, seed ^ 0x5c11, 5) - 0.5) * 4.6   // and the coast is not a function
    - point(cx);
  const water = new Field(W, H, (cx, cz) => cz + 0.5 < shoreAt(cx));
  water.ragged(seed ^ 0x2a41, { amount: 0.45, period: 3 }).despeckle(6);
  // **Orphan land, killed at the source.** Round 1 despeckled the *water* and never the land,
  // so one- and two-cell grass islands with sand rims floated in the open sea at
  // (450-620, 0-45) and (1500-1600, 120-190). Despeckling the complement and inverting it
  // back drowns them, and the same pass fills any stray one-cell puddle inland.
  const dryland = water.clone().invert().despeckle(12);
  water.bits.set(dryland.clone().invert().bits);
  water.despeckle(6);

  // The wet band: the wadeable shallows along the whole shore, deep water beyond it.
  //
  // `shrink(3)` is an **erosion**, and the arithmetic matters twice. It removes every feature
  // narrower than three cells, so the deep-water region is a *smoothed copy* of the coastline
  // — which is why round 2's drop-off read as a second clean staircase running parallel to
  // the first. And because the erosion is 8-connected, every deep cell is Chebyshev 4 or more
  // from land, so **no shallows cell ever touches both land and deep**: the 13-slot blob
  // palette below never has to draw an isthmus, which it cannot do. Both facts are why the
  // band stays three cells at its narrowest even where the noise thins it.
  const shoreDist = distanceField(water.clone().invert(), W, H, 12);
  const deep = new Field(W, H, (cx, cz) => water.get(cx, cz)
    // A drop-off that is a constant offset from the coast is the coast again. Varying the
    // band from three cells to seven on a low-frequency lattice makes the two lines
    // different lines: a shallow shelf across the bay, a short steep one off the point.
    && shoreDist[cz * W + cx] > 3 + valueNoise(cx, cz, seed ^ 0x4b19, 9) * 4);
  const eroded = water.clone().shrink(3);
  // `Field.shrink` counts outside the map as empty, so without this the top three rows of
  // open sea come back as *shallows* and the far edge of the frame ends in a pale band with
  // foam on it — a beach at the horizon.
  eroded.union(new Field(W, H, (cx, cz) => cz < 3 && water.get(cx, cz) && shoreDist[cz * W + cx] > 4));
  deep.intersect(eroded);
  deep.despeckle(10);
  const shallows = water.clone().subtract(deep);

  // ------------------------------------------------------------------ ground
  //
  // The land is cut out under the water for the same reason the meadow's brook is: every
  // border slot of a water palette is a partial ramp and the ground would bury it.
  draft.fill({ x: 0, z: 0, w: W, h: H },
    (cx, cz) => (water.get(cx, cz) ? null : palette.pick(grass, cx, cz)),
    { collision: 'walk', layer: 0 });

  // The bank: the lake palette's border slots are the sand ramp from the land at y 0 down
  // to −0.75, which is the only "ground drops to water" transition AdAstra ships.
  //
  // Its **centre is skipped**, and that one line is the difference between a coast and a
  // pond. `lake_water_center` is an opaque `ike01` quad at −0.5; the shallows sheet is at
  // −0.65 and `sea`'s surface lands at −0.65 too, so drawing the lake's centre puts a pond
  // over every interior water cell and buries all of it. Everything below was in the
  // placement list, cost draw calls, and was invisible — DECISIONS #28a again, and this time
  // in the module that wrote #28a down. Traced out of `solvePlacements`, not guessed.
  palette.draw(draft, 'set1', water, {
    underlay: false, collision: 'water', layer: 1, tags: ['water'],
    skip: (cx, cz, kase) => kase === 'center',
  });

  // ------------------------------------------------------------------- surf
  //
  // **The foam is resolved against the shallows, not against the whole sea, and that one
  // change is the whole of "the shoreline is a bare staircase with no surf".**
  //
  // `set7 walk_edge` ships a complete 13-slot family and every one of its border slots is
  // tagged `foam`/`surf`; only slot 6, `walkable_water_center`, is the flat wadeable sheet.
  // Round 2 solved that family over the *whole* water body, so the only boundary it ever saw
  // was water-against-land: the foam ringed the beach, and the drop-off — the far edge of the
  // band, where the wadeable water meets the deep — was resolved as `center` on every cell,
  // because from the whole body's point of view those cells are interior. So the deep water
  // ended at a hard grid step with nothing on it, twice, one step apart.
  //
  // Solving the same family over the **annulus** gives it two boundaries instead of one, and
  // it draws surf on both: against the land and against the deep. The model named `sea` has
  // no border family at all, so this is the only foam the tileset can put on that edge, and
  // the erosion above guarantees the annulus is never thinner than the three cells the blob
  // palette needs to resolve an inside and an outside on the same cell.
  //
  // The underlay still goes down over the whole annulus so no border slot's partial ramp
  // leaves a hole with the sky showing through (DECISIONS #28a).
  //
  // **The surf is tinted apart from the water it sits in, because the art is quiet.**
  // `sea_zanami2` — the texture on all twelve border slots — is not a white breaker: it is a
  // pale-blue wash (96,168,208 at its outer edge) fading to the shallows' own blue, with a
  // *ragged transparent cutout* along the last two rows that lets whatever is under it show
  // through. Dumped from the PNG, because on a dark background it reads as a white foam strip
  // and it is not one. Laid at full brightness next to `sea_asase02` (the wadeable centre) the
  // two are within a few luma of each other and the surf line disappears at any camera
  // distance a critic actually shoots.
  //
  // `tint` is an instanced *multiply*, so it can only darken — the surf cannot be made
  // brighter, but the body of the shallows can be taken down, and that is the same contrast.
  // The underlay goes down at the body's tint too, so the ragged cutout at the wave's lip
  // reads against deeper water instead of against itself.
  const SHALLOW_BODY = 0xa9c6dc;
  palette.draw(draft, 'set7', shallows, {
    underlay: true, collision: 'shallow', layer: 2, tags: ['water', 'shallow'],
    tint: (cx, cz, kase) => ((kase === 'center' || kase === 'underlay')
      ? mixTint(SHALLOW_BODY, 0x8fb2cc, fbm2(cx, cz, seed ^ 0x77e1, 6, 0.4),
        { jitter: 4, cx, cz, seed: seed ^ 0x1c4d })
      : 0xffffff),
  });

  // The deep, flush with the shallows sheet: `sea`'s surface is authored 0.3125 above its
  // placement, so it goes down at −0.9625 and its two planes land at −0.65 and −1.4625.
  //
  // Tinted off a low-frequency field rather than laid flat. `sea`'s texture is one dash glyph
  // and every cell draws the same one, so an untinted sheet is that glyph on a visible ~11px
  // lattice — the critic measured the pitch. A slow swell in the tint (and a cooler, deeper
  // blue the further out it is) breaks the lattice without touching the art, and it is the
  // one thing that reads as depth on a flat quad.
  if (seaDeep) {
    const SEA_NEAR = 0xbfe4f2;
    const SEA_FAR = 0x5a86c4;
    deep.forEach((cx, cz) => {
      const d = clamp01((shoreDist[cz * W + cx] - 3) / 7);
      const swell = fbm2(cx * 0.8, cz * 1.6, seed ^ 0x2f7a, 7, 0.45);
      draft.place(seaDeep, cx, cz, {
        y: SHALLOW_Y - SEA_SURFACE_DY, collision: 'water', layer: 3, tags: ['water', 'deep'],
        tint: mixTint(SEA_NEAR, SEA_FAR, clamp01(d * 0.75 + swell * 0.35),
          { jitter: 4, cx, cz, seed: seed ^ 0x51c3 }),
      });
    });
  }

  // ------------------------------------------------------------- the foreshore
  const distToSea = distanceField(water, W, H, 12);
  const land = water.clone().invert();

  // The strand: the belt of bare ground the tide keeps clear, four cells deep and hugging
  // the coastline rather than crossing it. It is drawn from the grass/path palette because
  // AdAstra ships no sand *floor* — its only sand is the `shore01` bank on the lake
  // palette's border slots, which is one cell wide and cannot be laid as a field.
  const track = new Field(W, H, (cx, cz) => {
    const d = distToSea[cz * W + cx];
    const reach = 2.4 + valueNoise(cx, 0, seed ^ 0x1b7, 6) * 3.6;
    return !water.get(cx, cz) && d >= 1 && d <= reach && cz < H - 3;
  });
  track.despeckle(4).closeCorners();
  // Round 5 left this line alone and filed it: the strand ran as a *divided* track for the
  // same reason the forest's trail did, because `set0`'s transition art samples inverted.
  // `set0Outward` turns it out and re-casts the corners; on an east-west band its shoulder
  // rule picks `edge_n`/`edge_s` rather than the trail's `edge_w`/`edge_e`, which is why the
  // rule measures the field instead of naming a side.
  palette.draw(draft, 'set0', track, { collision: 'walk', layer: 1, tags: ['path'],
    ...set0Outward(track) });
  if (dirtPatch.length) {
    track.forEach((cx, cz) => {
      if (valueNoise(cx, cz, seed ^ 0x6d2, 3) < 0.22) {
        draft.place(palette.pick(dirtPatch, cx, cz), cx, cz, { collision: 'walk', layer: 1 });
      }
    });
  }

  // Dune grass: nothing right at the water, thick where the land rises away from it.
  // Dune grass in patches, not as a lawn. The threshold floor matters: without one the
  // "thicker further from the sea" rule reaches zero somewhere inland and every remaining
  // cell turns into standing blades, which from the strand is a solid green wall filling
  // half the frame.
  const dunes = new Field(W, H, (cx, cz) => {
    if (!land.get(cx, cz) || track.get(cx, cz)) return false;
    if (cx < 1 || cz < 1 || cx > W - 2 || cz > H - 2) return false;
    const d = distToSea[cz * W + cx];
    if (d < 5) return false;
    const want = 0.68 - clamp01((d - 5) / 12) * 0.14;
    // Domain-warped for the same reason the meadow's is (DECISIONS #37): a plain threshold
    // on a period-7 lattice gives axis-aligned level sets, and `ragged` can only move them
    // one cell, so the dune grass shipped as a rectangle with a vertical edge.
    return warpedFbm(cx, cz, seed ^ 0x3c19, { period: 5, detail: 0.42, amp: 3, warpPeriod: 6 }) > want;
  });
  dunes.ragged(seed ^ 0x77b3, { amount: 0.5, period: 3 }).despeckle(3);
  dunes.fringe(seed ^ 0x77b4, { reach: 2, density: 0.5, period: 2 });
  dunes.intersect(land.clone().subtract(track));
  if (tallGrass.length) {
    const tall = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) > 0.55);
    const low = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) > 0.3 && (m.bounds?.max?.[1] ?? 0) <= 0.55);
    const flat = tallGrass.filter((m) => (m.bounds?.max?.[1] ?? 0) <= 0.3);
  // Tall grass is **tinted down**, and this is a contrast note rather than a colour one.
  // `ue_grass` is a 0.6-tall block of bright, fully-lit green: laid over the lawn at full
  // brightness a patch comes out *lighter* than the ground around it, which is backwards —
  // denser vegetation shades itself — and a dozen of them next to each other read as flat
  // poster paint with a hard edge, which is what the critic called "literal rectangles".
  // Taking it down to ~0.85 with a per-cell wobble puts the patch under the lawn in value,
  // so the edge is a change in shade rather than a change in poster, and no two neighbouring
  // cells land on exactly the same green.
  const grassTint = (cx, cz) => mixTint(0xb6c8a4, 0xe2ecd6, fbm2(cx, cz, seed ^ 0x6ac1, 4, 0.5),
    { jitter: 6, cx, cz, seed: seed ^ 0x33f7 });
    const core = dunes.clone().shrink(1);
    dunes.forEach((cx, cz) => {
      const inCore = core.get(cx, cz);
      const pool = inCore && tall.length ? tall : (flat.length ? flat : (low.length ? low : tall));
      const model = palette.pick(pool, cx, cz);
      if (model) {
        draft.place(model, cx, cz, {
          collision: 'walk', layer: 5, tags: ['tallgrass', 'encounter'], tint: grassTint(cx, cz),
        });
      }
    });
  }

  if (flowers.length) {
    land.forEach((cx, cz) => {
      const d = distToSea[cz * W + cx];
      if (d < 6 || d > 13 || track.get(cx, cz) || dunes.get(cx, cz)) return;
      if (fbm2(cx, cz, seed ^ 0x51b, 4, 0.5) > 0.76) {
        draft.place(palette.pick(flowers, cx, cz), cx, cz, { collision: 'walk', layer: 5 });
      }
    });
  }

  // ------------------------------------------------------------- rocks and wrack
  //
  // The rebuilt props are real geometry rather than a card leaning back at 45 degrees
  // (DECISIONS #22), and a shore without anything washed up on it reads as a diagram.
  // The two `hgss-overworld` rocks are excluded by name, and the name is the right handle
  // here because DECISIONS #23 names them: both have the surrounding water and grass baked
  // into their source sprite, so the cylindrical wrap carries ripples up the body. On the
  // strand they read as woven baskets rather than boulders — shot and looked at
  // (`docs/progress/hunts/r1/coast-sea.png` before this filter).
  // **Two more names are excluded than in round 1, and the critic is why.** `sylvan-town__
  // rock_tall` and `__rock_small` were already filed in STATUS as reading like woven baskets
  // or hay bales at this camera — the cylindrical wrap of a front-projected sprite — and on a
  // wild beach eight of them strewn over open grass read as an asset dump, not as a place.
  // The one boulder that survives is `bw2-twist__small_rock`, and it is used *sparingly and
  // where a boulder belongs*: clustered on the headland, not sprinkled across the meadow.
  const BASKETS = /^(hgss-overworld__|sylvan-town__rock_)/;
  const usable = (m) => !BASKETS.test(m.name);
  const props = ctx.get('tiles').find('props', { category: 'prop', tags: ['rock'] }) ?? [];
  const dryRocks = props.filter((m) => !m.tags.includes('water') && usable(m));
  const drift = ctx.get('tiles').find('props', { category: 'prop', tags: ['rustic'] })
    .filter((m) => m.name.includes('log') && usable(m));
  // A `Placement` names a model id and nothing else, and `InstancedWorld` resolves that id
  // against **one** tileset — put a props id through an AdAstra draft and you draw AdAstra's
  // model of the same number, silently (DECISIONS #26a). So the props are collected here and
  // built as their own world by `hunts`; only their collision goes into the draft.
  const propPlacements = [];
  const addProp = (model, cx, cz) => {
    if (!model) return;
    propPlacements.push({ modelId: model.id, cx, cz, y: 0, rot: 0, tint: 0xffffff, layer: 4 });
    for (let dz = 0; dz < (model.h ?? 1); dz++) {
      for (let dx = 0; dx < (model.w ?? 1); dx++) {
        if (draft.collisionAt(cx + dx, cz + dz) === 'walk') draft.setCollision(cx + dx, cz + dz, 'block');
      }
    }
  };

  // On the **headland only**. A boulder field has a reason where the rock reaches the sea
  // and none at all in the middle of a meadow; round 1 scattered them over every land cell
  // more than five from the water, which is most of the map.
  for (const [cx, cz] of scatterSpaced(rng.fork('rocks'), {
    rect: { x: 40, z: 3, w: 22, h: 26 },
    spacing: 4.6,
    accept: (cx, cz) => land.get(cx, cz) && !track.get(cx, cz)
      && distToSea[cz * W + cx] >= 2 && distToSea[cz * W + cx] < 8
      && fbm2(cx, cz, seed ^ 0x9f2, 6, 0.4) > 0.46,
  })) addProp(dryRocks[Math.floor(valueNoise(cx, cz, seed, 3) * dryRocks.length)], cx, cz);

  // `hgss-overworld/water_rock` is deliberately **not** used. DECISIONS #23 names it one of
  // the two weakest of the fifteen rebuilt props — the surrounding water is baked into its
  // sprite, so the cylindrical wrap carries ripples up the body — and on screen in the
  // shallows it reads as a clam shell rather than as a rock. The dry boulders stand on the
  // strand instead, which is where a boulder on a beach actually is.
  for (const [cx, cz] of scatterSpaced(rng.fork('strandrocks'), {
    rect: { x: 3, z: 3, w: W - 7, h: H - 10 },
    spacing: 14,
    accept: (cx, cz) => track.get(cx, cz) && track.get(cx + 1, cz)
      && fbm2(cx, cz, seed ^ 0x2c8, 6, 0.4) > 0.62,
  })) addProp(dryRocks[Math.floor(valueNoise(cx, cz, seed ^ 7, 3) * dryRocks.length)], cx, cz);

  for (const [cx, cz] of scatterSpaced(rng.fork('drift'), {
    rect: { x: 4, z: 4, w: W - 9, h: H - 9 },
    spacing: 11,
    accept: (cx, cz) => land.get(cx, cz) && distToSea[cz * W + cx] > 3 && distToSea[cz * W + cx] < 6,
  })) addProp(drift[Math.floor(valueNoise(cx, cz, seed ^ 11, 3) * drift.length)], cx, cz);

  // Scrub in the dunes, scattered rather than swept. A threshold over every land cell past a
  // distance lays a solid wall of identical flowering bushes across the whole map, which is
  // what round 1 did — from the shore it read as a privet hedge two hundred metres long.
  if (hedges.length) {
    for (const [cx, cz] of scatterSpaced(rng.fork('dunescrub'), {
      rect: { x: 2, z: 2, w: W - 4, h: H - 4 },
      spacing: 4.2,
      accept: (cx, cz) => land.get(cx, cz) && !track.get(cx, cz)
        && distToSea[cz * W + cx] > 7 && fbm2(cx, cz, seed ^ 0x8ba1, 7, 0.4) > 0.5,
    })) {
      draft.place(palette.pick(hedges, cx, cz, { salt: 4, baseWeight: 1 }), cx, cz,
        { collision: 'block', layer: 4 });
    }
  }
  if (trees.length) {
    for (const [cx, cz] of scatterSpaced(rng.fork('scrub'), {
      rect: { x: 2, z: 2, w: W - 5, h: H - 5 },
      spacing: 2.3,
      accept: (cx, cz) => land.get(cx, cz) && land.get(cx + 1, cz + 1)
        && distToSea[cz * W + cx] > 17 && !track.get(cx, cz),
    })) {
      draft.place(palette.pick(trees, cx, cz, { salt: 5, baseWeight: 1 }), cx, cz,
        { collision: 'block', layer: 3, claim: false });
    }
  }

  // **Markers go through `laneNear`, like every other biome's.** Coast was the one map that
  // still called `draft.mark` bare, on the reasoning that a strand is open ground and an
  // east leg walks anywhere on it. It is not: `scrub`, the boulders and the shallows put
  // blocked cells on the strand, and probed on the shipped seed-1337 map the `point` marker
  // (50, 18) was blocked at `cx + 3` and `sea` at `cx − 2` — so two of the four framings
  // walked into a rock, had the step dropped silently by `makeScriptedRoute`, and filed
  // north. That is the defect three blind A/B rounds named, still shipping in the biome the
  // judges said read correctly.
  const bounds = { x0: 13, x1: W - 14, z0: 13, z1: H - 9 };
  const mark = (name, cx, cz, opts = {}) => {
    const at = laneNear(draft, cx, cz, { maxR: 7, bounds, ...opts });
    draft.mark(name, at.cx, at.cz);
    return at;
  };
  const shoreCx = 26;
  draft.spawn = { cx: shoreCx, cz: Math.round(shoreAt(shoreCx)) + 6, dir: 3 };
  // `close` frames this marker at distance 16, which is four cells of ground south of the
  // focus, so the skirt is asked for here and nowhere else on this map.
  mark('shore', shoreCx, Math.round(shoreAt(shoreCx)) + 8, { south: 4 });
  // Clamped rather than offset blindly: adding the noise term to `shoreAt` moved this marker
  // to cz 46 of 54, inside the nine cells the framing arithmetic needs clear of the south
  // edge, and the selftest caught it before a shot did.
  mark('dunes', 16, Math.min(H - 10, Math.round(shoreAt(16)) + 13));
  mark('point', 50, Math.round(shoreAt(50)) + 9);
  mark('sea', 34, Math.round(shoreAt(34)) + 4);
  draft.mark('spawn', draft.spawn.cx, draft.spawn.cz);

  // --------------------------------------------------------- the wild Pokemon
  //
  // In the dune grass above the strand — the one cover on this map — gathered around the
  // framings a critic shoots, `shore` first because `route` uses it.
  const wild = wildCells(rng.fork('wild'), {
    w: W, h: H, seed,
    markers: ['shore', 'dunes', 'point', 'sea'].map((n) => draft.marker(n)),
    radius: 10, per: 3, spacing: 4.2,
    accept: (cx, cz) => dunes.get(cx, cz) && draft.collisionAt(cx, cz) === 'walk'
      && !track.get(cx, cz),
  });

  return {
    stats: {
      water: water.count(), deep: deep.count(), shallows: shallows.count(),
      track: track.count(), props: propPlacements.length, wild: wild.length,
    },
    extras: propPlacements.length ? [{ tileset: 'props', placements: propPlacements }] : [],
    wild,
  };
}

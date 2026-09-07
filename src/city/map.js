/**
 * The demo city's author function.
 *
 * Composition, not noise: a north-south high street crossed by an east-west lane, plots
 * either side, a pond in the north-east, a tree line closing the map, and a fenced garden.
 * A town reads as a town because of what it *encloses*, so the layout is laid out by hand
 * here and only the decoration is seeded.
 */

import { makeRng } from '../core/rng.js';

export const CITY_SIZE = 64;

/** Picks the first matching model, and complains loudly rather than silently placing nothing. */
function pick(tiles, slug, query, log, label) {
  const found = tiles.find(slug, query);
  if (!found.length) {
    log.warn(`city: no tile matches ${label ?? JSON.stringify(query)}`);
    return null;
  }
  return found[0];
}

export async function buildCityMap(draft, ctx) {
  const tiles = ctx.get('tiles');
  const { log } = ctx;
  const slug = draft.tileset;
  await tiles.load(slug);
  const rng = makeRng(draft.seed, `city/${draft.id}`);

  const W = draft.w, H = draft.h;
  const byName = (n) => tiles.find(slug, { name: n })[0] ?? null;

  // Select by tag, never by name: this tileset paints several different surfaces onto the
  // same `grass.obj` geometry, so only the classifier's texture-derived tags are reliable.
  const grass = tiles.find(slug, { category: 'ground', tags: ['grass'] });
  const grassBase = grass[0] ?? pick(tiles, slug, { category: 'ground' }, log, 'ground');

  // --- ground ---------------------------------------------------------------
  // Grass everywhere, with the variants scattered so the lawn is not one flat tone.
  draft.fill({ x: 0, z: 0, w: W, h: H }, (cx, cz) => grass[Math.floor(rng.next() * grass.length)] ?? grassBase,
    { collision: 'walk' });

  // --- streets --------------------------------------------------------------
  const HIGH_ST_X = 30, HIGH_ST_W = 4;
  const LANE_Z = 34, LANE_H = 3;
  const PLAZA = { x: 26, z: 28, w: 12, h: 10 };

  const isStreet = (cx, cz) =>
    (cx >= HIGH_ST_X && cx < HIGH_ST_X + HIGH_ST_W && cz >= 8 && cz < H - 6) ||
    (cz >= LANE_Z && cz < LANE_Z + LANE_H && cx >= 10 && cx < W - 10) ||
    (cx >= PLAZA.x && cx < PLAZA.x + PLAZA.w && cz >= PLAZA.z && cz < PLAZA.z + PLAZA.h);

  draft.autotile(tiles, 'set0', isStreet, { collision: 'walk', layer: 1, outsideIsFilled: false });

  // --- pond -----------------------------------------------------------------
  const POND = { cx: 48, cz: 16, rx: 6, rz: 4.5 };
  const inPond = (cx, cz) => {
    const dx = (cx - POND.cx) / POND.rx, dz = (cz - POND.cz) / POND.rz;
    return dx * dx + dz * dz < 1;
  };
  draft.autotile(tiles, 'set1', inPond, { collision: 'water', layer: 2, outsideIsFilled: false });
  draft.mark('pond', POND.cx, POND.cz + 6);

  // --- tree line closing the map -------------------------------------------
  const trees = tiles.find(slug, { category: 'tree', tags: ['tree'] }).filter((m) => m.w <= 3);
  const bigTree = byName('big_tree_dark') ?? trees[0];
  if (trees.length) {
    const ring = [];
    for (let cx = 0; cx < W; cx += 2) { ring.push([cx, 1], [cx, 3], [cx, H - 4], [cx, H - 2]); }
    for (let cz = 0; cz < H; cz += 2) { ring.push([1, cz], [3, cz], [W - 4, cz], [W - 2, cz]); }
    for (const [cx, cz] of ring) {
      if (isStreet(cx, cz) || inPond(cx, cz)) continue;
      if (draft.occupied[draft.idx(cx, cz)]) continue;
      const t = rng.next() < 0.22 ? bigTree : trees[Math.floor(rng.next() * trees.length)];
      draft.place(t, cx, cz, { collision: 'block', layer: 3 });
    }
  }

  // --- building plots -------------------------------------------------------
  // The structures themselves are authored meshes (DECISIONS #3) and are attached by the
  // structures pass; the map reserves and marks their footprints so nothing else lands here.
  const plots = [
    { name: 'pokecenter', x: 20, z: 20, w: 8, h: 6, door: [24, 26] },
    { name: 'mart', x: 40, z: 22, w: 7, h: 5, door: [43, 27] },
    { name: 'house-a', x: 16, z: 40, w: 6, h: 5, door: [19, 45] },
    { name: 'house-b', x: 42, z: 42, w: 6, h: 5, door: [45, 47] },
  ];
  const dirtPatch = byName('dirt') ?? byName('rot_dirtpatch');
  for (const plot of plots) {
    for (let dz = 0; dz < plot.h; dz++) {
      for (let dx = 0; dx < plot.w; dx++) {
        const cx = plot.x + dx, cz = plot.z + dz;
        draft.occupied[draft.idx(cx, cz)] = 1;
        draft.setCollision(cx, cz, 'block');
        draft.addTag(cx, cz, `plot:${plot.name}`);
        if (dirtPatch) draft.place(dirtPatch, cx, cz, { collision: 'block', layer: 1 });
      }
    }
    const [dx, dz] = plot.door;
    draft.setCollision(dx, dz, 'door');
    draft.addTag(dx, dz, `door:${plot.name}`);
    draft.mark(`${plot.name}-door`, dx, dz + 1);
  }

  // --- fenced garden --------------------------------------------------------
  const GARDEN = { x: 12, z: 12, w: 9, h: 7 };
  const onGardenEdge = (cx, cz) => {
    const inside = cx >= GARDEN.x && cx < GARDEN.x + GARDEN.w && cz >= GARDEN.z && cz < GARDEN.z + GARDEN.h;
    if (!inside) return false;
    return cx === GARDEN.x || cx === GARDEN.x + GARDEN.w - 1 || cz === GARDEN.z || cz === GARDEN.z + GARDEN.h - 1;
  };
  draft.autotile(tiles, 'set9', onGardenEdge, { collision: 'block', layer: 4, outsideIsFilled: false });

  const flowers = tiles.find(slug, { tags: ['flower'] });
  if (flowers.length) {
    draft.scatter(rng, () => flowers[Math.floor(rng.next() * flowers.length)], {
      rect: { x: GARDEN.x + 1, z: GARDEN.z + 1, w: GARDEN.w - 2, h: GARDEN.h - 2 },
      chance: 0.55, opts: { collision: 'walk', layer: 5 },
    });
  }

  // --- street furniture -----------------------------------------------------
  const lamp = byName('lamp_h');
  if (lamp) {
    for (let cz = 12; cz < H - 10; cz += 7) {
      for (const cx of [HIGH_ST_X - 1, HIGH_ST_X + HIGH_ST_W]) {
        if (draft.occupied[draft.idx(cx, cz)]) continue;
        draft.place(lamp, cx, cz, { collision: 'block', layer: 4, tags: ['streetlamp'] });
        draft.mark(`lamp-${cx}-${cz}`, cx, cz, { kind: 'lamp' });
      }
    }
  }
  const benches = { south: byName('bench_s'), north: byName('bench_n') };
  for (const [i, cz] of [PLAZA.z + 2, PLAZA.z + 6].entries()) {
    const b = i === 0 ? benches.north : benches.south;
    if (b) {
      draft.place(b, PLAZA.x + 2, cz, { collision: 'block', layer: 4 });
      draft.place(b, PLAZA.x + PLAZA.w - 3, cz, { collision: 'block', layer: 4 });
    }
  }

  // --- lawn detail ----------------------------------------------------------
  const decor = tiles.find(slug, { tags: ['decor'] });
  if (decor.length) {
    draft.scatter(rng, () => decor[Math.floor(rng.next() * decor.length)], {
      rect: { x: 5, z: 5, w: W - 10, h: H - 10 }, chance: 0.03,
      avoidTags: ['path'], opts: { collision: 'walk', layer: 5 },
    });
  }
  const tallGrass = byName('tall_grass') ?? byName('grass_patch');
  if (tallGrass) {
    for (const patch of [{ x: 6, z: 24, w: 6, h: 5 }, { x: 50, z: 44, w: 7, h: 6 }]) {
      draft.scatter(rng, tallGrass, { rect: patch, chance: 0.75,
        opts: { collision: 'walk', layer: 5, tags: ['tallgrass', 'encounter'] } });
    }
  }

  // --- spawn and framing markers -------------------------------------------
  draft.spawn = { cx: HIGH_ST_X + 1, cz: PLAZA.z + PLAZA.h + 4, dir: 2 };
  draft.mark('plaza', PLAZA.x + (PLAZA.w >> 1), PLAZA.z + (PLAZA.h >> 1));
  draft.mark('south-gate', HIGH_ST_X + 1, H - 10);
  draft.mark('high-street', HIGH_ST_X + 1, 20);
  draft.mark('garden', GARDEN.x + (GARDEN.w >> 1), GARDEN.z + (GARDEN.h >> 1));

  log.info(`city: ${draft.placements.length} placements on ${W}x${H}`);
}

/**
 * The demo city's author function — the AdAstra half.
 *
 * This paints everything that comes out of the house tileset: the lawn, the road network,
 * the paved square, the pond, the tree line, the hedges, the flowers, the benches and the
 * street lamps. It also *reserves* the cells the authored buildings and the adapted props
 * stand on, writing their collision, their tags and their door markers, because those two
 * tilesets cannot go through this draft: a `Placement` carries a model id and nothing else,
 * and `tiles.buildInstances()` resolves ids against exactly one tileset. `structures.js`
 * builds those worlds separately from the same layout.
 *
 * Composition, not noise. The plan is written down in `layout.js` and only the decoration
 * is seeded, so the same seed gives the same town, cell for cell, every time.
 */

import { makeRng } from '../core/rng.js';
import {
  CITY_SIZE, SPAWN, PLOTS, PLAZA, PLAZA_STONE, ROADS, POND, PLANTERS, TALL_GRASS,
  LAMPS, BENCHES, PROPS, TOWN_TREES, TUBS, FENCES, GARDEN_BEDS, PAVING,
  doorCellOf, plotModel, inRect,
} from './layout.js';

export { CITY_SIZE };

const BENCH_MODEL = { s: 'bench_s', n: 'bench_n', e: 'bench_e', w: 'bench_w' };

/** Picks the first match and says so loudly rather than silently placing nothing. */
function pick(tiles, slug, query, log, label) {
  const found = tiles.find(slug, query);
  if (!found.length) { log.warn(`city: no tile matches ${label ?? JSON.stringify(query)}`); return null; }
  return found[0];
}

/**
 * The same courtesy for an auto-tile palette, and it is not a nicety.
 *
 * `draft.autotile()` resolves a set id against the tileset and, when the id is not there,
 * `solveField` returns a field of −1 and places **nothing at all** — no throw, no warning,
 * no missing model, just a region of map that silently does not exist. That is exactly how
 * round 1 shipped a pond nobody could see, and how it survived a screenshot round: the
 * `pond` preset framed an empty lawn and the log was clean. The lamp lookup at the bottom of
 * this file has warned since day one; every set this map draws goes through here now.
 *
 * @returns {object|null} the set's metadata (`kind`, `digsIn`, `underlay`, …) or null
 */
function autotileSet(tiles, slug, setId, log, label) {
  const sets = typeof tiles.autotile?.sets === 'function' ? tiles.autotile.sets(slug) : [];
  const hit = sets.find((s) => s.id === setId || s.name === setId);
  if (!hit) {
    log.warn(`city: no auto-tile set "${setId}" (${label}) in tileset "${slug}" — ` +
      `nothing will be placed. Available: ${sets.map((s) => s.id).join(', ') || 'none'}`);
    return null;
  }
  return hit;
}

export async function buildCityMap(draft, ctx) {
  const tiles = ctx.get('tiles');
  const { log } = ctx;
  const slug = draft.tileset;
  // The two authored sets are loaded here, not in `enter()`, because the reservations below
  // read their footprints: a plot whose `w`/`h` came from a default rather than from the
  // model is a building that overhangs cells nothing knows are taken. A set that fails to
  // load costs the town its buildings, never its ground.
  await Promise.all([
    tiles.load(slug),
    tiles.load('structures').catch(() => null),
    tiles.load('props').catch(() => null),
  ]);
  const rng = makeRng(draft.seed, `city/${draft.id}`);

  const W = draft.w, H = draft.h;
  const byName = (n) => tiles.byName(slug, n);

  // Select by category and tag, never by name: this tileset paints several different
  // surfaces onto the same `grass.obj`, so only the texture-derived tags are reliable
  // (DECISIONS #6).
  const grass = tiles.find(slug, { category: 'ground', tags: ['grass'] });
  const grassBase = grass[0] ?? pick(tiles, slug, { category: 'ground' }, log, 'ground');

  const inPond = (cx, cz) => {
    const dx = (cx - POND.cx) / POND.rx, dz = (cz - POND.cz) / POND.rz;
    return dx * dx + dz * dz < 1;
  };

  // --- lawn -----------------------------------------------------------------
  // The pond is cut out of it. AdAstra's lake palette *descends* — the banks run from y 0
  // down to −0.75 and the water sheet is a flat quad at −0.5 — while the lawn is a quad at
  // y 0. Laid on top of an unbroken lawn the entire lake is under the grass, which is a
  // hole you cannot see rather than a pond, and it renders as an ordinary field with a
  // perfectly clean console. `tiles.autotile.sets()` says which sets do this (`digsIn`);
  // this one does, so the ground goes away first.
  draft.fill({ x: 0, z: 0, w: W, h: H },
    (cx, cz) => (inPond(cx, cz) ? null : (tiles.pick(grass, cx, cz, { salt: 7 }) ?? grassBase)),
    { collision: 'walk' });

  // --- roads and the square -------------------------------------------------
  const roadTests = [PLAZA, ...ROADS].map(inRect);
  const isPaved = (cx, cz) => roadTests.some((t) => t(cx, cz));
  if (autotileSet(tiles, slug, 'set0', log, 'grass/path')) {
    draft.autotile(tiles, 'set0', isPaved, { collision: 'walk', layer: 1, outsideIsFilled: false });
  }

  // The square's paving is not drawn here at all — it comes from `pt-overworld-7`'s `set21`
  // in `structures.js`, because AdAstra has no stone (see `PAVING` in layout.js) and a
  // second tileset cannot go through one draft. What the draft still owns is the *meaning*
  // of those cells: they are walkable, they are tagged `plaza`, and the square is therefore
  // a place NPC routing and the camera presets can both talk about.
  //
  // The *height* has to be authored here too, and that is not cosmetic. `simulation`'s
  // `surface.js` stands a walker on the highest `flat` model in the **draft**, falling back
  // to the authored heightfield — and it cannot see a placement that lives in another
  // world. Without this line every walker on the square would be planted on the road tile
  // underneath it at 0.07 while the paving they are standing on is at 0.10, which sinks
  // their contact shadow under an opaque surface (DECISIONS #27 records the same bug from
  // the other direction). The heightfield is exactly the right seam for it: it is what
  // `terrain.height()` means, and `surface.js` uses it as the floor.
  for (let cz = PLAZA_STONE.z; cz < PLAZA_STONE.z + PLAZA_STONE.h; cz++) {
    for (let cx = PLAZA_STONE.x; cx < PLAZA_STONE.x + PLAZA_STONE.w; cx++) {
      if (!draft.inside(cx, cz)) continue;
      draft.addTag(cx, cz, 'plaza');
      draft.setHeight(cx, cz, PAVING.y);
    }
  }
  // Still wanted for the cottage doormats, which sit on dirt outside the square.
  const stone = pick(tiles, slug, { category: 'path', tags: ['stone'], maxBaseY: 0.05 }, log, 'stone paving');

  // --- pond -----------------------------------------------------------------
  // `draft.autotile()` cannot draw this one: it places one model per cell at a single `y`,
  // and a lake needs its water *sheet* laid under every cell before the banks go on top —
  // each bank slot is a partial ramp that leaves the rest of its cell empty, so without the
  // sheet a shoreline is a ring of holes with the sky through it. `solvePlacements` with
  // `underlay` is the form that carries both, and it hands back a per-placement `y`.
  const pondSet = autotileSet(tiles, slug, POND.set, log, 'pond');
  if (pondSet) {
    const occ = new Uint8Array(W * H);
    let cells = 0;
    for (let cz = 0; cz < H; cz++) {
      for (let cx = 0; cx < W; cx++) {
        if (!inPond(cx, cz)) continue;
        occ[draft.idx(cx, cz)] = 1;
        // Nothing scatters into open water: the decor pass, the tree ring and the props all
        // read `occupied`, and a flower floating at y 0 over a sheet at −0.5 is unmistakable.
        draft.occupied[draft.idx(cx, cz)] = 1;
        cells++;
      }
    }
    const ts = tiles.get(slug);
    const solved = tiles.autotile.solvePlacements(slug, POND.set, occ, W, H,
      { underlay: true, outsideIsFilled: false });
    for (const q of solved) {
      draft.place(ts?.byId.get(q.modelId), q.cx, q.cz, {
        y: q.y, collision: 'water', layer: q.case === 'underlay' ? 3 : 4, tags: ['water'],
      });
    }
    if (!solved.length) {
      log.warn(`city: the pond covers ${cells} cells but "${POND.set}" resolved none of them`);
    } else {
      log.info(`city: pond ${cells} cells -> ${solved.length} placements (${pondSet.kind}, ` +
        `digsIn ${pondSet.digsIn}, underlay ${!!pondSet.underlay})`);
    }
  }

  // --- the buildings' ground ------------------------------------------------
  // Reserved, not placed: the meshes come from the `structures` tileset in structures.js.
  for (const plot of PLOTS) {
    const model = plotModel(tiles, plot);
    if (!model) log.warn(`city: no structure of kind "${plot.kind}" — plot ${plot.id} is a hole`);
    const w = model?.w ?? 6, h = model?.h ?? 5;
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = plot.x + dx, cz = plot.z + dz;
        if (!draft.inside(cx, cz)) continue;
        draft.occupied[draft.idx(cx, cz)] = 1;
        draft.setCollision(cx, cz, 'block');
        draft.addTag(cx, cz, `plot:${plot.id}`);
      }
    }
    // The door cell itself is enterable, and the cell immediately south of it is where a
    // walker stands to use it — that is the marker every NPC and every camera preset uses.
    const door = doorCellOf(plot, model);
    draft.setCollision(door.cx, door.cz, 'door');
    draft.addTag(door.cx, door.cz, `door:${plot.id}`);
    draft.mark(`${plot.id}-door`, door.cx, door.cz + 1, { kind: 'door', plot: plot.id, cell: door });
    // A doormat of paving, so the doorway is not a hole punched in the lawn.
    if (stone && draft.inside(door.cx, door.cz + 1) && !draft.hasTag(door.cx, door.cz + 1, 'plaza')) {
      for (const [ax, az] of [[door.cx, door.cz + 1], [door.cx + 1, door.cz + 1]]) {
        if (draft.inside(ax, az) && draft.collisionAt(ax, az) === 'walk') {
          draft.place(stone, ax, az, { y: 0.09, collision: 'walk', layer: 2, tags: ['approach'] });
        }
      }
    }
  }

  // --- the props' ground ----------------------------------------------------
  // Same story: reserved here, drawn from the `props` tileset in structures.js.
  for (const p of PROPS) {
    // `tiles.byName` is the explicit escape hatch and does not warn. A prop's name is the
    // stable handle here, unlike a PDSMS tile's: these fifteen were authored by us into their
    // own set under names we chose (DECISIONS #23).
    const model = tiles.byName('props', p.model);
    const w = model?.w ?? 1, h = model?.h ?? 1;
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = p.cx + dx, cz = p.cz + dz;
        if (!draft.inside(cx, cz)) continue;
        draft.occupied[draft.idx(cx, cz)] = 1;
        if (draft.collisionAt(cx, cz) !== 'water') draft.setCollision(cx, cz, 'block');
        draft.addTag(cx, cz, 'prop');
      }
    }
  }

  // --- the tree line that closes the map ------------------------------------
  const trees = tiles.find(slug, { category: 'tree', tags: ['tree'] }).filter((m) => (m.w ?? 1) <= 3);
  if (trees.length) {
    const ring = [];
    for (let cx = 1; cx < W - 2; cx += 3) ring.push([cx, 1], [cx, H - 3]);
    for (let cz = 1; cz < H - 2; cz += 3) ring.push([1, cz], [W - 3, cz]);
    // A second, sparser rank inside the first, so the edge of the world is a wood and not a
    // hedge: one row of trees reads as a fence, two read as depth.
    for (let cx = 3; cx < W - 4; cx += 6) ring.push([cx, 4], [cx, H - 6]);
    for (let cz = 4; cz < H - 5; cz += 6) ring.push([4, cz], [W - 6, cz]);
    for (const [cx, cz] of ring) {
      if (!draft.inside(cx, cz) || draft.occupied[draft.idx(cx, cz)]) continue;
      if (isPaved(cx, cz) || inPond(cx, cz)) continue;
      const t = tiles.pick(trees, cx, cz, { salt: 11 });
      draft.place(t, cx, cz, { collision: 'block', layer: 4 });
    }
  }

  // --- the square's landmark: two hedge-walled flower beds ------------------
  // Two families, and the difference is the whole reason the round-1 planters read as a row
  // of green boxes: `hedge1` is a **one-cell** bush, and five of them side by side are five
  // identical cubes with a seam between each pair. AdAstra also ships `hedge2`, `hedge3` and
  // `hedge4` — the same bush authored 2, 3 and 4 cells wide as *one* model, with the ends
  // capped and the middle continuous. A five-wide bed is `hedge4` + `hedge1`, which is one
  // hedge, not five shrubs.
  const tubBushes = tiles.find(slug, { category: 'plant', tags: ['hedge'], maxCells: 1 });
  const runBushes = tiles.find(slug, { category: 'plant', tags: ['hedge'] })
    .filter((m) => (m.h ?? 1) === 1).sort((a, b) => (b.w ?? 1) - (a.w ?? 1));
  const flowers = tiles.find(slug, { tags: ['flower'] });

  /** Lays a continuous hedge across `[x, x+w)` using the widest pieces that fit. */
  function hedgeRun(x, cz, w) {
    let cx = x;
    while (cx < x + w) {
      const piece = runBushes.find((m) => (m.w ?? 1) <= x + w - cx);
      if (!piece) break;
      if (draft.inside(cx, cz)) draft.place(piece, cx, cz, { collision: 'block', layer: 5 });
      cx += piece.w ?? 1;
    }
  }

  if (runBushes.length) {
    for (const bed of [...PLANTERS, ...GARDEN_BEDS]) {
      // Hedge along the bed's *north* row only, flowers in front of it. A full ring is 12
      // hedge tiles to 3 of flowers and reads as a box, not as a planting; backing the
      // flowers with one wall puts the green behind the colour from a camera looking north.
      hedgeRun(bed.x, bed.z, bed.w);
      // One row of flowers, not two. A flower tile is a flat decal at a finer texel pitch
      // than anything around it, so a 5x2 field of them reads as wallpaper laid on the
      // ground; a single course in front of the hedge reads as a bed. The row is broken at
      // both ends so the planting stops short of the kerb rather than running into it.
      if (flowers.length) {
        for (let cx = bed.x; cx < bed.x + bed.w; cx++) {
          if (!draft.inside(cx, bed.z + 1)) continue;
          draft.place(tiles.pick(flowers, cx, bed.z + 1, { salt: 3 }), cx, bed.z + 1,
            { y: 0.09, collision: 'block', layer: 6 });
        }
      }
    }
  }

  // --- the trees that close the square left and right ----------------------
  for (const t of TOWN_TREES) {
    const model = tiles.pick(trees, t.cx, t.cz, { salt: 17 });
    if (!model || !draft.inside(t.cx, t.cz)) continue;
    if (draft.occupied[draft.idx(t.cx, t.cz)]) continue;
    draft.place(model, t.cx, t.cz, { collision: 'block', layer: 4 });
  }

  // --- street furniture -----------------------------------------------------
  for (const t of TUBS) {
    const model = tiles.pick(tubBushes, t.cx, t.cz, { salt: 23 });
    if (!model || !draft.inside(t.cx, t.cz)) continue;
    draft.place(model, t.cx, t.cz, { collision: 'block', layer: 5 });
  }

  // --- the two yards' fences ------------------------------------------------
  // A fence set is a `line`, not a blob: `tiles` reads each piece's real arms off its own
  // geometry and solves 4-way connectivity, so a run is only the cells it passes through and
  // the corner pieces fall out of it (DECISIONS #25a / `armsOf`). This is what turns four
  // barrels on open grass into a delivery yard.
  const fenceCells = new Set(FENCES.map((f) => `${f.cx},${f.cz}`));
  if (fenceCells.size && autotileSet(tiles, slug, 'set9', log, 'fence')) {
    draft.autotile(tiles, 'set9', (cx, cz) => fenceCells.has(`${cx},${cz}`),
      { collision: 'block', layer: 7, tags: ['fence'] });
  }
  // --- the lamps' ground ----------------------------------------------------
  // Reserved, not placed, for the same reason the buildings are: the lamp is `structures`'
  // authored `street_lamp` now, and a `Placement` names a model id that `buildInstances`
  // resolves against exactly one tileset — put through this AdAstra draft it would draw
  // AdAstra's model 3. `structures.js` stands the posts up from these same cells.
  //
  // `occupied` is deliberately **not** set, unlike the plots and the props above, and that is
  // a determinism call rather than an oversight. `draft.scatter` draws from the seeded stream
  // only *after* its occupancy test (`terrain/draft.js`), so reserving one more cell here
  // shifts every random draw after it and re-rolls the whole lawn — a hundred decals and two
  // patches of tall grass move so that a lamp post stops standing on a pebble. `place()` never
  // claimed a 1x1 cell either, so this is exactly what the AdAstra lamp did; the post is
  // `block` for walkers and open to decor, as before.
  for (const lamp of LAMPS) {
    if (!draft.inside(lamp.cx, lamp.cz)) continue;
    draft.setCollision(lamp.cx, lamp.cz, 'block');
    draft.addTag(lamp.cx, lamp.cz, 'streetlamp');
    draft.mark(`lamp:${lamp.cx},${lamp.cz}`, lamp.cx, lamp.cz, { kind: 'lamp', head: lamp.head });
  }
  for (const b of BENCHES) {
    const model = byName(BENCH_MODEL[b.face] ?? BENCH_MODEL.s);
    if (!model || !draft.inside(b.cx, b.cz)) continue;
    draft.place(model, b.cx, b.cz, { collision: 'block', layer: 7 });
  }

  // --- lawn detail ----------------------------------------------------------
  const decor = tiles.find(slug, { tags: ['decor'] });
  if (decor.length) {
    draft.scatter(rng, (cx, cz) => tiles.pick(decor, cx, cz, { salt: 5 }), {
      rect: { x: 3, z: 3, w: W - 6, h: H - 6 }, chance: 0.045,
      avoidTags: ['path', 'plaza', 'approach', 'water'], opts: { collision: 'walk', layer: 6 },
    });
  }
  // No pebbles on the square any more. They were there because twenty by seven cells of one
  // flat brown texture read as a swatch and needed something breaking it up; the paving that
  // replaced it carries its own joints, and `rot_rocks` is a *tan* dirt decal, which on grey
  // stone stops reading as gravel and starts reading as litter.

  const tallGrass = tiles.find(slug, { category: 'plant', tags: ['tallgrass'] });
  if (tallGrass.length) {
    for (const patch of TALL_GRASS) {
      draft.scatter(rng, (cx, cz) => tiles.pick(tallGrass, cx, cz, { salt: 9 }), {
        rect: patch, chance: 0.8, avoidTags: ['path', 'plaza', 'water'],
        opts: { collision: 'walk', layer: 6, tags: ['tallgrass', 'encounter'] },
      });
    }
  }

  // --- spawn and framing markers -------------------------------------------
  draft.spawn = { ...SPAWN };
  draft.mark('plaza', PLAZA.x + (PLAZA.w >> 1), PLAZA.z + (PLAZA.h >> 1));
  draft.mark('high-street', 31, 30);
  draft.mark('south-gate', 31, 52);
  draft.mark('pond', POND.cx, POND.cz + 5);
  draft.mark('wood-yard', 41, 41);

  log.info(`city: ${draft.placements.length} placements on ${W}x${H}, ` +
    `${PLOTS.length} plots, ${LAMPS.length} lamps, ${PROPS.length} props`);
}

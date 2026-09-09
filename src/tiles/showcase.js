/**
 * The tiles gauntlet.
 *
 * Modes, all deterministic (ARCHITECTURE §6):
 *
 *   ?showcase=tiles                  every autotile set as a labelled blob, one glance
 *   ?showcase=tiles&mode=set3        one set: the blob, plus each of its 13 cases stamped
 *                                    in isolation and labelled, plus a coverage readout
 *   ?showcase=tiles&mode=catalog     one tile of every category
 *   ?showcase=tiles&mode=rotate      multi-cell models at all four rotations over a tinted
 *                                    footprint, which is how `composeMatrix` is proved
 *   ?showcase=tiles&mode=lamps       the four street-lamp variants at the game camera, plus
 *                                    the same row again on a night ramp — the emissive proof
 *   ?showcase=tiles&mode=ground      a bare lawn and a path, for judging tiling repetition
 *   ?showcase=tiles&mode=trees       every 2x2 tree alone on a lawn, then the same three
 *                                    packed into a copse, plus a lamp — the only mode where
 *                                    an upright billboard's silhouette stands against nothing
 *
 * It builds its placements itself rather than through `terrain.MapDraft`: `tiles` declares
 * `needs: []`, so its own proof has to stand up while terrain is being edited.
 */

import { Stage } from './stage.js';
import { makeLabelOverlay } from './labels.js';
import { BLOB_CASES, MASK_BITS } from './autotile.js';

const SLUG = 'bw2-adastra';
const { N, S, W, E } = MASK_BITS;

/** 3x3 stamps whose centre cell lands on exactly one of the 13 blob cases. */
const PATCH = {
  center: () => true,
  edge_n: (x, z) => z > 0,
  edge_s: (x, z) => z < 2,
  edge_w: (x, z) => x > 0,
  edge_e: (x, z) => x < 2,
  corner_nw: (x, z) => x > 0 && z > 0,
  corner_ne: (x, z) => x < 2 && z > 0,
  corner_sw: (x, z) => x > 0 && z < 2,
  corner_se: (x, z) => x < 2 && z < 2,
  inner_nw: (x, z) => !(x === 0 && z === 0),
  inner_ne: (x, z) => !(x === 2 && z === 0),
  inner_sw: (x, z) => !(x === 0 && z === 2),
  inner_se: (x, z) => !(x === 2 && z === 2),
};

/** The palette's own 5x3 reading order, so the shot matches Map Studio's window. */
const PALETTE_ROWS = [
  ['corner_nw', 'edge_n', 'corner_ne', 'inner_nw', 'inner_ne'],
  ['edge_w', 'center', 'edge_e', 'inner_sw', 'inner_se'],
  ['corner_sw', 'edge_s', 'corner_se'],
];

/** Fences are connectivity, not regions — these are their cases. */
const LINE_CASES = [
  ['we', W | E], ['ns', N | S], ['ne', N | E], ['nw', N | W], ['post', 0],
  ['se', S | E], ['sw', S | W], ['nwe', N | W | E], ['cross', N | S | W | E],
];
const linePatch = (conn) => (x, z) => (x === 1 && z === 1)
  || (x === 1 && z === 0 && (conn & N) !== 0)
  || (x === 1 && z === 2 && (conn & S) !== 0)
  || (x === 0 && z === 1 && (conn & W) !== 0)
  || (x === 2 && z === 1 && (conn & E) !== 0);

/**
 * A square with a one-cell hole and a bitten-out corner. The hole is what forces all four
 * inner corners; the notch adds a second, concave set of outer corners so the edges have to
 * stay continuous around a turn as well as along a straight.
 */
const blobShape = (size) => (x, z) => {
  if (x < 0 || z < 0 || x >= size || z >= size) return false;
  if (x === 4 && z === 4) return false;
  if (x >= size - 4 && z >= size - 4) return false;
  return true;
};

/** A ring, a cross through it, and one lone post: every fence junction in one shape. */
const fenceShape = (size) => (x, z) => {
  const r = size - 4;
  if (x < 0 || z < 0 || x > r || z > r) return false;
  const mid = r >> 1;
  return x === 0 || z === 0 || x === r || z === r || x === mid || z === mid
    || (x === mid + 2 && z === mid + 2);
};

// ---------------------------------------------------------------------------------------

export async function showcaseTiles(mode, ctx) {
  const tiles = ctx.get('tiles');
  const ts = await tiles.load(SLUG);
  const env = ctx.get('environment');
  env.setBiomePreset?.('meadow');
  env.setTimeOfDay?.(ctx.config.tod);

  const overlay = makeLabelOverlay(ctx);
  tiles._setOverlay?.(overlay);

  const lawnModels = tiles.find(SLUG, { category: 'ground', tags: ['grass'] });
  const lawn = (cx, cz) => tiles.pick(lawnModels, cx, cz, { salt: 7, baseWeight: 4 });

  const sets = tiles.autotile.sets(SLUG);
  const chosen = sets.find((s) => s.id === mode || s.name === mode);

  const ctxs = { ctx, tiles, ts, overlay, lawn, sets };
  if (mode === 'catalog') return catalogMode(ctxs);
  if (mode === 'rotate' || mode === 'rotation') return rotateMode(ctxs);
  if (mode === 'variants') return variantsMode(ctxs);
  if (mode === 'lamps' || mode === 'light') return lampsMode(ctxs);
  if (mode === 'ground') return groundMode(ctxs);
  if (mode === 'trees' || mode === 'wood') return treesMode(ctxs);
  if (chosen) return singleSetMode(ctxs, chosen);
  return overviewMode(ctxs);
}

// --- shared helpers ---------------------------------------------------------------------

/** Stamps one autotiled region into the stage and reports which cases it produced. */
function stamp(stage, tiles, ts, set, ox, oz, shape, { y0 = 0, layer = 1, clear = true } = {}) {
  const occ = new Uint8Array(stage.w * stage.h);
  for (let z = 0; z < stage.h; z++) {
    for (let x = 0; x < stage.w; x++) {
      if (shape(x - ox, z - oz)) occ[z * stage.w + x] = 1;
    }
  }
  // A lake is a hole in the lawn, not a decal on it.
  if (clear) {
    for (let i = 0; i < occ.length; i++) if (occ[i]) stage.clearGround(i % stage.w, (i / stage.w) | 0);
  }
  const solved = tiles.autotile.solvePlacements(SLUG, set.id, occ, stage.w, stage.h, {
    strict: true, outsideIsFilled: false, underlay: true, y0,
  });
  const byCase = new Map();
  let placed = 0;
  for (const p of solved) {
    const model = ts.byId.get(p.modelId);
    if (!model) continue;
    stage.place(model, p.cx, p.cz, { y: p.y, rot: p.rot, layer: p.case === 'underlay' ? layer - 1 : layer });
    if (p.case === 'underlay') continue;
    placed++;
    if (!byCase.has(p.case)) byCase.set(p.case, { count: 0, cell: p, model });
    byCase.get(p.case).count++;
  }
  // Cells the palette has no tile for stay empty on purpose: a gap you can see beats a
  // wrong-shaped tile you have to reverse-engineer.
  let holes = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i]) holes++;
  return { byCase, placed, cells: holes };
}

const topOf = (model, y) => y + (model?.bounds?.max?.[1] ?? 0);

/**
 * The registry's null object answers a `typeof` check TRUE on every property, so a dead
 * sibling passes `typeof env.lamps.add === 'function'` and then logs a warn for every read.
 * `__missing` is the marker that actually separates a live API from a quarantined one.
 */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * Where a lamp's lit head is, so `environment` can put a light pool under it.
 *
 * Two critics wrote the same sentence about `tiles-lamps-21.png`: "a lit lamp casts no light
 * pool". The pool is real and `environment` has been able to serve it since its round 2 — this
 * stage simply never registered a bulb, so there was nothing to light (environment filed it as
 * a request against this file). `environment.lamps` owns the eight-light pool and the night
 * ramp; tiles only says where the bulbs are, which is the same split `src/city/structures.js`
 * uses and the reason the lamps stay dark at noon without this file knowing the hour.
 *
 * The head is not the cell centre. An AdAstra street lamp is a post in its own cell with an arm
 * that reaches a cell and a half out of it (that overhang is what `overhangOf` measures and what
 * `orientation` names), and the lit lens is at the far end of that arm. Placing the bulb at the
 * cell centre would light the post's foot and leave the head glowing over dark ground — the same
 * defect one cell to the side. 0.75 of the reach lands it under the lens rather than past it.
 */
function bulbOf(model, cx, cz) {
  const b = model?.bounds;
  const w = model?.w ?? 1, h = model?.h ?? 1;
  if (!b) return { x: cx + w / 2, y: 2.4, z: cz + h / 2 };
  const reach = { w: -b.min[0], e: b.max[0] - w, n: -b.min[2], s: b.max[2] - h };
  const [dir, out] = Object.entries(reach).sort((a, c) => c[1] - a[1])[0];
  const r = Math.max(0, out) * 0.75;
  return {
    x: cx + w / 2 + (dir === 'w' ? -r : dir === 'e' ? r : 0),
    y: b.max[1] * 0.92,
    z: cz + h / 2 + (dir === 'n' ? -r : dir === 's' ? r : 0),
  };
}

/** Registers one bulb per placed lamp. A no-op when `environment` is quarantined. */
function lightLamps(ctx, bulbs) {
  const env = ctx.get('environment');
  if (!isLive(env) || typeof env.lamps?.add !== 'function') return 0;
  env.lamps.clear?.();
  for (const b of bulbs) {
    env.lamps.add({ ...b, color: 0xffab55, intensity: 1.6, radius: 12, size: 0.9 });
  }
  return bulbs.length;
}

/**
 * How a set has to be staged to be seen honestly.
 *
 *  - a coastal cliff (`sea_cliff`) descends into water, so the ground around it is the sea,
 *    not a lawn, and the sea doubles as the sheet under the rock;
 *  - a set that is entirely in one plane but authored below zero (`walk_edge`, the
 *    shallows) is shifted flush with the floor, because the drop it expects belongs to the
 *    terrain, not to the tiles, and unfilled it reads as a black trench;
 *  - anything else that digs in (a lake) needs the lawn cut away under it.
 */
function stagePlan(tiles, set) {
  const coastal = set.kind === 'surface' && set.categories.includes('cliff');
  return {
    coastal,
    // byName is the sanctioned escape hatch (DECISIONS #6); this is a specific piece of
    // scenery, not a query for "some water". `sea` itself is avoided on purpose: its top
    // layer is the one translucent material in the whole tileset (alpha 19, depthWrite off)
    // and a horizon-wide sheet of it glazes everything behind it.
    ground: coastal ? tiles.byName(SLUG, 'water_deep') : null,
    groundY: -0.5,
    y0: set.flat && set.digsIn ? -set.sinkY : 0,
    clear: set.digsIn && !coastal,
  };
}

function finish(ctx, tiles, stage, name, opts = {}) {
  stage.finalize();
  const world = tiles.buildInstances(ctx.three.scene, SLUG, stage.placements, { name, ...opts });
  ctx.log.info(`tiles showcase "${name}": ${stage.placements.length} placements, `
    + `${world.stats.meshes} meshes, ${Math.round(world.stats.triangles / 1000)}k tris`);
  return world;
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

/**
 * Model names inside one palette all start with the palette's own name, which eats the
 * width a label has for the part that differs. Strip the shared head, on an underscore.
 */
function shortener(names) {
  let prefix = names[0] ?? '';
  for (const n of names) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = prefix.lastIndexOf('_') + 1;
  const head = prefix.slice(0, cut);
  // Only shorten a name that really carries the head: a palette can borrow a tile from
  // outside its own family (`stone_path_center` inside `tall_mountain_*`) and blind slicing
  // would label it "ter".
  return cut >= 4 ? (n) => (String(n).startsWith(head) ? String(n).slice(cut) : String(n)) : (n) => String(n);
}

/**
 * Frames a stage. `cameraDistance 30` covers ~24 tiles across a 16:9 screen (core/config),
 * so ~0.8 tiles per unit horizontally; the ground runs about 0.62 tiles per unit in depth
 * once the 45-degree pitch is accounted for.
 */
function frameStage(ctx, stage, { pad: m = 3, lift = 0, cx = null, cz = null } = {}) {
  // `?cameraDistance=20&focus=8,10` hands the framing back to the caller, which is how the
  // close-ups that actually settle a seam question get taken.
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const d = params.has('cameraDistance')
    ? ctx.config.cameraDistance
    : Math.round(Math.max((stage.w + m * 2) / 0.80, (stage.h + m * 2) / 0.62, 18));
  ctx.three.rig.frame(cx ?? stage.w / 2, cz ?? stage.h / 2 + lift, 0, d);
}

// --- mode: one set in full --------------------------------------------------------------

/**
 * A set's own tiles are not always a different colour from the lawn they are stamped on.
 *
 * `set2` is the `grass_path_corner` palette and its centre, `michi03b`, is a 4-bit indexed
 * PNG whose entire palette is green — `74dc76`, `81db72`, `8bdc74`. Green tiles on a green
 * lawn: `docs/progress/tiles/critic/set2-12.png` proves thirteen cases are placed and shows
 * none of them. `set0` only escaped that by being tan.
 *
 * So every stamp gets a pad: the lawn under and around it is tinted down to a dark, desaturated
 * green-grey, which is a value contrast no palette in the set can collide with. Tinting the
 * lawn rather than swapping it for stone keeps the edge tiles meeting grass, which is what they
 * were drawn to meet.
 */
const PAD_TINT = 0x6d7488;
function padGround(stage, ox, oz, w, h, margin = 1) {
  for (let z = oz - margin; z < oz + h + margin; z++) {
    for (let x = ox - margin; x < ox + w + margin; x++) stage.tintGround(x, z, PAD_TINT);
  }
}

function singleSetMode({ ctx, tiles, ts, overlay, lawn }, set) {
  const isLine = set.kind === 'line';
  const BLOB = 13, PITCH = 6;
  const blobX = 2, blobZ = 4;
  const palX = blobX + BLOB + 4, palZ = blobZ;
  const stage = new Stage(palX + PITCH * 5 + 1, blobZ + Math.max(BLOB, PITCH * 3) + 3);
  const plan = stagePlan(tiles, set);
  stage.fillGround(plan.ground ?? lawn, 14, plan.ground ? plan.groundY : 0);

  const shape = isLine ? fenceShape(BLOB) : blobShape(BLOB);
  padGround(stage, blobX, blobZ, BLOB, BLOB);
  const blob = stamp(stage, tiles, ts, set, blobX, blobZ, shape, { y0: plan.y0, clear: plan.clear });

  const short = shortener(ts.models.filter((m) => m.autotile?.set === set.id).map((m) => m.name));

  overlay.add(`${set.id} · ${set.name}`, blobX + BLOB / 2, set.riseY + 1.6, blobZ - 1.6, 'title');
  overlay.add(isLine ? 'ring + cross + lone post' : 'blob: one-cell hole, bitten corner',
    blobX + BLOB / 2, set.riseY + 0.9, blobZ - 1.6, 'case', 26);

  // Each case again on its own, in the palette's own reading order, so a wrong slot is
  // obvious next to its neighbours instead of hidden in the middle of a field.
  const cases = isLine
    ? LINE_CASES.map(([name, conn], i) => ({ name, patch: linePatch(conn), col: i % 5, row: (i / 5) | 0 }))
    : PALETTE_ROWS.flatMap((row, r) => row.map((name, c) => ({ name, patch: PATCH[name], col: c, row: r })));

  const found = new Map();
  for (const c of cases) {
    const ox = palX + c.col * PITCH, oz = palZ + c.row * PITCH;
    padGround(stage, ox, oz, 3, 3);
    const r = stamp(stage, tiles, ts, set, ox, oz,
      (x, z) => x >= 0 && z >= 0 && x < 3 && z < 3 && c.patch(x, z), { y0: plan.y0, clear: plan.clear });
    const hit = r.byCase.get(c.name) ?? [...r.byCase.values()].find((v) => v.cell.cx === ox + 1 && v.cell.cz === oz + 1);
    const centreHit = [...r.byCase.values()].find((v) => v.cell.cx === ox + 1 && v.cell.cz === oz + 1);
    found.set(c.name, centreHit ?? null);
    overlay.add(
      centreHit ? [c.name, short(centreHit.model.name)] : [c.name, 'no tile in palette'],
      ox + 1.5, topOf(centreHit?.model, centreHit?.cell.y ?? 0) + 0.4, oz + 1.5,
      centreHit ? 'case' : 'note');
    void hit;
  }

  const lines = [
    `${set.id}   ${set.name}`,
    `kind      ${set.kind}${set.kind === 'plateau' ? `   riseY ${set.riseY}` : ''}`,
    `centre    ${set.centre ?? '— none in palette'}${set.centreIsFallback ? '  (substituted)' : ''}`,
    `cases     ${set.cases}${set.missing.length ? `   missing: ${set.missing.join(', ')}` : '   complete'}`,
    '',
    `${pad('case', 11)}${pad('model', 36)}in blob`,
    '─'.repeat(53),
    ...(isLine ? LINE_CASES.map(([n]) => n) : BLOB_CASES.map((c) => c.name)).map((name) => {
      const f = found.get(name);
      const b = blob.byCase.get(name);
      return `${pad(name, 11)}${pad(f ? f.model.name : '— MISSING FROM PALETTE', 36)}${b ? b.count : 0}`;
    }),
    '─'.repeat(53),
    `blob ${blob.placed}/${blob.cells} cells filled`,
  ];
  overlay.panel(lines, { corner: 'bottom-left' });

  finish(ctx, tiles, stage, `showcase:tiles:${set.id}`);
  frameStage(ctx, stage, { lift: 1 });
}

// --- mode: every set at once ------------------------------------------------------------

function overviewMode({ ctx, tiles, ts, overlay, lawn, sets }) {
  const BLOB = 13, GUT = 4, PITCH = BLOB + GUT, COLS = 4;
  const rows = Math.ceil(sets.length / COLS);
  const stage = new Stage(COLS * PITCH + 3, rows * PITCH + 5);
  stage.fillGround(lawn, 14);

  const report = [];
  sets.forEach((set, i) => {
    const ox = 2 + (i % COLS) * PITCH;
    const oz = 4 + ((i / COLS) | 0) * PITCH;
    const plan = stagePlan(tiles, set);
    if (plan.ground) {
      for (let z = oz - 3; z < oz + BLOB + 3; z++) {
        for (let x = ox - 3; x < ox + BLOB + 3; x++) stage.setGround(x, z, plan.ground, plan.groundY);
      }
    }
    const shape = set.kind === 'line' ? fenceShape(BLOB) : blobShape(BLOB);
    // Same pad as the single-set mode, for the same reason: `set2` is green on green and
    // without it the overview shows an empty lawn where thirteen cases were placed.
    if (!plan.ground) padGround(stage, ox, oz, BLOB, BLOB);
    const r = stamp(stage, tiles, ts, set, ox, oz, shape, { y0: plan.y0, clear: plan.clear });
    overlay.add(`${set.id} ${set.name}`, ox + BLOB / 2, 1.2, oz - 1.4, 'title');
    const notes = [
      ...(set.missing.length ? [`missing ${set.missing.join(',')}`] : []),
      ...(set.centreIsFallback ? ['centre substituted'] : []),
      ...(plan.y0 ? [`lifted flush +${plan.y0}`] : []),
    ];
    report.push(`${pad(set.id, 6)}${pad(set.name, 18)}${pad(set.kind, 9)}`
      + `${pad(set.kind === 'plateau' ? `rise ${set.riseY}` : '', 8)}`
      + `${pad(`${r.placed}/${r.cells}`, 9)}${notes.join('; ')}`);
  });

  overlay.panel([
    'bw2-adastra — every autotile set',
    'each blob is a square with a one-cell hole and a bitten corner,',
    'which forces all 13 neighbourhoods to appear.',
    '',
    `${pad('set', 6)}${pad('palette', 18)}${pad('kind', 9)}${pad('', 8)}${pad('cells', 9)}notes`,
    '─'.repeat(70),
    ...report,
  ], { corner: 'bottom-right' });

  finish(ctx, tiles, stage, 'showcase:tiles:overview');
  frameStage(ctx, stage, { lift: 2 });
}

// --- mode: one tile of every category ---------------------------------------------------

function catalogMode({ ctx, tiles, ts, overlay, lawn }) {
  const categories = [...new Set(tiles.models(SLUG).map((m) => m.category))]
    .filter((c) => c !== 'meta').sort();

  const COLS = 5, PITCH = 7;
  const rows = Math.ceil(categories.length / COLS);
  const stage = new Stage(COLS * PITCH + 2, rows * PITCH + 4);
  stage.fillGround(lawn, 14);

  const pad2 = tiles.byName(SLUG, 'grass_path_center');
  const deep = tiles.byName(SLUG, 'water_deep');

  const lines = [`${pad('category', 11)}${pad('example', 30)}models`, '─'.repeat(48)];

  categories.forEach((cat, i) => {
    const all = tiles.find(SLUG, { category: cat });
    // Prefer a piece that stands on the ground: the biggest, most-built one of those. A
    // shoreline ramp is the wrong ambassador for its category because most of it is below
    // the floor the catalogue stands on.
    const standing = all.filter((m) => (m.baseY ?? 0) >= -0.05);
    // A standalone piece over an autotile slot: an autotile slot is authored to be seen
    // between its neighbours and reads as a sliver on its own.
    const model = [...(standing.length ? standing : all)]
      .sort((a, b) => (!!a.autotile - !!b.autotile) || (b.w * b.h - a.w * a.h) || (b.tris - a.tris))[0];
    if (!model) return;

    const ox = 2 + (i % COLS) * PITCH;
    const oz = 3 + ((i / COLS) | 0) * PITCH;
    const sinks = (model.baseY ?? 0) < -0.05;
    for (let dz = 0; dz < model.h; dz++) {
      for (let dx = 0; dx < model.w; dx++) {
        if (sinks) {
          stage.clearGround(ox + dx, oz + dz);
          stage.place(deep, ox + dx, oz + dz, { y: -0.25, layer: -1 });
        } else {
          stage.place(pad2, ox + dx, oz + dz, { y: 0.01, tint: 0xa8c8f0, layer: 0 });
        }
      }
    }
    stage.place(model, ox, oz, { y: 0, layer: 1 });
    overlay.add([cat, model.name], ox + model.w / 2, topOf(model, 0) + 0.4, oz + model.h / 2, 'title');
    lines.push(`${pad(cat, 11)}${pad(model.name, 30)}${all.length}`);
  });

  overlay.panel(lines, { corner: 'bottom-left' });
  finish(ctx, tiles, stage, 'showcase:tiles:catalog');
  frameStage(ctx, stage, { lift: 1 });
}

// --- mode: rotation of multi-cell models -------------------------------------------------

function rotateMode({ ctx, tiles, ts, overlay, lawn }) {
  const subjects = [
    tiles.byName(SLUG, 'stairs'),                    // 3x1, strongly asymmetric north/south
    tiles.byName(SLUG, 'forest_entrance_front'),     // 4x4, the biggest single model shipped
    tiles.byName(SLUG, 'bridge'),                    // 3x1, geometry deliberately overhangs
    tiles.byName(SLUG, 'tree'),                      // 2x2
  ].filter(Boolean);

  // A tinted lawn is invisible — blue on green multiplies to more green. The pad is a real
  // tile of another material, so the claimed cells read at a glance.
  const pad = tiles.byName(SLUG, 'grass_path_center');

  const PITCH_X = 8, PITCH_Z = 7;
  const stage = new Stage(4 * PITCH_X + 3, subjects.length * PITCH_Z + 3);
  stage.fillGround(lawn, 14);

  for (let r = 0; r < subjects.length; r++) {
    const model = subjects[r];
    for (let rot = 0; rot < 4; rot++) {
      const ox = 2 + rot * PITCH_X;
      const oz = 3 + r * PITCH_Z;
      const fp = tiles.footprint(model, rot);
      // The claimed cells are paved before the model lands on them: if `composeMatrix`
      // anchored a rotation anywhere but the footprint's north-west corner, the model would
      // walk off its pad and the shot would say so without any measuring.
      for (let dz = 0; dz < fp.h; dz++) {
        for (let dx = 0; dx < fp.w; dx++) {
          stage.place(pad, ox + dx, oz + dz, { y: 0.01, tint: 0x9ec6ff, layer: 0 });
        }
      }
      stage.place(pad, ox, oz, { y: 0.02, tint: 0xffa62b, layer: 0 });   // the anchor cell
      stage.place(model, ox, oz, { rot, layer: 1 });
      overlay.add(`rot ${rot}  ${fp.w}x${fp.h}`, ox + fp.w / 2, 0.35, oz + fp.h + 0.5, 'case');
    }
    overlay.add(`${model.name}  ${model.w}x${model.h}`, 2, 0.6, 3 + r * PITCH_Z - 1.3, 'title');
  }

  overlay.panel([
    'multi-cell placement and rotation',
    '',
    'pale  = the cells the placement claims, paved before the model was placed',
    'amber = the anchor cell (cx, cz) passed to place()',
    '',
    'rot is quarter turns about +Y taken about the footprint centre, so the',
    'north-west corner of the footprint stays on (cx, cz);',
    'rot 1 and 3 swap the footprint extents (w x h -> h x w).',
    '',
    'Geometry that reaches past the pad is authored that way — a bridge has',
    'railing overhangs and a tree has a canopy wider than its trunk.',
  ], { corner: 'bottom-left' });

  // No contact shadows here: this mode's whole evidence is the pale pad the placement claims,
  // and a soft dark blob over it hides exactly what the shot is meant to prove.
  finish(ctx, tiles, stage, 'showcase:tiles:rotate', { contact: 0 });
  frameStage(ctx, stage, { lift: 1 });
}

// --- mode: seeded, non-repetitive variant picking -----------------------------------------

/**
 * `tiles.pick()` hashes the cell, not a stream, so the answer for a cell does not depend on
 * how many cells were visited before it: a map rebuilt from the same seed is the same map
 * even if the author changed the order of their loops. The left patch of each pair is what
 * a field looks like without it.
 */
function variantsMode({ ctx, tiles, ts, overlay, lawn }) {
  const families = ['michi03b', 'cliff_top']
    .map((name) => tiles.variantsOf(SLUG, tiles.byName(SLUG, name)))
    .filter((v) => v.length > 1);

  const SIZE = 8, GAP = 3;
  const stage = new Stage(2 + (SIZE + GAP) * 2 + 2, 4 + families.length * (SIZE + 4));
  stage.fillGround(lawn, 14);

  const lines = ['seeded variant picking', ''];
  families.forEach((variants, r) => {
    const oz = 4 + r * (SIZE + 4);
    for (let col = 0; col < 2; col++) {
      const ox = 2 + col * (SIZE + GAP);
      for (let dz = 0; dz < SIZE; dz++) {
        for (let dx = 0; dx < SIZE; dx++) {
          // salt is the family index, so two fields on the same cells do not correlate.
          const model = col === 0
            ? variants[0]
            : tiles.pick(variants, ox + dx, oz + dz, { salt: r + 1, baseWeight: 1 });
          // Half of these families are authored flush with the floor or a little below it
          // (`cliff_top_v2..v6` are the worn, sunken paving), so the lawn has to go first.
          stage.clearGround(ox + dx, oz + dz);
          stage.place(model, ox + dx, oz + dz, { layer: 1 });
        }
      }
      overlay.add(col === 0 ? 'variants[0] only' : `pick() over ${variants.length}`,
        ox + SIZE / 2, topOf(variants[0], 0) + 0.4, oz + SIZE + 0.6, 'case');
    }
    overlay.add(`${variants[0].name}  x${variants.length}`, 2 + SIZE, 0.7, oz - 1.3, 'title');
    lines.push(`${pad(variants[0].name, 16)}${variants.length} variants: ${variants.map((m) => m.name).join(', ')}`);
  });

  lines.push('', 'pick(models, cx, cz) hashes the cell, so the choice for a cell is the same',
    'however the map was walked — and identical on every replay of the same seed.');
  overlay.panel(lines, { corner: 'bottom-left' });

  finish(ctx, tiles, stage, 'showcase:tiles:variants');
  frameStage(ctx, stage, { lift: 1 });
}

// --- mode: the street lamps, close up ----------------------------------------------------

/**
 * The lamp gauntlet, because `light` is the one category the boot shot showed as a blob.
 *
 * All four `lamp_h*` variants stand in a row on paving, each labelled with the orientation
 * the loader derives from its own geometry (`orientation`), so a map author can see that
 * "arm to the west" is a query and not a guess. `?emissive=1` drives `setEmissiveScale`
 * directly — `environment` owns the night ramp, but the lamp has to be provable without it.
 */
function lampsMode({ ctx, tiles, ts, overlay, lawn }) {
  const lamps = tiles.find(SLUG, { category: 'light' });
  const paving = tiles.byName(SLUG, 'stone_path_center') ?? tiles.byName(SLUG, 'grass_path_center');
  const bench = tiles.byName(SLUG, 'bench_s');

  const PITCH = 4;
  const stage = new Stage(2 + lamps.length * PITCH, 11);
  stage.fillGround(lawn, 10);

  // A paved strip under the row: a lamp reads against a road, and the shadow decal at its
  // foot has to be judged on a surface, not on grass that hides it.
  for (let cz = 4; cz < 8; cz++) {
    for (let cx = -2; cx < stage.w + 2; cx++) stage.setGround(cx, cz, paving);
  }

  const bulbs = [];
  lamps.forEach((m, i) => {
    const cx = 2 + i * PITCH, cz = 6;
    stage.place(m, cx, cz, { layer: 2 });
    bulbs.push(bulbOf(m, cx, cz));
    overlay.add([m.name, `arm ${m.orientation ?? '—'}  ${m.tris} tris`],
      cx + 0.5, topOf(m, 0) + 0.5, cz + 0.5, 'case');
  });
  const lit = lightLamps(ctx, bulbs);
  // Two benches, on the paving, flanking the row. They were at (3,9) and (w-4,9), which is
  // outside the framing this mode uses: the left one landed behind the readout panel and the
  // right one was cut in half by the frame edge, so the proof shot's only extra content read
  // as debris. `frameStage` covers roughly x -1..19 and z -3..12 here, and z 7 is the south
  // edge of the paved strip, which is where a bench belongs anyway.
  if (bench) {
    stage.place(bench, 4, 7, { layer: 2 });
    stage.place(bench, 12, 7, { layer: 2 });
  }

  // Deliberately does *not* call setEmissiveScale: `?emissive=` is already applied at init,
  // and calling it here with a default of 0 would latch the module into "someone is driving
  // me" and kill the clock-following ramp — a lamps showcase that proves lamps do not light.
  const driven = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
    .has('emissive');

  overlay.panel([
    `street lamps — ${lamps.length} variants of one 30-triangle model`,
    '',
    ...lamps.map((m) => `${pad(m.name, 12)}arm ${pad(m.orientation ?? '—', 6)}`
      + `x ${m.bounds.min[0].toFixed(2)}..${m.bounds.max[0].toFixed(2)}  `
      + `z ${m.bounds.min[2].toFixed(2)}..${m.bounds.max[2].toFixed(2)}`),
    '',
    driven ? 'setEmissiveScale — driven from ?emissive=' : 'setEmissiveScale — following the clock',
    lit ? `${lit} bulbs registered with environment.lamps — the ground pool is theirs, not ours`
      : 'environment is not live: the glass glows and the ground stays dark',
    'the head is real geometry; the arm reaches a cell and a half out of the tile,',
    'so a lamp placed with the arm on the camera axis hides its own post.',
  ], { corner: 'bottom-left' });

  finish(ctx, tiles, stage, 'showcase:tiles:lamps');
  frameStage(ctx, stage, { pad: 1, lift: -1 });
}

// --- mode: the ground, with nothing on it ------------------------------------------------

/**
 * Repetition is only visible over area, so this is deliberately boring: a wide lawn, a
 * wide path, and the seam between them. `?variety=0` turns the instancer's per-cell
 * variety off so the two can be shot from the same URL and diffed.
 */
function groundMode({ ctx, tiles, ts, overlay, lawn }) {
  const stage = new Stage(40, 30);
  stage.fillGround(lawn, 12);

  const isPath = (cx, cz) => (cx >= 14 && cx < 22) || (cz >= 18 && cz < 23 && cx >= 4 && cx < 36);
  stamp(stage, tiles, ts, tiles.autotile.sets(SLUG).find((s) => s.id === 'set0'), 0, 0, isPath,
    { layer: 1, clear: false });

  // Two scatters, because the two surfaces need opposite things. The lawn wants *objects*
  // that break its plane — flowers and tufts, which throw their own small shadows. The road
  // wants *wear*: the three dirt overlays are alpha cutouts of cracks and bald patches that
  // land on top of the paving and give a four-colour texture somewhere to catch the light.
  const lawnDetail = [...tiles.find(SLUG, { tags: ['flower'] }),
    ...tiles.find(SLUG, { category: 'plant', tags: ['grass'] })];
  const roadDetail = tiles.find(SLUG, { category: 'path', tags: ['dirt'] })
    .filter((m) => m.autotile == null && (m.baseY ?? 0) >= 0.1);

  for (let cz = 0; cz < stage.h; cz++) {
    for (let cx = 0; cx < stage.w; cx++) {
      const h = ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
      const on = isPath(cx, cz);
      const pool = on ? roadDetail : lawnDetail;
      if (!pool.length) continue;
      if ((h % 100) >= (on ? 11 : 7)) continue;
      stage.place(pool[h % pool.length], cx, cz, { layer: 3 });
    }
  }

  overlay.panel([
    'the lawn and the path, with nothing to look at but the tiling',
    '',
    'grass is one model with GLOBALMAPPING at scale 0.25, so without help the',
    'whole field is a 4x4-cell stamp repeated; the path centre is scale 1, so',
    'every path cell is the same square.',
    '',
    'buildInstances({ variety }) breaks both: a globally-mapped tile is phased by',
    'its own 4x4 block, so the artist\'s pattern stays continuous inside a block',
    'and only the repeat is broken; a scale-1 tile gets a per-cell quarter turn',
    'and phase. Both get a tonal blotch on a 24-cell lattice, which moves 1% per',
    'cell — under what the eye can find a grid in.  No extra draw calls.',
    '?variety=0 to compare, ?contact=0 for the contact shadows.',
  ], { corner: 'bottom-left' });

  finish(ctx, tiles, stage, 'showcase:tiles:ground');
  frameStage(ctx, stage, { pad: 0 });
}

// --- mode: the trees, one at a time -------------------------------------------------------

/**
 * The mode the blind judges' forest complaints have to be settled in.
 *
 * A wood is the worst place to debug a tree: every crown overlaps its neighbour's, so a
 * card that is drawn wrong is indistinguishable from a card that is merely behind
 * something. This stands each 2x2 tree alone on open lawn with four clear cells around it,
 * at the game camera, so the *silhouette* is readable — trunk, canopy, root decal and the
 * order they stack in — and then repeats the three of them packed at the spacing `hunts`
 * actually plants at, so a fix can be judged on an isolated object and on a mass in the
 * same frame. One `lamp_h` stands at the end of the row on paving for the same reason.
 */
function treesMode({ ctx, tiles, ts, overlay, lawn }) {
  const trees = ['tree', 'round_tree', 'darker_pine', 'big_tree_dark']
    .map((n) => tiles.byName(SLUG, n)).filter(Boolean);
  const lamp = tiles.find(SLUG, { category: 'light', orientation: 'w' })[0]
    ?? tiles.find(SLUG, { category: 'light' })[0];
  const paving = tiles.byName(SLUG, 'stone_path_center') ?? tiles.byName(SLUG, 'grass_path_center');

  const PITCH = 6;
  const stage = new Stage(PITCH * trees.length + 10, 18);
  stage.fillGround(lawn, 10);

  // Row one: one tree per column, four cells of clear lawn between crowns.
  trees.forEach((m, i) => {
    const cx = 2 + i * PITCH, cz = 3;
    stage.place(m, cx, cz, { layer: 2 });
    overlay.add([m.name, `${m.tris} tris  y ${m.bounds.min[1].toFixed(2)}..${m.bounds.max[1].toFixed(2)}`],
      cx + m.w / 2, topOf(m, 0) + 0.5, cz + m.h / 2, 'case');
  });

  // Row two: the copse. `hunts` packs 2x2 crowns at 1.85 cells with overlap allowed
  // (DECISIONS #36b), so this is that spacing on a fixed lattice — the mass, not the object.
  const copse = trees.slice(0, 3);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 6; c++) {
      const m = copse[(r * 2 + c * 3) % copse.length];
      stage.place(m, 2 + c * 3, 10 + r * 2, { layer: 2 });
    }
  }

  if (lamp && paving) {
    const cx = stage.w - 4;
    for (let cz = 2; cz < 6; cz++) stage.setGround(cx, cz, paving);
    stage.place(lamp, cx, 4, { layer: 2 });
    lightLamps(ctx, [bulbOf(lamp, cx, 4)]);
    overlay.add([lamp.name, `${lamp.tris} tris  slamp03 16x32`],
      cx + 0.5, topOf(lamp, 0) + 0.5, 4.5, 'case');
  }

  overlay.panel([
    'the trees, alone and in a mass',
    '',
    ...trees.map((m) => `${pad(m.name, 15)}${pad(`${m.tris} tris`, 9)}`
      + `y ${m.bounds.min[1].toFixed(2)}..${m.bounds.max[1].toFixed(2)}  `
      + `${m.groups.length} materials`),
    '',
    'an AdAstra tree is two upright cards crossing at the cell centre plus',
    'horizontal canopy slices, one material per layer (DECISIONS #22). The',
    'cards carry the whole tree — trunk at the bottom, crown at the top — so',
    'they are the only geometry in the set that can show a V flip.',
  ], { corner: 'bottom-left' });

  finish(ctx, tiles, stage, 'showcase:tiles:trees');
  frameStage(ctx, stage, { pad: 1, lift: -1 });
}

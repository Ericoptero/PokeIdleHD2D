/**
 * hunts selftest — the parts of a biome that can be checked without a GPU.
 *
 *   node src/hunts/selftest.js
 *
 * Discovered and run by `tools/seams/run.js`. It exits non-zero on the first real failure,
 * because a composition bug that survives to a screenshot costs a whole round.
 *
 * ## What this file is NOT, stated first because it was trusted for something it never did
 *
 * Round 3 shipped this green at 279/279 in a round where three named framings on the live
 * seed-1337 map still walked the party north, and the critic was right to call that worse
 * than having no selftest at all. Two things made its maps different maps:
 *
 *  1. **A different RNG stream.** It called `makeRng(seed, 'hunts/<biome>')`; the game calls
 *     `ctx.rng.fork('hunts/<biome>/<seed>')`, and `ctx.rng` is `makeRng(config.seed, 'root')`
 *     whose `fork` *appends* — so the shipped label is `root/hunts/<biome>/<seed>`. Different
 *     label, different `hashString`, different stream: every scatter in the map — outcrops,
 *     trees, litter, the wild cells — landed somewhere else. Fixed below; the stream is now
 *     built the way the game builds it.
 *  2. **A stub tileset**, which is still true and cannot cheaply stop being true: loading the
 *     real pack needs `THREE.TextureLoader` and a DOM. So model footprints here are the
 *     stub's, not AdAstra's, and `pick`/`solvePlacements` are stand-ins. A region's *shape*
 *     is a pure function of the seed and is therefore real; which model lands in a cell, and
 *     how wide that model's footprint is, is not.
 *
 * So: this file proves the **region algebra, the noise, and per-seed determinism**. The
 * shipped map's framings are asserted at runtime instead, by `hunts.audit()`, which runs on
 * the real `MapDraft` on every `enter()` and warns per failing preset — and the screenshot
 * harness records `consoleWarnings` in the JSON beside every PNG, so a clean shot log is the
 * assertion. The last line of this file's output says all of that again, out loud, because
 * the number in front of it is the thing people read.
 */

import {
  Field, valueNoise, fbm2, scatterSpaced, ellipseFalloff, mulTint, litAt, findLoop, slotsForLoop } from './compose.js';
import { makeRng } from '../core/rng.js';
import terrainModule from '../terrain/index.js';
import { BIOMES } from './index.js';
import { makePalette, set0Outward, SET_CASE_SIG } from './palette.js';

/**
 * `MapDraft` comes off `terrain`'s **published API**, not off `terrain/draft.js`.
 *
 * A cross-module deep import is banned (`tools/seams/run.js` fails the
 * build on it), and the ban is right even in a test: a selftest that reaches past a module's
 * index is a second definition of that module's contract, and it goes stale silently. So the
 * descriptor is initialised against a stub context and the class is taken from what it
 * returns — which also asserts, for free, that `terrain.init` still hands one out.
 */
const stubCtx = {
  bus: { emit() {}, on: () => () => {}, once() {} },
  log: { info() {}, warn() {}, error() {} },
  get: () => ({ __missing: true }),
};
const { MapDraft } = terrainModule.init(stubCtx);

let passed = 0, failed = 0;
const fails = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; return true; }
  failed++; fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------ region algebra

{
  const a = new Field(10, 10, (x, z) => x >= 2 && x <= 5 && z >= 2 && z <= 5);
  check('Field.count counts what was set', a.count() === 16, `got ${a.count()}`);

  const grown = a.clone().grow(1);
  check('grow(1) adds a ring', grown.count() === 36, `got ${grown.count()}`);
  check('grow keeps the interior', grown.get(3, 3) === 1);

  const shrunk = a.clone().shrink(1);
  check('shrink(1) removes the ring', shrunk.count() === 4, `got ${shrunk.count()}`);

  const b = new Field(10, 10, (x) => x >= 4);
  const inter = a.clone().intersect(b);
  check('intersect is the overlap', inter.count() === 8, `got ${inter.count()}`);
  const minus = a.clone().subtract(b);
  check('subtract removes the overlap', minus.count() === 8, `got ${minus.count()}`);
  check('union restores the whole', minus.clone().union(inter).count() === a.count());

  const speck = new Field(10, 10);
  speck.set(1, 1); speck.set(8, 8);
  speck.set(4, 4); speck.set(5, 4); speck.set(4, 5); speck.set(5, 5);
  speck.despeckle(3);
  check('despeckle drops islands under the floor', speck.count() === 4, `got ${speck.count()}`);
  check('despeckle keeps the blob', speck.get(4, 4) === 1);

  // A ragged edge must move only the boundary — an interior cell surviving is what keeps a
  // patch one patch instead of dissolving into confetti.
  const disc = new Field(24, 24, (x, z) => (x - 12) ** 2 + (z - 12) ** 2 < 49);
  const before = disc.count();
  const frayed = disc.clone().ragged(1337, { amount: 0.5, period: 4 });
  check('ragged keeps the middle', frayed.get(12, 12) === 1);
  check('ragged moves the edge', frayed.count() !== before, 'nothing changed');
  check('ragged does not run away', Math.abs(frayed.count() - before) < before * 0.6,
    `${before} -> ${frayed.count()}`);
  const again = disc.clone().ragged(1337, { amount: 0.5, period: 4 });
  check('ragged is deterministic', frayed.bits.every((v, i) => v === again.bits[i]));
}

// ------------------------------------------------------------------------- noise

{
  // The whole point of interpolating: neighbours must be close, or a threshold on this
  // noise draws a checkerboard and the eye finds the grid instantly.
  let worst = 0;
  for (let z = 0; z < 60; z++) {
    for (let x = 0; x < 60; x++) {
      worst = Math.max(worst, Math.abs(valueNoise(x, z, 99, 8) - valueNoise(x + 1, z, 99, 8)));
    }
  }
  check('valueNoise is smooth cell to cell', worst < 0.35, `worst step ${worst.toFixed(3)}`);
  check('valueNoise stays in range', [...Array(200)].every((_, i) => {
    const v = valueNoise(i * 7, i * 13, 3, 6);
    return v >= 0 && v < 1;
  }));
  check('valueNoise is a pure function', near(valueNoise(5, 9, 1, 8), valueNoise(5, 9, 1, 8)));
  check('fbm2 stays in range', [...Array(200)].every((_, i) => {
    const v = fbm2(i * 3, i * 5, 7, 12, 0.35);
    return v >= 0 && v < 1;
  }));
  // ---- the light the biomes are graded off -------------------------------------------
  //
  // `mulTint` is the operation `instanceColor` performs, done at author time so a cell can
  // carry two independent gradings at once. If it stopped being a multiply the forest floor
  // would lose either its canopy ramp or its sun pool, silently, and only a screenshot would
  // say which.
  check('mulTint by white is the identity', mulTint(0x8ab3c4, 0xffffff) === 0x8ab3c4,
    mulTint(0x8ab3c4, 0xffffff).toString(16));
  check('mulTint by black is black', mulTint(0x8ab3c4, 0x000000) === 0);
  check('mulTint halves each channel independently',
    mulTint(0xff8040, 0x808080) === 0x804020, mulTint(0xff8040, 0x808080).toString(16));
  const gap = { x: 10, z: 10, rx: 4, rz: 3, feather: 0.8 };
  check('litAt is full inside the pool', near(litAt(9, 9, gap, 7), 1));
  check('litAt is dark well outside it', near(litAt(30, 30, gap, 7), 0));
  check('litAt is a pure function of the cell', litAt(12, 11, gap, 7) === litAt(12, 11, gap, 7));
  check('litAt falls off rather than stepping',
    litAt(15, 10, gap, 7) > 0 && litAt(15, 10, gap, 7) < 1, String(litAt(15, 10, gap, 7)));

  check('ellipseFalloff peaks at the centre', near(ellipseFalloff(9, 9, { x: 10, z: 10, rx: 5, rz: 5 }), 1));
  check('ellipseFalloff bottoms out beyond the rim',
    ellipseFalloff(30, 10, { x: 10, z: 10, rx: 5, rz: 5 }) === 0);
}

// ----------------------------------------------------------------------- scatter

{
  const rng = makeRng(1337, 'selftest/scatter');
  const cells = scatterSpaced(rng, { rect: { x: 0, z: 0, w: 40, h: 40 }, spacing: 4 });
  let minD2 = Infinity;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const dx = cells[i][0] - cells[j][0], dz = cells[i][1] - cells[j][1];
      minD2 = Math.min(minD2, dx * dx + dz * dz);
    }
  }
  check('scatterSpaced respects its spacing', minD2 >= 16, `closest pair ${Math.sqrt(minD2).toFixed(2)}`);
  check('scatterSpaced fills the rect', cells.length > 40, `only ${cells.length}`);
  const again = scatterSpaced(makeRng(1337, 'selftest/scatter'), { rect: { x: 0, z: 0, w: 40, h: 40 }, spacing: 4 });
  check('scatterSpaced is deterministic', JSON.stringify(cells) === JSON.stringify(again));
}

// -------------------------------------------------------------- the biome builds
//
// A stub tileset stands in for `tiles`: the builds are exercised for their *composition*,
// which is what this file can check, and the geometry is what the screenshots check.

function stubTiles() {
  const models = [];
  const mk = (name, category, tags, w = 1, h = 1, maxY = 0.3, autotile = null) => {
    const m = {
      id: models.length, name, category, subcategory: null, orientation: null,
      tags, biomes: ['any'], collision: 'walk', w, h, baseY: 0,
      bounds: { min: [0, 0, 0], max: [w, maxY, h] }, autotile,
    };
    models.push(m);
    return m;
  };
  mk('grass', 'ground', ['flat', 'floor', 'grass']);
  mk('dirt', 'path', ['dirt', 'flat', 'floor', 'path']);
  mk('tall_grass', 'plant', ['encounter', 'foliage', 'tallgrass'], 1, 1, 0.62);
  mk('tall_grass_light', 'plant', ['encounter', 'foliage', 'tallgrass'], 1, 1, 0.5);
  mk('flower', 'plant', ['decor', 'flat', 'flower']);
  mk('hedge1', 'plant', ['foliage', 'hedge'], 1, 1, 1);
  mk('hedge3', 'plant', ['foliage', 'hedge', 'multicell'], 3, 1, 1);
  mk('tree', 'tree', ['billboard', 'foliage', 'multicell', 'tall', 'tree'], 2, 2, 4.5);
  mk('big_tree', 'tree', ['billboard', 'foliage', 'multicell', 'tall', 'tree'], 3, 3, 4.75);
  mk('cave_ground', 'cave', ['cave', 'flat', 'floor']);
  mk('cave_mud', 'cave', ['cave', 'flat', 'floor', 'multicell'], 2, 2);
  mk('cave_big_rock', 'cave', ['cave', 'multicell', 'tall'], 6, 6, 6.5);
  mk('cave_exit', 'cave', ['cave', 'cliff', 'multicell', 'rock', 'tall'], 2, 3, 2);
  mk('estalactita', 'prop', ['cave', 'multicell', 'stalactite', 'tall'], 2, 1, 8.24);
  mk('sea', 'water', ['sunken', 'water'], 1, 1, 0.3125);
  const byId = new Map(models.map((m) => [m.id, m]));
  const KNOWN_SIGS = new Set(Object.values(SET_CASE_SIG));
  const SETS = ['set0', 'set1', 'set3', 'set4', 'set7', 'set9'].map((id) => ({
    id, name: id, kind: id === 'set9' ? 'line' : 'surface', riseY: 0, sinkY: 0,
    digsIn: false, flat: true, underlay: id === 'set1' || id === 'set4' || id === 'set7',
    cases: 13, missing: [],
  }));
  return {
    load: async () => {},
    get: () => ({ models, byId }),
    byId: (_slug, id) => byId.get(id) ?? null,
    find: (_slug, q = {}) => models.filter((m) => {
      if (q.category && m.category !== q.category) return false;
      if (q.maxCells !== undefined && m.w * m.h > q.maxCells) return false;
      for (const t of q.tags ?? []) if (!m.tags.includes(t)) return false;
      return true;
    }),
    pick: (list, cx, cz) => (list?.length ? list[Math.floor(valueNoise(cx, cz, 5, 3) * list.length)] : null),
    autotile: {
      sets: () => SETS,
      solvePlacements: (_slug, setId, occ, w, h) => {
        const out = [];
        const ground = models[0];
        for (let z = 0; z < h; z++) {
          for (let x = 0; x < w; x++) if (occ[z * w + x]) out.push({ modelId: ground.id, cx: x, cz: z, y: 0, rot: 0, case: 'center' });
        }
        return out;
      },
      // The join `palette.draw`'s `remap` goes through: a case signature back to a model id.
      // The stub answers with the *dirt* model rather than the ground one so a re-cast cell is
      // distinguishable from a cell the solver chose, and −1 for a signature it does not know,
      // which is the real API's contract for a set that never enumerated that slot.
      solve: (_slug, _setId, sig) => (KNOWN_SIGS.has(sig) ? models[1].id : -1),
    },
  };
}

const quietLog = { info() {}, warn() {}, error() {} };

// -------------------------------------- palette.draw honours `rotate` and `remap`
//
// `set0Outward` is the only thing standing between the trail and the three-tan-runs-split-by-
// two-grass-ribbons it shipped as for four rounds, and between the meander steps and the green
// comma they stamped inside the dirt for five. It works by turning all thirteen solved cases
// 180 degrees and re-casting the eight corners as a neighbouring case. If `draw` ever stops
// passing either hook through, the road silently goes back to being divided and nothing says
// so — which is exactly how three rounds of this module's own header came to claim a fix that
// was never applied.
{
  const tiles = stubTiles();
  const draft = new MapDraft({ id: 'rot', w: 8, h: 8, tileset: 'stub', biome: 'meadow', seed: 1 });
  const field = new Field(8, 8, (cx, cz) => cx > 1 && cx < 6 && cz > 1 && cz < 6);
  const pal = makePalette(tiles, 'stub', quietLog);
  pal.draw(draft, 'set0', field, { collision: 'walk', layer: 1, rotate: () => 2 });
  check('palette.draw passes `rotate` through to the placement',
    draft.placements.length > 0 && draft.placements.every((p) => p.rot === 2),
    `${draft.placements.filter((p) => p.rot === 2).length}/${draft.placements.length} at rot 2`);

  const draft2 = new MapDraft({ id: 'remap', w: 8, h: 8, tileset: 'stub', biome: 'meadow', seed: 1 });
  const pal2 = makePalette(tiles, 'stub', quietLog);
  pal2.draw(draft2, 'set0', field, { collision: 'walk', layer: 1, remap: () => 'edge_w' });
  check('palette.draw passes `remap` through and re-casts every cell',
    (pal2.lastDraw()?.recast ?? 0) === draft2.placements.length && draft2.placements.length > 0,
    JSON.stringify(pal2.lastDraw()));

  const draft3 = new MapDraft({ id: 'remap0', w: 8, h: 8, tileset: 'stub', biome: 'meadow', seed: 1 });
  const pal3 = makePalette(tiles, 'stub', quietLog);
  pal3.draw(draft3, 'set0', field, { collision: 'walk', layer: 1, remap: () => 'not_a_case' });
  check('an unknown `remap` target keeps the solver’s own model rather than losing the cell',
    draft3.placements.length === draft2.placements.length && (pal3.lastDraw()?.recast ?? -1) === 0,
    JSON.stringify(pal3.lastDraw()));

  check('SET_CASE_SIG names all thirteen blob slots',
    Object.keys(SET_CASE_SIG).length === 13 && SET_CASE_SIG.edge_w === 11
    && SET_CASE_SIG.center === 255 && SET_CASE_SIG.inner_se === 127,
    Object.keys(SET_CASE_SIG).join(','));
}

// ------------------------------------------------ set0Outward: the corner re-cast rule
//
// Two synthetic fields, no textures needed. A north-south band and an east-west band, each
// with one meander step in it, and the assertion is that the *same* rule reads the shoulder
// off the field and picks the longitudinal edge in both — a hard-coded `edge_w` would pass the
// first and fail the second, and the coast's strand is the second.
{
  // A 3-wide north-south band that steps one cell west half way down.
  const ns = new Field(12, 12, (cx, cz) => (cz < 6 ? cx >= 5 && cx <= 7 : cx >= 4 && cx <= 6));
  const pol = set0Outward(ns);
  check('set0Outward turns every case 180 degrees', pol.rotate() === 2, String(pol.rotate()));
  check('set0Outward re-casts an inner corner to plain dirt',
    pol.remap('inner_nw', 5, 6) === 'center' && pol.remap('inner_se', 7, 5) === 'center');
  check('set0Outward leaves the four straight edges and the centre alone',
    ['edge_n', 'edge_s', 'edge_w', 'edge_e', 'center'].every((k) => pol.remap(k, 5, 3) === null));
  // (4,6) is the outward corner of the step: exposed west (a 6-cell shoulder) and north (1).
  check('on a north-south trail an outer corner takes the long north-south shoulder',
    pol.remap('corner_nw', 4, 6) === 'edge_w', pol.remap('corner_nw', 4, 6));

  // The same band transposed: 3 cells tall, running east, stepping one cell north.
  const ew = new Field(12, 12, (cx, cz) => (cx < 6 ? cz >= 5 && cz <= 7 : cz >= 4 && cz <= 6));
  const pol2 = set0Outward(ew);
  check('on an east-west track the same rule takes the long east-west shoulder',
    pol2.remap('corner_nw', 6, 4) === 'edge_n', pol2.remap('corner_nw', 6, 4));
}

/** The two biomes round 7 gave a practical to — see the block inside the loop. */
const LIT_BIOMES = new Set(['forest', 'meadow']);

for (const biome of BIOMES) {
  const tiles = stubTiles();
  const ctxStub = { get: (id) => (id === 'tiles' ? tiles : { __missing: true }), rng: makeRng(1337, 'selftest') };

  const build = (seed) => {
    const draft = new MapDraft({ id: `hunt-${biome.id}`, w: biome.w, h: biome.h, tileset: biome.tileset, biome: biome.id, seed });
    const palette = makePalette(tiles, biome.tileset, quietLog);
    // The stream the *game* builds: `ctx.rng` is `makeRng(config.seed, 'root')` and `fork`
    // appends, so `ctx.rng.fork('hunts/cave/1337')` is `makeRng(1337, 'root/hunts/cave/1337')`.
    // Round 3 passed `hunts/cave`, which is a different label and therefore a different
    // xoshiro state — so every scatter in this file's maps was somewhere else than in the
    // shipped ones, before the tileset stub is even considered.
    const stream = makeRng(seed, 'root').fork(`hunts/${biome.id}/${seed}`);
    const report = biome.build(draft, ctxStub, palette, stream, quietLog);
    draft.finalize();
    return { draft, report };
  };

  const a = build(1337);
  const b = build(1337);
  const c = build(4242);

  check(`${biome.id}: places something`, a.draft.placements.length > 500,
    `${a.draft.placements.length} placements`);
  check(`${biome.id}: same seed, same map`,
    JSON.stringify(a.draft.placements) === JSON.stringify(b.draft.placements));
  check(`${biome.id}: a different seed is a different map`,
    JSON.stringify(a.draft.placements) !== JSON.stringify(c.draft.placements));

  // A spawn nobody can stand on is a map that boots to a wall.
  const s = a.draft.spawn;
  check(`${biome.id}: spawn is inside the map`,
    s.cx > 0 && s.cz > 0 && s.cx < biome.w - 1 && s.cz < biome.h - 1, JSON.stringify(s));
  check(`${biome.id}: spawn is walkable`, a.draft.passable(s.cx, s.cz, 2),
    `collision "${a.draft.collisionAt(s.cx, s.cz)}"`);

  // ---- the motivated light (round 7) --------------------------------------------------
  //
  // Four blind rounds said the same thing about `forest-day`, `forest-night` and
  // `meadow-day`: *"a uniform tint with no light source anywhere"*, against references that
  // each have one committed source. A bulb that exists but sits outside the framing the pair
  // is shot on fixes nothing, so what is asserted here is not "there is a light" but "the
  // light is in the picture and it falls on the line the eye follows".
  if (LIT_BIOMES.has(biome.id)) {
    const lights = a.report?.lights ?? [];
    check(`${biome.id}: registers a practical with environment`, lights.length >= 1,
      `${lights.length} lights`);
    check(`${biome.id}: every bulb is inside the map and near the floor`,
      lights.every((L) => L.x > 0 && L.z > 0 && L.x < biome.w && L.z < biome.h
        && L.y > 0 && L.y < 3),
      JSON.stringify(lights.map((L) => [L.x, L.z, L.y])));
    check(`${biome.id}: at least one bulb takes a PointLight slot`,
      lights.some((L) => L.point !== false));
    // **In frame.** `showcaseDefault` is the framing both blind pairs are shot on; at
    // distance 30 the camera shows ground from 12.7 cells north of the focus to 8 south and
    // about 12.5 either side, and the focus is the party three tiles east of the marker.
    const dflt = (biome.presets ?? {})[biome.showcaseDefault];
    const dm = dflt && a.draft.marker(dflt.marker ?? biome.showcaseDefault);
    if (dm) {
      const fx = dm.cx + 3, fz = dm.cz;
      const inFrame = lights.every((L) => Math.abs(L.x - fx) <= 12
        && L.z - fz >= -12 && L.z - fz <= 7);
      check(`${biome.id}: the practical is inside the judged framing`, inFrame,
        `focus ~${fx},${fz}; bulbs ${JSON.stringify(lights.map((L) => [L.x, L.z]))}`);
    }
    // **And it lights the trail.** `docs/refs/03` is a party on a *lit path*; a pool that
    // falls entirely on lawn beside the track is the same frame with a lamp bolted onto it.
    const onTrail = a.report?.stats?.litPathCells ?? a.report?.stats?.litTrackCells ?? 0;
    check(`${biome.id}: the lit pool covers part of the trail`, onTrail >= 6,
      `${onTrail} path cells inside the pool`);
    // **And nothing it put down blocks the walk.** The camps sit inside `path.grow(2)`, and
    // `makeScriptedRoute` drops an impassable step in silence and files the party north.
    const camp = String(a.report?.stats?.camp ?? '').split(',').map(Number);
    if (camp.length === 2 && Number.isFinite(camp[0])) {
      check(`${biome.id}: the camp cell stays walkable`,
        a.draft.collisionAt(camp[0], camp[1]) === 'walk',
        `collision "${a.draft.collisionAt(camp[0], camp[1])}" at ${camp}`);
    }
  }

  // How much ground a framing actually covers, in cells, at a given zoom.
  //
  // The camera is orthographic, so the frustum is the internal buffer over `pixelsPerUnit`
  // — no distance, no fov. The reference buffer is 640x360, which is what both
  // 1920x1080 and the gate's own 1280x720 now produce. A run of L cells in Z covers L*sin(45)
  // of *screen* height under the 45-degree pitch, so the visible depth is the frustum height
  // over sin(45) — about 1.41x what the height alone suggests. `cameraLookAhead` lifts the aim
  // point by 1.6 world units of Y, which at 45 degrees is 1.6/tan(45) = 1.6 cells of ground:
  // that much of the depth moves from behind the focus to in front of it.
  const framingCells = (ppu) => {
    const [W, H] = [640, 360];
    const sin45 = Math.SQRT1_2;
    const depth = (H / ppu) / sin45;
    const shift = 1.6;                       // cameraLookAhead / tan(cameraPitch)
    return {
      wide: Math.ceil((W / ppu) / 2),
      north: Math.ceil(depth / 2 + shift),
      south: Math.ceil(depth / 2 - shift),
    };
  };

  // Every camera framing has to have somewhere to stand, or `--preset` silently shows the
  // default view and a whole contact sheet is one picture four times.
  for (const [name, spec] of Object.entries(biome.presets ?? {})) {
    const m = a.draft.marker(spec.marker ?? name);
    check(`${biome.id}: preset "${name}" has a marker`, !!m, `wants "${spec.marker ?? name}"`);
    if (m) {
      check(`${biome.id}: preset "${name}" is inside the map`,
        m.cx >= 0 && m.cz >= 0 && m.cx < biome.w && m.cz < biome.h, JSON.stringify(m));
      // The framing arithmetic, asserted rather than remembered — and now asserted per
      // preset, because the zoom is per preset. A marker nearer to an edge
      // than the frame is deep frames the void beyond the map; `cave-mouth` shipped exactly
      // that once, and the bottom third of the frame was black.
      const { wide: mw, north: mn, south: ms } = framingCells(spec.ppu ?? 32);
      check(`${biome.id}: preset "${name}" is clear of the south edge`, m.cz <= biome.h - ms,
        `cz ${m.cz} of ${biome.h}, needs ${ms} clear at ppu ${spec.ppu ?? 32}`);
      check(`${biome.id}: preset "${name}" is clear of the north edge`, m.cz >= mn,
        `cz ${m.cz} of ${biome.h}, needs ${mn} clear at ppu ${spec.ppu ?? 32}`);
      check(`${biome.id}: preset "${name}" is clear of the side edges`,
        m.cx >= mw && m.cx <= biome.w - mw - 1,
        `cx ${m.cx} of ${biome.w}, needs ${mw} clear at ppu ${spec.ppu ?? 32}`);
      check(`${biome.id}: preset "${name}" stands on walkable ground`, a.draft.passable(m.cx, m.cz, 2),
        `collision "${a.draft.collisionAt(m.cx, m.cz)}"`);
    }
  }

  // **Every framing has to have an east-west lane to walk in**, and this is the check that
  // would have caught round 2's worst defect before a screenshot did.
  //
  // Three blind A/B rounds named one thing: the party files north, hides itself behind
  // itself, and shows the camera the back of the trainer's cap. Asking the route for an east
  // leg is not enough — `makeScriptedRoute` drops an impassable step *silently* and falls
  // through to the next direction — so a marker that is not on an east-west opening is a
  // frame that walks north again with nothing in the console. `Line.place` also lays the
  // whole queue along the walk direction at the teleport: with `followerGapTiles` 2 and four
  // members the tail sits five cells behind the marker and the lead two ahead, so the row has
  // to be clear from `cx − 5` to `cx + 6` for the queue to be strung out rather than stacked.
  for (const [name, spec] of Object.entries(biome.presets ?? {})) {
    const m = a.draft.marker(spec.marker ?? name);
    if (!m) continue;
    // **`cx + 8`, not `cx + 6`.** The window used to stop one cell short of the walk: the
    // lead starts at `cx + 2` and `advanceTo(3, 7)` moves it 4.4 tiles to `cx + 6.4`, which
    // means it *steps into* `cx + 7`. `cave/pool` was clear across the old window and blocked
    // at `cx + 7`, so this check passed on a framing whose lead reported `dir 2`.
    const y0 = a.draft.heightAt(m.cx, m.cz);
    let clear = 0, level = 0;
    for (let dx = -5; dx <= 8; dx++) {
      if (a.draft.passable(m.cx + dx, m.cz, 3)) clear++;
      // One height across the lane, or two walkers stand either side of a step — which is
      // the `cave --preset close` frame where the trainer was cut off at the waist.
      if (Math.abs(a.draft.heightAt(m.cx + dx, m.cz) - y0) <= 0.26) level++;
    }
    check(`${biome.id}: preset "${name}" has an east-west lane`, clear === 14,
      `${clear}/14 cells walkable across (${m.cx - 5}..${m.cx + 8}, ${m.cz})`);
    check(`${biome.id}: preset "${name}" lane is one height`, level === 14,
      `${level}/14 cells level with (${m.cx}, ${m.cz})`);
  }

  // Wildlife has to have somewhere to stand that a walker could also stand on, or the grass
  // is empty again — which is the whole-game critic's headline about this module.
  const wild = a.report?.wild ?? [];
  check(`${biome.id}: offers wild Pokemon cells`, wild.length >= 8, `${wild.length} cells`);
  check(`${biome.id}: every wild cell is walkable`,
    wild.every((c) => a.draft.inside(c.cx, c.cz) && a.draft.passable(c.cx, c.cz, 2)),
    JSON.stringify(wild.filter((c) => !a.draft.passable(c.cx, c.cz, 2)).slice(0, 3)));
  check(`${biome.id}: the wild cells are the same from the same seed`,
    JSON.stringify(wild) === JSON.stringify(b.report?.wild ?? []));

  // The party has to be able to reach the map from the spawn; a walled-in spawn is the one
  // failure that looks completely fine in a screenshot and is unplayable.
  const reach = floodFrom(a.draft, s.cx, s.cz);
  check(`${biome.id}: the spawn opens onto the map`, reach > 150, `only ${reach} cells reachable`);

  // Encounters need somewhere to happen.
  let encounterCells = 0;
  for (let cz = 0; cz < biome.h; cz++) {
    for (let cx = 0; cx < biome.w; cx++) if (a.draft.hasTag(cx, cz, 'encounter')) encounterCells++;
  }
  check(`${biome.id}: has encounter ground`, encounterCells > 40, `${encounterCells} cells`);

  // ---------------------------------------------------------- the wood is a wood
  //
  // Round 5's whole brief in two numbers, because "denser" is not a thing a screenshot can
  // be diffed on a round later. The critic's reading of round 4 was *"individual crowns each
  // ringed by lit lawn, each with its root decal showing and its own separate cast
  // shadow"* — a plantation — and the geometry behind it was that `scatterSpaced` rejects a
  // pair on `dx² + dz² < r²`, so a floor of 1.75 put the closest possible pair two whole
  // cells apart and a 2x2 crown could only ever *touch* its neighbour.
  //
  // The stub's tree footprints are honest 2x2 and 3x3, so crown *coverage* is real here even
  // though which model lands where is not. Two assertions:
  //
  //  · crowns **interlock**: more than 40 % of the cells under canopy are under more than
  //    one. Both ends were measured through this same stub, by reverting the file to its
  //    round-4 behaviour and building again: round 4 is **18.1 %** (337 of 1867) and round 5
  //    is **52.8 %** (1112 of 2108), so the threshold sits between the two rather than at a
  //    round number someone liked.
  //  · the pitch is **below the touching distance**: round 4's nearest-neighbour distance was
  //    2.00 at the minimum, the first quartile and the median alike — a lattice — and round
  //    5's is 1.00 / 1.41 / 1.41.
  if (biome.id === 'forest') {
    const cover = new Uint8Array(biome.w * biome.h);
    const origins = [];
    for (const p of a.draft.placements) {
      const m = tiles.byId(biome.tileset, p.modelId);
      if (!m || m.category !== 'tree') continue;
      origins.push([p.cx, p.cz]);
      for (let dz = 0; dz < m.h; dz++) {
        for (let dx = 0; dx < m.w; dx++) {
          const x = p.cx + dx, z = p.cz + dz;
          if (x < biome.w && z < biome.h) cover[z * biome.w + x]++;
        }
      }
    }
    let covered = 0, multi = 0;
    for (const c of cover) { if (c) { covered++; if (c > 1) multi++; } }
    check('forest: the canopy interlocks rather than tiles',
      covered > 0 && multi / covered > 0.4, `${multi}/${covered} cells under two crowns`);

    // A quasi-lattice has one nearest-neighbour distance; a wood has several. Round 4's
    // scatter put 2.00 at the minimum, the first quartile and the median alike, which is what
    // "5 rows x 9 columns of the same crown" is in numbers.
    const nn = origins.map(([x, z]) => {
      let best = Infinity;
      for (const [ox, oz] of origins) {
        if (ox === x && oz === z) continue;
        const d = Math.hypot(ox - x, oz - z);
        if (d < best) best = d;
      }
      return best;
    }).sort((p, q) => p - q);
    check('forest: the wood packs below the touching distance',
      nn.length > 200 && nn[Math.floor(nn.length / 2)] < 1.9,
      `median nearest neighbour ${nn.length ? nn[Math.floor(nn.length / 2)].toFixed(2) : 'n/a'} over ${nn.length} trees`);

    // Half the crowns are mirrored. `place` carries no scale, so a quarter turn and a second
    // model are the only silhouette variety this tileset has, and "no rotation variation" was
    // named in pixels.
    const rots = new Set(a.draft.placements
      .filter((p) => tiles.byId(biome.tileset, p.modelId)?.category === 'tree').map((p) => p.rot));
    check('forest: the crowns are not all at one yaw', rots.size > 1, `rots ${[...rots].join(',')}`);

    // ------------------------------------------------ the front rank keeps no bare trunks
    //
    // The critic counted the failure in pixels — *"about 11 bare trunk-and-root decals in a
    // straight line across x 40-900"* and *"four crowns on lit lawn each with its full trunk
    // and root decal exposed"* — and the cause was that round 5 covered them with a Poisson
    // scatter over the `face` row, which has gaps by construction and does not know where the
    // trunks are. The rule now is exact and therefore assertable: **a crown with no crown
    // standing in the row south of its footprint carries a plant on every cell of its own
    // southern row.** One uncovered cell is one visible trunk.
    const plant = new Uint8Array(biome.w * biome.h);
    for (const p of a.draft.placements) {
      const m = tiles.byId(biome.tileset, p.modelId);
      if (!m || m.category !== 'plant' || m.tags?.includes('tallgrass')) continue;
      const fw = (p.rot & 1) ? (m.h ?? 1) : (m.w ?? 1);
      const fh = (p.rot & 1) ? (m.w ?? 1) : (m.h ?? 1);
      for (let dz = 0; dz < fh; dz++) {
        for (let dx = 0; dx < fw; dx++) {
          const x = p.cx + dx, z = p.cz + dz;
          if (x < biome.w && z < biome.h) plant[z * biome.w + x] = 1;
        }
      }
    }
    let front = 0, bare = 0;
    for (const p of a.draft.placements) {
      const m = tiles.byId(biome.tileset, p.modelId);
      if (!m || m.category !== 'tree') continue;
      const w = m.w ?? 1, h = m.h ?? 1;
      let exposed = false;
      for (let dx = 0; dx < w; dx++) {
        const x = p.cx + dx, z = p.cz + h;
        if (z >= biome.h || x >= biome.w || !cover[z * biome.w + x]) exposed = true;
      }
      if (!exposed) continue;
      front++;
      const bz = p.cz + h - 1;
      for (let dx = 0; dx < w; dx++) {
        const x = p.cx + dx;
        if (x < biome.w && bz < biome.h && !plant[bz * biome.w + x]
          && a.draft.collisionAt(x, bz) === 'block') { bare++; break; }
      }
    }
    check('forest: no crown on the front rank keeps a bare trunk',
      front > 20 && bare === 0, `${bare} of ${front} front-rank crowns uncovered`);
    check('forest: the trunk cover is reported and is not empty',
      (a.report?.stats?.trunksCovered ?? 0) > 20
      && (a.report?.stats?.coverCells ?? 0) >= (a.report?.stats?.trunksCovered ?? 0),
      JSON.stringify({ covered: a.report?.stats?.trunksCovered, cells: a.report?.stats?.coverCells }));
  }
}

/** How many cells a walker can reach from a start, four-connected. */
function floodFrom(draft, cx, cz) {
  const seen = new Uint8Array(draft.w * draft.h);
  const stack = [[cx, cz]];
  let n = 0;
  seen[draft.idx(cx, cz)] = 1;
  while (stack.length) {
    const [x, z] = stack.pop();
    n++;
    for (const [dx, dz, dir] of [[0, 1, 0], [-1, 0, 1], [0, -1, 2], [1, 0, 3]]) {
      const nx = x + dx, nz = z + dz;
      if (!draft.inside(nx, nz) || seen[draft.idx(nx, nz)]) continue;
      if (!draft.passable(nx, nz, dir)) continue;
      seen[draft.idx(nx, nz)] = 1;
      stack.push([nx, nz]);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// The loop and its slots
// ---------------------------------------------------------------------------
// `findLoop` and `slotsForLoop` are pure functions of a draft, so unlike everything above
// them they mean exactly the same thing here as they do on the shipped map. What they are
// asked about the SHIPPED map is `hunts.audit()`'s job, at runtime, on every enter().
{
  // A hand-built room: a 24x20 walkable floor with a pillar in the middle of it.
  const room = new MapDraft({ id: 'loop-test', w: 24, h: 20, seed: 1 });
  for (let z = 1; z < 19; z++) for (let x = 1; x < 23; x++) room.setCollision(x, z, 'walk');
  for (let z = 8; z < 12; z++) for (let x = 10; x < 14; x++) room.setCollision(x, z, 'block');

  // `margin` is a CAMERA constraint (the frame must not see past the map edge), and this room
  // is a 24x20 fixture with no camera in it — the shipped default of 11 leaves nothing to
  // search. The geometry under test is the perimeter, not the framing.
  const loop = findLoop(room, { cx: 12, cz: 10 }, { min: 6, max: 18, margin: 1 });
  check('a loop is found in an open room', !!loop, loop ? `${loop.w}x${loop.h}` : 'none');
  if (loop) {
    // Walk it, exactly as `audit()` does on the real draft.
    let cx = loop.start.cx; let cz = loop.start.cz; let blocked = 0;
    const DX = [0, -1, 0, 1]; const DZ = [1, 0, -1, 0];
    const L = { s: 0, w: 1, n: 2, e: 3 };
    const dirs = [];
    for (const m of loop.route.matchAll(/([nsew])\s*(\d*)/g)) {
      const n = m[2] ? parseInt(m[2], 10) : 1;
      for (let i = 0; i < n; i++) dirs.push(L[m[1]]);
    }
    for (const d of dirs) {
      const nx = cx + DX[d]; const nz = cz + DZ[d];
      if (!room.passable(nx, nz, d)) blocked++;
      cx = nx; cz = nz;
    }
    check('every step of the loop is passable', blocked === 0, `${blocked} blocked`);
    check('the loop CLOSES', cx === loop.start.cx && cz === loop.start.cz,
      `ends ${cx},${cz} want ${loop.start.cx},${loop.start.cz}`);
    check('the route has one step per perimeter cell', dirs.length === loop.cells.length,
      `${dirs.length} steps, ${loop.cells.length} cells`);
    check('the loop steps around the pillar, not through it',
      !loop.cells.some((c) => c.cx >= 10 && c.cx < 14 && c.cz >= 8 && c.cz < 12));

    const slots = slotsForLoop(room, loop.cells, makeRng(1, 'slots'), { count: 8 });
    check('slots are placed', slots.length > 0, `${slots.length}`);
    // The arithmetic the encounter trigger rests on: tether 1 + trigger 1 = contact at 2.
    const dist = (s2) => Math.min(...loop.cells.map((c) => Math.max(Math.abs(c.cx - s2.cx), Math.abs(c.cz - s2.cz))));
    check('every slot is EXACTLY two cells off the path',
      slots.every((s2) => dist(s2) === 2),
      slots.map(dist).join(','));
    check('no two slots share a cell',
      new Set(slots.map((s2) => `${s2.cx},${s2.cz}`)).size === slots.length);
    check('every slot is somewhere a creature can stand',
      slots.every((s2) => room.passable(s2.cx, s2.cz, 0)));

    /**
     * The detour's geometry, asserted rather than reasoned about.
     *
     * Every offset `slotsForLoop` tries is axial, so the midpoint between the path cell and
     * the slot is ONE step off the circuit — Chebyshev 1 from both ends and never a loop cell,
     * because `near()` has already rejected anything within one cell of the path. That is what
     * lets a detour be a queued pair rather than a path search, and it is the claim the whole
     * of Phase B rests on, so it is pinned here on a room a Node test can build.
     */
    const cheb = (a, b) => Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cz - b.cz));
    check('every slot records where the party leaves the circuit',
      slots.every((s2) => s2.from && s2.approach && Number.isFinite(s2.step)));
    check('the cell it leaves from is ON the loop',
      slots.every((s2) => loop.cells.some((c) => c.cx === s2.from.cx && c.cz === s2.from.cz)));
    check('the departure cell is exactly two from its slot',
      slots.every((s2) => cheb(s2.from, s2) === 2));
    check('the approach is ONE step off the path and ONE from the wild',
      slots.every((s2) => cheb(s2.approach, s2.from) === 1 && cheb(s2.approach, s2) === 1),
      slots.map((s2) => `${cheb(s2.approach, s2.from)}/${cheb(s2.approach, s2)}`).join(' '));
    check('no approach cell is itself a loop cell',
      !slots.some((s2) => loop.cells.some((c) => c.cx === s2.approach.cx && c.cz === s2.approach.cz)));
    check('the approach is walkable in both directions',
      slots.every((s2) => room.passable(s2.approach.cx, s2.approach.cz, s2.step)
        && room.passable(s2.from.cx, s2.from.cz, (s2.step + 2) & 3)));
    check('stepping out and back lands on the cell it left',
      slots.every((s2) => {
        const DXl = [0, -1, 0, 1]; const DZl = [1, 0, -1, 0];
        const back = (s2.step + 2) & 3;
        const outCell = { cx: s2.from.cx + DXl[s2.step], cz: s2.from.cz + DZl[s2.step] };
        const home = { cx: outCell.cx + DXl[back], cz: outCell.cz + DZl[back] };
        return home.cx === s2.from.cx && home.cz === s2.from.cz;
      }));
  }

  // --- corners: configurable, and closure survives every one of them ------
  // The rectangle is the floor. Each bend displaces a straight run sideways, which cannot open
  // the ring because it replaces a path between two cells with another path between the same
  // two cells — but "cannot" is worth checking at every setting rather than asserted once.
  const big = new MapDraft({ id: 'corners', w: 60, h: 56, seed: 1 });
  for (let z = 1; z < 55; z++) for (let x = 1; x < 59; x++) big.setCollision(x, z, 'walk');

  const walkRing = (draft, ring) => {
    const DXr = [0, -1, 0, 1]; const DZr = [1, 0, -1, 0];
    let bad = 0;
    for (let i = 0; i < ring.length; i++) {
      const a2 = ring[i]; const b2 = ring[(i + 1) % ring.length];
      const dx = b2.cx - a2.cx; const dz = b2.cz - a2.cz;
      if (Math.abs(dx) + Math.abs(dz) !== 1) { bad++; continue; }
      const dir = dx === 1 ? 3 : dx === -1 ? 1 : dz === 1 ? 0 : 2;
      if (!draft.passable(b2.cx, b2.cz, dir)) bad++;
      void DXr; void DZr;
    }
    return bad;
  };

  let cornersTracked = 0; let allClosed = 0; let allStraightLead = 0;
  const ASKED = [4, 8, 12, 16, 24];
  for (const want of ASKED) {
    const l = findLoop(big, { cx: 30, cz: 28 },
      { min: 8, max: 24, margin: 2, corners: want, depth: 2, straightLead: 4, rng: makeRng(1, `c${want}`) });
    if (!l) continue;
    if (l.corners === want) cornersTracked++;
    if (walkRing(big, l.cells) === 0) allClosed++;
    // The ring must OPEN on a straight at least as long as the walker queue, or `hunts.enter`
    // places the head — the walker that follows the route — off its own path.
    const d0 = (a2, b2) => (b2.cx > a2.cx ? 3 : b2.cx < a2.cx ? 1 : b2.cz > a2.cz ? 0 : 2);
    let lead = 0;
    while (lead + 1 < l.cells.length
      && d0(l.cells[lead], l.cells[lead + 1]) === d0(l.cells[0], l.cells[1])) lead++;
    if (lead >= 4) allStraightLead++;
  }
  check('the corner count is configurable and tracks the request', cornersTracked === ASKED.length,
    `${cornersTracked}/${ASKED.length}`);
  check('a bent circuit is still closed and walkable at every setting', allClosed === ASKED.length,
    `${allClosed}/${ASKED.length}`);
  check('every circuit opens on a straight long enough for the queue',
    allStraightLead === ASKED.length, `${allStraightLead}/${ASKED.length}`);

  // Bending must not turn a lap into a marathon.
  const plain = findLoop(big, { cx: 30, cz: 28 }, { min: 8, max: 24, margin: 2, corners: 4, rng: makeRng(1, 'p') });
  const bent = findLoop(big, { cx: 30, cz: 28 }, { min: 8, max: 24, margin: 2, corners: 24, depth: 2, rng: makeRng(1, 'b') });
  check('bending a circuit does not balloon it', bent.cells.length <= plain.cells.length * 1.55,
    `${plain.cells.length} -> ${bent.cells.length}`);
  check('four corners really is a plain rectangle', plain.corners === 4, `${plain.corners}`);

  // A map with nowhere to walk must say so rather than inventing a circuit.
  const solid = new MapDraft({ id: 'solid', w: 20, h: 20, seed: 1 });
  check('a map with no walkable ring reports no loop', findLoop(solid, { cx: 10, cz: 10 }, { margin: 1 }) === null);
}

const total = passed + failed;
if (failed) for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`${failed ? '✗' : '✓'} hunts selftest: ${passed}/${total} `
  + '(composition only — built against a STUB tileset, so these are not the shipped maps; '
  + 'the shipped map\'s framings are asserted at runtime by hunts.audit(), which warns on '
  + 'every enter() and lands in each screenshot JSON\'s consoleWarnings)');
if (failed) process.exitCode = 1;

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

import { Field, valueNoise, fbm2, scatterSpaced, ellipseFalloff } from './compose.js';
import { makeRng } from '../core/rng.js';
import terrainModule from '../terrain/index.js';
import { BIOMES } from './index.js';
import { makePalette, SET0_OUTWARD } from './palette.js';

/**
 * `MapDraft` comes off `terrain`'s **published API**, not off `terrain/draft.js`.
 *
 * A cross-module deep import is banned (ARCHITECTURE §5, and `tools/seams/run.js` fails the
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
  // noise draws a checkerboard and the eye finds the grid instantly (DECISIONS #30e).
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
    },
  };
}

const quietLog = { info() {}, warn() {}, error() {} };

// ------------------------------------------------------- palette.draw honours `rotate`
//
// `SET0_OUTWARD` is the only thing standing between the trail and the three-tan-runs-split-
// by-two-grass-ribbons it shipped as for four rounds, and it works by turning two of the
// thirteen solved cases. If `draw` ever stops passing the turn through, the road silently
// goes back to being divided and nothing says so.
{
  const tiles = stubTiles();
  const draft = new MapDraft({ id: 'rot', w: 8, h: 8, tileset: 'stub', biome: 'meadow', seed: 1 });
  const field = new Field(8, 8, (cx, cz) => cx > 1 && cx < 6 && cz > 1 && cz < 6);
  const pal = makePalette(tiles, 'stub', quietLog);
  pal.draw(draft, 'set0', field, { collision: 'walk', layer: 1, rotate: () => 2 });
  check('palette.draw passes `rotate` through to the placement',
    draft.placements.length > 0 && draft.placements.every((p) => p.rot === 2),
    `${draft.placements.filter((p) => p.rot === 2).length}/${draft.placements.length} at rot 2`);
  check('SET0_OUTWARD turns the two side cases and nothing else',
    SET0_OUTWARD.edge_w === 2 && SET0_OUTWARD.edge_e === 2
    && Object.keys(SET0_OUTWARD).length === 2, JSON.stringify(SET0_OUTWARD));
}

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

  // Every camera framing has to have somewhere to stand, or `--preset` silently shows the
  // default view and a whole contact sheet is one picture four times (DECISIONS #28j).
  for (const [name, spec] of Object.entries(biome.presets ?? {})) {
    const m = a.draft.marker(spec.marker ?? name);
    check(`${biome.id}: preset "${name}" has a marker`, !!m, `wants "${spec.marker ?? name}"`);
    if (m) {
      check(`${biome.id}: preset "${name}" is inside the map`,
        m.cx >= 0 && m.cz >= 0 && m.cx < biome.w && m.cz < biome.h, JSON.stringify(m));
      // The framing arithmetic, asserted rather than remembered: at pitch 45 / fov 26 /
      // distance 30 the camera shows ground from 12.7 cells north of the focus to 8 south,
      // so a marker nearer than that to an edge frames the void beyond the map. `cave-mouth`
      // shipped exactly that once — the bottom third of the frame was black.
      check(`${biome.id}: preset "${name}" is clear of the south edge`, m.cz <= biome.h - 9,
        `cz ${m.cz} of ${biome.h}`);
      check(`${biome.id}: preset "${name}" is clear of the north edge`, m.cz >= 13,
        `cz ${m.cz} of ${biome.h}`);
      check(`${biome.id}: preset "${name}" is clear of the side edges`,
        m.cx >= 13 && m.cx <= biome.w - 14, `cx ${m.cx} of ${biome.w}`);
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

const total = passed + failed;
if (failed) for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`${failed ? '✗' : '✓'} hunts selftest: ${passed}/${total} `
  + '(composition only — built against a STUB tileset, so these are not the shipped maps; '
  + 'the shipped map\'s framings are asserted at runtime by hunts.audit(), which warns on '
  + 'every enter() and lands in each screenshot JSON\'s consoleWarnings)');
if (failed) process.exitCode = 1;

/**
 * hunts selftest — the parts of a biome that can be checked without a GPU.
 *
 *   node src/hunts/selftest.js
 *
 * Discovered and run by `tools/seams/run.js`. It exits non-zero on the first real failure,
 * because a composition bug that survives to a screenshot costs a whole round.
 *
 * What it can prove here: the region algebra does what its name says, the noise is smooth
 * enough that a threshold cannot produce a checkerboard, and every biome's build function
 * is a pure function of its seed — same seed, byte-identical placements. What it cannot
 * prove is whether the result is *beautiful*; that is what the screenshots are for.
 */

import { Field, valueNoise, fbm2, scatterSpaced, ellipseFalloff } from './compose.js';
import { makeRng } from '../core/rng.js';
import terrainModule from '../terrain/index.js';
import { BIOMES } from './index.js';
import { makePalette } from './palette.js';

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

for (const biome of BIOMES) {
  const tiles = stubTiles();
  const ctxStub = { get: (id) => (id === 'tiles' ? tiles : { __missing: true }), rng: makeRng(1337, 'selftest') };

  const build = (seed) => {
    const draft = new MapDraft({ id: `hunt-${biome.id}`, w: biome.w, h: biome.h, tileset: biome.tileset, biome: biome.id, seed });
    const palette = makePalette(tiles, biome.tileset, quietLog);
    const report = biome.build(draft, ctxStub, palette, makeRng(seed, `hunts/${biome.id}`), quietLog);
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
console.log(`${failed ? '✗' : '✓'} hunts selftest: ${passed}/${total}`);
if (failed) process.exitCode = 1;

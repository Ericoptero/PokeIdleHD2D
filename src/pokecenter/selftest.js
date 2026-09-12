#!/usr/bin/env node
/**
 * pokecenter selftest — the room's layout, checked without a GPU.
 *
 *   node src/pokecenter/selftest.js
 *
 * Discovered and run by `tools/seams/run.js` (rule 6). `buildPokecenterMap` is the real
 * function `map.js` ships, run against a stub `tiles` that answers the same
 * category/subcategory/orientation/bounds queries the real `pt-house-indoor` catalog does
 * (verified by direct catalog read — see the slice this module was written from) — so what
 * is checked here is the actual collision the shipped room produces, not a hand-copied
 * expectation of it.
 *
 * `MapDraft` comes off `terrain`'s own published API, not a deep import of
 * `terrain/draft.js` (ARCHITECTURE §5, `tools/seams/run.js` rule 2) — the same guard
 * `hunts/selftest.js` uses.
 */

import terrainModule from '../terrain/index.js';
import { buildPokecenterMap } from './map.js';
import { ROOM_W, ROOM_H, SPAWN, EXIT, EXIT_TAG, COUNTER, NURSE, BENCHES } from './layout.js';

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

/** A `tiles` stub that answers the same queries `map.js` makes, against models shaped like
 *  the real `pt-house-indoor` catalog (category, subcategory, orientation, bounds). */
function stubTiles() {
  const models = [];
  const mk = (name, category, subcategory, opts = {}) => {
    const m = {
      id: models.length, name, category, subcategory,
      orientation: opts.orientation ?? null,
      tags: opts.tags ?? [], biomes: ['any'], collision: opts.collision ?? 'block',
      w: opts.w ?? 1, h: opts.h ?? 1,
      bounds: opts.bounds ?? { min: [0, -0.125, 0], max: [opts.w ?? 1, 2.875, opts.h ?? 1] },
    };
    models.push(m);
    return m;
  };
  for (let i = 0; i < 3; i++) {
    mk(`wooden_floor${i ? `_v${i + 1}` : ''}`, 'interior', 'wooden_floor',
      { collision: 'walk', bounds: { min: [0, -0.125, 0], max: [1, -0.125, 1] } });
  }
  mk('table', 'unknown', 'table', { w: 3, h: 1, collision: 'block' });
  for (let i = 0; i < 3; i++) mk(`house_wall${i ? `_v${i + 1}` : ''}`, 'building', 'house_wall');
  mk('house_wall_c_w', 'building', 'house_wall_c', { orientation: 'w' });
  mk('house_wall_c_e', 'building', 'house_wall_c', { orientation: 'e' });
  mk('house_wall_side', 'building', 'house_wall_side', { bounds: { min: [1, -0.125, 0], max: [1, 2.875, 1] } });
  mk('house_wall_side_v2', 'building', 'house_wall_side', { bounds: { min: [0, -0.125, 0], max: [0, 2.875, 1] } });

  const byId = new Map(models.map((m) => [m.id, m]));
  return {
    load: async () => ({ models, byId }),
    get: () => ({ models, byId }),
    find: (_slug, q = {}) => models.filter((m) => {
      if (q.category && m.category !== q.category) return false;
      if (q.subcategory && m.subcategory !== q.subcategory) return false;
      if (q.orientation && m.orientation !== q.orientation) return false;
      return true;
    }),
    byName: (_slug, name) => models.find((m) => m.name === name) ?? null,
    pick: (list) => (list?.length ? list[0] : null),
  };
}

const tiles = stubTiles();
const ctx = { get: (id) => (id === 'tiles' ? tiles : { __missing: true }), log: stubCtx.log };
const draft = new MapDraft({ id: 'pokecenter', w: ROOM_W, h: ROOM_H, tileset: 'pt-house-indoor', biome: 'city', seed: 1337 });
await buildPokecenterMap(draft, ctx);

// --- the exit ----------------------------------------------------------------
check('the exit cell is inside the room', draft.inside(EXIT.cx, EXIT.cz),
  `${EXIT.cx},${EXIT.cz} against ${ROOM_W}x${ROOM_H}`);
check('the exit cell is walkable', draft.passable(EXIT.cx, EXIT.cz, 0),
  `collision "${draft.collisionAt(EXIT.cx, EXIT.cz)}"`);
check('the exit cell carries the tag the door listener reads',
  draft.hasTag(EXIT.cx, EXIT.cz, EXIT_TAG));

// --- spawn and exit ------------------------------------------------------------
check('the spawn cell is inside the room', draft.inside(SPAWN.cx, SPAWN.cz));
check('the spawn cell is walkable', draft.passable(SPAWN.cx, SPAWN.cz, 0),
  `collision "${draft.collisionAt(SPAWN.cx, SPAWN.cz)}"`);
check('spawn and exit are distinct cells',
  SPAWN.cx !== EXIT.cx || SPAWN.cz !== EXIT.cz);
const dx = Math.abs(SPAWN.cx - EXIT.cx), dz = Math.abs(SPAWN.cz - EXIT.cz);
check('spawn and exit are orthogonally adjacent', (dx === 0 && dz === 1) || (dx === 1 && dz === 0),
  `dx ${dx} dz ${dz}`);

// --- the counter ----------------------------------------------------------------
// The pack's one furniture piece is 3 cells wide; every one of them has to actually block,
// not just the cell `map.js` calls `place()` on.
let counterCells = 0;
for (let cx = COUNTER.cx; cx < COUNTER.cx + COUNTER.w; cx++) {
  counterCells++;
  check(`counter cell ${cx},${COUNTER.cz} is blocked`, draft.collisionAt(cx, COUNTER.cz) === 'block',
    `got "${draft.collisionAt(cx, COUNTER.cz)}"`);
}
check('the counter was actually measured', counterCells === COUNTER.w, String(counterCells));
let counterTagCells = 0;
for (let cx = COUNTER.cx; cx < COUNTER.cx + COUNTER.w; cx++) {
  counterTagCells++;
  check(`counter cell ${cx},${COUNTER.cz} carries the 'counter' tag`,
    draft.hasTag(cx, COUNTER.cz, 'counter'));
}
check('the counter tag was checked on every cell', counterTagCells === COUNTER.w, String(counterTagCells));

// --- Nurse Joy's spot -----------------------------------------------------------
check('the Nurse spot is inside the room', draft.inside(NURSE.cx, NURSE.cz),
  `${NURSE.cx},${NURSE.cz} against ${ROOM_W}x${ROOM_H}`);
check('the Nurse spot is walkable', draft.passable(NURSE.cx, NURSE.cz, 0),
  `collision "${draft.collisionAt(NURSE.cx, NURSE.cz)}"`);
check('the Nurse spot is not a counter cell',
  !(NURSE.cz === COUNTER.cz && NURSE.cx >= COUNTER.cx && NURSE.cx < COUNTER.cx + COUNTER.w));
check('the Nurse spot is distinct from spawn',
  NURSE.cx !== SPAWN.cx || NURSE.cz !== SPAWN.cz);
check('the Nurse spot is distinct from the exit',
  NURSE.cx !== EXIT.cx || NURSE.cz !== EXIT.cz);

// --- the three built walls, and the one side that is not -----------------------
check('the north wall blocks its row (outside the window)',
  [1, 2, ROOM_W - 2, ROOM_W - 3].every((cx) => draft.collisionAt(cx, 0) === 'block'));
check('the west wall blocks its column', [0, 1, 2, ROOM_H - 1].every((cz) => draft.collisionAt(0, cz) === 'block'));
check('the east wall blocks its column',
  [0, 1, 2, ROOM_H - 1].every((cz) => draft.collisionAt(ROOM_W - 1, cz) === 'block'));
check('the room has no fourth wall — every other south cell is open floor',
  [1, 2, ROOM_W - 3, ROOM_W - 2].every((cx) => cx === EXIT.cx || draft.passable(cx, ROOM_H - 1, 0)));

// --- the benches' reserved ground ------------------------------------------------
check('every bench cell is inside the room and blocked',
  BENCHES.every((b) => draft.inside(b.cx, b.cz) && draft.collisionAt(b.cx, b.cz) === 'block'));

// --- report -----------------------------------------------------------------
for (const f of fails) console.log(`✗ ${f}`);
console.log(`${failed ? '' : '✓ '}pokecenter: ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);

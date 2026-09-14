import { describe, it, expect } from 'vitest';
import { encodeRuns } from './mapfile.js';
import { validateMap, reachableFrom } from './validate.js';

/** A minimal, otherwise-valid 4x4 map file: an open walkable field, nothing fancy. */
function baseMap(overrides = {}) {
  const w = 4;
  const h = 4;
  const collision = new Array(w * h).fill('walk');
  const height = new Array(w * h).fill(0);
  const tags = new Array(w * h).fill([]);
  const occupied = new Array(w * h).fill(0);
  return {
    format: 'pokeidle.map', version: 3, id: 'test-map', name: 'Test', kind: 'hunt',
    w, h, tileset: 'bw2-adastra', seed: 1,
    economy: { money: 1, exp: 1, research: 1, encounters: 1, favours: {} },
    grid: {
      collision: encodeRuns(collision), height: encodeRuns(height),
      tags: encodeRuns(tags), occupied: encodeRuns(occupied),
    },
    layers: [], regions: [], spawn: { cx: 1, cz: 1, dir: 0 }, markers: [],
    loop: null, spawnPoints: [], npcs: [], links: [], lights: [], cameras: null,
    ...overrides,
  };
}

function setCollision(map, cx, cz, kind) {
  const decoded = [];
  for (const [idx, n] of map.grid.collision.r) for (let i = 0; i < n; i++) decoded.push(map.grid.collision.p[idx]);
  decoded[cz * map.w + cx] = kind;
  map.grid.collision = encodeRuns(decoded);
}

describe('validateMap', () => {
  it('reports no errors on a clean, fully-walkable map', () => {
    const { errors } = validateMap(baseMap());
    expect(errors).toEqual([]);
  });

  it('flags a ledge cell with no direction tag', () => {
    const map = baseMap();
    setCollision(map, 2, 2, 'ledge');
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'ledge-no-direction')).toBe(true);
  });

  it('does not flag a ledge cell that carries a direction tag', () => {
    const map = baseMap();
    setCollision(map, 2, 2, 'ledge');
    const decoded = [];
    for (const [idx, n] of map.grid.tags.r) for (let i = 0; i < n; i++) decoded.push(map.grid.tags.p[idx]);
    decoded[2 * map.w + 2] = ['ledge:0'];
    map.grid.tags = encodeRuns(decoded);
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'ledge-no-direction')).toBe(false);
  });

  it('flags a spawn placed on a blocked cell', () => {
    const map = baseMap({ spawn: { cx: 0, cz: 0, dir: 0 } });
    setCollision(map, 0, 0, 'block');
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'spawn-not-passable')).toBe(true);
  });

  it('flags loop.via naming a marker that does not exist', () => {
    const map = baseMap({ loop: { via: ['nope'] } });
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'marker-missing')).toBe(true);
  });

  it('does not flag an inline {cx,cz} loop.via waypoint as a missing marker', () => {
    const map = baseMap({ loop: { via: [{ cx: 1, cz: 1 }, { cx: 2, cz: 1 }] } });
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'marker-missing')).toBe(false);
  });

  it('finds an unreachable walkable island behind a wall of blocked cells', () => {
    const map = baseMap({ spawn: { cx: 0, cz: 0, dir: 0 } });
    // Wall off column 2 entirely so column 3 is unreachable from spawn at (0,0).
    for (let cz = 0; cz < map.h; cz++) setCollision(map, 2, cz, 'block');
    const { warnings } = validateMap(map);
    expect(warnings.some((w) => w.code === 'unreachable-region')).toBe(true);
    const reach = reachableFrom(map, map.spawn);
    expect(reach[0 * map.w + 3]).toBe(0); // top-right corner, walled off
  });

  it('skips a context-dependent check when its env input is absent, rather than passing it silently', () => {
    const map = baseMap({ spawnPoints: [{ cx: 1, cz: 1, dir: 0, species: [{ name: 'patrat', chance: 10 }] }] });
    const { skipped } = validateMap(map);
    expect(skipped).toContain('spawn-point-species');
    expect(skipped).toContain('model-unresolved');
  });

  it('runs the spawn-point-species check when a species set is provided', () => {
    const map = baseMap({ spawnPoints: [{ cx: 1, cz: 1, dir: 0, species: [{ name: 'patrat', chance: 10 }] }] });
    const { errors } = validateMap(map, { species: new Set(['patrat']) });
    expect(errors.some((e) => e.code === 'spawn-point-species')).toBe(false);
  });

  it('flags a spawn point naming an unknown species', () => {
    const map = baseMap({ spawnPoints: [{ cx: 1, cz: 1, dir: 0, species: [{ name: 'nope', chance: 10 }] }] });
    const { errors } = validateMap(map, { species: new Set(['patrat']) });
    expect(errors.some((e) => e.code === 'spawn-point-species')).toBe(true);
  });

  it('flags a spawn point placed on a blocked cell', () => {
    const map = baseMap({ spawnPoints: [{ cx: 2, cz: 2, dir: 0, species: [{ name: 'patrat', chance: 10 }] }] });
    setCollision(map, 2, 2, 'block');
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'spawn-point-blocked')).toBe(true);
  });

  it('resolves a region\'s autotile set against the MAP\'s own tileset, not a non-existent Region.tileset', () => {
    const mask = new Array(16).fill(0);
    mask[5] = 1;
    const map = baseMap({
      regions: [{ id: 'r0', kind: 'autotile', set: 'set0', layer: 0, mask: encodeRuns(mask) }],
    });
    // The map's own tileset ("bw2-adastra") carries "set0"; a region has no `tileset` field of
    // its own for the check to have been misreading in the first place.
    const clean = validateMap(map, { catalogs: { 'bw2-adastra': { autotileSets: ['set0'] } } });
    expect(clean.errors.some((e) => e.code === 'autotile-set-missing')).toBe(false);

    const dirty = validateMap(map, { catalogs: { 'bw2-adastra': { autotileSets: ['other-set'] } } });
    expect(dirty.errors.some((e) => e.code === 'autotile-set-missing')).toBe(true);
  });

  it('flags a region mask cell that a layer\'s own tile grid already draws something on', () => {
    const modelAt = new Array(16).fill(-1);
    modelAt[5] = 0; // something already drawn at cell (1,1)
    const mask = new Array(16).fill(0);
    mask[5] = 1; // the region claims the same cell
    const map = baseMap({
      layers: [{ tileset: 'bw2-adastra', role: 'draft', models: ['grass'], tiles: [{ layer: 0, model: encodeRuns(modelAt) }], objects: [] }],
      regions: [{ id: 'r0', kind: 'autotile', set: 'set0', layer: 0, mask: encodeRuns(mask) }],
    });
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'region-tile-overlap')).toBe(true);
  });

  it('does not flag a region mask cell that the layer leaves empty (-1)', () => {
    const mask = new Array(16).fill(0);
    mask[5] = 1;
    const map = baseMap({
      layers: [{ tileset: 'bw2-adastra', role: 'draft', models: [], tiles: [{ layer: 0, model: encodeRuns(new Array(16).fill(-1)) }], objects: [] }],
      regions: [{ id: 'r0', kind: 'autotile', set: 'set0', layer: 0, mask: encodeRuns(mask) }],
    });
    const { errors } = validateMap(map);
    expect(errors.some((e) => e.code === 'region-tile-overlap')).toBe(false);
  });
});

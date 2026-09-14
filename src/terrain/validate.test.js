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
    format: 'pokeidle.map', version: 1, id: 'test-map', name: 'Test', kind: 'hunt',
    w, h, tileset: 'bw2-adastra', biome: 'meadow', seed: 1,
    grid: {
      collision: encodeRuns(collision), height: encodeRuns(height),
      tags: encodeRuns(tags), occupied: encodeRuns(occupied),
    },
    layers: [], regions: [], spawn: { cx: 1, cz: 1, dir: 0 }, markers: [],
    loop: null, wild: null, encounters: null, npcs: [], links: [], lights: [], cameras: null,
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
    const map = baseMap({ encounters: { table: 'meadow' } });
    const { skipped } = validateMap(map);
    expect(skipped).toContain('encounter-weights');
    expect(skipped).toContain('model-unresolved');
  });

  it('runs the encounter-weights check when a table is provided', () => {
    const map = baseMap({ encounters: { table: 'meadow' } });
    const { infos, errors } = validateMap(map, { tables: { meadow: [{ n: 'folhote', w: 40 }] } });
    expect(infos.some((i) => i.code === 'encounter-weights')).toBe(true);
    expect(errors.some((e) => e.code === 'encounter-weights')).toBe(false);
  });
});

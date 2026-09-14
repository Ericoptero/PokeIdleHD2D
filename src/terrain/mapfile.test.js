import { describe, it, expect } from 'vitest';
import { MapDraft } from './draft.js';
import { encodeRuns, decodeRuns, draftToMapFile, parseMapFile, serializeMapFile } from './mapfile.js';

describe('mapfile run-length codec', () => {
  it('round-trips primitive arrays', () => {
    const values = ['walk', 'walk', 'walk', 'block', 'block', 'walk'];
    const runs = encodeRuns(values);
    expect(decodeRuns(runs, values.length)).toEqual(values);
  });

  it('round-trips arrays of arrays (tags)', () => {
    const values = [[], ['path'], ['path'], [], ['tallgrass', 'encounter']];
    const runs = encodeRuns(values);
    expect(decodeRuns(runs, values.length)).toEqual(values);
  });

  it('collapses a uniform fill to one run', () => {
    const values = new Array(4000).fill('walk');
    const runs = encodeRuns(values);
    expect(runs.r.length).toBe(1);
    expect(runs.p.length).toBe(1);
  });

  it('throws on a length mismatch rather than truncating silently', () => {
    const runs = encodeRuns(['a', 'a', 'b']);
    expect(() => decodeRuns(runs, 2)).toThrow();
  });
});

/** A tiny stand-in catalog: three 1x1 models and one 2x2 tree, on one fake tileset. */
function fakeResolver() {
  const models = {
    3: { name: 'grass01ax_v1', w: 1, h: 1 },
    12: { name: 'michi01a', w: 1, h: 1 },
    96: { name: 'bridge_v2', w: 1, h: 1 },
    40: { name: 'tree_big', w: 2, h: 2 },
  };
  return (tileset, id) => models[id] ?? null;
}

function buildFixtureDraft() {
  const draft = new MapDraft({ id: 'fixture', w: 8, h: 6, tileset: 'bw2-adastra', biome: 'meadow', seed: 42 });
  draft.fill({ x: 0, z: 0, w: 8, h: 6 }, { id: 3 }, { layer: 0 });
  draft.place({ id: 12 }, 2, 2, { layer: 1, tags: ['path'] });
  draft.place({ id: 96 }, 3, 2, { layer: 1, rot: 1, tint: 0xaabbcc });
  draft.place({ id: 40 }, 5, 1, { layer: 3, collision: 'block' }); // 2x2 footprint -> objects[]
  draft.setHeight(0, 0, 0.5);
  draft.mark('spawn', 1, 1);
  draft.finalize();
  return draft;
}

describe('draftToMapFile', () => {
  it('produces a parseable map file and preserves placement count', () => {
    const draft = buildFixtureDraft();
    const map = draftToMapFile(draft, { name: 'Fixture', kind: 'hunt', resolveModel: fakeResolver() });
    expect(() => parseMapFile(map)).not.toThrow();
    expect(map.w).toBe(8);
    expect(map.h).toBe(6);
    expect(map.markers).toEqual([{ name: 'spawn', cx: 1, cz: 1 }]);

    const layer = map.layers[0];
    // grass fill (48 cells, grid-eligible) + michi01a (grid-eligible, layer 1) +
    // bridge_v2 (grid-eligible, layer 1) all become tile grids; the 2x2 tree is not
    // grid-eligible and lands in objects[].
    expect(layer.objects.length).toBe(1);
    expect(layer.objects[0].m).toBe(layer.models.indexOf('tree_big'));
  });

  it('serializes to text and parses back byte-identical (round trip through JSON text)', () => {
    const draft = buildFixtureDraft();
    const map = draftToMapFile(draft, { name: 'Fixture', resolveModel: fakeResolver() });
    const text1 = serializeMapFile(map);
    const parsed = parseMapFile(text1);
    const text2 = serializeMapFile(parsed);
    expect(text2).toBe(text1);
  });
});

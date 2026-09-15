/**
 * `cameraFacingRot`'s bit arithmetic (`instanced.js`), pinned in isolation from the
 * InstancedMesh building it feeds — the geometry/material plumbing around it needs a real
 * tileset and is exercised through the flows instead. This is the one place both guards
 * (the `twinDropped` gate and the square-footprint gate) and the new `viewYawQuarter` bit
 * are cheap to check exhaustively, and the one place a regression here would otherwise go
 * unnoticed until a Studio screenshot showed a bare trunk.
 *
 * `InstancedWorld.patch()` (Slice 8) does not get that treatment: `THREE.InstancedMesh`/
 * `BufferGeometry`/`Material` construction needs no renderer or canvas, only the objects
 * themselves, so `vitest.config.js`'s `environment: 'node'` is enough to build a real
 * `InstancedWorld` end to end (confirmed by hand before writing these tests). The fixture
 * below is a minimal stand-in for what `loadTileset` (`src/tiles/index.js`) produces: a
 * `byId` map of plain model objects, each with one real `THREE.BufferGeometry`/`Material`
 * group, deliberately kept off the ground-variety (`vary`) and global-UV (`step`) paths —
 * those need shader-patch material cloning this fixture has no reason to exercise, since
 * `patch()`'s own job (matching a fresh rebuild bucket for bucket) is orthogonal to which
 * variety paths a bucket happens to take.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { cameraFacingRot, InstancedWorld } from './instanced.js';

describe('cameraFacingRot', () => {
  it('at the shipped default (viewYawQuarter omitted), an even rot passes through unchanged', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 0)).toBe(0);
  });

  it('an odd rot still snaps to the nearest even one at yaw quarter 0 — unchanged pre-existing behaviour', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 1, 0)).toBe(0);
  });

  it('yaw quarter 1 ORs its low bit into an even rot', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 0, 1)).toBe(1);
  });

  it('yaw quarter 1 ORs into a 180°-mirrored rot too', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 2, h: 2 }, 2, 1)).toBe(3);
  });

  it('a non-square footprint refuses the snap regardless of viewYawQuarter', () => {
    expect(cameraFacingRot({ twinDropped: 'x', w: 3, h: 2 }, 1, 1)).toBe(1);
  });

  it('a model that never dropped its twin passes rot through untouched, ignoring viewYawQuarter', () => {
    expect(cameraFacingRot({ twinDropped: undefined }, 1, 1)).toBe(1);
  });
});

/**
 * One (model, group) bucket's worth of fixture: a real geometry/material pair so
 * `InstancedMesh` construction and `computeBoundingSphere()` have something to chew on, and a
 * model shape plain enough (`category: 'prop'`, no `flat` tag) that `varies()` is false for
 * every model here — the ground-variety spin/phase/tint pass is `_buildBucket`'s own concern,
 * already unit-proven by never having changed in this slice; what `patch()` needs proven is
 * that it reaches the identical bucket a fresh build would, not that every rendering path
 * inside one bucket build works.
 */
function makeModel(id, name, { category = 'prop', count = 6 } = {}) {
  return {
    id, name, w: 1, h: 1, category, tags: [], autotile: null, globalUv: false, bounds: null,
    groups: [{ geometry: new THREE.PlaneGeometry(1, 1), material: new THREE.MeshBasicMaterial(), count }],
  };
}

/** A tileset fixture shaped like `loadTileset`'s return (`src/tiles/index.js`). */
function makeTileset(models) {
  return {
    byId: new Map(models.map((m) => [m.id, m])),
    byName: new Map(models.map((m) => [m.name, m])),
    scatter: { flatVary: true, on: false, region: 2.9, angleDeg: 31.7, jitter: 0.12 },
    models,
    clones: new Set(),
  };
}

/** Every bucket key present in either world, so a missing bucket shows up as a diff, not a skip. */
function allBucketKeys(...worlds) {
  const keys = new Set();
  for (const w of worlds) for (const k of w.bucketsByKey.keys()) keys.add(k);
  return keys;
}

describe('InstancedWorld.patch()', () => {
  // Model A is never in `dirtyModelIds` in tests 1-3: its bucket is the control that proves a
  // patch leaves everything but the dirty model(s) alone — same `InstancedMesh`, not merely an
  // equal one.
  const A = 1, B = 2, C = 3;

  function placementsP0() {
    return [
      { modelId: A, cx: 0, cz: 0, rot: 0 }, { modelId: A, cx: 1, cz: 0, rot: 0 },
      { modelId: A, cx: 2, cz: 0, rot: 0 },
      { modelId: B, cx: 5, cz: 5, rot: 0 }, { modelId: B, cx: 6, cz: 5, rot: 0 },
    ];
  }

  function build(tileset, placements, opts) {
    return new InstancedWorld(THREE, new THREE.Group(), tileset, placements,
      // `contact: 0` sidesteps `addContactShadows` entirely (out of scope for `patch()` —
      // see its own doc comment) so every assertion below is about bucket meshes only.
      { contact: 0, ...opts });
  }

  it('a dirty model going from N items to 0 removes its bucket and leaves other buckets untouched', () => {
    const tileset = makeTileset([makeModel(A, 'A'), makeModel(B, 'B'), makeModel(C, 'C')]);
    const world = build(tileset, placementsP0());
    const aMeshBefore = world.bucketsByKey.get(`${A}:0`).mesh;
    expect(world.bucketsByKey.has(`${B}:0`)).toBe(true);

    const p1 = placementsP0().filter((p) => p.modelId !== B);
    world.patch(p1, [B]);

    expect(world.bucketsByKey.has(`${B}:0`)).toBe(false);
    expect(world.group.children.some((c) => c.name === 'B#0')).toBe(false);
    expect(world.meshes.some((e) => e.model?.id === B)).toBe(false);
    // Model A's bucket is the exact same mesh instance, not a rebuilt lookalike.
    expect(world.bucketsByKey.get(`${A}:0`).mesh).toBe(aMeshBefore);
    expect(world.placements).toBe(p1);

    const fresh = build(tileset, p1);
    expect(world.stats.meshes).toBe(fresh.stats.meshes);
    expect(world.stats.triangles).toBe(fresh.stats.triangles);
    for (const key of allBucketKeys(world, fresh)) {
      expect(Array.from(world.bucketsByKey.get(key).mesh.instanceMatrix.array))
        .toEqual(Array.from(fresh.bucketsByKey.get(key).mesh.instanceMatrix.array));
    }
  });

  it('a dirty model going from 0 items to N creates its bucket', () => {
    const tileset = makeTileset([makeModel(A, 'A'), makeModel(B, 'B'), makeModel(C, 'C')]);
    const world = build(tileset, placementsP0());
    expect(world.bucketsByKey.has(`${C}:0`)).toBe(false);

    const p2 = [...placementsP0(),
      { modelId: C, cx: 10, cz: 10, rot: 1 }, { modelId: C, cx: 11, cz: 10, rot: 0 }];
    world.patch(p2, [C]);

    expect(world.bucketsByKey.has(`${C}:0`)).toBe(true);
    expect(world.group.children.some((c) => c.name === 'C#0')).toBe(true);
    expect(world.bucketsByKey.get(`${C}:0`).items.length).toBe(2);

    const fresh = build(tileset, p2);
    expect(world.stats.meshes).toBe(fresh.stats.meshes);
    expect(world.stats.triangles).toBe(fresh.stats.triangles);
    for (const key of allBucketKeys(world, fresh)) {
      expect(Array.from(world.bucketsByKey.get(key).mesh.instanceMatrix.array))
        .toEqual(Array.from(fresh.bucketsByKey.get(key).mesh.instanceMatrix.array));
    }
  });

  it('a dirty model keeping its item count but changing position/rotation rebuilds the bucket with a new matrix', () => {
    const tileset = makeTileset([makeModel(A, 'A'), makeModel(B, 'B'), makeModel(C, 'C')]);
    const world = build(tileset, placementsP0());
    const bMeshBefore = world.bucketsByKey.get(`${B}:0`).mesh;
    const matrixBefore = Array.from(bMeshBefore.instanceMatrix.array);

    const p3 = placementsP0().map((p) => (p.modelId === B ? { ...p, cx: p.cx + 20, rot: 2 } : p));
    world.patch(p3, [B]);

    const bMeshAfter = world.bucketsByKey.get(`${B}:0`).mesh;
    expect(bMeshAfter).not.toBe(bMeshBefore);      // a resized-in-place mesh is not attempted
    expect(Array.from(bMeshAfter.instanceMatrix.array)).not.toEqual(matrixBefore);

    const fresh = build(tileset, p3);
    expect(world.stats.meshes).toBe(fresh.stats.meshes);
    expect(world.stats.triangles).toBe(fresh.stats.triangles);
    for (const key of allBucketKeys(world, fresh)) {
      expect(Array.from(world.bucketsByKey.get(key).mesh.instanceMatrix.array))
        .toEqual(Array.from(fresh.bucketsByKey.get(key).mesh.instanceMatrix.array));
    }
  });

  it('passing a model id with zero current placements is a valid no-op removal, not an error', () => {
    const tileset = makeTileset([makeModel(A, 'A'), makeModel(C, 'C')]);
    const world = build(tileset, placementsP0().filter((p) => p.modelId === A));
    expect(() => world.patch(world.placements, [C])).not.toThrow();
    expect(world.bucketsByKey.has(`${C}:0`)).toBe(false);
  });

  it('a model unresolved in the tileset is skipped like the constructor skips it, via the same stats counter', () => {
    const tileset = makeTileset([makeModel(A, 'A')]);
    const world = build(tileset, placementsP0().filter((p) => p.modelId === A));
    const skippedBefore = world.stats.skipped;
    expect(() => world.patch(world.placements, [999])).not.toThrow();
    expect(world.stats.skipped).toBe(skippedBefore + 1);
  });

  it('a bucket the constructor would have dropped as a baked shadow decal is never built by patch() either', () => {
    // Category in CONTACT_CATEGORIES, no 'flat'/'raised' tag, tall enough bounds: eligible for
    // a generated contact shadow, so its own baked `shadowDecal` group is the one
    // `dropBakedShadowDecals` drops once `contact > 0` — the same condition the constructor's
    // own bucketing loop already applies before a bucket is ever created.
    const model = makeModel(A, 'tree', { category: 'tree' });
    model.bounds = { min: [0, 0, 0], max: [0, 1, 0] };
    model.groups[0].material.userData.shadowDecal = true;
    const tileset = makeTileset([model]);

    const world = build(tileset, [], { contact: 1 });
    expect(world.bucketsByKey.has(`${A}:0`)).toBe(false);

    const withPlacements = [{ modelId: A, cx: 0, cz: 0, rot: 0 }];
    expect(() => world.patch(withPlacements, [A])).not.toThrow();
    expect(world.bucketsByKey.has(`${A}:0`)).toBe(false);
    expect(world.stats.skipped).toBe(0);   // the model resolved fine; it was dropped, not missing
  });
});

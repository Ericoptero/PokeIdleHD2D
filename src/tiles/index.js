/**
 * tiles — tileset loading, materials, geometry and auto-tiling (ARCHITECTURE §5.1).
 *
 * Loads the build product from `public/generated/tiles/<slug>/` (pack.json + pack.bin),
 * which the browser can turn into BufferGeometry with zero parsing: the .bin is already
 * interleaved position/normal/uv/color, exactly the layout three.js wants.
 */

import * as THREE from 'three';
import { makeAutotiler } from './autotile.js';
import { InstancedWorld } from './instanced.js';

const STRIDE = 11;            // px py pz nx ny nz u v r g b
const BYTES = STRIDE * 4;

async function loadTileset(slug, { log }) {
  const base = `/generated/tiles/${slug}`;
  const [pack, bin] = await Promise.all([
    fetch(`${base}/pack.json`).then((r) => {
      if (!r.ok) throw new Error(`tileset "${slug}": pack.json ${r.status}`);
      return r.json();
    }),
    fetch(`${base}/pack.bin`).then((r) => {
      if (!r.ok) throw new Error(`tileset "${slug}": pack.bin ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  const loader = new THREE.TextureLoader();
  const textures = pack.materials.map((m) => {
    if (!m.image) return null;
    const tex = loader.load(`${base}/tex/${m.image}`, undefined, undefined,
      () => log.warn(`tileset "${slug}": missing texture ${m.image}`));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;      // no mipmaps: DS textures are 8–64px, mips mush them
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 1;
    tex.name = m.image;
    return tex;
  });

  const materials = pack.materials.map((m, i) => {
    const map = textures[i];
    const mat = new THREE.MeshLambertMaterial({
      map,
      // DS alpha is 0..31; anything below 31 is a genuinely translucent surface (water, glass).
      transparent: m.translucent,
      opacity: m.translucent ? m.alpha / 31 : 1,
      depthWrite: !m.translucent,
      // Cutout foliage: opaque textures have alpha 1 everywhere, so this is free for them.
      alphaTest: m.translucent ? 0 : 0.35,
      side: m.bothFaces ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: true,
      fog: m.fog !== false,
      name: m.name ?? m.image ?? `mat${i}`,
    });
    mat.userData.spec = m;
    return mat;
  });

  // One BufferGeometry per (model, group). Uploaded once; every instance reuses it.
  const geometries = new Map();
  const byId = new Map();
  const models = [];

  for (const m of pack.models) {
    if (m.empty) continue;
    const groups = m.groups.map((g, gi) => {
      const key = `${m.id}:${gi}`;
      let geo = geometries.get(key);
      if (!geo) {
        const view = new Float32Array(bin, g.offset, g.count * STRIDE);
        const interleaved = new THREE.InterleavedBuffer(view, STRIDE);
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
        geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
        geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleaved, 2, 6));
        geo.setAttribute('color', new THREE.InterleavedBufferAttribute(interleaved, 3, 8));
        geo.computeBoundingSphere();
        geo.name = `${m.name}#${gi}`;
        geometries.set(key, geo);
      }
      return { geometry: geo, material: materials[g.material] ?? materials[0], materialId: g.material, count: g.count };
    });
    const model = { ...m, groups, tris: groups.reduce((a, g) => a + g.count / 3, 0) };
    models.push(model);
    byId.set(m.id, model);
  }

  const byName = new Map(models.map((m) => [m.name, m]));
  const autotile = makeAutotiler(pack.autotileSets, byId);

  return {
    slug, pack, models, byId, byName, materials, textures, autotile,
    /** Frees GPU memory when a tileset is no longer used by any live map. */
    dispose() {
      for (const g of geometries.values()) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t?.dispose();
    },
  };
}

export default {
  id: 'tiles',
  needs: [],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['terrain'],

  async init(ctx) {
    const { log } = ctx;
    const loaded = new Map();
    const pending = new Map();

    async function load(slug) {
      if (loaded.has(slug)) return loaded.get(slug);
      if (pending.has(slug)) return pending.get(slug);
      const p = loadTileset(slug, { log }).then((ts) => {
        loaded.set(slug, ts);
        pending.delete(slug);
        ctx.bus.emit('tiles:loaded', { slug, models: ts.models.length });
        return ts;
      });
      pending.set(slug, p);
      return p;
    }

    const api = {
      load,
      get: (slug) => loaded.get(slug) ?? null,
      loaded: () => [...loaded.keys()],

      models: (slug) => loaded.get(slug)?.models ?? [],

      /** `find('bw2-adastra', { category:'tree', tags:['tall'], biome:'forest' })` */
      find(slug, query = {}) {
        const ts = loaded.get(slug);
        if (!ts) return [];
        const { category, subcategory, tags = [], biome, orientation, name, maxBaseY } = query;
        return ts.models.filter((m) => {
          if (name && m.name !== name) return false;
          // Cliff-top surfaces are authored metres above their own cell; excluded unless the
          // caller explicitly asks for them, because placing one at ground level floats it.
          if (maxBaseY !== undefined && (m.baseY ?? 0) > maxBaseY) return false;
          if (maxBaseY === undefined && !tags.includes('raised') && m.tags.includes('raised')) return false;
          if (category && m.category !== category) return false;
          if (subcategory && m.subcategory !== subcategory) return false;
          if (orientation && m.orientation !== orientation) return false;
          if (biome && !m.biomes.includes(biome) && !m.biomes.includes('any')) return false;
          for (const t of tags) if (!m.tags.includes(t)) return false;
          return true;
        });
      },

      autotile: {
        sets: (slug) => loaded.get(slug)?.autotile.sets() ?? [],
        solve: (slug, setId, mask) => loaded.get(slug)?.autotile.solve(setId, mask) ?? -1,
        solveField: (slug, setId, occupancy, w, h) =>
          loaded.get(slug)?.autotile.solveField(setId, occupancy, w, h) ?? new Int32Array(w * h).fill(-1),
        /** Flips the north/south convention if PDSMS's palette turns out to be bottom-up. */
        setFlipped: (slug, flipped) => loaded.get(slug)?.autotile.setFlipped(flipped),
      },

      /** Builds the InstancedMeshes for a set of placements (ARCHITECTURE §7). */
      buildInstances(scene, slug, placements, opts) {
        const ts = loaded.get(slug);
        if (!ts) throw new Error(`tiles.buildInstances: tileset "${slug}" is not loaded`);
        return new InstancedWorld(ctx.THREE ?? THREE, scene, ts, placements, opts);
      },

      InstancedWorld,
    };

    // AdAstra is the house style and is always resident (ARCHITECTURE §9).
    await load('bw2-adastra');
    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseTiles } = await import('./showcase.js');
    return showcaseTiles(mode, ctx);
  },
};

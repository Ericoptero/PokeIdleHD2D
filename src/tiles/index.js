/**
 * tiles — tileset loading, materials, geometry and auto-tiling (ARCHITECTURE §5.1).
 *
 * Loads the build product from `public/generated/tiles/<slug>/` (pack.json + pack.bin),
 * which the browser can turn into BufferGeometry with zero parsing: the .bin is already
 * interleaved position/normal/uv/color, exactly the layout three.js wants.
 */

import * as THREE from 'three';
import { makeAutotiler, armsOf } from './autotile.js';
import { InstancedWorld, footprint } from './instanced.js';
import {
  ALPHA, alphaProfile, materialGeometryRoles, emissiveStrength, makeGlowTexture,
  liftNormalsAboveHorizon, rewindDownwardFaces, uprightUvToImageOrder, dropEdgeOnTwins,
  makeMaterial,
  liftNormalsInShader, makeFoliagePatch, foliageHueScales, applyShaderPatches,
  FOLIAGE_LIT_KNEE_DEG, FOLIAGE_LIT_NIGHT_LIFT,
} from './materials.js';

const STRIDE = 11;            // px py pz nx ny nz u v r g b

/** The colour a derived lamp glow is tinted with — sodium-ish, never a white LED. */
const LAMP_GLOW = 0xffb861;

/**
 * The default night ramp, in case nothing drives one.
 *
 * `environment` owns the ramp (§5.3) and `setEmissiveScale` is the seam it drives, but a
 * lamp that only lights when another module remembers to ask is a lamp that is dark in
 * every screenshot taken before that module lands. So `tiles` runs this curve off the time
 * of day by default and stands down the moment anyone calls `setEmissiveScale` explicitly.
 * Pinned to `environment`'s own phase boundaries (`phaseOf` in `src/environment/index.js`:
 * night starts 19.6, dawn ends 6.3) so the lamps come on as the sky turns, not before.
 */
function nightRamp(tod) {
  const t = ((tod % 24) + 24) % 24;
  const up = (a, b) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
  if (t >= 12) return up(18.4, 19.8);          // dusk: on across golden hour into night
  return 1 - up(4.8, 6.4);                     // dawn: off as the sun clears the horizon
}

/**
 * What `setEmissiveScale(1)` means in linear light.
 *
 * The seam has to hide this number, not publish it. `environment` knows its dusk curve and
 * nothing about how hot a DS lamp glass has to be to survive AgX and clear the bloom
 * threshold (`core/render.js`), so it passes a ramp in 0..1 and this module turns that into
 * radiance. Measured across `docs/progress/tiles/r1/06-lamps-night-on.png` (gain 1: the glass
 * is a flat pale strip) and `08-lamps-night.png` (gain 3.2: it blooms and reads as a lit lamp
 * from across the plaza).
 */
const EMISSIVE_HDR_GAIN = 3.2;

/** Categories a map author never wants back from a blind query. */
const HIDDEN_CATEGORIES = new Set(['meta']);

/**
 * Position-stable, order-independent variant hash. Two neighbouring cells get unrelated
 * values, the same cell always gets the same value, and nothing depends on how many times
 * anyone called before — which is what makes a scattered lawn reproducible from a seed.
 */
function hash2(x, z, salt) {
  let h = Math.imul((x | 0) + 0x9e3779b9, 374761393) ^ Math.imul((z | 0) + 0x85ebca6b, 668265263);
  h = Math.imul(h ^ (h >>> 13), (salt | 0) * 2 + 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

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

  // A view, not a copy: the geometries below alias the same memory, so a normal fixed here
  // is a normal fixed in every InstancedMesh that ever draws this model.
  const wholeBuffer = new Float32Array(bin);
  // Rewind first, lift second: the rewind negates the stored normal of a triangle it turns
  // over, and after the lift there is no negative Y left for it to find.
  const rewound = rewindDownwardFaces(pack, wholeBuffer, STRIDE);
  const lifted = liftNormalsAboveHorizon(wholeBuffer, STRIDE);
  // Third and independent of both: the pack's upright faces carry V top-down (DS/DirectX)
  // and three uploads bottom-up, so every tall card was sampling upside down. Horizontal
  // faces are left alone — see the function, and DECISIONS #24 for what a global flip costs.
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const uvFixed = params.get('uvright') === '0' ? 0 : uprightUvToImageOrder(pack, wholeBuffer, STRIDE);
  // Fourth: half of every crossed billboard pair is edge-on to a camera that never yaws, and
  // draws a pale pole through the crown plus a hard shadow wedge across its own twin.
  const twins = params.get('crossed') === '1' ? 0 : dropEdgeOnTwins(pack, wholeBuffer, STRIDE);
  const foliageMode = params.get('foliage');
  const harmonise = foliageMode !== '0';
  // `?foliage=knee` is the round-3 build exactly: every sheet scale pinned to 1 *and* the
  // light-side ceiling off, leaving only the per-texel knee #41c shipped. Pinning the scales
  // alone would have been a flag that says "round 3" and renders something else.
  const roundThree = foliageMode === 'knee';
  const sheetScales = harmonise && !roundThree;
  const foliageBand = params.has('foliageBand') ? Number(params.get('foliageBand')) : undefined;
  // `?foliageLit=<deg>` moves the ceiling on the lit colour; `?foliageLit=0` removes it.
  const foliageLit = roundThree ? 0
    : params.has('foliageLit') ? Number(params.get('foliageLit')) : undefined;

  const loader = new THREE.TextureLoader();
  /**
   * Awaited rather than fired and forgotten: the material a texture belongs to cannot be
   * configured until its alpha histogram has been read, and every one of these files is
   * 8x8 to 32x64 and already in the browser's cache from the same fetch batch.
   */
  const textures = await Promise.all(pack.materials.map(async (m) => {
    if (!m.image) return null;
    let tex;
    try {
      tex = await loader.loadAsync(`${base}/tex/${m.image}`);
    } catch {
      log.warn(`tileset "${slug}": missing texture ${m.image}`);
      return null;
    }
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;      // no mipmaps: DS textures are 8–64px, mips mush them
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 1;
    tex.name = m.image;
    return tex;
  }));

  const roles = materialGeometryRoles(pack, wholeBuffer, STRIDE);
  const profiles = textures.map((t) => alphaProfile(t?.image));
  // One wood, not two (DECISIONS #44a): no foliage sheet's median hue may sit more than a
  // few degrees above the set's own foliage median. Measured off the decoded texels, so a
  // pack authored bluer than AdAstra is closed against itself.
  // The light-side ceiling is one uniform object shared by every foliage material, so the
  // night ramp below moves all of them with a single assignment. Pinned and left alone when
  // the URL names a value, so `?foliageLit=` stays an honest control.
  const litPinned = foliageLit !== undefined;
  const litRef = { value: litPinned ? (foliageLit > 0 ? foliageLit : 0) : FOLIAGE_LIT_KNEE_DEG };
  const foliage = sheetScales
    ? foliageHueScales(profiles, roles, foliageBand === undefined ? {} : { band: foliageBand })
    : { scales: new Float64Array(pack.materials.length).fill(1), ceiling: NaN, median: NaN, moved: [] };

  /** @type {{material:THREE.Material, base:number}[]} materials that can be made to glow. */
  const emissives = [];
  const materials = pack.materials.map((m, i) => {
    const mat = makeMaterial(m, textures[i], profiles[i], roles[i], i);
    // Every lit tile material carries the elevation clamp; an unlit decal has no normal to
    // clamp, so it is left with no patch and no cache key of its own. A foliage sheet carries
    // the hue knee on top of it, which is what makes `darker_pine` the same wood as the tree
    // beside it (see `makeFoliagePatch`) — and only a foliage sheet, so the pond and
    // the sea keep their blue.
    const patches = [];
    if (mat.isMeshLambertMaterial) patches.push(liftNormalsInShader);
    if (harmonise && roles[i]?.tags.has('foliage')) patches.push(makeFoliagePatch(foliage.scales[i], litRef));
    applyShaderPatches(mat, patches);
    const glow = emissiveStrength(pack, roles, i);
    if (glow > 0 && textures[i]) {
      // An authored set (`structures`) paints a window on its own sheet and means all of it;
      // a set whose emissive we inferred shares one sheet between the post and the glass, so
      // only the bright texels are allowed to light.
      const derived = typeof m.emissive !== 'number';
      const map = derived
        ? makeGlowTexture(profiles[i], { name: `${m.image}:glow` })
        : textures[i];
      if (map) {
        mat.emissiveMap = map;
        // MeshLambertMaterial's `emissive` defaults to black and *multiplies* the map, so
        // leaving it costs nothing but silently makes every glow zero.
        mat.emissive = new THREE.Color(derived ? LAMP_GLOW : 0xffffff);
        mat.emissiveIntensity = 0;             // dark until environment ramps it (§5.3)
        mat.userData.emissiveBase = glow;
        mat.userData.ownGlowMap = derived ? map : null;
        emissives.push({ material: mat, base: glow });
      }
    }
    return mat;
  });

  const softCount = profiles.filter((p) => p.cls === ALPHA.SOFT).length;
  const decalCount = materials.filter((m) => m.userData.decal).length;

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
    const model = {
      ...m, groups,
      tris: groups.reduce((a, g) => a + g.count / 3, 0),
      // Which sides a thin billboard piece connects to; the fence solver reads this instead
      // of trusting the palette slot the classifier named it after (DECISIONS #6).
      arms: armsOf(wholeBuffer, m, STRIDE),
      orientation: m.orientation ?? overhangOf(m),
    };
    models.push(model);
    byId.set(m.id, model);
  }

  const byName = new Map(models.map((m) => [m.name, m]));
  const autotile = makeAutotiler(pack.autotileSets, byId, models);

  // The centre slot of a palette is the only auto-tiled tile that carries no direction: it
  // is a full square of one surface, so it may be varied per cell like a plain ground tile
  // while its twelve edge and corner siblings may not. Tagged here rather than guessed at
  // downstream, because only the autotiler knows which model a palette put at signature 255.
  for (const set of autotile.sets()) {
    const centre = autotile.describe(set.id)?.cases?.find((c) => c.name === 'center');
    const m = centre && centre.modelId >= 0 ? byId.get(centre.modelId) : null;
    if (m && !m.tags.includes('autotile-center')) m.tags = [...m.tags, 'autotile-center'];
  }

  log.info(`tileset "${slug}": ${models.length} models, ${materials.length} materials `
    + `(${softCount} soft, ${decalCount} decal, ${emissives.length} emissive), `
    + `${lifted} normals lifted, ${rewound} faces rewound, ${uvFixed} upright uvs righted, ${twins} edge-on twins dropped`
    + (foliage.moved.length
      ? `, foliage median ${foliage.median.toFixed(1)} deg -> ceiling ${foliage.ceiling.toFixed(1)}, `
        + `${foliage.moved.length} sheets scaled (`
        + foliage.moved.map((m) => `${pack.materials[m.index].image} ${m.median.toFixed(0)}x${m.scale.toFixed(3)}`).join(', ') + ')'
      : ''));

  /** Materials cloned downstream (the global-UV patch) that must follow the glow ramp. */
  const clones = new Set();
  let emissiveScale = 0;

  return {
    slug, pack, models, byId, byName, materials, textures, autotile, emissives, clones,

    /**
     * The night ramp seam (ARCHITECTURE §5.3: environment "owns city window/lamp emissives
     * at night"). `k` is 0 at full daylight and 1 at the darkest part of the night; the
     * material's own authored strength scales it, so a `Ke 0.35` door never gets as hot as
     * a `Ke 1.0` lamp glass at the same `k`.
     */
    setEmissiveScale(k) {
      emissiveScale = Math.max(0, k);
      const gain = emissiveScale * EMISSIVE_HDR_GAIN;
      for (const e of emissives) e.material.emissiveIntensity = gain * e.base;
      for (const c of clones) {
        if (c.userData.emissiveBase) c.emissiveIntensity = gain * c.userData.emissiveBase;
      }
      // The foliage light-side ceiling rides the same ramp, because it corrects a *daylight*
      // mechanism (a warm key against a blue fill splitting hue by value) and there is no warm
      // key at 21:00. One shared uniform object, so this is the whole update. See
      // `FOLIAGE_LIT_NIGHT_LIFT` for the four-way measurement that chose the lift.
      if (!litPinned) {
        litRef.value = FOLIAGE_LIT_KNEE_DEG + Math.min(1, emissiveScale) * FOLIAGE_LIT_NIGHT_LIFT;
      }
      return emissives.length;
    },
    emissiveScale: () => emissiveScale,

    /** Frees GPU memory when a tileset is no longer used by any live map. */
    dispose() {
      for (const g of geometries.values()) g.dispose();
      for (const m of materials) { m.userData.ownGlowMap?.dispose(); m.dispose(); }
      for (const t of textures) t?.dispose();
      for (const c of clones) c.dispose();
      clones.clear();
    },
  };
}

/**
 * Which way a model reaches out of its own cell.
 *
 * The four street lamps are one 30-triangle model in four flavours and the pack gives all
 * of them `orientation: null`, so a map author has no way to ask for "the one whose arm
 * points west" — `src/city/map.js` places `lamp_h` everywhere, and `lamp_h`'s arm runs a
 * cell and a half *south*, straight down the camera axis, where it covers its own post and
 * reads as a featureless obelisk. That is the whole of the boot shot's lamp bug: the
 * geometry was never broken, the query to avoid it did not exist.
 *
 * Derived from the model's own bounds against its footprint, so it costs nothing and is
 * right for anything that overhangs — an awning, a signpost, a bridge rail. Compass letters
 * match the vocabulary the pack already uses for its `s`/`n`/`e`/`w` pieces.
 */
function overhangOf(m) {
  const b = m.bounds;
  if (!b) return null;
  const out = {
    w: -b.min[0], e: b.max[0] - (m.w ?? 1),
    n: -b.min[2], s: b.max[2] - (m.h ?? 1),
  };
  let best = null, bestV = 0.25;             // a quarter cell: below that it is a moulding
  for (const k of ['n', 's', 'e', 'w']) if (out[k] > bestV) { best = k; bestV = out[k]; }
  return best;
}

export default {
  id: 'tiles',
  needs: [],

  async init(ctx) {
    const { log } = ctx;
    const loaded = new Map();
    const pending = new Map();
    const namedWarned = new Set();
    /** Set by the showcase; a null-safe no-op the rest of the time. */
    let overlay = null;
    const urlQuery = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
    const varietyDefault = urlQuery.has('variety') ? Number(urlQuery.get('variety')) || 0 : 1;
    const contactDefault = urlQuery.has('contact') ? Number(urlQuery.get('contact')) || 0 : 1;
    /** `?kage=1` restores the tileset's own hand-painted shadow quads for the A/B. */
    const keepBakedDefault = urlQuery.get('kage') === '1';
    /** Set the first time anyone calls setEmissiveScale; the auto ramp then stops. */
    let emissiveDriven = false;
    let lastAutoTod = null;

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

      /**
       * `find('bw2-adastra', { category:'tree', tags:['tall'], biome:'forest' })`
       *
       * Two guards the map authors depend on:
       *  - tiles authored on top of a cliff (`baseY >= 0.5`, DECISIONS #7) never come back
       *    unless asked for by the `raised` tag or an explicit `maxBaseY`, because placed at
       *    ground level they float and leave a hole with sky through it;
       *  - `meta` tiles (the PDSMS separator) are never returned at all.
       *
       * Selecting by `name` still works but is logged once per name: the classifier names a
       * model after its dominant texture (DECISIONS #6), so a name is an implementation
       * detail of the build, and category + tags are the stable handle.
       */
      find(slug, query = {}) {
        const ts = loaded.get(slug);
        if (!ts) return [];
        const {
          category, subcategory, tags = [], biome, orientation, name, maxBaseY,
          maxCells, walkable, includeHidden = false,
        } = query;
        if (name && !namedWarned.has(name)) {
          namedWarned.add(name);
          log.warn(`tiles.find: selecting "${name}" by name — names follow the texture (DECISIONS #6); prefer category + tags`);
        }
        return ts.models.filter((m) => {
          if (name && m.name !== name) return false;
          if (!includeHidden && HIDDEN_CATEGORIES.has(m.category)) return false;
          // Cliff-top surfaces are authored metres above their own cell; excluded unless the
          // caller explicitly asks for them, because placing one at ground level floats it.
          if (maxBaseY !== undefined && (m.baseY ?? 0) > maxBaseY) return false;
          if (maxBaseY === undefined && !tags.includes('raised') && m.tags.includes('raised')) return false;
          if (category && m.category !== category) return false;
          if (subcategory && m.subcategory !== subcategory) return false;
          if (orientation && m.orientation !== orientation) return false;
          if (maxCells !== undefined && (m.w ?? 1) * (m.h ?? 1) > maxCells) return false;
          if (walkable === true && !['walk', 'stairs', 'shallow', 'door'].includes(m.collision)) return false;
          if (biome && !m.biomes.includes(biome) && !m.biomes.includes('any')) return false;
          for (const t of tags) if (!m.tags.includes(t)) return false;
          return true;
        });
      },

      /**
       * Night lighting. `k = 0` is full daylight (no material glows), `k = 1` is the middle
       * of the night. Each material scales `k` by its own authored strength — the MTL's
       * `Ke`, which `tools/assets/obj.js` reads and the pack carries — so one call ramps a
       * Poké Center window (`Ke 0.5`), its door (`0.35`) and a street lamp's glass (derived
       * `1.0`) by the right amounts relative to each other.
       *
       * `environment` owns the ramp itself (§5.3) and drives this from its own dusk curve;
       * `city` and `hunts` never need to call it. Passing a `slug` limits the change to one
       * tileset, which is what a lit interior wants when the street outside is still bright.
       *
       * @param {number} k        0..1, clamped at 0, not clamped above
       * @param {string} [slug]   one tileset, or every loaded tileset
       * @returns {number} how many materials the call actually moved
       */
      setEmissiveScale(k, slug) {
        emissiveDriven = true;
        return applyEmissive(k, slug);
      },

      /** What the last `setEmissiveScale` set, per tileset — for the debug overlay. */
      emissiveScale: (slug) => (slug ? loaded.get(slug)?.emissiveScale?.() ?? 0
        : (loaded.values().next().value?.emissiveScale?.() ?? 0)),

      /** Which materials can glow at all, so a scene can tell "unlit" from "no lamps here". */
      emissiveMaterials: (slug) => (loaded.get(slug)?.emissives ?? []).map((e) => ({
        name: e.material.name, base: e.base,
      })),

      /** The explicit escape hatch for the one case where a name really is the handle. */
      byName: (slug, name) => loaded.get(slug)?.byName.get(name) ?? null,
      byId: (slug, id) => loaded.get(slug)?.byId.get(id) ?? null,

      /**
       * Deterministic variant picking. Same (cx, cz, salt) always gives the same model, no
       * matter what order cells are visited in, so a lawn rebuilt from the same seed is the
       * same lawn. `baseWeight` keeps the first variant dominant so a field reads as one
       * material with variation rather than as confetti.
       */
      pick(models, cx, cz, { salt = 0, baseWeight = 3 } = {}) {
        if (!models || !models.length) return null;
        if (models.length === 1) return models[0];
        const weights = models.map((_, i) => (i === 0 ? baseWeight : 1));
        const total = weights.reduce((a, b) => a + b, 0);
        let r = hash2(cx, cz, salt) * total;
        for (let i = 0; i < models.length; i++) {
          r -= weights[i];
          if (r < 0) return models[i];
        }
        return models[models.length - 1];
      },

      /** One model from a list, off a seeded stream, when position is not the right key. */
      pickOne(models, rng) {
        if (!models || !models.length) return null;
        return models[Math.floor((rng?.next?.() ?? 0) * models.length) % models.length];
      },

      /**
       * Every model that is the same piece as `model` in a different flavour — the `_v2`
       * family the AdAstra set ships for grass, rocks, trees and cliff tops. Feed this to
       * `pick()` to get variety without repeating one stamp across a whole field.
       */
      variantsOf(slug, model) {
        const ts = loaded.get(slug);
        if (!ts || !model) return model ? [model] : [];
        const stem = String(model.name).replace(/_v\d+$/, '');
        return ts.models.filter((m) => String(m.name).replace(/_v\d+$/, '') === stem
          && m.category === model.category && m.w === model.w && m.h === model.h);
      },

      /** The cells a placement claims once rotated — (w,h) swap on the odd quarter turns. */
      footprint,

      autotile: {
        sets: (slug) => loaded.get(slug)?.autotile.sets() ?? [],
        describe: (slug, setId) => loaded.get(slug)?.autotile.describe(setId) ?? null,
        caseName: (slug, sig) => loaded.get(slug)?.autotile.caseName(sig) ?? null,
        covers: (slug, setId, mask) => loaded.get(slug)?.autotile.covers(setId, mask) ?? false,
        maskAt: (slug, occ, w, h, x, z, outside) =>
          loaded.get(slug)?.autotile.maskAt(occ, w, h, x, z, outside) ?? 0,
        solve: (slug, setId, mask) => loaded.get(slug)?.autotile.solve(setId, mask) ?? -1,
        resolve: (slug, setId, mask, opts) => loaded.get(slug)?.autotile.resolve(setId, mask, opts) ?? null,
        solveField: (slug, setId, occupancy, w, h, opts) =>
          loaded.get(slug)?.autotile.solveField(setId, occupancy, w, h, opts) ?? new Int32Array(w * h).fill(-1),
        /**
         * Preferred over `solveField`: carries the Y a case needs, so the interior of a
         * mountain plateau lands on top of its own banks instead of at their feet.
         */
        solvePlacements: (slug, setId, occupancy, w, h, opts) =>
          loaded.get(slug)?.autotile.solvePlacements(setId, occupancy, w, h, opts) ?? [],
        /** Flips the north/south convention if PDSMS's palette turns out to be bottom-up. */
        setFlipped: (slug, flipped) => loaded.get(slug)?.autotile.setFlipped(flipped),
      },

      /**
       * Builds the InstancedMeshes for a set of placements (ARCHITECTURE §7).
       * `?variety=0` turns the per-cell ground variation off for an A/B screenshot; every
       * caller gets it on, because a map author should not have to ask for a lawn that is
       * not wallpaper.
       */
      buildInstances(scene, slug, placements, opts) {
        const ts = loaded.get(slug);
        if (!ts) throw new Error(`tiles.buildInstances: tileset "${slug}" is not loaded`);
        return new InstancedWorld(ctx.THREE ?? THREE, scene, ts, placements,
          { variety: varietyDefault, contact: contactDefault, keepBaked: keepBakedDefault, ...opts });
      },

      InstancedWorld,

      /** @internal the showcase parks its DOM label overlay here so `frame` can drive it. */
      _setOverlay(o) { overlay = o; },
    };

    function applyEmissive(k, slug) {
      const sets = slug ? [loaded.get(slug)] : [...loaded.values()];
      let n = 0;
      for (const ts of sets) n += ts?.setEmissiveScale?.(k) ?? 0;
      return n;
    }

    /**
     * Follows the clock until something better takes over. `environment` is reached through
     * `ctx.get`, so a quarantined one hands back the null-object proxy — whose every method
     * answers `undefined`, which is why liveness is tested on the *value* coming back and
     * not on `typeof api.getTimeOfDay === 'function'` (that is true even when dead).
     */
    function followClock() {
      if (emissiveDriven) return;
      const tod = ctx.get('environment')?.getTimeOfDay?.();
      if (!Number.isFinite(tod)) return;
      if (lastAutoTod !== null && Math.abs(tod - lastAutoTod) < 0.02) return;
      lastAutoTod = tod;
      applyEmissive(nightRamp(tod));
    }

    // AdAstra is the house style and is always resident (ARCHITECTURE §9).
    await load('bw2-adastra');
    // A showcase or a critic can dial the night ramp straight off the URL without waiting
    // for `environment` to exist: `?emissive=0.9`.
    if (urlQuery.has('emissive')) api.setEmissiveScale(Number(urlQuery.get('emissive')) || 0);
    api._frame = () => {
      followClock();
      try { overlay?.update(); } catch { /* a label must never kill the module */ }
    };
    return api;
  },

  /**
   * The showcase's DOM labels are projected from world space every frame — `main.js` resizes
   * the view after `showcase()` returns, so a one-shot projection would be stale.
   */
  frame(dt, alpha, ctx) {
    ctx.get('tiles')?._frame?.();
  },

  async showcase(mode, ctx) {
    const { showcaseTiles } = await import('./showcase.js');
    return showcaseTiles(mode, ctx);
  },
};

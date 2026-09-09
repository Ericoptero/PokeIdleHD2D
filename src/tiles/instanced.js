/**
 * The instanced world (ARCHITECTURE §7).
 *
 * Placements are grouped by (model, material group) and each group becomes one
 * InstancedMesh. A 96x96 map lands at roughly 110–200 draw calls with every tile resident,
 * which is why we do not chunk: chunking would multiply draw calls by the chunk count for
 * a culling win we do not need at this world size.
 */

import * as THREE from 'three';
import { applyShaderPatches, contactShadowPatch, makeGroundScatterPatch } from './materials.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const _axisY = new THREE.Vector3(0, 1, 0);

/**
 * Reproduces PDSMS's global texture mapping on an InstancedMesh: the geometry carries the
 * UVs for one cell and each instance shifts them by its own cell position, so a field of
 * grass shows a 1/scale-cell repeat instead of the same stamp in every square.
 *
 * The material is cloned before patching — several models share one material object, and
 * only the global-mapped ones may grow this attribute.
 */
function uvOffsetPatch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aUvOffset;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv += aUvOffset;');
}
uvOffsetPatch.key = 'uvOffset';

function attachUvOffset(mesh, offsets, tileset, label, scatter) {
  mesh.geometry = mesh.geometry.clone();
  mesh.geometry.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(offsets, 2));

  const mat = mesh.material.clone();
  mat.name = `${mesh.material.name}+${label}`;
  // `clone()` copies neither `onBeforeCompile` nor `customProgramCacheKey`, so the clone
  // would silently lose the normal-elevation clamp its original carries — a lawn that shades
  // differently from the path beside it. Both patches are re-applied together, and the key is
  // their names joined: every material carrying the same set compiles one program, which is
  // what keeps the count at 13 (ARCHITECTURE §7 budgets 60).
  applyShaderPatches(mat, [...(mesh.material.userData.shaderPatches ?? []), uvOffsetPatch,
    ...(scatter ? [makeGroundScatterPatch(scatter)] : [])]);
  mesh.material = mat;
  mesh.userData.globalUv = true;
  // The clone has to keep following the night ramp, or a lit ground material would go dark
  // the moment it grew this attribute.
  tileset?.clones?.add(mat);
}

/**
 * Reproduces PDSMS's global texture mapping and, on top of it, breaks the repeat.
 *
 * `GLOBALMAPPING` alone gives a field of grass a `1/uvScale`-cell period — the AdAstra lawn
 * is scale 0.25, so it is one 4x4-cell stamp tiled forever, and that quilt is plainly
 * visible in `docs/progress/_boot/wave-a-end.png`. `phase` adds a per-cell offset of whole
 * texels (so the art stays on the pixel grid) drawn from the same position hash the variant
 * picker uses, which turns the quilt into per-cell noise at no cost: it is two more floats
 * per instance on a mesh that was already instanced.
 */
function uvOffsets(items, step, phase) {
  const su = step?.u ?? 0, sv = step?.v ?? 0;
  const offsets = new Float32Array(items.length * 2);
  for (let i = 0; i < items.length; i++) {
    const { cx, cz } = items[i];
    offsets[i * 2] = cx * su + (phase ? phase(cx, cz, 0) : 0);
    offsets[i * 2 + 1] = cz * sv + (phase ? phase(cx, cz, 1) : 0);
  }
  return offsets;
}

/**
 * The cells a placement claims. A quarter turn swaps the footprint's extents, so a 3x1
 * stairs at rot 1 or 3 occupies 1 cell east-west and 3 north-south. Geometry may reach
 * outside this box on purpose (bridge railings, a tree canopy, a stair's kerb) — the box
 * is what the map *reserves*, not the model's bounds.
 * @param {{w?:number,h?:number}} model
 * @param {0|1|2|3} rot
 * @returns {{w:number, h:number}}
 */
export function footprint(model, rot = 0) {
  const w = model?.w ?? 1, h = model?.h ?? 1;
  return (rot & 1) ? { w: h, h: w } : { w, h };
}

/**
 * The yaw a placement is actually *drawn* at, once half its geometry has been thrown away.
 *
 * `dropEdgeOnTwins` (DECISIONS #41b) collapses the X-facing half of a crossed foliage
 * billboard because the camera's yaw is fixed forever and that card can only ever rasterise
 * as a 1–2 px smear. The half it keeps is the Z-facing one — which is camera-facing at
 * `rot 0` and `rot 2`, and **edge-on at `rot 1` and `rot 3`**. So a tree the map turned a
 * quarter took the drop on the card the camera was about to see and rendered as a bare
 * trunk with a few leaves clinging to it (`docs/progress/tiles/r4/00-rotate-before.png`,
 * the `tree 2x2` row: rot 0 and rot 2 are full crowns, rot 1 and rot 3 are slivers).
 *
 * The fix is to test the placement's own yaw instead of assuming one. A quarter turn of a
 * *crossed billboard* carries no information — both cards hold the same picture, which is
 * the 80 %-coverage clause `dropEdgeOnTwins` already checks — so snapping the odd turns to
 * the even one loses nothing that was ever visible, while the 180° component is kept
 * because it mirrors the crown and that is real variety.
 *
 * Two guards. The snap is refused on a non-square footprint, because `rot & 1` swaps a
 * model's extents and un-swapping them would move the tile off the cells the map reserved.
 * And the effective yaw is computed here and passed to `composeMatrix` — `p.rot` itself is
 * never written back, because `terrain/draft.js` and `simulation/surface.js` read it for
 * the collision footprint and must keep seeing what the author asked for.
 *
 * @param {{twinDropped?:string, w?:number, h?:number}} model
 * @param {number} rot
 */
export function cameraFacingRot(model, rot) {
  if (model?.twinDropped !== 'x') return rot;
  if ((model.w ?? 1) !== (model.h ?? 1)) return rot;
  return rot & 2;
}

/**
 * @typedef {Object} Placement
 * @property {number} modelId  tile model id within the tileset
 * @property {number} cx       cell x (west→east)
 * @property {number} cz       cell z (north→south)
 * @property {number} [y]      world Y of the tile's own origin; defaults to 0
 * @property {0|1|2|3} [rot]   quarter turns about +Y, applied about the footprint centre
 * @property {number} [tint]   0xRRGGBB multiplied into the instance; defaults to white
 */

/**
 * Position-stable hash, the same one `tiles.pick()` uses. Two neighbouring cells get
 * unrelated values and a cell always gets its own, so a lawn is identical on every replay
 * of a seed however the map was walked.
 */
function hash2(x, z, salt) {
  let h = Math.imul((x | 0) + 0x9e3779b9, 374761393) ^ Math.imul((z | 0) + 0x85ebca6b, 668265263);
  h = Math.imul(h ^ (h >>> 13), (salt | 0) * 2 + 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Whether a model may be varied per cell without changing what it *means*.
 *
 * A quarter turn or a texture phase shift is only free on a tile that is a plain square of
 * one surface. An auto-tiled piece encodes which side its neighbour is on, a multi-cell
 * piece has a shape, and anything with height has a silhouette a rotation would spin —
 * all three are excluded. What is left is the lawn, the paving field and the dirt patches,
 * which is exactly the ground the boot shot repeats.
 *
 * `raised` used to be excluded here as well and should never have been. It is set by
 * `tools/assets/classify.js` from `bounds.min[1] >= 0.5` — *elevation*, a tile authored on top
 * of a cliff — while the silhouette test this predicate actually wants is `flat`
 * (`bounds.max[1] - bounds.min[1] < 0.02`), which is already on the line above. A plateau top
 * is a flat square of one surface at height, so it varies like any other floor; excluding it
 * left `cliff_top_center` as the one ground surface in the game that is still pure wallpaper,
 * and left `grass_v2` — the lawn's own `_v2` twin — treated differently from the lawn beside
 * it, which is a hard seam wherever both are placed.
 */
/**
 * Smooth value noise on the cell lattice.
 *
 * A per-cell random tint reads as a checkerboard, because every cell differs from its
 * neighbour by the full amplitude and the eye finds the grid immediately. What the
 * reference has instead (`docs/refs/01-forest-tilemap-frame.png`) is large soft blotches of
 * light and dark across a dozen cells. Interpolating a coarse lattice gives exactly that:
 * neighbouring cells differ by a fraction of a percent, a patch a dozen cells wide differs
 * by several, and no cell edge is ever a step.
 */
function lattice(x, z, salt, period) {
  const fx = x / period, fz = z / period;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  let tx = fx - x0, tz = fz - z0;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash2(x0, z0, salt), b = hash2(x0 + 1, z0, salt);
  const c = hash2(x0, z0 + 1, salt), d = hash2(x0 + 1, z0 + 1, salt);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

/**
 * Two octaves of it, centred on zero.
 *
 * The periods are the whole argument. A tint is constant across a cell however smooth the
 * field it was sampled from, so the *only* thing that decides whether a lawn reads as ground
 * or as a checkerboard is how much the field can move between one cell and the next: at most
 * `amplitude x 1.5 / period` per octave. The first cut ran 9 and 4 cells at +-7.5 %,
 * which puts a 3.4 % step across every cell edge — plainly a chequerboard at close range in
 * `docs/progress/tiles/critic/hedge-close-12.png`. At 24 and 11 cells, weighted 1.6 / 0.4, the
 * same +-6.5 % of tone moves **1.0 %** per cell, which is a quarter of a level at 8 bits and
 * below what the eye can find a grid in — while a patch two dozen cells wide still swings the
 * whole amount. Large soft blotches, no cell edges, which is what
 * `docs/refs/01-forest-tilemap-frame.png` has. The amplitude was never the bug; the period was.
 */
function blotch(x, z, salt) {
  return (lattice(x, z, salt, 24) - 0.5) * 1.6 + (lattice(x, z, salt + 101, 11) - 0.5) * 0.4;
}

/**
 * Which kinds of model get a contact shadow, and which are already carrying one.
 *
 * At noon the sun is nearly overhead, so the shadow it casts lands *under* the thing casting
 * it and the object stands on top of its own shadow: `hedge-close-12.png` has a perfectly
 * working shadow map and a hedge that still meets the lawn with no darkening whatever, which
 * is what makes it read as pasted on rather than planted. `docs/refs/01-forest-tilemap-frame.png`
 * carries large soft ground shading around the base of everything in it and most of its depth
 * comes from that, not from the cast shadow.
 *
 * The AdAstra artists agreed: twelve of the set's models ship a hand-painted `kage_out` or
 * `h_kage` blob under them. Those keep theirs — a second one on top would double the density —
 * and everything else that stands up off the ground gets a generated one.
 *
 * **That sentence was not true of the code until round 4.** `wantsContactShadow` never
 * excluded a model that ships a baked blob, so for all twelve of them both were drawn, and
 * the baked one is the harder picture of the two. `kage_out.png` decoded is an 8x8 sheet
 * holding exactly two levels — a 6x6 interior of `rgb(29,33,34)` at alpha 0.48 inside a
 * one-texel border of `rgb(56,60,60)` at 0.25 — and `h_kage.png` is two levels split across
 * a row with no border on any side at all. Neither has a gradient in it: at the game camera
 * they are dark rectangles with a single hard step, which is a critic's "floating black
 * rectangles" almost exactly. `dropBakedShadowDecals` below is that comment finally being
 * implemented; `?kage=1` puts the baked blobs back for the A/B.
 */
const CONTACT_CATEGORIES = new Set(['tree', 'plant', 'prop', 'light', 'fence', 'building', 'roof']);
const CONTACT_MIN_HEIGHT = 0.45;
/** Above every flat ground top in the set (`michi_hage` is the highest at 0.15). */
const CONTACT_Y = 0.17;
/** How far past the footprint the penumbra reaches, in cells, on each side. */
const CONTACT_MARGIN = 0.75;
/** The colour AdAstra painted its own `kage_out` blob, so a generated one matches a baked one. */
const CONTACT_COLOR = 0x1d2122;
const CONTACT_OPACITY = 0.42;

/**
 * A model that already ships one is *not* excluded, and that was settled on screen.
 * `hedge4` carries a `kage_out` quad over its own 4x1 footprint at y 0.13 — and the hedge
 * body is a full cell tall, so at a 45-degree pitch it covers every pixel of its own baked
 * shadow and the hedge still meets the lawn with a hard edge
 * (`docs/progress/tiles/critic/hedge-close-12.png`). The baked blobs are painted to sit
 * *under* a piece; what grounds it is the half cell of penumbra that reaches past it.
 */
function wantsContactShadow(model) {
  if (!CONTACT_CATEGORIES.has(model.category)) return false;
  if (model.tags.includes('flat') || model.tags.includes('raised')) return false;
  const b = model.bounds;
  return !!b && (b.max[1] - b.min[1]) >= CONTACT_MIN_HEIGHT;
}

/**
 * Whether this (model, group) is a baked shadow the generated pass is about to replace.
 *
 * Only where the replacement actually happens: a world built with `contact: 0` (an interior
 * with no ground under it) keeps every baked blob it ships, because taking the picture away
 * and drawing nothing in its place is strictly worse than a hard rectangle.
 */
function dropBakedShadowDecals(model, group, contact, keepBaked) {
  return !keepBaked && contact > 0
    && !!group.material?.userData?.shadowDecal
    && wantsContactShadow(model);
}

function varies(model, flatVary = true) {
  return (model.autotile == null || model.tags.includes('autotile-center'))
    && (model.w ?? 1) === 1 && (model.h ?? 1) === 1
    && (model.category === 'ground' || model.category === 'path')
    && model.tags.includes('flat')
    && (flatVary || !model.tags.includes('raised'));
}

export class InstancedWorld {
  /**
   * @param {typeof THREE} T
   * @param {THREE.Object3D} parent
   * @param {object} tileset  the loaded tileset from tiles/index.js
   * @param {Placement[]} placements
   * @param {{name?:string, castShadow?:boolean, receiveShadow?:boolean, variety?:number,
   *          contact?:number, keepBaked?:boolean}} [opts]
   *   `variety` is 0..1 and scales the per-cell ground variation (quarter turns, texture
   *   phase and a tonal jitter). 0 reproduces the old, visibly tiled lawn.
   *   `contact` is 0..1 and scales the generated contact shadows; 0 turns them off, which is
   *   what an indoor scene with no ground under it wants.
   *   `keepBaked` draws the tileset's own hand-painted `kage` shadow quads as well as the
   *   generated ones — the round-3 behaviour, kept only for the A/B (`?kage=1`).
   */
  constructor(T, parent, tileset, placements,
    { name = 'world', castShadow = true, receiveShadow = true, variety = 1, contact = 1,
      keepBaked = false } = {}) {
    this.tileset = tileset;
    this.group = new THREE.Group();
    this.group.name = name;
    this.meshes = [];
    this.placements = placements;
    this.stats = { placements: placements.length, meshes: 0, triangles: 0, skipped: 0 };

    /** @type {Map<string, {model:object, groupIndex:number, items:Placement[]}>} */
    const buckets = new Map();
    for (const p of placements) {
      const model = tileset.byId.get(p.modelId);
      if (!model) { this.stats.skipped++; continue; }
      for (let gi = 0; gi < model.groups.length; gi++) {
        if (dropBakedShadowDecals(model, model.groups[gi], contact, keepBaked)) {
          this.stats.bakedShadowsDropped = (this.stats.bakedShadowsDropped ?? 0) + 1;
          continue;
        }
        const key = `${p.modelId}:${gi}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { model, groupIndex: gi, items: [] }));
        b.items.push(p);
      }
    }

    for (const { model, groupIndex, items } of buckets.values()) {
      const g = model.groups[groupIndex];
      const mesh = new THREE.InstancedMesh(g.geometry, g.material, items.length);
      mesh.name = `${model.name}#${groupIndex}`;
      // A baked shadow decal is a *picture* of a shadow lying on the ground. Letting it into
      // the shadow map stamps a second, harder shadow next to the sun's own.
      mesh.castShadow = castShadow && !model.tags.includes('flat') && !g.material.userData?.decal;
      mesh.receiveShadow = receiveShadow;
      mesh.frustumCulled = false;      // one mesh spans the whole map; culling it is all-or-nothing
      mesh.userData.model = model;

      // Ground variety: a quarter turn per cell on a square of one surface, which costs a
      // different matrix in an array of matrices we were writing anyway.
      const vary = variety > 0 && varies(model, tileset.scatter?.flatVary ?? true);
      // A palette's centre tile gets tone and phase but never a quarter turn: its twelve
      // siblings meet it at a seam the artist drew, and spinning it would break that join
      // wherever the texture is not isotropic.
      // A globally-mapped tile is one cell of a *larger* pattern the artist drew across
      // `1/uvScale` cells (grass runs 4x4). Spinning one cell of that pattern, or phasing it
      // independently of its neighbours, tears the pattern at every cell edge — which is
      // invisible at the game camera and reads as a grid of green squares at three times the
      // zoom (`docs/progress/tiles/critic/hedge-close-12.png`). So a global tile is varied by
      // its **block**: the whole 4x4 patch shifts together and stays continuous inside itself,
      // and the repeat is broken at the scale it actually repeats at.
      // Measured off the model's own vertices, not read off `uvScale`: `globalUvStep` records
      // why, and the V half of it is a four-round-old bug. `null` on `?uvstep=0` or on a group
      // whose UVs do not move with X or Z, and the old assumption is the fallback.
      const step = g.uvStep ?? (model.globalUv && model.uvScale
        ? { u: model.uvScale, v: model.uvScale } : null);
      const block = step ? Math.max(1, Math.round(1 / Math.abs(step.u))) : 1;
      const spin = vary && model.autotile == null && block === 1;
      // A sheet that spans more than one cell is the one that shows a *field* period, and it is
      // the one the panels keep naming. Its repeat is broken in the fragment shader instead —
      // off the cell grid entirely — so it must not also take the block phase, which is what put
      // the cut on the grid in the first place. `?scatter=0` swaps them back.
      const scatters = vary && block > 1 && (tileset.scatter?.on ?? false)
        && g.material.userData?.alphaClass === 'opaque';

      let needsColor = false;
      for (let i = 0; i < items.length; i++) {
        const p = items[i];
        const rot = spin && p.rot === undefined ? (hash2(p.cx, p.cz, 11) * 4) | 0 : (p.rot ?? 0);
        this.constructor.composeMatrix(_m, p, model, cameraFacingRot(model, rot));
        mesh.setMatrixAt(i, _m);
        if (p.tint !== undefined && p.tint !== 0xffffff) needsColor = true;
      }

      // Whole-texel phase, so the art stays on the pixel grid at every zoom: a 64px texture
      // shifts in sixty-fourths, and anything finer would resample the pixel art and blur it.
      //
      // Only a fully opaque texture may be phased. `dirt`, `rot_dirtpatch` and `sterr_patch`
      // are cutout *decals* — a crack, a bald patch — and shifting one under RepeatWrapping
      // wraps it around the cell edge, so a centred crack comes back as two torn halves on
      // opposite sides of the square. They keep the turn and the tone and lose the phase.
      const phasable = vary && !scatters && g.material.userData?.alphaClass === 'opaque';
      const tw = g.material.map?.image?.width || 16;
      const th = g.material.map?.image?.height || tw;
      const phase = phasable
        ? (cx, cz, axis) => {
          const n = axis ? th : tw;
          const bx = Math.floor(cx / block), bz = Math.floor(cz / block);
          return Math.floor(hash2(bx, bz, 3 + axis) * n) / n * variety;
        }
        : null;
      if (vary && !phasable && !scatters) mesh.userData.noPhase = true;
      if (step || phasable) {
        const s = tileset.scatter;
        attachUvOffset(mesh, uvOffsets(items, step, phase), tileset,
          scatters ? 'scatter' : step ? 'globalUv' : 'phase',
          scatters ? {
            tex: new THREE.Vector2(tw, th),
            step: new THREE.Vector2(step.u, step.v),
            cfg: new THREE.Vector4(Math.max(0.25, s.region),
              Math.cos(s.angleDeg * Math.PI / 180), Math.sin(s.angleDeg * Math.PI / 180),
              Math.max(0, s.jitter)),
            amount: variety,
          } : null);
      }
      if (needsColor || vary) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(items.length * 3), 3);
        for (let i = 0; i < items.length; i++) {
          _c.set(items[i].tint ?? 0xffffff);
          // A field of one texture reads as wallpaper however well it is phased, because
          // every cell comes back the same brightness. A few percent of tone, hashed by
          // cell, is what turns it into ground. Green is moved least: the eye reads a hue
          // shift in a lawn long before it reads a luminance one.
          if (vary) {
            const { cx, cz } = items[i];
            const t = blotch(cx, cz, 29);           // light and shade, across many cells
            const u = blotch(cx, cz, 31);           // and a slower swing of hue with it
            _c.r *= 1 + (t * 0.065 + u * 0.026) * variety;
            _c.g *= 1 + (t * 0.040) * variety;
            _c.b *= 1 + (t * 0.065 - u * 0.038) * variety;
          }
          mesh.setColorAt(i, _c);
        }
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();

      this.group.add(mesh);
      this.meshes.push({ mesh, model, groupIndex, items });
      this.stats.triangles += (g.count / 3) * items.length;
    }
    if (contact > 0) this.addContactShadows(placements, contact);
    this.stats.meshes = this.meshes.length;
    parent.add(this.group);
  }

  /**
   * One extra InstancedMesh — one draw call for the whole world — carrying a soft dark quad
   * under everything that stands up off the ground.
   *
   * Unlit on purpose (`MeshBasicMaterial`): a shadow that takes the key light gets brighter as
   * the sun rises, which is exactly backwards, and turns orange at golden hour with it. It
   * writes no depth and takes a polygon offset so it never fights the tile it lies on, and it
   * is not in the shadow map — a picture of a shadow must not cast one.
   *
   * The plateau-and-penumbra shape is `contactShadowPatch`; see there for why it is a shader
   * and not a texture.
   */
  addContactShadows(placements, strength) {
    const items = [];
    for (const p of placements) {
      const model = this.tileset.byId.get(p.modelId);
      if (!model || !wantsContactShadow(model)) continue;
      items.push({ p, model });
    }
    if (!items.length) return;

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.name = 'contact-shadow';
    const inner = new Float32Array(items.length * 2);
    const margin = new Float32Array(items.length * 2);
    const mat = new THREE.MeshBasicMaterial({
      color: CONTACT_COLOR,
      transparent: true,
      opacity: Math.min(1, strength) * CONTACT_OPACITY,
      depthWrite: false,
      side: THREE.FrontSide,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      name: 'contact-shadow',
    });
    applyShaderPatches(mat, [contactShadowPatch]);

    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    mesh.name = 'contact-shadows';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    for (let i = 0; i < items.length; i++) {
      const { p, model } = items[i];
      const fp = footprint(model, p.rot ?? 0);
      inner[i * 2] = fp.w / 2;
      inner[i * 2 + 1] = fp.h / 2;
      margin[i * 2] = CONTACT_MARGIN;
      margin[i * 2 + 1] = CONTACT_MARGIN;
      _p.set(p.cx + fp.w / 2, (p.y ?? 0) + CONTACT_Y, p.cz + fp.h / 2);
      _q.identity();
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    geo.setAttribute('aInner', new THREE.InstancedBufferAttribute(inner, 2));
    geo.setAttribute('aMargin', new THREE.InstancedBufferAttribute(margin, 2));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.meshes.push({ mesh, model: null, groupIndex: 0, contact: true, items: items.map((it) => it.p) });
    this.contact = { mesh, material: mat, geometry: geo, count: items.length };
    this.stats.contactShadows = items.length;
    this.stats.triangles += 2 * items.length;
  }

  /**
   * Tile geometry is authored with its origin at the footprint's north-west corner, so a
   * rotation has to happen about the footprint centre to keep the tile on its cells.
   */
  static composeMatrix(out, p, model, rotOverride) {
    const rot = ((rotOverride ?? p.rot ?? 0)) & 3;
    const w = model.w ?? 1, h = model.h ?? 1;
    _q.setFromAxisAngle(_axisY, -rot * Math.PI * 0.5);
    if (rot === 0) {
      _p.set(p.cx, p.y ?? 0, p.cz);
    } else {
      // Rotate the local footprint about its centre, then place that centre on the cells.
      const halfW = w / 2, halfH = h / 2;
      const cxCentre = p.cx + ((rot & 1) ? halfH : halfW);
      const czCentre = p.cz + ((rot & 1) ? halfW : halfH);
      const dx = -halfW, dz = -halfH;
      const cos = Math.cos(-rot * Math.PI * 0.5), sin = Math.sin(-rot * Math.PI * 0.5);
      _p.set(cxCentre + (dx * cos + dz * sin), p.y ?? 0, czCentre + (-dx * sin + dz * cos));
    }
    out.compose(_p, _q, _s);
    return out;
  }

  /** Re-tints one placement (season, night dimming, damage flash). */
  setTint(placementIndex, hex) {
    const p = this.placements[placementIndex];
    if (!p) return;
    p.tint = hex;
    for (const entry of this.meshes) {
      if (entry.contact) continue;      // a shadow is not tinted by the season
      const i = entry.items.indexOf(p);
      if (i < 0) continue;
      if (!entry.mesh.instanceColor) {
        entry.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(entry.items.length * 3).fill(1), 3);
      }
      _c.set(hex);
      entry.mesh.setColorAt(i, _c);
      entry.mesh.instanceColor.needsUpdate = true;
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.contact?.material.dispose();
    this.contact?.geometry.dispose();
    this.contact = null;
    for (const { mesh } of this.meshes) {
      mesh.dispose();
      mesh.removeFromParent();
    }
    this.meshes.length = 0;
    this.group.removeFromParent();
  }
}

/**
 * Tile materials — what a DS texture actually is, measured rather than assumed.
 *
 * The pack's material record carries the **polygon** flags the .pdsts stores: `alpha` is
 * the DS material alpha (0..31), `bothFaces` is BOTHFACE, and so on. It says nothing about
 * the *texture's* own per-texel alpha, and six AdAstra textures are soft:
 *
 *     kage_out   8x8    a 0.25 / 0.48 shadow blob under a lamp or a hedge
 *     h_kage     8x8    the same under a tree
 *     ki02c     32x32   the horizontal canopy slice that makes a 10-triangle tree a volume
 *     kusa_ec3  16x16   the soft outer fringe of a grass border
 *     mori01s   32x16   the forest floor wash
 *     dansa01a  16x16   the shading on a step
 *
 * Loading all of them with `transparent:false` and a 0.35 alpha test — which is what the
 * first cut did — discards every texel below 0.35 and draws every texel above it fully
 * opaque. A soft shadow becomes a hard black slab with a ragged edge; that slab is the
 * black rectangle at the foot of every lamp in `docs/progress/_boot/wave-a-end.png`.
 *
 * So the texture is decoded once at load and classified from its own alpha histogram.
 */

import * as THREE from 'three';

/** Alpha classes a DS texture can be in. */
export const ALPHA = { OPAQUE: 'opaque', CUTOUT: 'cutout', SOFT: 'soft' };

/** A group whose geometry is this thin is a decal lying on the ground, not a volume. */
const FLAT_Y = 0.06;

/**
 * How high a paper-thin group may sit and still be a *ground* decal.
 *
 * Thinness alone is not the test. A tree's canopy is built out of horizontal slices
 * (DECISIONS #22) and every one of them is paper-thin, so `flatOnly` catches a leaf layer
 * three metres in the air exactly as it catches the shadow blob under the trunk — and a
 * canopy slice that does not write depth stops occluding anything behind it. AdAstra's
 * real ground decals top out at 0.13 (`kage_out`) and the lowest canopy slice a tree owns
 * starts at 1.44, so a cut at a third of a cell is unambiguous.
 */
const GROUND_DECAL_Y = 0.35;

/**
 * The minimum elevation, in degrees above the horizon, a shaded normal may have.
 *
 * DECISIONS #25c lifted every below-horizon normal *to* the horizon and stopped there. That
 * trades a black silhouette for a black shaft: a normal at exactly 0 elevation takes
 * `max(dot(N, L), 0) = 0` from a sun overhead, so at noon every vertical face in the set —
 * a lamp post, a tree trunk, the edge-on leaf cards, a bench's flank — is lit by the
 * hemisphere fill alone, and that fill is deliberately small (`env/presets.js` runs ambient
 * at ~0.1). The measured symptoms were a navy lamp post with a hard band where the lifted
 * vertices met the unlifted ones, a forest canopy that reads dark teal at noon, and 2–4 px
 * pure-black streaks down every edge-on card.
 *
 * Nothing in this game is ever seen from underneath and nothing is ever seen from below the
 * horizon, so the honest shading model for a DS tile is "no face is worse-lit than a face
 * tilted 22 degrees up". At the noon sun altitude that floor is worth ~0.37 of the key on a
 * face that would otherwise have had none, while a face that already points up keeps every
 * bit of its own shading — the up-and-outward normals AdAstra's props are built on
 * (DECISIONS #22) sit at 35 degrees and are untouched.
 */
export const NORMAL_MIN_ELEVATION_DEG = 22;
const NLIFT_SIN = Math.sin(NORMAL_MIN_ELEVATION_DEG * Math.PI / 180);
const NLIFT_COS = Math.cos(NORMAL_MIN_ELEVATION_DEG * Math.PI / 180);

/**
 * Why this is a *fragment* patch and not another pass over the vertex buffer.
 *
 * Six AdAstra materials are `bothFaces` — `ki02ax`, the crossed upright cards a tree is
 * built from, is one of them. three flips the normal for a back face inside
 * `normal_fragment_begin` (`normal *= faceDirection`), so a card whose stored normal was
 * lifted to +22 degrees renders its *other* side at −22: the camera looks north and sees the
 * south face of every north-facing card, which would come out darker than it is today. The
 * clamp has to happen after the flip, which means in the fragment shader.
 *
 * `normal` there is in view space, so world up is `viewMatrix`'s own Y column rather than
 * `vec3(0,1,0)`; `viewMatrix` is in three's fragment prefix, so it costs no uniform.
 */
const NLIFT_GLSL = `
	{
		vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
		float elev = dot( normal, upV );
		if ( elev < ${NLIFT_SIN.toFixed(6)} ) {
			vec3 flat_ = normal - upV * elev;
			float flatLen = length( flat_ );
			normal = flatLen > 1e-4
				? normalize( flat_ * ( ${NLIFT_COS.toFixed(6)} / flatLen ) + upV * ${NLIFT_SIN.toFixed(6)} )
				: upV;
		}
	}
`;

/** Adds the elevation clamp to a shader three is about to compile. */
export function liftNormalsInShader(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>', `#include <normal_fragment_begin>${NLIFT_GLSL}`);
}
liftNormalsInShader.key = 'nlift';

/**
 * Composes shader patches onto one material.
 *
 * `Material.clone()` copies neither `onBeforeCompile` nor `customProgramCacheKey`, and
 * `instanced.js` clones a material to hang the global-UV attribute on it — so the two
 * patches have to be applied together, from a list, rather than each overwriting the other.
 * The cache key is the patch names joined, which keeps every material carrying the same set
 * on one program (ARCHITECTURE §7 budgets 60).
 */
export function applyShaderPatches(mat, patches) {
  if (!patches.length) return mat;
  mat.userData.shaderPatches = patches;
  mat.onBeforeCompile = (shader) => { for (const p of patches) p(shader); };
  const key = patches.map((p) => p.key).join('+');
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * Decodes an image into a canvas once and reports what its alpha channel is doing.
 * Textures here are 8x8 to 32x64, so this costs microseconds and runs at load, never in a
 * frame.
 * @returns {{cls:string, minAlpha:number, softTexels:number, texels:number, luma:Float32Array|null}}
 */
export function alphaProfile(image) {
  const w = image?.width | 0, h = image?.height | 0;
  if (!w || !h) return { cls: ALPHA.OPAQUE, minAlpha: 1, softTexels: 0, texels: 0, data: null, w: 0, h: 0 };
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g2d = canvas.getContext('2d', { willReadFrequently: true });
  g2d.clearRect(0, 0, w, h);
  g2d.drawImage(image, 0, 0);
  const data = g2d.getImageData(0, 0, w, h).data;

  let soft = 0, zero = 0, minA = 255;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a === 0) zero++;
    else if (a < 255) soft++;
    if (a < minA) minA = a;
  }
  const cls = soft > 0 ? ALPHA.SOFT : (zero > 0 ? ALPHA.CUTOUT : ALPHA.OPAQUE);
  return { cls, minAlpha: minA / 255, softTexels: soft, texels: w * h, data, w, h };
}

/**
 * Every group in the pack that draws with material `id`, and the Y extent of its geometry.
 * A material used only by paper-thin groups is a decal: it lies on the ground, it must not
 * write depth, and it must not cast a shadow of its own — a shadow casting a shadow is how
 * you get a second, harder shadow beside the first.
 */
export function materialGeometryRoles(pack, floats, stride) {
  const roles = pack.materials.map(() => ({
    flatOnly: true, maxY: -Infinity, minY: Infinity, groups: 0, categories: new Set(),
  }));
  for (const m of pack.models) {
    if (m.empty || !m.groups) continue;
    for (const g of m.groups) {
      const r = roles[g.material];
      if (!r) continue;
      r.groups++;
      r.categories.add(m.category);
      let lo = Infinity, hi = -Infinity;
      const start = g.offset / 4;
      for (let i = 0; i < g.count; i++) {
        const y = floats[start + i * stride + 1];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      if (hi - lo > FLAT_Y) r.flatOnly = false;
      if (hi > r.maxY) r.maxY = hi;
      if (lo < r.minY) r.minY = lo;
    }
  }
  return roles;
}

/**
 * Triangles whose *geometric* normal points down, on a material that is not `bothFaces`,
 * are wound so the renderer culls them from above — and the camera never goes below the
 * horizon, so they are simply holes.
 *
 * PDSMS itself draws with backface culling off, which is why a DS artist has no reason to
 * keep a consistent winding (DECISIONS #5). The exporter rewinds each triangle to agree with
 * the *artist's stored normals*, and where those normals point down the rewind faithfully
 * reproduces a face that cannot be seen. `forest_entrance_front`'s top canopy slice is
 * exactly this: eight of its sixteen triangles are wound face-down and they are the eight
 * covering the model's northern half, so the whole north half of the canopy roof is missing
 * and the lawn 3.7 m below shows through it. That is the pale diamond in the middle of the
 * tree in `docs/progress/tiles/critic/tree-close-12.png`.
 *
 * 46 triangles of AdAstra's 2402 are in this state and every one of them is on a forest
 * entrance. Flipping their winding (and the normals with it, so the shading agrees) costs
 * nothing anywhere else: a genuine underside of a closed volume is still hidden by its own
 * top face through the depth test.
 *
 * @returns {number} triangles flipped
 */
export function rewindDownwardFaces(pack, floats, stride) {
  let flipped = 0;
  const swap = (a, b) => {
    for (let k = 0; k < stride; k++) {
      const t = floats[a + k]; floats[a + k] = floats[b + k]; floats[b + k] = t;
    }
  };
  for (const m of pack.models) {
    if (m.empty || !m.groups) continue;
    for (const g of m.groups) {
      if (pack.materials[g.material]?.bothFaces) continue;
      const start = g.offset / 4;
      for (let t = 0; t + 3 <= g.count; t += 3) {
        const o0 = start + t * stride, o1 = o0 + stride, o2 = o1 + stride;
        const ax = floats[o1] - floats[o0], ay = floats[o1 + 1] - floats[o0 + 1],
          az = floats[o1 + 2] - floats[o0 + 2];
        const bx = floats[o2] - floats[o0], by = floats[o2 + 1] - floats[o0 + 1],
          bz = floats[o2 + 2] - floats[o0 + 2];
        const ny = az * bx - ax * bz;                       // the Y term of a x b
        const len = Math.hypot(ay * bz - az * by, ny, ax * by - ay * bx);
        if (!len || ny / len > -0.5) continue;
        swap(o1, o2);
        for (const o of [o0, o1, o2]) {
          if (floats[o + 4] >= 0) continue;
          floats[o + 3] = -floats[o + 3];
          floats[o + 4] = -floats[o + 4];
          floats[o + 5] = -floats[o + 5];
        }
        flipped++;
      }
    }
  }
  return flipped;
}

/**
 * The one material property the pack does carry and the loader used to drop: `emissive`,
 * read from the MTL's `Ke` by `tools/assets/obj.js`. Only the authored sets (`structures`,
 * `props`) have it, because a `.pdsts` has no place to put one — so a set that is silent
 * gets its lights derived from the classifier instead: a material used *exclusively* by
 * models in the `light` category is a lamp's own material and nothing else's.
 *
 * `kage_out` is the check that this is drawn tightly enough: it is on the lamp too, but the
 * hedges use it as well, so it is not exclusive and does not glow.
 */
export function emissiveStrength(pack, roles, index) {
  const m = pack.materials[index];
  if (typeof m.emissive === 'number') return m.emissive;
  const r = roles[index];
  if (!r || !r.groups) return 0;
  return (r.categories.size === 1 && r.categories.has('light')) ? 1 : 0;
}

/**
 * A glow map for a material whose emissive was *derived* rather than authored.
 *
 * `slamp03` is one 16x32 sheet holding both the post and the glass, so lighting it with its
 * own colour map makes the whole post glow. The lamp's white block (`f8f8f8`, luma 0.973)
 * is a full 0.12 clear of the next brightest texel in the sheet (`c8d8e0`, 0.85), so a luma
 * gate at 0.90 keeps exactly the glass and drops the metal. Authored sets skip this: a
 * `pokemon_center:window` is already its own texture and its artist meant all of it.
 */
export function makeGlowTexture(profile, { threshold = 0.9, name = 'glow' } = {}) {
  const { data, w, h } = profile;
  if (!data || !w || !h) return null;
  const out = new Uint8Array(w * h * 4);
  let lit = 0;
  // Row order is *not* flipped, and that was settled on screen rather than reasoned about:
  // written in reading order the glow lands along the lamp's glass strip
  // (`docs/progress/tiles/r1/08-lamps-night.png`); written bottom-row-first it lands on the
  // elbow where the arm meets the shade (`07-lamps-night-on.png`). Whatever three and the
  // driver do with `flipY` between an <img> upload and a DataTexture upload, these two land
  // in the same orientation as they stand, and the picture is the authority.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4, o = i;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const k = a === 0 ? 0 : Math.max(0, (luma - threshold) / (1 - threshold));
      if (k > 0) lit++;
      out[o] = r * k;
      out[o + 1] = g * k;
      out[o + 2] = b * k;
      out[o + 3] = 255;
    }
  }
  if (!lit) return null;
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.flipY = false;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * DS normals point wherever the tile artist left them, and 382 of AdAstra's 7206 vertices
 * (5.3 %) point *below* the horizon — 19 of the 30 on a lamp, 45 of 162 on a forest
 * entrance, 9 of 48 on a hedge. Nothing in this game is ever seen from underneath (the
 * camera is locked 45 degrees above the horizontal, ARCHITECTURE §2.7), so a downward
 * normal is not an underside anyone will look at: it is a face that takes no sun and reads
 * as a black silhouette. The four lamp variants are the proof — the two whose posts happen
 * to carry the downward normals render as black sticks while the two mirrored ones, same
 * model, render as grey metal.
 *
 * Normals are lifted to the horizon and no further. A face pointing straight down becomes
 * `+Y`; a face pointing down-and-north keeps its northness and grazes. This preserves the
 * up-and-outward shading AdAstra's props are built on (DECISIONS #22) and only touches
 * normals that were pointing into the ground.
 *
 * @returns {number} how many vertices were lifted, for the log
 */
export function liftNormalsAboveHorizon(floats, stride) {
  let lifted = 0;
  for (let o = 0; o + stride <= floats.length; o += stride) {
    const ny = floats[o + 4];
    if (ny >= 0) continue;
    const nx = floats[o + 3], nz = floats[o + 5];
    const len = Math.hypot(nx, nz);
    if (len < 1e-4) { floats[o + 3] = 0; floats[o + 4] = 1; floats[o + 5] = 0; }
    else { floats[o + 3] = nx / len; floats[o + 4] = 0; floats[o + 5] = nz / len; }
    lifted++;
  }
  return lifted;
}

/**
 * Builds the THREE material for one pack material.
 *
 * @param {object} spec        the pack.materials record
 * @param {THREE.Texture|null} map
 * @param {{cls:string}} profile     from alphaProfile()
 * @param {{flatOnly:boolean, maxY:number}} role  from materialGeometryRoles()
 */
export function makeMaterial(spec, map, profile, role, index) {
  const soft = profile.cls === ALPHA.SOFT;
  const cutout = profile.cls === ALPHA.CUTOUT;
  // A soft texture on paper-thin geometry is a ground decal: the baked shadow under a lamp,
  // a hedge or a tree. It has to blend, must not write depth (two decals overlapping would
  // punch a hole in each other), and must not cast.
  //
  // Height is the other half of the test. A tree's canopy is built out of horizontal slices
  // (DECISIONS #22) and every one of them is paper-thin too, so thinness alone would classify
  // a leaf layer three metres up as a decal and stop it occluding anything behind it.
  const decal = soft && role.flatOnly && role.maxY <= GROUND_DECAL_Y;
  const translucent = spec.translucent;

  const opts = {
    map,
    transparent: translucent || soft,
    opacity: translucent ? spec.alpha / 31 : 1,
    depthWrite: !translucent && !decal,
    // Cutouts keep a hard test — that is what makes a leaf edge a pixel edge. Soft textures
    // get a test low enough to drop only the fully clear texels, so their gradient survives.
    alphaTest: soft ? 0.02 : (cutout ? 0.35 : 0),
    side: spec.bothFaces ? THREE.DoubleSide : THREE.FrontSide,
    vertexColors: true,
    fog: spec.fog !== false,
    name: spec.name ?? spec.image ?? `mat${index}`,
  };
  // A baked contact shadow is a *picture of an absence of light*, so lighting it is a category
  // error: `kage_out` is a flat quad with a +Y normal, which at noon takes the full key, and
  // at golden hour turns orange with the sun. Unlit, the same texture multiplies down onto
  // whatever it lies on at every time of day, which is the whole job.
  const mat = decal ? new THREE.MeshBasicMaterial(opts) : new THREE.MeshLambertMaterial(opts);
  if (decal) {
    // Sits a hair proud of the ground it lies on so the two never fight for the depth
    // buffer at a grazing angle.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
  }
  mat.userData.spec = spec;
  mat.userData.decal = decal;
  mat.userData.alphaClass = profile.cls;
  return mat;
}

/**
 * The contact shadow a piece standing on the ground has to have, as a shader.
 *
 * The reference frames carry most of their depth in ground shading —
 * `docs/refs/01-forest-tilemap-frame.png` is largely soft darkening around the bases of
 * things — and at noon the sun is nearly overhead, so the shadow it casts lands *under* the
 * object and the object stands on top of it: `docs/progress/tiles/critic/hedge-close-12.png`
 * has a perfectly working shadow map and a hedge that still meets the lawn with no darkening
 * whatever, which is what makes it read as pasted on rather than planted.
 *
 * AdAstra's artists agreed the piece is needed and painted `kage_out` / `h_kage` blobs under
 * twelve of their models — but those are painted to sit *under* a footprint, and a hedge a
 * full cell tall covers every pixel of its own at a 45-degree pitch. What grounds a piece is
 * the penumbra that reaches *past* it.
 *
 * That penumbra has to be a plateau over the footprint and a falloff outside it, measured in
 * **cells**, on each axis independently. A radial texture cannot do that: scaled onto a 4x1
 * hedge it becomes an ellipse whose falloff starts a cell inside the hedge along one axis and
 * half a cell outside it along the other, which is why the first cut of this was invisible.
 * Two instanced attributes and five lines of GLSL do it exactly, for any footprint, in one
 * draw call and with no texture at all.
 *
 *   aInner   half the footprint, in cells
 *   aMargin  how far the penumbra reaches past it, in cells
 *
 * The quad is a unit square sized in the vertex shader, so the instance matrix carries only a
 * translation and one geometry serves a 1x1 lamp and a 4x4 forest entrance alike.
 */
export function contactShadowPatch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      attribute vec2 aInner;
      attribute vec2 aMargin;
      varying vec2 vEdge;
      varying vec2 vInner;
      varying vec2 vMargin;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.xz *= 2.0 * ( aInner + aMargin );
      vEdge = transformed.xz;
      vInner = aInner;
      vMargin = aMargin;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec2 vEdge;
      varying vec2 vInner;
      varying vec2 vMargin;`)
    .replace('#include <alphatest_fragment>', `
      vec2 past = max( abs( vEdge ) - vInner, vec2( 0.0 ) ) / max( vMargin, vec2( 1e-4 ) );
      float fall = clamp( 1.0 - length( past ), 0.0, 1.0 );
      diffuseColor.a *= fall * fall * ( 3.0 - 2.0 * fall );
      #include <alphatest_fragment>`);
}
contactShadowPatch.key = 'contactShadow';

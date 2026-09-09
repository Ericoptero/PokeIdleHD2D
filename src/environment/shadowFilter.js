/**
 * environment/shadowFilter — the sun's shadow gets a penumbra.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * ARCHITECTURE §2.7 asks for `PCFSoftShadowMap`, and `core/render.js` sets exactly that.
 * three r185 **deprecated that constant**: `WebGLShadowMap.render()` substitutes
 * `PCFShadowMap` on the first shadow pass and moves on (`WebGLShadowMap.js:99`). The
 * substitute is a 5-tap Vogel disk whose radius is `LightShadow.radius * texelSize`, and
 * `LightShadow.radius` **defaults to 1**, which nothing in this project had ever set.
 *
 * One texel of a 2048² map over a 56-unit ortho box is `56 / 2048 = 0.0273` world units.
 * So every shadow in the game had a penumbra a thirty-sixth of a tile wide — a razor edge
 * on a bench, a tree, a roof and a fence alike, at every hour. That is the "HARD-EDGED
 * SHADOWS" three separate module critics filed, and the reason the golden-hour lawn reads
 * as venetian blinds: at `tod 17.5` the shown sun is 8.6° up, so a tree canopy's own gaps
 * are raked 6.6× into parallel bars, and every one of those bars had a one-pixel edge.
 *
 * ── Why not simply raise `LightShadow.radius` ────────────────────────────────────────────
 * Measured (DECISIONS #52, `docs/progress/environment/r7/sweep/`): with three's own 5 taps,
 * radius 12 and 20 do soften the bars — and they dither the whole lawn, because 5 samples
 * rotated per pixel by interleaved gradient noise over a 12-texel disk is a 45 % standard
 * error on the coverage estimate. `crop-lawn-r20.png` is salt and pepper. The filter needs
 * more taps, and three's chunk has no knob for that.
 *
 * ── What this installs ───────────────────────────────────────────────────────────────────
 * One shader chunk, `shadowmap_pars_fragment`, with the PCF branch's `getShadow` replaced:
 *
 *   · **`TAPS` samples instead of 5.** The tap count is the whole of the noise: the standard
 *     error of a coverage estimate falls as `1/sqrt(n)`, so 24 taps is 2.2× quieter than 5
 *     and the dither drops under the frame's own grain. Each tap is still a hardware
 *     `sampler2DShadow` fetch under `LinearFilter`, which is a free 2×2 comparison, so 24
 *     taps is ~96 effective ones. At the internal 426×240 (pixelScale 3) that is about 2.5 M
 *     fetches a frame and it does not move the frame rate — measured, 60 fps unchanged.
 *
 *   · **A receiver-plane depth bias.** Three compares all of its taps against the receiver's
 *     depth at the centre of the kernel, so on a surface tilted away from the light every
 *     uphill tap reads as occluded and the surface self-shadows. A tap displaced `R` texels
 *     along the light's own vertical axis reads ground `R · texel · cot(elevation)` nearer the
 *     light; at 8.6° that is 0.18 world units *per texel*, against the 0.17 units of slack the
 *     constant bias buys. So each tap is compared against the depth the receiving *plane*
 *     actually has there: `dFdx`/`dFdy` of the shadow coordinate give `∂z/∂u` and `∂z/∂v` from
 *     a 2×2 solve, and the tap tests `z + dot(∂z/∂uv, offset)`.
 *
 *     **How much it is worth, measured** (`?envNoRpdb=1`, radius 12, `docs/progress/environment/
 *     r7/rpdb/`): on `city/high-street/17.5` it changes 4.31 % of the frame, and those pixels
 *     are 0.70× as bright without it. The diff mask says *where*, and it is not where the theory
 *     points: **lamp posts, awnings and the strip of ground at the foot of a wall** — the narrow,
 *     steeply tilted things that also cast. Roofs are untouched (region mean 84.17 with, 84.21
 *     without) and the lawn is untouched, because `src/tiles/instanced.js` keeps flat ground out
 *     of the shadow pass entirely, so open ground writes nothing to the map and cannot
 *     self-shadow at any radius. So this is not what unlocked the wide kernel — the tap count
 *     was — but it is what keeps a post from acneing itself at 12 texels, and it costs nothing.
 *
 *     Two details are load-bearing. The derivatives are taken **before** the frustum test,
 *     because a `dFdx` inside non-uniform control flow is undefined for any quad that
 *     straddles the edge of the shadow box. And the fitted slope is **clamped per texel of
 *     offset**: at a silhouette the derivative is the caster's whole depth jump rather than
 *     the receiver's plane, and an unclamped fit would peter-pan the kernel clean off the
 *     caster. The clamp is sized at `SLOPE_PER_TEXEL`, the real slope of flat ground under a
 *     sun 2.3° up — below the 3.4° elevation floor `index.js` enforces, so the legitimate
 *     case is never clipped.
 *
 * ── Why a chunk override and not a change to `core/render.js` ────────────────────────────
 * Folder ownership (ARCHITECTURE §1): `src/core/` is the integrator's. §2.7 says the pipeline
 * is "owned by core, **tuned** by environment", and this is a tune written at runtime, exactly
 * like the per-hour `shadow.bias`/`normalBias` pair `index.js` already writes onto the light.
 * `docs/STATUS.json → coreRequests[]` carries the request to move it into `render.js` and to
 * stop asking for a deprecated constant. Until then it lives here, and it is *reversible from
 * a URL* (`?envNoShadowFilter=1`) so a critic can A/B it without a code change.
 */

import * as THREE from 'three';

/** `?envShadowTaps=N` / `?envNoRpdb=1` — the two knobs this filter is worth sweeping on. */
function devNum(name, fallback) {
  try {
    const v = new URLSearchParams(location.search).get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}

/**
 * Samples per shadow lookup.
 *
 * The count buys exactly one thing — the dither — because the standard error of a coverage
 * estimate falls as `1/sqrt(n)`: 0.45 at three's 5 taps, 0.29 at 12, 0.20 at 24, 0.18 at 32.
 *
 * Swept, rather than reasoned: `?showcase=city&preset=high-street&tod=17.5&envShadowRadius=12`,
 * and the lawn crop (x 40..240, y 20..140) measured for high-frequency energy — the mean
 * `|luma − avg(4 neighbours)|`, which is the grass texture plus the dither and nothing else,
 * since the scene is identical between shots:
 *
 *      taps      5      12      24      32        radius 1 (the old hard shadow)
 *      hf     2.874   2.440   2.301   2.282       2.804
 *
 * 5 taps of *this* filter measures 2.874, the same as three's own 5-tap kernel at the same
 * radius — which is the check that the replacement is a like-for-like one. 24 → 32 buys 0.019
 * and is not visible; 12 still carries 0.14 of dither over 24. So 24, and the flag stays, so the
 * next agent can re-run the sweep instead of trusting this paragraph.
 */
const TAPS = Math.max(4, Math.min(64, Math.round(devNum('envShadowTaps', 24))));

/**
 * Ceiling on the fitted plane slope, in normalised shadow depth per shadow-map texel.
 *
 * The ortho shadow camera runs `near 0.5` to `far 168`, so one unit of `shadowCoord.z` is
 * 167.5 world units and one texel is 0.0273. Flat ground under a sun `e` above the horizon
 * has a slope of `0.0273 · cot(e) / 167.5` per texel: 0.0011 at 8.6°, 0.0027 at 3.4° — the
 * floor `KEY_ELEVATION_FLOOR` puts on the key. 0.004 is 2.3°, comfortably under it, so a
 * real receiver is never clipped and a silhouette's runaway derivative always is.
 */
const SLOPE_PER_TEXEL = devNum('envNoRpdb', 0) === 1 ? 0 : 0.004;

/** Marker so `installed()` can prove the chunk in the compiled program is this one. */
const MARK = 'ENV_SHADOW_FILTER_V1';

function pcfSource() {
  return /* glsl */`
		// ${MARK} — see src/environment/shadowFilter.js
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

			vec3 sc = shadowCoord.xyz / shadowCoord.w;

			// Receiver-plane depth bias. Taken here, in uniform control flow: a derivative
			// inside the frustum test below is undefined for a quad that straddles the edge
			// of the shadow box, and "undefined" on this hardware is a black quad.
			vec3 ddx = dFdx( sc );
			vec3 ddy = dFdy( sc );
			float det = ddx.x * ddy.y - ddx.y * ddy.x;
			vec2 dzduv = vec2( 0.0 );
			if ( abs( det ) > 1e-12 ) {
				dzduv = vec2( ddy.y * ddx.z - ddx.y * ddy.z, ddx.x * ddy.z - ddy.x * ddx.z ) / det;
			}

			float shadow = 1.0;

			bool inFrustum = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0;

			if ( inFrustum && sc.z <= 1.0 ) {

				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float radius = shadowRadius * texelSize.x;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				float z0 = sc.z + shadowBias;
				// Per-texel ceiling on the plane fit, in the kernel's own units.
				float slopeMax = float( ${SLOPE_PER_TEXEL} ) / texelSize.x;

				float sum = 0.0;

				for ( int i = 0; i < ${TAPS}; i ++ ) {

					vec2 off = vogelDiskSample( i, ${TAPS}, phi ) * radius;
					float lim = slopeMax * length( off );
					float dz = clamp( dot( dzduv, off ), - lim, lim );
					sum += texture( shadowMap, vec3( sc.xy + off, z0 + dz ) );

				}

				shadow = sum * ( 1.0 / float( ${TAPS} ) );

			}

			return mix( 1.0, shadow, shadowIntensity );

		}
`;
}

/**
 * Finds `float getShadow( sampler2DShadow …` in the chunk and returns the half-open range of
 * the whole function, by matching braces from its opening one.
 *
 * Anchoring on a brace scan rather than on the exact text three ships is what makes this
 * survive a patch release. If the anchor is ever gone the install is skipped and the game
 * renders with three's own filter — a hard shadow is a defect, a failed string replace that
 * emits invalid GLSL is a black screen, and the dev server has to stay loadable (§2.1).
 */
function findGetShadow(src) {
  const at = src.indexOf('float getShadow( sampler2DShadow shadowMap');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { start: at, end: i + 1 };
  }
  return null;
}

/**
 * Swaps the filter into `THREE.ShaderChunk` and puts the renderer on the shadow-map type
 * that actually reads it.
 *
 * Call before the first frame. Programs compile lazily at first render, so anything after
 * that would need every material in the scene marked `needsUpdate` — and `environment`
 * cannot reach another module's materials.
 *
 * `renderer.shadowMap.type` is set explicitly to `PCFShadowMap` rather than left on the
 * deprecated constant. It is the same value three would substitute a moment later, but doing
 * it here means the *first* program compiled already carries `SHADOWMAP_TYPE_PCF`, instead of
 * depending on the order in which the shadow pass and the first material happen to run.
 *
 * @returns {{ installed: boolean, why?: string, taps?: number }}
 */
export function installShadowFilter(renderer, log) {
  try {
    if (renderer?.shadowMap) renderer.shadowMap.type = THREE.PCFShadowMap;

    const chunks = THREE.ShaderChunk;
    const src = chunks?.shadowmap_pars_fragment;
    if (typeof src !== 'string') return { installed: false, why: 'no shadowmap_pars_fragment chunk' };
    if (src.includes(MARK)) return { installed: true, taps: TAPS };

    const span = findGetShadow(src);
    if (!span) return { installed: false, why: 'getShadow(sampler2DShadow) not found in the chunk' };

    chunks.shadowmap_pars_fragment = src.slice(0, span.start) + pcfSource().trim() + src.slice(span.end);
    return { installed: true, taps: TAPS };
  } catch (err) {
    log?.warn?.(`environment: shadow filter not installed (${err?.message ?? err})`);
    return { installed: false, why: String(err?.message ?? err) };
  }
}

/** True when the chunk three will compile from is this module's. Used by the dev dump. */
export function shadowFilterInstalled() {
  return String(THREE.ShaderChunk?.shadowmap_pars_fragment ?? '').includes(MARK);
}

export const SHADOW_FILTER_TAPS = TAPS;

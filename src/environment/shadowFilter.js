/**
 * environment/shadowFilter — the sun's shadow gets a penumbra, and the penumbra grows with
 * the distance from the thing that casts it.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * ARCHITECTURE §2.7 asks for `PCFSoftShadowMap`, and `core/render.js` sets exactly that.
 * three r185 **deprecated that constant**: `WebGLShadowMap.render()` substitutes
 * `PCFShadowMap` on the first shadow pass and moves on (`WebGLShadowMap.js:99`). The
 * substitute is a 5-tap Vogel disk whose radius is `LightShadow.radius * texelSize`, and
 * `LightShadow.radius` **defaults to 1**, which nothing in this project had ever set.
 *
 * One texel of a 2048² map over a 56-unit ortho box is `56 / 2048 = 0.0273` world units.
 * So every shadow in the game had a penumbra a thirty-sixth of a tile wide — a razor edge on
 * a bench, a tree, a roof and a fence alike, at every hour. That is the "HARD-EDGED SHADOWS"
 * three separate module critics filed (DECISIONS #52).
 *
 * ── What round 7 shipped, and what it cost ───────────────────────────────────────────────
 * Round 7 replaced three's 5-tap kernel with a 24-tap one and rode `LightShadow.radius` on
 * the sun's elevation: 6.4 texels at noon, 12 at the golden hour. That fixed the raked bars
 * and it broke the contacts, because **one penumbra width per frame is wrong within the
 * frame**. Round 7's own note said so, and the round-7 critic then measured it: a shadow at
 * its caster's feet got the same 12 texels as one 26 units away, so at the golden hour the
 * ground at a wall's foot never reached full occlusion (it ramped over ~2.2 world units of
 * lawn — `0.33 / sin 8.6°`, the kernel's own projected length), and at noon a lamp post's
 * post, crook and head all washed out at 6.4 texels because the *whole* shadow is 1.2 units
 * long.
 *
 * ── What this installs: PCSS, with a comparison sampler that will not return a depth ─────
 * The fix is the one every note in this repo has been pointing at: the penumbra has to be
 * **per pixel**, and set by that pixel's own distance to the blocker above it. That is PCSS,
 * and PCSS wants a *depth value* out of the shadow map. three's PCF map is a
 * `sampler2DShadow` — `WebGLShadowMap` sets `compareFunction` on the depth texture — and
 * reading a comparison texture through a plain `sampler2D` does not return a number, it
 * **drops the whole draw call silently** (DECISIONS #43 paid a round for that one). We do not
 * own `core/render.js` and cannot turn the comparison off without taking the free hardware
 * 2×2 filtering, and `castShadows.js`'s own read of the map, down with it.
 *
 * So the blocker distance is **probed rather than read**. A comparison sampler will not say
 * "the blocker is at 0.31"; it answers "is the blocker nearer to the light than *this*?" as
 * often as you like. Probe a ladder of references marching from the receiver toward the light
 * and count how many rungs come back lit, and the count *is* the distance:
 *
 *      texture( map, vec3( uv, z − t ) ) == 1  ⟺  t ≥ (z − blockerDepth) = d
 *
 * so for a ladder `t = Δ, 2Δ … KΔ` a tap's lit-count is `K − d/Δ`. Sum that over the search
 * taps and one accumulator carries `Σd` for the whole disk; a second accumulator (the ladder's
 * own `t = 0` rung) carries how many of those taps were blockers at all. Two sums, one
 * division, and no depth value ever leaves the sampler:
 *
 *      Σ blockers  d  =  Δ · ( N·K − Σ lit )        avg d = that / blockerCount
 *
 * Every rung is still a hardware `sampler2DShadow` fetch under `LinearFilter` — a free 2×2
 * comparison — so the rungs come back *fractional* near an edge and the estimate is smooth
 * rather than quantised to the K+1 levels a naive count would give.
 *
 * The penumbra is then `MIN_TEXELS + (max − MIN_TEXELS) · d/dSat`, i.e. linear in the blocker
 * distance and saturating at `LightShadow.radius`, which this file now reads as **the widest
 * penumbra this hour** rather than as the only one. Ladder pitch Δ is derived from that same
 * pair so the rungs always span exactly the distance range the ride can express: no rung is
 * ever spent on a distance whose penumbra is already clamped.
 *
 * ── The three numbers, and where they came from ──────────────────────────────────────────
 *   · `MIN_TEXELS` 2.0 — the penumbra of a shadow touching its caster. Not 0, and the sizing is
 *     arithmetic rather than taste: at `fov 26°`, a 30-unit camera distance and `pixelScale 3`,
 *     one world unit is about 26 internal pixels at 1080p, so a shadow-map texel (0.0273 units)
 *     is **0.7 of an internal pixel**, or two screen pixels. 2.0 texels is therefore a 1.4-pixel
 *     penumbra at the internal resolution — the narrowest edge that still resamples as an edge.
 *     Anything under ~1.5 is the round-6 razor again and shimmers on a moving camera.
 *   · `SLOPE_TEXELS_PER_UNIT` 0.42 — how fast it opens. Fixed by the two crops round 7 already
 *     had: a canopy at the golden hour sits `4 / sin 8.6° ≈ 26` units above the far end of its
 *     own shadow, and `2.0 + 0.42 × 26 = 12.9` is round 7's golden-hour width. The same
 *     constant puts a bench at noon (`0.6 / sin 60° = 0.7` units of blocker distance) at 2.3
 *     texels instead of 6.4, which is the "thin casters wash out at noon" defect.
 *   · `RPDB_SLOPE_PER_TEXEL` 0.003, down from round 7's 0.004. See below.
 *
 * ── A receiver-plane depth bias, and why its ceiling moved ───────────────────────────────
 * Three compares all of its taps against the receiver's depth at the centre of the kernel, so
 * on a surface tilted away from the light every uphill tap reads as occluded and the surface
 * self-shadows. `dFdx`/`dFdy` of the shadow coordinate give `∂z/∂u` and `∂z/∂v` from a 2×2
 * solve, and each tap tests `z + dot(∂z/∂uv, offset)`. The blocker search needs it *more* than
 * the PCF does: without it every tap on the uphill half of a 12-texel disk reads the receiving
 * ground itself as a blocker at distance ≈ 0, and the estimate collapses to `MIN_TEXELS`
 * everywhere — a hard shadow with extra steps.
 *
 * Two details are load-bearing. The derivatives are taken **before** the frustum test, because
 * a `dFdx` inside non-uniform control flow is undefined for any quad that straddles the edge
 * of the shadow box. And the fitted slope is **clamped per texel of offset**: at a screen-space
 * depth discontinuity the 2×2 quad's derivative is the whole jump between two surfaces rather
 * than one receiver's plane, and an unclamped fit peter-pans the kernel clean off the caster.
 *
 * Round 7 clamped at 0.004 normalised depth per texel — flat ground under a sun 2.3° up. The
 * round-7 critic priced that: the shadow camera runs `near 0.5` to `far 168`, so one unit of
 * `shadowCoord.z` is 167.5 world units, and `0.004 × 12 texels × 167.5` is **8 world units** of
 * depth push at the edge of a golden-hour kernel. It now clamps at **0.003**, which is flat
 * ground at 3.4° — `KEY_ELEVATION_FLOOR`, the shallowest key `index.js` will ever set — so a
 * real receiver is still never clipped and the runaway case is clipped 25 % harder. The rest of
 * that 8 units went away on its own: the push scales with `|offset|`, and PCSS *is* the thing
 * that makes `|offset|` small exactly where a contact shadow lives.
 *
 * ── Why a chunk override and not a change to `core/render.js` ────────────────────────────
 * Folder ownership (ARCHITECTURE §1): `src/core/` is the integrator's. §2.7 says the pipeline
 * is "owned by core, **tuned** by environment", and this is a tune written at runtime, exactly
 * like the per-hour `shadow.bias`/`normalBias` pair `index.js` already writes onto the light.
 * **Open:** this belongs in `render.js` rather than here, and it should stop asking for a
 * deprecated constant. Until someone moves it, it lives here, and every part of it is
 * *reversible from a URL* so it can be A/B'd without a code change:
 *
 *     ?envNoShadowFilter=1   three's own 5-tap kernel, the round-6 rig
 *     ?envNoPcss=1           round 7 exactly: one penumbra width per frame, no blocker search
 *     ?envShadowTaps=N       PCF taps (24)
 *     ?envPcssSearch=N       blocker-search taps (8)
 *     ?envPcssRungs=K        ladder rungs per search tap (5)
 *     ?envPcssMin=T          penumbra in texels at zero blocker distance (2.0)
 *     ?envPcssSlope=T        texels of penumbra per world unit of blocker distance (0.42)
 *     ?envRpdbSlope=S        receiver-plane clamp, normalised depth per texel (0.003)
 *     ?envNoRpdb=1           receiver-plane bias off entirely
 *
 * ── One latent hazard, named rather than fixed ──────────────────────────────────────────
 * `getShadow( sampler2DShadow … )` is the PCF branch's shadow lookup for **directional AND
 * spot** lights, and the ladder pitch is calibrated against the SUN's orthographic depth range
 * (167.5 world units). A spot light's shadow camera is perspective, so its `shadowCoord.z` is
 * not linear in distance and the rung pitch would mean something different at every depth — the
 * penumbra estimate would be nonsense. Nothing in this game casts from a spot today
 * (`lamps.js` registers point lights and glow quads, never a shadow-casting spot), so this is
 * latent. If one is ever added, this filter needs a per-light calibration, not a constant.
 */

import * as THREE from 'three';

/** `?envShadowTaps=N` and friends — the knobs this filter is worth sweeping on. */
function devNum(name, fallback) {
  try {
    const v = new URLSearchParams(location.search).get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}

/**
 * Samples per shadow lookup, at the final per-pixel radius.
 *
 * The count buys exactly one thing — the dither — because the standard error of a coverage
 * estimate falls as `1/sqrt(n)`: 0.45 at three's 5 taps, 0.29 at 12, 0.20 at 24, 0.18 at 32.
 * Swept in DECISIONS #52(c) over the golden-hour lawn, measuring high-frequency energy:
 *
 *      taps      5      12      24      32        radius 1 (the old hard shadow)
 *      hf     2.874   2.440   2.301   2.282       2.804
 *
 * 24 → 32 buys 0.019 and is not visible; 12 still carries 0.14 of dither over 24. So 24.
 */
const TAPS = Math.max(4, Math.min(64, Math.round(devNum('envShadowTaps', 24))));

/**
 * Blocker-search taps, and ladder rungs per tap. `SEARCH × (RUNGS + 1)` fetches.
 *
 * 8 × 6 = 48, on top of the 24 the PCF spends: 72 where round 7 spent 24. Priced first, before
 * any of this was written, by sweeping round 7's own `?envShadowTaps` at 1920×1080 on
 * `city/high-street/17.5` — 24 / 48 / 72 / 96 taps measured **p95 16.7 / 16.7 / 16.8 / 16.8 ms**
 * at 60 fps throughout. Read that for exactly what it is: the frame is **vsync-locked**, so a
 * p95 frame *interval* cannot resolve the GPU cost of a shader — 96 taps reads the same 16.8 as
 * 72. What it does establish is that four times the fetch count does not break the lock, so the
 * §7 budget (≥ 50 fps, p95 ≤ 20 ms) is met with headroom nobody has measured the bottom of. At
 * `pixelScale 3` the shadow lookup runs at 640×360, which is why that is unsurprising.
 */
const SEARCH = Math.max(4, Math.min(32, Math.round(devNum('envPcssSearch', 8))));
const RUNGS = Math.max(2, Math.min(16, Math.round(devNum('envPcssRungs', 5))));

/** Penumbra in shadow-map texels where the shadow touches its caster, and how fast it opens. */
const MIN_TEXELS = Math.max(0.25, devNum('envPcssMin', 2.0));
const SLOPE_TEXELS_PER_UNIT = Math.max(0.02, devNum('envPcssSlope', 0.42));

/**
 * Ceiling on the fitted plane slope, in normalised shadow depth per shadow-map texel.
 *
 * Flat ground under a sun `e` above the horizon has a slope of `texel · cot(e) / depthRange`
 * per texel: 0.0011 at 8.6°, 0.0027 at 3.4° — the floor `KEY_ELEVATION_FLOOR` puts on the key.
 * 0.003 is just above that floor, so a real receiver is never clipped at any hour the game can
 * reach, and a silhouette's runaway derivative always is.
 */
const RPDB_SLOPE = devNum('envNoRpdb', 0) === 1 ? 0 : Math.max(0, devNum('envRpdbSlope', 0.003));

/** `?envNoPcss=1` — one width per frame, which is round 7 exactly. The A/B control. */
const PCSS = devNum('envNoPcss', 0) !== 1;

/** Marker so `installed()` can prove the chunk in the compiled program is this one. */
const MARK = 'ENV_SHADOW_FILTER_V2_PCSS';

/**
 * Normalised shadow depth per world unit — `1 / (far − near)` of the sun's ortho shadow
 * camera. Read off the light at install time rather than hardcoded, because it is the one
 * number in here that belongs to `core/render.js` (`cam.near = 0.5; cam.far = extent * 3`)
 * and a core change to `config.shadowExtent` would otherwise silently rescale every blocker
 * distance this file measures. 1/167.5 on the shipping rig.
 */
let depthPerWorld = 1 / 167.5;

function f(n) { return Number(n).toFixed(6); }

function pcfSource() {
  // `?envNoPcss=1`: the round-7 kernel, one width per frame, so the whole of this round is
  // one URL parameter apart from its control.
  const searchBlock = PCSS ? /* glsl */`
				// ── blocker search ───────────────────────────────────────────────────────
				// A comparison sampler will not hand back a depth, so the distance is probed:
				// a rung at reference z-t comes back lit exactly when t has reached past
				// the blocker. Counting lit rungs over the disk gives the blocker distance
				// summed over the taps, and the t=0 rung gives how many taps were blockers.
				float span = max( maxTexels - ${f(MIN_TEXELS)}, 0.05 );
				float rung = ( span / ${f(SLOPE_TEXELS_PER_UNIT)} ) * ${f(depthPerWorld)} / float( ${RUNGS} );
				float searchR = maxTexels * texelSize.x;

				float litAtReceiver = 0.0;
				float rungSum = 0.0;

				for ( int i = 0; i < ${SEARCH}; i ++ ) {

					vec2 off = vogelDiskSample( i, ${SEARCH}, phi ) * searchR;
					float lim = slopeMax * length( off );
					float zr = z0 + clamp( dot( dzduv, off ), - lim, lim );
					vec2 uv = sc.xy + off;

					litAtReceiver += texture( shadowMap, vec3( uv, zr ) );
					for ( int j = 1; j <= ${RUNGS}; j ++ ) {
						rungSum += texture( shadowMap, vec3( uv, zr - float( j ) * rung ) );
					}

				}

				float blockers = float( ${SEARCH} ) - litAtReceiver;

				// Nothing in the search disk occludes: the pixel is lit, and the PCF below
				// would spend 24 taps proving it. It is NOT returned as fully lit, because a
				// caster thinner than the gap between search taps can slip through - a lamp's
				// crook is about seven texels and eight taps over a twelve-texel disk sit
				// about seven apart. The tightest kernel finds it if it is there, and the
				// tightest kernel is also the right answer for a caster that close.
				float depthFrac = blockers < 0.02 ? 0.0
					: clamp( ( float( ${SEARCH} * ${RUNGS} ) - rungSum ) / ( blockers * float( ${RUNGS} ) ), 0.0, 1.0 );

				radiusTexels = ${f(MIN_TEXELS)} + span * depthFrac;
`
    : /* glsl */`
				radiusTexels = maxTexels;   // ?envNoPcss=1 - round 7's one-width-per-frame
`;

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
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				float z0 = sc.z + shadowBias;
				// Per-texel ceiling on the plane fit, in the kernel's own units.
				float slopeMax = float( ${f(RPDB_SLOPE)} ) / texelSize.x;
				// LightShadow.radius is the WIDEST penumbra this hour, not the only one.
				float maxTexels = max( shadowRadius, ${f(MIN_TEXELS)} );
				float radiusTexels;
${searchBlock}
				// ── the shadow itself, at this pixel's own penumbra ──────────────────────
				float radius = radiusTexels * texelSize.x;
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
 * @param {THREE.WebGLRenderer} renderer
 * @param {{warn?:(s:string)=>void}} [log]
 * @param {{shadowCamera?:{near:number, far:number}}} [opts]
 *   the sun's ortho shadow camera, so the blocker ladder is calibrated in world units
 *   against core's own `near`/`far` instead of against a copy of them.
 * @returns {{ installed: boolean, why?: string, taps?: number }}
 */
export function installShadowFilter(renderer, log, opts) {
  try {
    const cam = opts?.shadowCamera;
    const range = cam ? Number(cam.far) - Number(cam.near) : NaN;
    if (Number.isFinite(range) && range > 1) depthPerWorld = 1 / range;

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

/** What the filter is doing, for `window.__ENVSHADOW__()`. */
export function shadowFilterInfo() {
  return {
    pcss: PCSS,
    taps: TAPS,
    searchTaps: PCSS ? SEARCH : 0,
    rungs: PCSS ? RUNGS : 0,
    fetchesPerPixel: TAPS + (PCSS ? SEARCH * (RUNGS + 1) : 0),
    minTexels: MIN_TEXELS,
    texelsPerWorldUnit: SLOPE_TEXELS_PER_UNIT,
    rpdbSlopePerTexel: RPDB_SLOPE,
    depthRangeWorld: +(1 / depthPerWorld).toFixed(2),
  };
}

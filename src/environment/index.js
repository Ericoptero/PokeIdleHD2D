/**
 * environment — sky, sun, weather and the per-time-of-day grade (ARCHITECTURE §5.3).
 *
 * The sun is placed from a real solar-position formula at a fictional latitude, so its
 * direction and the length of every shadow change through the day the way they do outdoors.
 * That, and not an orange filter, is what makes the golden hour in docs/refs/04 read as
 * light falling on a place.
 *
 * ── What this module writes ──────────────────────────────────────────────────────────────
 *   scene.fog                the only "air" the player ever sees — see the note below
 *   three.sun                direction, colour, intensity, and the shadow bias that a
 *                            grazing sun needs and a noon sun does not
 *   hemisphere + ambient     the sky/ground fill, kept small and strongly coloured
 *   bounce + camFill         two shadowless directional fills — the anti-sun bounce and the
 *                            camera-axis fill. See presets.js, "why two fills".
 *   three.view.grade         lift / gain, the display-space half of the look
 *   config                   exposure, contrast, saturation, bloom, vignette, grain
 *
 * ── Why fog carries the atmosphere ───────────────────────────────────────────────────────
 * The camera is locked at 45° below horizontal with a 26° fov (§2.7), so the horizon is
 * *never* in frame: from 32° to 58° below level, every ray hits ground. The sky dome only
 * ever shows through gaps. All perceived distance and all "air" therefore has to come from
 * `FogExp2`, whose colour we allow to exceed 1.0 in linear space (`fogBoost`) so that far
 * geometry glows and crosses the bloom threshold by itself.
 */

import * as THREE from 'three';
import { solarPosition, kelvinToRGB, DAY_OF_YEAR } from './sky.js';
import { PRESETS, blendPreset, applyWeather, WEATHERS } from './presets.js';
import { makeLamps } from './lamps.js';
import { makeCasterPolicy } from './casters.js';
import { makeWeather } from './weather.js';
import { makeCastShadows } from './castShadows.js';
import { installShadowFilter, shadowFilterInstalled, SHADOW_FILTER_TAPS, shadowFilterInfo } from './shadowFilter.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uGround, uSunColor, uSunDir, uGlow;
uniform float uSunSize, uSunIntensity, uHaze, uStars, uMoon;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 31.71;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;

  // Sky: horizon band widened by haze, ground below it.
  float t = clamp(up, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(t, 0.42 + uHaze * 0.45));
  sky = mix(sky, uGround, smoothstep(0.0, -0.16, up));

  // Stars first, so the sun and its aureole paint over them.
  if (uStars > 0.001 && up > -0.05) {
    float band = smoothstep(0.0, 0.30, up);
    // Two densities: a sparse bright layer and a dense faint one, which is what stops a
    // star field reading as salt on a tablecloth.
    vec3 c1 = floor(d * 210.0);
    float s1 = hash3(c1);
    float big = smoothstep(0.9982, 0.99995, s1);
    vec3 c2 = floor(d * 460.0);
    float s2 = hash3(c2 + 3.7);
    float small = smoothstep(0.9975, 1.0, s2) * 0.34;
    float tint = hash3(c1 + 11.0);
    vec3 starCol = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.92, 0.78), tint);
    sky += starCol * (big + small) * uStars * band;
  }

  // A twilight wash toward the sun's azimuth, alive even after the disc has set. This is
  // most of what "dusk" looks like from under a 45 degree camera.
  float az = max(0.0, dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))));
  sky += uGlow * pow(az, 3.0) * (1.0 - smoothstep(0.0, 0.5, abs(up)));

  // Sun (or moon) disc plus its aureole; the aureole is what sells depth at low angles.
  float cosA = dot(d, normalize(uSunDir));
  float disc = smoothstep(1.0 - uSunSize * 1.7, 1.0 - uSunSize * 0.45, cosA);
  float glow = pow(max(cosA, 0.0), 260.0) * 0.55 + pow(max(cosA, 0.0), 11.0) * 0.18;
  sky += uSunColor * (disc * uSunIntensity * 7.0 + glow * uSunIntensity);
  // The moon keeps a hard rim instead of an aureole.
  sky += uSunColor * disc * uMoon * 2.2;

  gl_FragColor = vec4(max(sky, 0.0), 1.0);
}
`;

/**
 * Verification toggles, read once from the URL.
 *
 * These exist so an A/B is a *URL* change and not a code change: the harness freezes the
 * clock and disables the cache (#24), so two captures one flag apart are the same frame with
 * exactly one thing moved, and a claim about what a light is doing can be *shown*. They are
 * read straight from `location.search` because `core/config.js` only accepts keys it
 * declares, and none of these belong in the shipped tunables.
 *
 *   ?envNoShadow=1   the sun/moon stops casting — is that dark quad a shadow or a decal?
 *   ?envNoConeBend=1 the night key goes back on the moon's raw antipode azimuth, so the
 *                    shadow is behind its caster again — the control for DECISIONS #46a.
 *   ?envNoPool=1     lamp point lights off
 *   ?envNoDecal=1    lamp ground pools off
 *   ?envNoFills=1    bounce + camFill off
 *   ?envNoCast=1     projected sprite shadows off — is that shadow the character's own?
 *   ?envNoShadowClamp=1  a projected shadow stops asking the shadow map whether the sun had
 *                    already left this ground — how much of the black was compounding?
 *   ?envDumpCasters=1 `window.__ENVCASTERS__()` lists every object the shadow pass will
 *                    rasterise, with the `side`/`shadowSide`/`alphaTest` that decide what
 *                    shape its shadow is.
 *   ?envCasterOff=tree,pine   drop named objects out of the shadow pass — the bisection that
 *                    answers "what casts that slab?" (round 6: it is the trees).
 *   ?envBiasMul=N / ?envNormalBiasMul=N   sweep the shadow bias pair.
 *   ?envMinElevDeg=N  raise the key's elevation floor, so the shadow run is capped at
 *                    `cot(N)` caster-heights. Measured and NOT shipped — see DECISIONS #48.
 *   ?envShadowIntensity=N  how much of the shadow map's shadow is applied (three's
 *                    `LightShadow.intensity`). Also measured and not shipped.
 *   ?envTune=contrast:1.12,lift:0x2a2f3c   the grade, from the URL.
 *   ?envNoCasterFix=1  the caster policy off, so an object `city` or `hunts` kept out of the
 *                    shadow map stays out — the A/B for DECISIONS #54(e), and the control
 *                    that proves `city/high-street/21` is byte-identical to #48's frame.
 *   ?envNoPcss=1     the penumbra goes back to one width per frame — round 7 exactly. With
 *                    `&envNoCasterFix=1&envRpdbSlope=0.004` it is the whole of round 8's
 *                    control, which is how #54's matrix A/B was taken.
 *   ?envShadowTaps=N / ?envPcssSearch=N / ?envPcssRungs=K / ?envPcssMin=T / ?envPcssSlope=T
 *   ?envRpdbSlope=S / ?envNoRpdb=1        the whole shadow filter, swept from the URL — see
 *                    shadowFilter.js for what each one buys and what it was measured at.
 *
 * Every one defaults to the shipping behaviour, so a normal load is unaffected.
 */
function devFlag(name) {
  try { return new URLSearchParams(location.search).get(name) === '1'; } catch { return false; }
}

/**
 * The numeric half of the same idea. A boolean flag answers "is this term responsible?";
 * a multiplier answers "how much of it, and does more of it help?" — which is the question
 * the shadow bias pair needs, because a bias that is too small acnes and one that is too
 * large peter-pans, and only a sweep tells you which side of that you are on.
 *
 *   ?envBiasMul=8  ?envNormalBiasMul=8   scale the depth / normal offsets written per frame
 */
function devNum(name, fallback) {
  try {
    const v = new URLSearchParams(location.search).get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}

/**
 * `?envTune=contrast:1.12,lift:0x2a2f3c` — the whole grade, from the URL.
 *
 * `environment.tune()` already exists for this (ARCHITECTURE §5.3), but the screenshot
 * harness has no hook that reaches a module API, so tuning by hand meant editing
 * `presets.js` once per variant — which is a code change per data point, and a code change
 * cannot be A/B'd against itself in the same minute. Values starting `0x` are colours; the
 * rest are numbers. Applied last, over the preset and the weather, exactly like `tune()`.
 */
function urlTune() {
  try {
    const v = new URLSearchParams(location.search).get('envTune');
    if (!v) return null;
    const out = {};
    for (const pair of v.split(',')) {
      const [k, raw] = pair.split(':');
      if (!k || raw == null) continue;
      out[k.trim()] = raw.trim().startsWith('0x') ? new THREE.Color(Number(raw)) : Number(raw);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** `?envBiasMul` / `?envNormalBiasMul` — the shadow-bias sweep. 1 is the shipping rig. */
const URL_TUNE = urlTune();
const BIAS_MUL = devNum('envBiasMul', 1);
const SHADOW_INTENSITY = devNum('envShadowIntensity', 1);
const NORMAL_BIAS_MUL = devNum('envNormalBiasMul', 1);
/**
 * `?envShadowRadius=N` pins the penumbra; `NaN` (the shipping path) runs the curve below.
 *
 * `LightShadow.radius` defaults to **1**, and nothing in this project had ever set it — which
 * is the whole of "the shadows are hard". One texel of a 2048 map over a 56-unit ortho box is
 * `56 / 2048 = 0.0273` world units, a thirty-sixth of a tile, so every shadow in the game had
 * an edge one screen pixel wide at any zoom a player will ever see. `ARCHITECTURE` §2.7 asks
 * for `PCFSoftShadowMap` and `core/render.js` sets it, but three r185 deprecated that constant
 * and silently substitutes `PCFShadowMap` (`WebGLShadowMap.js:99`), whose kernel is
 * `shadowRadius * texelSize` — so the requested soft filter has been a one-texel one all along.
 */
const SHADOW_RADIUS = devNum('envShadowRadius', NaN);

/**
 * How wide the penumbra is, in shadow-map texels, at a given key elevation.
 *
 * A penumbra is set by how far the shadow has travelled from the thing that casts it, and in
 * this game that distance is set almost entirely by the hour: at noon a bench's shadow lies
 * at its own feet, at 17:30 the same 8.6-degree sun throws a tree 6.6 caster-heights across
 * the lawn. One constant radius therefore cannot serve both, and both failures were shot
 * (`docs/progress/environment/r7/sweep/`):
 *
 *   · at 12 texels the *golden hour* is right — `crop-f-lawn-r12.png` — and noon is wrong:
 *     `crop-bench-f12.png` has the bench's shadow blurred down to a faint smudge, because
 *     0.33 world units of blur across a shadow only 1.2 units long is most of the shadow.
 *   · at 6 texels *noon* is right — `crop-bench-f6.png` keeps the shadow's shape with a soft
 *     edge — and the golden hour keeps more of its corduroy than it should.
 *
 * So the radius rides the key's elevation, linearly in `graze = 1 - sin(elevation)`, through
 * the two points those two crops picked: 6.4 texels at noon's `graze` of 0.45, 12 at the
 * golden hour's 0.85. The ends are clamped — 5 is the softest a *short* shadow can take
 * before it stops reading as a shadow at all, and 14 is where the far end of a raked one
 * starts to smear rather than soften.
 *
 * Note what this is *not*: it is not the missing per-pixel contact hardening. A real filter
 * would widen with each pixel's own blocker distance, which needs a depth *value* and three's
 * PCF map is a comparison sampler that will not give one (castShadows.js has the note on what
 * reading one through a `sampler2D` costs). This is the frame-wide average of that, and it is
 * chosen by looking at two crops rather than derived, because the derivation is wrong: the
 * kernel is a disk in the shadow map, and projection onto flat ground already stretches it by
 * `1 / sin(elevation)` along the shadow's run for free. Only the width *across* the run —
 * which is what makes a bar a bar — needs this.
 */
function shadowRadiusFor(sunY) {
  if (Number.isFinite(SHADOW_RADIUS)) return SHADOW_RADIUS;
  const graze = 1 - Math.max(0, Math.min(1, sunY));
  return Math.max(5, Math.min(14, 5 + 14 * (graze - 0.35)));
}

/** Set by `init`, read by `frame`. One environment per page, so one reference is enough. */
let activeFx = null;

/**
 * Camera-axis fill direction (§2.7 pins the camera at 45° south of the focus).
 *
 * Deliberately far *shallower* than the camera, and the number is chosen by a ratio rather
 * than by where light comes from. This fill has exactly one job: the front of an upright
 * sprite card, whose normal is `(0, 0.778, 0.628)` (pokemon/field.js). Its enemy is the
 * floor, because every unit of light that lands on the floor is a unit the shadow no longer
 * shows.
 *
 *      elevation   sprite front   tile wall*   flat floor   sprite : floor
 *      38° (r2)        0.975         0.960        0.620          1.6
 *      10.4° (r3)      0.758         0.980        0.180          4.2
 *      (* a tile's near-vertical face, whose normal `tiles` clamps to 22° above horizon)
 *
 * At 10.4° the fill can be tripled — which is what stops a subject sinking below its own
 * ground when the sun goes low — and the light reaching the *floor* still falls. Both halves
 * of the round-2 note ("shadows shallowest exactly when they should be deepest", "subjects
 * darken to 0.72× noon while their own ground holds 0.88×") are this one number, because
 * both are about how much of a fill lands on a floor that the sun has already left.
 *
 * The reason a subject needs this at all is geometric: a sprite card's normal is 51° up, so
 * an overhead sun gives it *more* than the floor (0.99 against 0.87 at noon) and a grazing
 * one gives it *less* (0.14 against 0.17 at 17:30). The subject therefore loses a third of
 * its key, relative to the ground it stands on, between noon and the golden hour — and
 * nothing that lights the floor can give it back.
 */
const CAM_FILL_DIR = { y: 0.180, z: 0.9837 };
/**
 * Elevation of the anti-sun bounce fill, as a sine.
 *
 * 0.18 is 10.4 degrees above the horizon, and the number is chosen by the *ratio* it buys
 * rather than by where a real bounce comes from. This fill exists for one job: the facet the
 * key has turned its back on — the Mart's west hip at 08:00, the wall behind a hedge at
 * 17:30. A vertical wall takes `cos(elevation)` of it and a flat floor `sin(elevation)`, so
 * at 10.4° the wall keeps 0.98 and the floor takes only 0.18.
 *
 * Its *magnitude* is the number round 3 cut, and hard: 2.80 at the golden hour down to 0.95.
 * A bounce is warm, and at 2.80 it was the largest single term in the shadowed ground — 59%
 * of the red in it — which is why a frame with a warm key also had warm shadows and every
 * hue in it collapsed onto the sun's. The blue hemisphere is the shadow's colour now and the
 * bounce only rescues the facets that have no key at all; `docs/progress/environment/r3/
 * ab-nofills-17.5.png` is the same frame with both fills off, and what goes black in it is
 * exactly what the bounce is for.
 */
const BOUNCE_ELEVATION = 0.18;
/**
 * How close to the horizon the key light is allowed to get, as a sine. A light exactly on
 * the horizon takes zero diffuse off every up-facing surface, which is a black world; 0.06
 * is 3.4°, low enough that shadows still run 17× the caster's height.
 */
/** Ceiling on the brightness the elevation soft-cap is allowed to hand back (DECISIONS #40). */
const TILT_GAIN_MAX = 1.9;
/**
 * Floor on the same ratio, and it is 1 unless `?envMinElevDeg` is raising the key.
 *
 * #40's rule is `key *= sin(trueAltitude) / sin(shownAltitude)`: whatever the tilt does to
 * `dot(N, L)` on a horizontal surface, the key intensity undoes. It was clamped at 1 because
 * the only thing that had ever moved `shownAltitude` was the soft *cap*, which lowers it, so
 * the ratio was never below 1 and the clamp cost nothing. The `envMinElevDeg` sweep moves it
 * the other way, and with the clamp still at 1 a shorter shadow would also be a brighter
 * frame and the sweep would be measuring two things at once. It stays at 1 when the flag is
 * off, because at sunset `trueAltitude` is clamped to 0 and the ratio with it, and a floor
 * below 1 there would take 55 % of the key off the sunset frame.
 */
const MIN_ELEV_DEG = devNum('envMinElevDeg', 0);
const KEY_ELEVATION_FLOOR = MIN_ELEV_DEG > 0 ? Math.sin(MIN_ELEV_DEG * (Math.PI / 180)) : 0.06;
const TILT_GAIN_MIN = MIN_ELEV_DEG > 0 ? 0.35 : 1;

/**
 * Half-angle of the cone, measured from due north, in which a shadow is hidden behind the
 * card that casts it (DECISIONS #46a). It is the same 38 degrees `config.sunAzimuthOffset`
 * bends the sun by, because it is the same fact: this camera looks north, so a shadow that
 * runs due north runs straight up-screen behind its own caster.
 */

/**
 * Pushes the *night* key's azimuth out of that cone.
 *
 * DECISIONS #40 bent the sun by a constant +38 degrees, which clears the cone at the two
 * moments the source crosses the meridian — solar noon and solar midnight — and nowhere
 * else. The shadow azimuth sweeps continuously through the whole day, so it still passes
 * through due north twice: around 10:30 for the sun and around 22:00 for the moon. The
 * moon's pass is the one three modules filed, because it is four and a half hours wide
 * (19:30 to past midnight) and it covers `tod 21`, the hour every night frame is shot at:
 * at 21 the shadow's lateral component is 0.29 and its run 1.7, so it reads as a dark halo
 * stuck to the sprite rather than as a shadow lying on the ground.
 *
 * The remap is `sign(a) * 90 * (|a| / 90) ^ P` on the shadow's azimuth `a` measured from
 * due north. It is monotone, continuous, fixes 0 and +/-90, and steepens near 0, so the
 * source still sweeps the sky in the right direction and at the right speed while spending
 * far less of the night behind the caster. It cannot *remove* the pass — a shadow that
 * swings from one side of a caster to the other has to go behind it once, and any
 * continuous function of the azimuth has to cross the cone — so this compresses the window
 * from about 4.7 game-hours to about 1.0 (computed, not shot: `|a| < 38 deg` becomes
 * `|a| < 7.7`; the shot is the `?envNoConeBend=1` A/B at tod 21).
 *
 * The **day is deliberately untouched**. Its arc is the one DECISIONS #40 paid for with a
 * blind round, and noon, 08:00 and 17:30 are the frames every other module has tuned
 * against; re-bending them to fix a night defect is a trade nobody asked for.
 */
const NIGHT_AZ_POWER = 0.35;

function pushOutOfCone(x, z) {
  // The shadow runs away from the light. Azimuth measured clockwise from north, signed so
  // that 0 is straight up-screen (hidden) and +/-90 is straight across it (fully visible).
  const sx = -x, sz = -z;
  const h = Math.hypot(sx, sz);
  if (h < 1e-6) return { x, z };
  const a = Math.atan2(sx / h, -sz / h);
  const mag = Math.abs(a);
  // Beyond 90 degrees the shadow already runs toward the camera and is never hidden; the
  // remap is mirrored there so it stays monotone across the whole circle instead of
  // folding back on itself.
  const t = mag <= Math.PI / 2 ? mag : Math.PI - mag;
  const bent = (Math.PI / 2) * Math.pow(t / (Math.PI / 2), NIGHT_AZ_POWER);
  const outMag = mag <= Math.PI / 2 ? bent : Math.PI - bent;
  const out = Math.sign(a || 1) * outMag;
  // Back to a direction *toward* the light, which is the shadow's azimuth turned 180.
  const la = out + Math.PI;
  return { x: Math.sin(la) * h, z: -Math.cos(la) * h };
}

/**
 * How bright one practical is, at the point it lights, relative to everything that is not
 * that practical. `practicalMul = fill / (fill + lamp)`, so 1.15 puts an indoor character's
 * shadow at about 0.47 — half the light gone, not all of it.
 *
 * The alternative was to reuse the sun's `shadowMul` indoors, and that is exactly what round
 * 3 shipped: the cave preset runs a key of 5.20 against a hemisphere of 0.50, so the ratio
 * lands near 0.09 and every character stamped a near-black dart on the floor. A lantern is
 * not the sky. It also matters that this is per channel: the bulbs are warm and the fill is
 * not, so the blue channel loses least and the shadow comes out cooler than the floor, which
 * is what a warm light on a cool room actually does.
 */
const PRACTICAL_KEY_RATIO = 0.95;

/** Phase names carried on `tod:changed` (ARCHITECTURE §4). Pinned to the solar events. */
function phaseOf(t) {
  if (t < 4.6 || t >= 19.6) return 'night';
  if (t < 6.3) return 'dawn';
  if (t < 8.6) return 'morning';
  if (t < 16.2) return 'day';
  if (t < 18.4) return 'goldenHour';
  return 'dusk';
}

export default {
  id: 'environment',
  needs: [],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['tiles', 'terrain'],

  init(ctx) {
    const { config, bus, three, log, rng } = ctx;
    const scene = three.scene;
    const noShadow = devFlag('envNoShadow');
    const noFills = devFlag('envNoFills');
    const lampDev = { noPool: devFlag('envNoPool'), noDecal: devFlag('envNoDecal') };
    if (noShadow) three.sun.light.castShadow = false;

    /**
     * The sun's penumbra, installed before the first frame because programs compile lazily
     * at first render and `environment` cannot reach another module's materials to mark them
     * dirty afterwards. `?envNoShadowFilter=1` leaves three's own 5-tap filter in place, so
     * the whole change is one URL parameter apart. See shadowFilter.js.
     */
    // The blocker ladder is calibrated in world units, so it needs the sun's ortho depth
    // range — and at `init` the shadow camera is still three's untouched default (0.5..500),
    // because `core/render.js` writes `cam.near = 0.5; cam.far = extent * 3` from inside
    // `sun.update()`, which main.js first calls *after* `registry.frame()` on frame one.
    // Reading it now would bake a 499.5-unit range against a real 167.5 and every blocker
    // distance this filter measures would come out three times short. So core is asked to
    // fill its own camera in first: `sun.update` is idempotent and main.js calls it again
    // with the real focus a moment later, and this way the range is core's own arithmetic
    // rather than a copy of it here that a change to `config.shadowExtent` could desync.
    three.sun.update({ x: 0, y: 0, z: 0 });
    const shadowFilter = devFlag('envNoShadowFilter')
      ? { installed: false, why: '?envNoShadowFilter=1' }
      : installShadowFilter(three.renderer, log, { shadowCamera: three.sun.light.shadow.camera });
    if (!shadowFilter.installed && !devFlag('envNoShadowFilter')) {
      log?.warn?.(`environment: soft shadow filter not installed — ${shadowFilter.why}`);
    }

    /**
     * `?envDumpCasters=1` — every object the shadow pass will actually rasterise, with the
     * three properties that decide *which face* of it lands in the depth buffer. three.js
     * renders a `FrontSide` material into the shadow map as `BackSide` unless the material
     * names its own `shadowSide`, so a single-sided card is culled out of the map entirely
     * and a single-sided box casts from its far wall. Guessing which of those a tile is
     * costs a round; reading it costs a URL.
     */
    /**
     * `?envCasterOff=lake,tall_grass` — drop named objects out of the shadow pass so the
     * question "which caster is that slab?" is answered by bisection instead of by staring.
     * Matching is a substring of the object's name, which is the tile model id, so one term
     * takes out a whole tile family.
     */
    const casterOff = (() => {
      try {
        const v = new URLSearchParams(location.search).get('envCasterOff');
        return v ? v.split(',').map((t) => t.trim()).filter(Boolean) : null;
      } catch { return null; }
    })();
    if (casterOff) {
      // The scene is built after `environment.init` (it needs `terrain`, which needs
      // `tiles`), so this has to run on a frame rather than now.
      const applyCasterOff = () => {
        scene.traverse((o) => {
          if (o.castShadow && casterOff.some((t) => (o.name || '').includes(t))) o.castShadow = false;
        });
      };
      setTimeout(applyCasterOff, 1500);
      setTimeout(applyCasterOff, 4000);
    }

    if (devFlag('envDumpCasters')) {
      window.__ENVCASTERS__ = () => {
        const rows = [];
        scene.traverse((o) => {
          if (!o.castShadow || !o.isObject3D || !o.geometry) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          rows.push({
            name: o.name || o.type, kind: o.isInstancedMesh ? `instanced x${o.count}` : o.type,
            visible: o.visible, frustumCulled: o.frustumCulled,
            bs: o.geometry.boundingSphere ? +o.geometry.boundingSphere.radius.toFixed(2) : null,
            mats: mats.filter(Boolean).map((m) => `${m.name || m.type}:side=${m.side}:shadowSide=${m.shadowSide}`
              + `:alphaTest=${m.alphaTest}:transparent=${m.transparent}:map=${m.map ? 'y' : 'n'}:type=${m.type}`),
          });
        });
        return rows;
      };
    }

    /**
     * `window.__ENVSHADOW__()` — what the sun's shadow rig actually is, this frame.
     *
     * Three rounds looked for a cause of the hard edges in the frustum, the bias pair and the
     * caster list, and the answer was two numbers nobody had printed: the shadow-map *type*
     * three had silently swapped in, and `LightShadow.radius`. It is always exposed, not
     * gated behind a flag, because it costs nothing and the next agent should be able to read
     * it rather than deduce it.
     */
    window.__ENVSHADOW__ = () => {
      const s = three.sun.light.shadow;
      return {
        rendererType: three.renderer.shadowMap.type,
        rendererTypeName: { 0: 'Basic', 1: 'PCF', 2: 'PCFSoft(deprecated)', 3: 'VSM' }[three.renderer.shadowMap.type],
        filterInstalled: shadowFilterInstalled(), taps: SHADOW_FILTER_TAPS,
        filter: shadowFilterInfo(),
        // Under PCSS `radius` is the WIDEST penumbra this hour, not the only one: a pixel
        // whose blocker is directly overhead gets `filter.minTexels` instead.
        maxRadiusTexels: s.radius, mapSize: s.mapSize.x, extent: config.shadowExtent,
        maxPenumbraWorldUnits: +(s.radius * (config.shadowExtent / s.mapSize.x)).toFixed(4),
        minPenumbraWorldUnits: +(shadowFilterInfo().minTexels * (config.shadowExtent / s.mapSize.x)).toFixed(4),
        // The live camera against the depth range baked into the compiled chunk. They must
        // agree: the ladder is calibrated in world units and a mismatch silently rescales
        // every blocker distance. `filter.depthRangeWorld` is what the shader believes.
        shadowCamera: { near: s.camera.near, far: s.camera.far, rangeWorld: +(s.camera.far - s.camera.near).toFixed(2) },
        bias: s.bias, normalBias: s.normalBias, intensity: s.intensity,
        casting: three.sun.light.castShadow,
        casterPolicy: casterFix.report(),
        lampsOn: look?.lamps ?? null,
      };
    };

    // --- sky dome ----------------------------------------------------------
    const skyUniforms = {
      uZenith: { value: new THREE.Color(0x2360c8) },
      uHorizon: { value: new THREE.Color(0x8fbde8) },
      uGround: { value: new THREE.Color(0x2f3a22) },
      uSunColor: { value: new THREE.Color(0xfff6e6) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlow: { value: new THREE.Color(0x000000) },
      uSunSize: { value: 0.013 },
      uSunIntensity: { value: 1 },
      uHaze: { value: 0.26 },
      uStars: { value: 0 },
      uMoon: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyUniforms,
        // Painted first with no depth interaction at all: a sky pinned to the far plane
        // fails a LESS depth test against a cleared buffer and silently disappears
        // (DECISIONS #11).
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      }),
    );
    sky.name = 'sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.scale.setScalar(200);
    scene.add(sky);

    // --- lights ------------------------------------------------------------
    const hemi = new THREE.HemisphereLight(0x6fa0e0, 0x36401f, 0.94);
    hemi.name = 'env:hemi';
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0x9fb2c8, 0.046);
    ambient.name = 'env:ambient';
    scene.add(ambient);

    // Two directional fills, neither of which casts a shadow, so `three.sun` remains the one
    // shadow-casting light in the frame (ARCHITECTURE §2.7). See presets.js "why two fills":
    // a hemisphere is a function of `normal.y` and cannot tell a face turned *into* the key
    // from one turned away, which is why raising it only ever produced milk.
    //
    // Both are aimed at the origin and parked one unit away along their direction. A
    // directional light only reads `position − target`, and neither casts a shadow, so
    // neither has to follow the camera the way `sun.update()` does.
    const bounce = new THREE.DirectionalLight(0xffffff, 0);
    bounce.name = 'env:bounce';
    bounce.castShadow = false;
    scene.add(bounce, bounce.target);
    const camFill = new THREE.DirectionalLight(0xffffff, 0);
    camFill.name = 'env:camFill';
    camFill.castShadow = false;
    // The camera is locked at 45° below horizontal and never yaws (§2.7), so this direction
    // is a constant: from the south, a little steeper than the camera itself so a flat floor
    // still takes some of it and a sprite's front takes most of it.
    camFill.position.set(0, CAM_FILL_DIR.y, CAM_FILL_DIR.z);
    scene.add(camFill, camFill.target);

    scene.fog = new THREE.FogExp2(0x86aeda, 0.0074);

    // The painted pool has to lie on the *ground*, and only `terrain` knows where that is.
    // Resolved lazily, once per `lamps.add()`: environment has no `needs`, so it initialises
    // before terrain, but nothing registers a bulb until a scene is built.
    const lamps = makeLamps(THREE, scene, (x, z) => {
      const t = ctx.get('terrain');
      const h = t?.height?.(Math.floor(x), Math.floor(z));
      return Number.isFinite(h) ? h : 0;
    });
    const weatherFx = makeWeather(THREE, scene, rng.fork('environment:weather'));
    // Characters are flat cards and cannot be shadow-mapped without self-shadowing; see
    // castShadows.js. It needs the same shadow depth and colour the shadow map produces, so
    // `apply()` computes that once, below, and hands it over.
    const castFx = makeCastShadows(THREE, scene);
    /**
     * Every caster casts. The lamp posts stand on lit ground and write nothing to the
     * shadow map, which two blind judges filed as "two incompatible lighting models in one
     * frame". `?envNoCasterFix=1` is the A/B. See casters.js for the audit and for why the
     * override is gated on the sun still being the key.
     */
    const casterFix = makeCasterPolicy(scene, { off: devFlag('envNoCasterFix') });
    const noCast = devFlag('envNoCast');
    const noClamp = devFlag('envNoShadowClamp');
    /** `?envNoConeBend=1` — put the night key back on the moon's raw antipode azimuth. */
    const noConeBend = devFlag('envNoConeBend');

    // --- state -------------------------------------------------------------
    let tod = ((Number(config.tod) % 24) + 24) % 24;
    let biome = 'meadow';
    let weather = { name: 'clear', intensity: 0 };
    let phase = phaseOf(tod);
    /** `tune()` writes here; apply() lets these win over the preset. */
    const overrides = {};
    let look = null;
    let fxTime = 0;

    const sunDir = new THREE.Vector3(0, 1, 0);
    const tmpFog = new THREE.Color();
    /**
     * What a flat piece of ground keeps when the key is taken off it, per channel.
     *
     * This is the *definition* of a shadow in this renderer — `fill / (fill + key)` — and it
     * is computed from the lights `apply()` has just written rather than authored, so a
     * preset change cannot put the painted shadows and the shadow-mapped ones out of step.
     * A shadow that carries the fill's hue is a shadow; one that is a grey luminance multiply
     * is paint, and the difference is entirely in this number being a vec3.
     */
    const shadowMul = { r: 0.2, g: 0.24, b: 0.34 };
    /**
     * What a shadow cast by a *practical* keeps, per channel — the indoor counterpart of
     * `shadowMul`, and deliberately a much shallower number.
     *
     * `shadowMul` is `fill / (fill + key)` and in the cave preset the key is 5.20 against a
     * hemisphere of 0.50, so it lands near black. That is the right depth for a shaft of
     * daylight and quite wrong for a lantern six cells away in a room that is already lit by
     * four more of them: what a bulb removes is one bulb's worth, not the whole sky. So this
     * is `fill / (fill + lamp)` with the lamp sized as a fraction of the fill, which puts the
     * depth near a half and — because the bulbs are warm and the fill is not — leaves the
     * shadow *cooler* than the floor around it without any second colour being authored.
     */
    const practicalMul = { r: 0.5, g: 0.5, b: 0.5 };
    /**
     * Whether the moon rather than the sun is the key, written by `apply()` and read by the
     * frame step. `casters.js` needs it to know whether a street lamp is an occluder or a
     * light this hour — see DECISIONS #48, which measured the night case and kept it.
     */
    let keyIsMoon = false;

    /** 0..1. 1 = sealed interior: no sun, no sun shadow, practicals do the modelling. */
    let enclosed = 0;
    /** Look keys `tune()` may override; anything else in a tune patch goes to config. */
    const LOOK_SCALARS = new Set(['sun', 'sunSize', 'hemi', 'ambient', 'bounce', 'camFill',
      'enclosed', 'fogDensity', 'fogBoost',
      'exposure', 'contrast', 'saturation', 'bloom', 'bloomThreshold', 'vignette', 'grain',
      'haze', 'stars', 'lamps']);
    /** Colour-valued look keys. Kept apart from the scalars because `tune({ lift: 0x241a10 })`
     *  is a *number* and storing it as one put a NaN straight into the grade uniform. */
    const LOOK_COLORS = new Set(['skyZenith', 'skyHorizon', 'skyGround', 'hemiSky',
      'hemiGround', 'ambientColor', 'sunTint', 'bounceColor', 'camFillColor', 'fog',
      'lift', 'gain']);

    function apply() {
      const solar = solarPosition(tod, config.latitude, DAY_OF_YEAR, {
        azimuthOffset: (config.sunAzimuthOffset ?? 0) * (Math.PI / 180),
        maxElevation: (config.sunMaxElevation ?? 0) * (Math.PI / 180),
      });
      const base = blendPreset(tod, PRESETS[biome] ?? PRESETS.meadow);
      look = applyWeather(base, weather);
      for (const [k, v] of Object.entries(overrides)) if (k in look) look[k] = v;
      if (URL_TUNE) for (const [k, v] of Object.entries(URL_TUNE)) if (k in look) look[k] = v;

      // Direction from the world *toward* the light. Once the sun is down the moon takes
      // over: it sits opposite, is far dimmer and much cooler, so there is always something
      // with a direction to model geometry with at night.
      //
      // Both branches use the *same* elevation floor, and that is load-bearing rather than
      // tidy. The floor is a lie about `dot(N, L)` on a flat floor, so a key of a given
      // intensity puts `sun · floor` on the ground; if the two branches floor at different
      // heights, the frame's brightness steps the instant the sun crosses −2°. It did: with
      // the moon floored at 0.38 against the sun's 0.06, `tod 18.7` measured a median 80
      // where `tod 18.3` measured 52 — dusk got *brighter* as the sun set. At −2° both
      // branches now clamp to the same 0.06 and the crossing is continuous; by `tod 21` the
      // moon is 30° up on its own and the floor does nothing at all.
      const night = solar.altitude < -0.035;
      keyIsMoon = night;
      if (night) {
        // The moon is the sun's antipode, so `sunAzimuthOffset` arrives on it already; what
        // it does not do is keep the moon's *shadow* off the camera axis at any hour but
        // midnight. `pushOutOfCone` is the fix, and it is night-only on purpose — see the
        // note on NIGHT_AZ_POWER.
        const m = noConeBend ? { x: -solar.dir.x, z: -solar.dir.z }
          : pushOutOfCone(-solar.dir.x, -solar.dir.z);
        sunDir.set(m.x, Math.max(KEY_ELEVATION_FLOOR, -solar.dir.y), m.z).normalize();
      } else {
        sunDir.set(solar.dir.x, Math.max(KEY_ELEVATION_FLOOR, solar.dir.y), solar.dir.z).normalize();
      }

      // Colour: the keyframe is the artist's word, nudged toward the physical colour
      // temperature so a latitude change still reads (6500 K overhead, 2000 K on the deck).
      const h = Math.max(0, Math.min(1, (solar.altitude + 0.06) / 0.62));
      const sunColor = night
        ? look.sunTint.clone()
        : look.sunTint.clone().lerp(kelvinToRGB(2000 + h * 4600), 0.22);

      three.sun.setDirection(sunDir.x, sunDir.y, sunDir.z);
      three.sun.light.color.copy(sunColor);
      // Lowering the sun to make it rake costs brightness, and that cost is not optional:
      // a flat floor takes `sin(elevation)` of the key, so soft-capping 60 degrees down to
      // 33.5 removed a third of the light on every horizontal surface in the game. The
      // first cut of this change was measured at 19-28% lower mean luma at noon, and a
      // blind round went 3/7 to 1/7 on it — the shadows arrived and the picture got duller,
      // which is a bad trade.
      //
      // So the key is scaled back up by exactly the ratio the tilt took away, which leaves
      // a horizontal surface as bright as the real sun would have made it while the shadows
      // still rake. Clamped, because near sunrise and sunset the ratio runs away and the
      // grazing hours are supposed to be dim.
      const trueY = Math.sin(Math.max(0, solar.trueAltitude ?? solar.altitude));
      const shownY = Math.sin(Math.max(0.02, solar.altitude));
      const tiltGain = night ? 1
        : Math.min(TILT_GAIN_MAX, Math.max(TILT_GAIN_MIN, trueY / Math.max(shownY, 1e-3)));
      // `TILT_GAIN_MIN` is 1 on the shipping path, so this is `Math.max(1, ratio)` as it was.
      three.sun.light.intensity = look.sun * tiltGain;

      // A grazing sun rakes across every surface and needs a bigger normal offset than a
      // sun overhead; one fixed bias either acnes at dusk or peter-pans at noon. These are
      // written straight onto the light because core reads config for them only once, at
      // construction (see the coreRequest in this module's report).
      const graze = 1 - Math.max(0, Math.min(1, sunDir.y));
      const normalBias = (0.026 + 0.055 * graze * graze) * NORMAL_BIAS_MUL;
      const bias = (-0.0005 - 0.0006 * graze) * BIAS_MUL;
      three.sun.light.shadow.normalBias = normalBias;
      three.sun.light.shadow.bias = bias;
      three.sun.light.shadow.intensity = SHADOW_INTENSITY;
      three.sun.light.shadow.radius = shadowRadiusFor(sunDir.y);
      config.set({ shadowNormalBias: normalBias, shadowBias: bias });

      hemi.color.copy(look.hemiSky);
      hemi.groundColor.copy(look.hemiGround);
      hemi.intensity = look.hemi;
      ambient.color.copy(look.ambientColor);
      ambient.intensity = look.ambient;

      // The bounce sits opposite the key in azimuth, lifted to a fixed elevation. Squashing
      // the horizontal part to unit length first means it keeps its azimuth however high the
      // sun is; at noon that leaves it due north, which is exactly the wall that has nothing.
      const hx = -sunDir.x, hz = -sunDir.z;
      const hl = Math.hypot(hx, hz);
      const flat = Math.sqrt(1 - BOUNCE_ELEVATION * BOUNCE_ELEVATION);
      if (hl > 1e-4) bounce.position.set(hx / hl * flat, BOUNCE_ELEVATION, hz / hl * flat);
      else bounce.position.set(0, 1, 0);
      bounce.color.copy(look.bounceColor);
      bounce.intensity = noFills ? 0 : look.bounce;
      camFill.color.copy(look.camFillColor);
      camFill.intensity = noFills ? 0 : look.camFill;

      skyUniforms.uZenith.value.copy(look.skyZenith);
      skyUniforms.uHorizon.value.copy(look.skyHorizon);
      // Below the horizon the dome is *not* painted the authored ground colour on its own.
      // At a 45 degree pitch the only way the lower hemisphere is ever on screen is through a
      // hole — the far edge of a map that is smaller than the view frustum — and 0x2f3a22
      // through `exposure 0.33` and `contrast 1.27` clamps to literal black, so the hole reads
      // as a void instead of as distance. Pulled three quarters of the way to the fog it reads
      // as the same air everything else fades into. `xmod-hunts-12.png`.
      tmpFog.copy(look.fog).multiplyScalar(look.fogBoost);
      // 0.92 rather than 0.75: a named camera preset (`garden`) frames the west edge of the
      // demo city, and at 0.75 the strip of dome under the map's horizon read as a flat brown
      // slab rather than as more of the same distance. Pulled almost all the way to the fog
      // it is the colour the far ground has already faded to, so the edge stops announcing
      // itself. It is still not *nothing* — a map that ends inside the frustum is the map
      // author's problem, and this only stops it looking like a rendering fault.
      skyUniforms.uGround.value.copy(look.skyGround).lerp(tmpFog, 0.92);
      skyUniforms.uSunColor.value.copy(sunColor);
      skyUniforms.uSunDir.value.copy(sunDir);
      skyUniforms.uSunSize.value = look.sunSize;
      skyUniforms.uSunIntensity.value = night ? 0.10 : Math.max(0.15, look.sun * 0.30);
      skyUniforms.uMoon.value = night ? 0.9 : 0;
      skyUniforms.uHaze.value = Math.min(1, look.haze);
      skyUniforms.uStars.value = look.stars;
      // Twilight wash: strongest while the disc is within ~8 degrees of the horizon.
      const twilight = Math.exp(-Math.pow(solar.altitude * 7.0, 2));
      skyUniforms.uGlow.value.copy(look.fog).multiplyScalar(twilight * 0.55 * look.fogBoost);

      // fogBoost may push the colour above 1 in linear space: that is deliberate, it is how
      // the distance gets hot enough to bloom on its own.
      tmpFog.copy(look.fog).multiplyScalar(look.fogBoost);
      scene.fog.color.copy(tmpFog);
      scene.fog.density = look.fogDensity;

      const grade = three.view.grade;
      grade.uLift.value.set(look.lift.r, look.lift.g, look.lift.b);
      grade.uGain.value.set(look.gain.r, look.gain.g, look.gain.b);
      config.set({
        exposure: look.exposure,
        contrast: look.contrast,
        saturation: look.saturation,
        bloomStrength: look.bloom,
        bloomThreshold: look.bloomThreshold,
        vignette: look.vignette,
        grain: look.grain,
      });

      // --- what a shadow is, this hour ------------------------------------
      // Irradiance a flat, up-facing piece of ground takes from the key, and from everything
      // that is not the key. A hemisphere gives an up-facing normal all of `hemiSky`; a
      // directional fill gives it the sine of its elevation.
      const keyY = Math.max(0, sunDir.y);
      for (const ch of ['r', 'g', 'b']) {
        const key = sunColor[ch] * look.sun * tiltGain * keyY;
        const fill = look.hemiSky[ch] * look.hemi
          + look.ambientColor[ch] * look.ambient
          + look.bounceColor[ch] * (noFills ? 0 : look.bounce) * BOUNCE_ELEVATION
          + look.camFillColor[ch] * (noFills ? 0 : look.camFill) * CAM_FILL_DIR.y;
        shadowMul[ch] = Math.max(0.03, fill / Math.max(1e-4, fill + key));
      }

      // --- indoors, the sun is not the light ------------------------------
      // A sealed cave drew hard-edged near-black darts that swung with a daily arc under a
      // rock ceiling; two separate blind rounds filed it and one judge called it "geometry
      // corruption". The preset says whether the room has a sky over it (`enclosed`), and a
      // scene may override that through `setEnclosure` without environment ever having to
      // know a biome's name. The directional key stays — it is the preset's warm shaft, and
      // it still models geometry — but it stops *casting*, and the practicals take over.
      enclosed = Math.max(0, Math.min(1, overrides.enclosed ?? look.enclosed ?? 0));
      const wantsShadow = !noShadow && enclosed < 0.5;
      if (three.sun.light.castShadow !== wantsShadow) three.sun.light.castShadow = wantsShadow;

      // The colour of a practical's shadow, taken from the bulbs actually registered so a
      // blue cave crystal and a warm lantern do not share one authored number.
      const bulbs = lamps.list();
      let lr = 0, lg = 0, lb = 0;
      for (const L of bulbs) { lr += L.color.r; lg += L.color.g; lb += L.color.b; }
      const nb = bulbs.length || 1;
      const lampCol = { r: lr / nb || 1, g: lg / nb || 1, b: lb / nb || 1 };
      const lampMax = Math.max(lampCol.r, lampCol.g, lampCol.b) || 1;
      for (const ch of ['r', 'g', 'b']) {
        const fill = Math.max(0.02, look.hemiSky[ch] * look.hemi + look.ambientColor[ch] * look.ambient);
        const lamp = (lampCol[ch] / lampMax) * fill * PRACTICAL_KEY_RATIO;
        practicalMul[ch] = Math.max(0.22, fill / (fill + lamp));
      }

      const p = phaseOf(tod);
      if (p !== phase) { phase = p; bus.emit('tod:changed', { tod, phase }); }
    }

    apply();

    const api = {
      // --- ARCHITECTURE §5.3 ----------------------------------------------
      setTimeOfDay(t) {
        const n = Number(t);
        if (!Number.isFinite(n)) return;
        tod = ((n % 24) + 24) % 24;
        apply();          // apply() emits tod:changed only when the phase turns over
      },
      getTimeOfDay: () => tod,
      setBiomePreset(name) {
        if (!PRESETS[name]) { log.warn(`no environment preset "${name}"`); return false; }
        biome = name; apply(); return true;
      },
      setWeather(name, intensity = 0.7) {
        if (!WEATHERS.includes(name)) { log.warn(`no weather "${name}"`); return false; }
        weather = { name, intensity: Math.max(0, Math.min(1, Number(intensity) || 0)) };
        apply();
        return true;
      },
      sun() {
        const s = solarPosition(tod, config.latitude, DAY_OF_YEAR, {
          azimuthOffset: (config.sunAzimuthOffset ?? 0) * (Math.PI / 180),
          maxElevation: (config.sunMaxElevation ?? 0) * (Math.PI / 180),
        });
        return {
          azimuth: s.azimuth, altitude: s.altitude,
          direction: { x: sunDir.x, y: sunDir.y, z: sunDir.z },
          colour: three.sun.light.color.getHex(), color: three.sun.light.color.getHex(),
          intensity: three.sun.light.intensity,
          /** Multiples of an object's height, at ground level. `Infinity` once it is down. */
          shadowLength: sunDir.y > 1e-3 ? Math.sqrt(1 - sunDir.y * sunDir.y) / sunDir.y : Infinity,
        };
      },
      /**
       * Live-tune (ARCHITECTURE §5.3). Keys that name part of the *look* become overrides
       * that survive the clock moving on — otherwise the next `apply()` would immediately
       * put the preset value back and tuning would look broken. Everything else is a plain
       * config tunable (`pixelScale`, `cameraDistance`, …) and goes straight to config.
       * Pass `null` to drop an override and hand the key back to the preset.
       */
      tune(patch) {
        const toConfig = {};
        for (const [k, v] of Object.entries(patch ?? {})) {
          const colour = LOOK_COLORS.has(k);
          if (!colour && !LOOK_SCALARS.has(k)) { toConfig[k] = v; continue; }
          if (v === null) delete overrides[k];
          else overrides[k] = colour ? new THREE.Color(v) : Number(v);
        }
        if (Object.keys(toConfig).length) config.set(toConfig);
        apply();
        config.persist?.();
        return { ...overrides };
      },

      // --- extras other modules and the harness use ------------------------
      biome: () => biome,
      weather: () => ({ ...weather }),
      phase: () => phaseOf(tod),
      /**
       * Declare that the camera is under a roof (ARCHITECTURE §5.3 — environment owns the
       * sun). A scene that builds its own cave mouth or a shop interior calls this; it does
       * not have to be a whole biome and environment never has to know a biome's name. The
       * preset supplies the default (`cave` and `interior` are 1, everything outdoors 0), so
       * a map that says nothing still behaves correctly.
       *
       * At 1 the directional key stops casting a shadow — an interior lit by a sun that is
       * not in the room is the "geometry corruption" two blind rounds filed — and the
       * projected character shadows are thrown by the registered practicals instead.
       *
       * @param {number|boolean|null} v  0..1, or null to hand the key back to the preset.
       * @returns {number} the enclosure now in force
       */
      setEnclosure(v) {
        if (v === null || v === undefined) delete overrides.enclosed;
        else overrides.enclosed = Math.max(0, Math.min(1, Number(v) || 0));
        apply();
        return enclosed;
      },
      /** 0 = open sky, 1 = sealed interior. What the sun's shadow is actually doing. */
      enclosure: () => enclosed,
      /** The multiplier a practical's shadow lays down indoors — the indoor `shadow()`. */
      practicalShadow: () => ({ ...practicalMul }),
      presets: () => Object.keys(PRESETS),
      weathers: () => [...WEATHERS],
      /** The blended look actually in force — the debug overlay and the critic read this. */
      look: () => ({ ...look }),
      /**
       * The per-channel multiplier a flat surface keeps when the key is taken off it — the
       * number the painted shadows use, exposed so a shot can be checked against it rather
       * than eyeballed. `shadowMul.g` at noon is the linear shadow/lit ratio of the frame.
       */
      shadow: () => ({ ...shadowMul }),
      /** How many sprite fields are having their silhouettes projected (castShadows.js). */
      castShadows: () => castFx.count(),
      skyUniforms,

      /**
       * Practical lights. `city` and `hunts` register their lamp bulbs here rather than
       * making their own point lights, so the night ramp and the pool budget stay in one
       * place (ARCHITECTURE §5.3 — environment owns lamp emissives at night).
       */
      lamps: {
        add: (spec) => lamps.add(spec),
        clear: () => lamps.clear(),
        count: () => lamps.count(),
      },

      /** Time-of-day framings the screenshot harness can request by name. */
      preset(name) {
        const t = {
          night: 0.6, predawn: 4.9, dawn: 5.8, morning: 7.6, day: 9.4, noon: 12,
          afternoon: 15.4, golden: 17.35, sunset: 18.3, dusk: 19.1, evening: 20.6,
        }[name];
        if (t === undefined) return false;
        api.setTimeOfDay(t);
        return true;
      },
    };
    // `frame` runs outside this closure. Hand it a direct reference rather than reaching
    // back through `ctx.get('environment')`: a quarantined module is replaced by a
    // null-object proxy, and probing that for a private field logs a warning every frame.
    activeFx = {
      step(dt, focus) {
        if (!config.timeFrozen) fxTime += dt;
        casterFix.update({ night: keyIsMoon, lampsOn: look?.lamps ?? 0 });
        lamps.update(look?.lamps ?? 0, fxTime, focus, lampDev);
        weatherFx.update(look?.particles, tmpFog, fxTime, focus);
        // Indoors `?envNoShadow=1` must change nothing: the sun already casts no shadow
        // there, and these shadows are the room's lanterns, not the sun's. Outdoors it is
        // still the flag that answers "is that dark quad a shadow or a decal?".
        castFx.update({
          sunDir,
          shade: enclosed >= 0.5 ? practicalMul : shadowMul,
          strength: (noShadow && enclosed < 0.5) ? 0 : 1,
          off: noCast,
          practicals: enclosed >= 0.5 ? lamps.nearest(focus, 4) : null,
          keyLight: three.sun.light,
          noClamp,
        });
      },
    };
    api.dispose = () => { activeFx = null; lamps.dispose(); weatherFx.dispose(); castFx.dispose(); casterFix.dispose(); };
    return api;
  },

  tick(dt, ctx) {
    const { config } = ctx;
    if (config.timeFrozen) return;
    const env = ctx.get('environment');
    const perHour = Math.max(1e-3, config.secondsPerGameHour);
    env.setTimeOfDay(env.getTimeOfDay() + dt / perHour);
  },

  frame(dt, alpha, ctx) {
    activeFx?.step(dt, ctx.three.rig.focus);
  },

  async showcase(mode, ctx) {
    const { showcaseEnvironment } = await import('./showcase.js');
    return showcaseEnvironment(mode, ctx);
  },
};

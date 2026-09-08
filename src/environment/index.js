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
import { makeWeather } from './weather.js';
import { makeCastShadows } from './castShadows.js';

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
 *   ?envNoPool=1     lamp point lights off
 *   ?envNoDecal=1    lamp ground pools off
 *   ?envNoFills=1    bounce + camFill off
 *   ?envNoCast=1     projected sprite shadows off — is that shadow the character's own?
 *
 * Every one defaults to the shipping behaviour, so a normal load is unaffected.
 */
function devFlag(name) {
  try { return new URLSearchParams(location.search).get(name) === '1'; } catch { return false; }
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

const KEY_ELEVATION_FLOOR = 0.06;

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
    const noCast = devFlag('envNoCast');

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
    /** Look keys `tune()` may override; anything else in a tune patch goes to config. */
    const LOOK_SCALARS = new Set(['sun', 'sunSize', 'hemi', 'ambient', 'bounce', 'camFill',
      'fogDensity', 'fogBoost',
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
      if (night) {
        sunDir.set(-solar.dir.x, Math.max(KEY_ELEVATION_FLOOR, -solar.dir.y), -solar.dir.z).normalize();
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
      const tiltGain = night ? 1 : Math.min(TILT_GAIN_MAX, Math.max(1, trueY / Math.max(shownY, 1e-3)));
      three.sun.light.intensity = look.sun * tiltGain;

      // A grazing sun rakes across every surface and needs a bigger normal offset than a
      // sun overhead; one fixed bias either acnes at dusk or peter-pans at noon. These are
      // written straight onto the light because core reads config for them only once, at
      // construction (see the coreRequest in this module's report).
      const graze = 1 - Math.max(0, Math.min(1, sunDir.y));
      const normalBias = 0.026 + 0.055 * graze * graze;
      const bias = -0.0005 - 0.0006 * graze;
      three.sun.light.shadow.normalBias = normalBias;
      three.sun.light.shadow.bias = bias;
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
        lamps.update(look?.lamps ?? 0, fxTime, focus, lampDev);
        weatherFx.update(look?.particles, tmpFog, fxTime, focus);
        castFx.update(sunDir, shadowMul, noShadow ? 0 : 1, noCast);
      },
    };
    api.dispose = () => { activeFx = null; lamps.dispose(); weatherFx.dispose(); castFx.dispose(); };
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

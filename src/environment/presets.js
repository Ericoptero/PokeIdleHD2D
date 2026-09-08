/**
 * Time-of-day and biome look presets.
 *
 * Each biome is a list of keyframes at fixed hours; `blendPreset` interpolates the two that
 * bracket the current time, wrapping across midnight. Keeping the look in data means a
 * critic's note ("dusk is too magenta") is a number change, not a shader rewrite.
 *
 * ── How these numbers were chosen ────────────────────────────────────────────────────────
 * The composite pass (core/render.js) is  `scene*exposure → AgX → *gain+lift → sat →
 * contrast → vignette`.  AgX spreads 16.5 EV over the display range, so a scene sitting in
 * the middle of that curve loses roughly 90% of its contrast: two stops of key-to-fill
 * arrive as ~35 sRGB levels.  That is exactly what "washed out" was.  Three things fix it
 * and all three are driven from here:
 *
 *   1. `exposure` places the *lit* surface high on the AgX curve instead of mid-grey.
 *      The tileset albedos are DS-bright (grass01ax averages #74cc71, michi01b #ebd795) and
 *      Lambert divides by π, so scene-linear values are small and exposure runs 1.5–3.
 *   2. `contrast` (previously never written — it sat at the config default 1.04 all day)
 *      re-expands what AgX compressed. 1.25–1.38 outdoors.
 *   3. the sun/fill *ratio*: fill is a small, strongly coloured hemisphere, not a big white
 *      one. A shadow that is 1/4 the luminance of its key and blue reads as a shadow; one
 *      that is 2/3 and white reads as paint.
 *
 * Round 2 added a fourth, and it is the one that fixed the golden hour and the night:
 *
 *   4. `gain` is applied *after* the tonemap, so it is a multiply on the finished display
 *      range. The night keyframes used to run `gain: 0xa9afbc`, which in the linear working
 *      space is 0.42 — every pixel of the night frame was squeezed into the bottom 42% of
 *      the range before `contrast` pulled it down again, and no lamp could ever make a
 *      highlight. Night `gain` is near white now and `exposure` carries the hour instead.
 *
 * Round 6 found the arithmetic error that had been hiding under all four of those, and it
 * is worth stating precisely because two rounds already "fixed" it and did not:
 *
 *   5. **`lift` is authored as a display-space hex and delivered as a linear one.** It goes
 *      through `new THREE.Color(hex)`, and `THREE.ColorManagement` is on, so `0x191c28`
 *      arrives at the shader as `(0.0097, 0.0116, 0.0212)` — display `(2.5, 3.0, 5.4)/255`,
 *      not the `(25, 28, 40)` the hex reads as. Meanwhile `contrast` is a gain about 0.5, so
 *      it has a crush point at `0.5 - 0.5/contrast`: at the night's 1.22 that is
 *      **0.0902**, or 23/255. Every night lift this project has ever shipped has been an
 *      order of magnitude *inside* its own crush point, so the frame had no floor at all and
 *      "raise the lift" moved nothing. Measured on the shipped night frames: `city-21` was
 *      4.58 % of the frame at exactly rgb(0,0,0), plus 0.43 % at rgb(25,0,0) and 0.38 % at
 *      rgb(0,0,50) — single-channel pixels, which is what `saturation` above 1 does to a
 *      dark pixel once `contrast` has clamped the other two channels to zero.
 *      The night, blue-hour and golden-hour lifts are now sized against the crush point and
 *      `exposure` / `saturation` pay for the midtone and the colour the bigger offset costs.
 *
 * `fogBoost` multiplies the fog colour in *linear* space and may exceed 1. Distance then
 * glows and crosses the bloom threshold on its own, which is what gives docs/refs/04 its
 * hot horizon — the 45° camera never actually shows the sky, so all "air" must come from
 * fog, not from the dome.
 */

import * as THREE from 'three';

const c = (hex) => new THREE.Color(hex);

/**
 * One keyframe. Colours are authored as sRGB hex and land in the linear working space.
 *
 * @param {number} hour
 * @param {object} o
 *   sky*      – the dome gradient (rarely on screen at 45°, but it drives the horizon glow)
 *   sun       – directional intensity; `sunTint` its colour; `sunSize` the disc
 *   hemi*     – the fill. `hemiSky` lights up-facing surfaces, `hemiGround` down-facing.
 *   ambient   – flat term; keep it tiny outdoors or shadows go grey
 *   bounce/bounceColor – the *anti-sun* fill (§ "why two fills" below)
 *   camFill/camFillColor – the camera-axis fill
 *   fog/fogDensity/fogBoost – see the header
 *   exposure/contrast/saturation/bloom/bloomThreshold/vignette/grain – the grade
 *   lift/gain – display-space offset and multiplier, applied after the tonemap
 *   stars     – 0..1 star field opacity; `haze` widens the horizon band
 *
 * ── Why two fills, and not a bigger hemisphere ───────────────────────────────────────────
 * A HemisphereLight is a function of `normal.y` alone, so it cannot tell a wall facing *into*
 * the sun from one facing away: raising it lifts both and the frame turns to milk (that was
 * the "washed out" note in round 0). The two things a low sun actually breaks are directional,
 * so their fills are directional too:
 *
 *   `bounce`  sits on the **anti-sun azimuth**, 20° up. It is the light a real ground throws
 *             back at the surfaces the sun has turned its back on. Without it, a west-facing
 *             roof facet at 08:00 takes literally zero key and renders as hemisphere-only
 *             near-black — the "hard-edged black polygon slashed across the roof" that reads
 *             as a shadow bug but is fill starvation (it *does* swap sides with the sun).
 *   `camFill` sits on the **camera axis**, 38° up. Every sprite in the game is an upright card
 *             whose normal points at the camera (DECISIONS #18), so when the sun is due west
 *             the trainer's front takes `dot(N,L) = 0` and goes black whatever the hemisphere
 *             does. This is the fill that keeps a subject off the road behind it.
 *
 * Neither casts a shadow, so the frame keeps exactly one shadow-casting light (ARCHITECTURE
 * §2.7) and they cost no draw call — only two more terms in the Lambert loop.
 */
function key(hour, o) {
  return {
    hour,
    skyZenith: c(o.zenith), skyHorizon: c(o.horizon), skyGround: c(o.skyGround ?? o.ground),
    ground: c(o.ground),
    hemiSky: c(o.hemiSky ?? o.horizon), hemiGround: c(o.hemiGround ?? o.ground),
    ambientColor: c(o.ambientColor ?? 0xffffff),
    sunTint: c(o.sunTint), fog: c(o.fog),
    bounceColor: c(o.bounceColor ?? o.sunTint), camFillColor: c(o.camFillColor ?? o.hemiSky ?? o.horizon),
    lift: c(o.lift ?? 0x000000), gain: c(o.gain ?? 0xffffff),

    sun: o.sun, sunSize: o.sunSize ?? 0.014,
    hemi: o.hemi, ambient: o.ambient,
    bounce: o.bounce ?? 0, camFill: o.camFill ?? 0,
    fogDensity: o.fogDensity, fogBoost: o.fogBoost ?? 1,
    exposure: o.exposure, contrast: o.contrast, saturation: o.saturation,
    bloom: o.bloom, bloomThreshold: o.bloomThreshold,
    vignette: o.vignette ?? 0.3, grain: o.grain ?? 0.016,
    haze: o.haze ?? 0.35, stars: o.stars ?? 0,
    /**
     * 0 = open sky, 1 = a roof over the camera. Read by index.js: at 1 the directional key
     * stops casting and the registered practicals throw the character shadows instead. It
     * lives on the keyframe rather than in a `biome === 'cave'` test so that a scene can
     * declare a roofed *part* of an outdoor map through `environment.setEnclosure()` and
     * nothing here has to know a biome's name.
     */
    enclosed: o.enclosed ?? 0,
    /** Warm practical lights (street lamps, windows) ramp on with this. */
    lamps: o.lamps ?? 0,
  };
}

/**
 * The outdoor default: a clear spring day at 36°N. Other biomes start here and override.
 *
 * Hours are pinned to the solar events of `dayOfYear = 96` (sunrise 5.7, sunset 18.3), so
 * "the light goes warm" and "the sun touches the horizon" happen at the same instant.
 */
const OUTDOOR = [
  // ── deep night (docs/refs/03) ─────────────────────────────────────────────────────────
  // The corners of the reference are black and its path is warm and *bright*; what makes it
  // read as night is the ratio, not the average. So `exposure` here does not compensate for
  // the missing sun — it is close to noon's, and the frame is three stops darker because the
  // light is. `gain` stays near white for the same reason: an 0xa9afbc gain multiplies the
  // whole display range by 0.42 and nothing can ever reach a highlight again.
  key(0.0, {
    zenith: 0x081026, horizon: 0x111e40, ground: 0x04060c,
    hemiSky: 0x74829a, hemiGround: 0x322f2c, ambientColor: 0x3e4458,
    sunTint: 0xb2c4e6, sun: 3.50, sunSize: 0.010,
    hemi: 0.60, ambient: 0.054,
    bounce: 0.24, bounceColor: 0x78809a,
    camFill: 0.20, camFillColor: 0xb6c0d8,
    fog: 0x080d1a, fogDensity: 0.0170, fogBoost: 0.30,
    // Round 6: `exposure` down and `saturation` up pay for the much larger `lift` below, so
    // the frame gets its floor back without getting its midtones lifted with it. See the
    // `lift` note — the old 0x191c28 was not a floor at all, it was 2.5/255.
    exposure: 0.26, contrast: 1.22, saturation: 1.34,
    bloom: 1.15, bloomThreshold: 0.85,
    vignette: 0.46, grain: 0.020, haze: 0.18, stars: 1.0, lamps: 1.0,
    lift: 0x3a3f52, gain: 0xfdfdff,
  }),
  // ── astronomical → civil twilight, the sky lifts before the sun ───────────────────────
  key(4.9, {
    zenith: 0x12224e, horizon: 0x3b3d6e, ground: 0x0b0d16,
    hemiSky: 0x687894, hemiGround: 0x2c2c24, ambientColor: 0x444a62,
    sunTint: 0xdce0ec, sun: 3.00, sunSize: 0.010,
    hemi: 0.62, ambient: 0.054,
    bounce: 0.26, bounceColor: 0x7e86a0,
    camFill: 0.28, camFillColor: 0xbac2d8,
    fog: 0x161d36, fogDensity: 0.0160, fogBoost: 0.42,
    exposure: 0.375, contrast: 1.14, saturation: 1.42,
    bloom: 0.75, bloomThreshold: 2.2,
    vignette: 0.42, grain: 0.019, haze: 0.42, stars: 0.55, lamps: 1.0,
    lift: 0x2c3040, gain: 0xfeffff,
  }),
  // ── sunrise: the sun is on the horizon, everything vertical catches it ────────────────
  key(5.75, {
    zenith: 0x1d3f80, horizon: 0xc4744a, ground: 0x191319,
    hemiSky: 0x8ba0cc, hemiGround: 0x4e3c2e, ambientColor: 0x66626a,
    sunTint: 0xffa966, sun: 15.5, sunSize: 0.020,
    hemi: 0.62, ambient: 0.078,
    bounce: 1.25, bounceColor: 0xffbe8e,
    camFill: 1.10, camFillColor: 0xd8d6e2,
    fog: 0x9c6244, fogDensity: 0.0088, fogBoost: 0.95,
    exposure: 0.50, contrast: 1.25, saturation: 1.46,
    bloom: 0.55, bloomThreshold: 1.6,
    vignette: 0.36, grain: 0.017, haze: 0.78, stars: 0.10, lamps: 0.6,
    lift: 0x242a3a, gain: 0xfffaf3,
  }),
  // ── early morning: long shadows, air still cool ───────────────────────────────────────
  key(7.2, {
    zenith: 0x2f6bc4, horizon: 0xcfa887, ground: 0x22271a,
    hemiSky: 0x86a2d2, hemiGround: 0x4c4230, ambientColor: 0x7c8698,
    sunTint: 0xffd9a8, sun: 7.10, sunSize: 0.016,
    hemi: 0.50, ambient: 0.080,
    bounce: 0.90, bounceColor: 0xffd0ab,
    camFill: 0.95, camFillColor: 0xdee2f0,
    fog: 0xa89279, fogDensity: 0.0082, fogBoost: 0.98,
    exposure: 0.445, contrast: 1.30, saturation: 1.44,
    bloom: 0.4, bloomThreshold: 0.95,
    vignette: 0.32, grain: 0.015, haze: 0.55, stars: 0, lamps: 0.02,
    lift: 0x1e2230, gain: 0xfffbf6,
  }),
  // ── mid morning ───────────────────────────────────────────────────────────────────────
  key(9.4, {
    zenith: 0x2c6ecd, horizon: 0x9dc4e8, ground: 0x2a3320,
    hemiSky: 0x7ea6dc, hemiGround: 0x3c3d26, ambientColor: 0x91a0b6,
    sunTint: 0xffeed0, sun: 3.72, sunSize: 0.014,
    hemi: 0.72, ambient: 0.094,
    bounce: 0.62, bounceColor: 0xffe6ce,
    camFill: 0.42, camFillColor: 0xdfe9f6,
    fog: 0x8fb4d8, fogDensity: 0.0064, fogBoost: 1.02,
    exposure: 0.42, contrast: 1.33, saturation: 1.58,
    bloom: 0.32, bloomThreshold: 1.05,
    vignette: 0.29, grain: 0.014, haze: 0.34, stars: 0, lamps: 0,
    lift: 0x1a1e2a, gain: 0xfffefb,
  }),
  // ── noon: the flattest hour. Keep the fill blue and small or it turns to milk. ─────────
  // The fills are deliberately tiny here: at noon nothing is starved of key except a
  // north-facing wall, and that is exactly what `bounce` (which sits due north at noon)
  // reaches without touching the ground. This keyframe is the approved frame — every number
  // that is not a fill is the one that was signed off.
  key(12.0, {
    zenith: 0x2360c8, horizon: 0x8fbde8, ground: 0x2f3a22,
    hemiSky: 0x76a2dc, hemiGround: 0x3d4526, ambientColor: 0xa0b0c4,
    sunTint: 0xfff2dc, sun: 4.05, sunSize: 0.013,
    hemi: 0.84, ambient: 0.100,
    bounce: 0.40, bounceColor: 0xf6efdf,
    camFill: 0.34, camFillColor: 0xdfe9f6,
    fog: 0x86aeda, fogDensity: 0.0056, fogBoost: 1.0,
    exposure: 0.341, contrast: 1.32, saturation: 1.70,
    bloom: 0.3, bloomThreshold: 1.15,
    vignette: 0.28, grain: 0.013, haze: 0.26, stars: 0, lamps: 0,
    lift: 0x161a26, gain: 0xfffffe,
  }),
  // ── afternoon: warms and saturates before the golden hour proper ──────────────────────
  key(15.4, {
    zenith: 0x2a68c6, horizon: 0xb2cbe4, ground: 0x2f3520,
    hemiSky: 0x83a4d2, hemiGround: 0x433c26, ambientColor: 0x9aa6b6,
    sunTint: 0xffe9bd, sun: 5.05, sunSize: 0.015,
    hemi: 0.74, ambient: 0.090,
    bounce: 0.78, bounceColor: 0xffdfbb,
    camFill: 0.62, camFillColor: 0xdfe7f4,
    fog: 0x9fb6cf, fogDensity: 0.007, fogBoost: 1.05,
    exposure: 0.425, contrast: 1.28, saturation: 1.54,
    bloom: 0.38, bloomThreshold: 1.0,
    vignette: 0.30, grain: 0.014, haze: 0.42, stars: 0, lamps: 0,
    lift: 0x1a1e2a, gain: 0xfffdfa,
  }),
  // ── golden hour (docs/refs/04): long warm key, warm bounce, cool sky ───────────────────
  // The sun is 9.6 degrees up here, so a flat ground takes `dot(N,L) = 0.17` of it and is
  // lit almost entirely by the fill — which is why a pure-blue hemisphere used to turn every
  // neutral surface magenta and starve the green channel from both ends. `hemiGround` is a
  // warm bounce, `hemiSky` is a paler blue, and the fog is desaturated: at 0xc46b34 boosted
  // 1.15 the fog alone was adding more red to distant grass than the grass had of its own.
  key(17.35, {
    zenith: 0x27529f, horizon: 0xefa25c, ground: 0x241b16,
    hemiSky: 0x7d9ad6, hemiGround: 0x5c4630, ambientColor: 0x6e7690,
    sunTint: 0xffc078, sun: 20.0, sunSize: 0.021,
    hemi: 0.50, ambient: 0.078,
    bounce: 0.95, bounceColor: 0xffc086,
    camFill: 1.15, camFillColor: 0xe0dae0,
    fog: 0xc08a62, fogDensity: 0.0070, fogBoost: 0.90,
    // Round 6: the warm `lift 0x120d07` was the golden hour's own version of the cave's
    // one-hue bug (#46b). It delivered (0.0060, 0.0040, 0.0021) against a crush point of
    // 0.1183, so every shadow in the frame had blue clamped to zero and red held up by the
    // lift: a golden hour whose shade could only be orange. The lift is cool and above the
    // crush now, `exposure` pays for the midtones it would otherwise have raised, and
    // `saturation` pays for the colour the bigger lift washes out.
    exposure: 0.40, contrast: 1.31, saturation: 1.50,
    bloom: 0.5, bloomThreshold: 1.8,
    vignette: 0.33, grain: 0.015, haze: 0.78, stars: 0, lamps: 0.10,
    lift: 0x242a3a, gain: 0xfffbf5,
  }),
  // ── sunset: the disc is on the horizon, the ground barely catches it ──────────────────
  key(18.3, {
    zenith: 0x1e3f86, horizon: 0xe0662f, ground: 0x1b1416,
    hemiSky: 0x7690c6, hemiGround: 0x523e2c, ambientColor: 0x666a82,
    sunTint: 0xffa059, sun: 16.5, sunSize: 0.026,
    hemi: 0.56, ambient: 0.076,
    bounce: 0.95, bounceColor: 0xffb076,
    camFill: 1.20, camFillColor: 0xd8d2e0,
    fog: 0xb05a30, fogDensity: 0.0092, fogBoost: 0.95,
    exposure: 0.41, contrast: 1.26, saturation: 1.46,
    bloom: 0.6, bloomThreshold: 1.6,
    vignette: 0.37, grain: 0.017, haze: 0.90, stars: 0, lamps: 0.30,
    lift: 0x242a3a, gain: 0xfff9f2,
  }),
  // ── blue hour: the warm key is gone, the sky is the only source ───────────────────────
  key(19.1, {
    zenith: 0x14245e, horizon: 0x5a4272, ground: 0x101118,
    hemiSky: 0x6478a0, hemiGround: 0x2e2c24, ambientColor: 0x4c5068,
    sunTint: 0xccc8de, sun: 3.80, sunSize: 0.012,
    hemi: 0.62, ambient: 0.056,
    bounce: 0.30, bounceColor: 0x968ea8,
    camFill: 0.34, camFillColor: 0xbec6dc,
    fog: 0x22243c, fogDensity: 0.0150, fogBoost: 0.50,
    exposure: 0.46, contrast: 1.14, saturation: 1.40,
    bloom: 0.85, bloomThreshold: 1.4,
    vignette: 0.43, grain: 0.019, haze: 0.55, stars: 0.35, lamps: 1.0,
    // Crush point at contrast 1.14 is 0.0614; the old 0x0a0b11 delivered 0.0031.
    lift: 0x2c3040, gain: 0xfeffff,
  }),
  // ── night proper (docs/refs/03) ───────────────────────────────────────────────────────
  key(20.6, {
    zenith: 0x091230, horizon: 0x13204a, ground: 0x05070e,
    hemiSky: 0x74829a, hemiGround: 0x322f2c, ambientColor: 0x40465a,
    sunTint: 0xb2c4e6, sun: 3.50, sunSize: 0.010,
    hemi: 0.60, ambient: 0.054,
    bounce: 0.24, bounceColor: 0x78809a,
    camFill: 0.20, camFillColor: 0xb6c0d8,
    fog: 0x090e1c, fogDensity: 0.0166, fogBoost: 0.32,
    exposure: 0.26, contrast: 1.22, saturation: 1.34,
    bloom: 1.15, bloomThreshold: 0.85,
    vignette: 0.46, grain: 0.020, haze: 0.22, stars: 0.95, lamps: 1.0,
    lift: 0x3a3f52, gain: 0xfdfdff,
  }),
];

/** Shifts every keyframe of a preset by a set of multipliers / colour pulls. */
function tinted(base, fn) {
  return base.map((k) => ({ ...k, ...fn(k) }));
}
const isDark = (k) => k.hour >= 18.9 || k.hour <= 5.0;
const pull = (col, hex, t) => col.clone().lerp(c(hex), t);

export const PRESETS = {
  meadow: OUTDOOR,

  /**
   * A town: masonry bounces warm light back up, rooftops hold haze, and at night the
   * sodium lamps stain the air orange instead of blue.
   */
  city: tinted(OUTDOOR, (k) => ({
    hemiGround: pull(k.hemiGround, 0x4a3f31, 0.55),
    hemi: k.hemi * 1.06,
    fogDensity: k.fogDensity * 0.86,
    fog: isDark(k) ? pull(k.fog, 0x4a2c12, 0.42) : pull(k.fog, 0xb0a190, 0.12),
    fogBoost: isDark(k) ? k.fogBoost * 1.35 : k.fogBoost,
    bloom: isDark(k) ? k.bloom * 1.18 : k.bloom,
    saturation: k.saturation * 1.01,
  })),

  /**
   * Canopy: less sky reaches the floor, the bounce that does is green, and the air between
   * the trunks is thick. This is the docs/refs/03 look at night.
   */
  forest: tinted(OUTDOOR, (k) => {
    /**
     * ── Round 5: a canopy is an argument about the *sky*, and at night there isn't one ──
     * Every multiplier below used to apply at every hour, and at night they compounded into
     * a flat multiply over the whole frame: `forest-21` measured mean 20.4 / p95 43 / 25.8%
     * of the frame under luma 8 while `meadow-21`, the same OUTDOOR night keyframes with no
     * tint at all, measured mean 40.4 — so the two biomes had no shared lighting language at
     * the same hour, which is what `hunts` filed. docs/refs/03 is a *night* forest and its
     * path is the brightest thing in the picture (p95 129.5, max 217): what makes it read as
     * night is the ratio between the path and the black under the trees, not the average.
     *
     * The canopy argument is "less sky reaches the floor". At noon the sky is the second
     * source and cutting it is most of the look. At 21:00 the sky is already three stops
     * down and cutting it again just removes the picture — so at night the fill goes *up*
     * (which is what the shade under a canopy actually looks like: it is filled by the
     * ground and the trunks around it, not by the sky), the fog thins back toward the
     * outdoor night, and the extra vignette comes off a frame that is already dark at the
     * edges. The daytime numbers are untouched — `forest-12` is the frame nobody filed.
     */
    const dark = isDark(k);
    return {
      hemiSky: pull(k.hemiSky, 0x37703a, dark ? 0.22 : 0.34),
      hemiGround: pull(k.hemiGround, 0x16260f, dark ? 0.38 : 0.6),
      hemi: k.hemi * (dark ? 1.30 : 0.78),
      // A tree is two crossed upright cards (#29), so under a canopy almost every lit surface
      // is *vertical* and a hemisphere that has been cut to 0.78 to sell the shade reaches
      // none of it. The camera-axis fill does, and it is the only source in the rig that points
      // at the face the player is actually looking at.
      camFill: k.camFill * (dark ? 2.4 : 1.55),
      bounce: k.bounce * (dark ? 1.7 : 1.15),
      fogDensity: k.fogDensity * (dark ? 1.05 : 1.75),
      fog: pull(k.fog, dark ? 0x16291d : 0x33502a, dark ? 0.42 : 0.5),
      fogBoost: k.fogBoost * (dark ? 1.35 : 0.95),
      exposure: k.exposure * (dark ? 1.30 : 1),
      contrast: k.contrast * (dark ? 1.02 : 1),
      saturation: k.saturation * (dark ? 0.96 : 1.05),
      haze: Math.min(1, k.haze + 0.12),
      vignette: dark ? k.vignette : Math.min(0.62, k.vignette + 0.08),
    };
  }),

  /**
   * No sky at all. A cave is lit by its openings and by whatever glows down there, so the
   * key is a warm shaft, the fill is almost nothing, and the far dark is the subject.
   *
   * ── Round 5: the room was one hue, and every number here was pushing it that way ──────
   * Three modules filed the same note and `hunts` measured it: mean saturation 0.93-0.94 on
   * every cave frame against docs/refs/02's 0.194 and refs/04's 0.773, and a luma spread
   * flatter than any other scene in the game. `?envNoShadow=1` produced a byte-identical
   * PNG, so it was never the shadows — it was this table. Four terms, in order of how much
   * each contributed (each was shot on its own before they were combined):
   *
   *   `fogDensity 0.040` — at a 45 degree pitch the visible floor runs 15-30 world units
   *     out, and exp(-0.04 * 20) = 0.45, so **more than half of the average pixel was the
   *     fog colour** rather than the surface under it. Outdoor day runs 0.0056-0.0092. At
   *     0.016 the far tray still fades but the rock keeps its own albedo.
   *   `fog 0x4a2f18 x fogBoost 1.35` — and that colour was a saturated orange. Every pixel
   *     was therefore lerped toward one orange, which is the definition of one hue. The fog
   *     is a cool slate now: the room's *air* is the cool half of the frame and the lamps
   *     are the warm half, so there are two hues in the picture without a second light.
   *   `lift 0x1a1208` — a warm floor under the display range. It is why the cave measured
   *     `pureBlack 0.00` and `belowL8 0.00`: no pixel in a cave could be dark, or neutral.
   *   `saturation 1.30` on top of all of that.
   *
   * `sun` stays high and warm and still does not cast (`enclosed: 1`, DECISIONS #43) — it
   * is the shaft from the openings, and it is the only thing separating a floor from a wall
   * in here, so cutting it was tried and measured *flatter*, not less muddy.
   */
  cave: OUTDOOR.map((k) => ({
    ...k,
    // The 45 degree camera never frames the dome, but everything the *map* does not cover
    // does show it, and a cave map ends at its own tray. At 0x03040a that boundary read as
    // a hole punched in the frame the moment the fog stopped being thick enough to hide it
    // (it is why the old preset could run `fogDensity 0.040` and never notice). Pitched at
    // the fog's own colour, a little darker, the same boundary reads as air going back.
    skyZenith: c(0x1b2030), skyHorizon: c(0x272d3e), skyGround: c(0x141721),
    ground: c(0x141721),
    hemiSky: c(0x7d92bd), hemiGround: c(0x35343a), ambientColor: c(0x646c82),
    sunTint: c(0xffd0a0), sun: 5.20, sunSize: 0.02,
    hemi: 1.10, ambient: 0.082,
    // Explicit, because `...k` would otherwise inherit the outdoor hour's fills, and those
    // are sized against an outdoor `sun`/`exposure` this preset replaces wholesale.
    bounce: 0.30, bounceColor: c(0xff9c50), camFill: 0.26, camFillColor: c(0xbfc8e0),
    fog: c(0x39415a), fogDensity: 0.019, fogBoost: 1.05,
    // `contrast` is a gain about 0.5, so it has a crush point: everything under
    // `0.5 - 0.5/contrast` of the display range becomes literally 0. At the old 1.14 that
    // was 15.7/255, and the old warm `lift 0x1a1208` cleared it on red (26) and *not* on
    // blue (8) — which is the whole of the one-hue reading, arithmetically: every unlit
    // pixel in the cave had its blue channel clamped to zero and its red held up by the
    // lift, so the room could only ever be orange. The lift is cool now and clears the
    // crush on all three channels.
    // Round 6: `exposure` 1.00 -> 1.20 replaces the highlight that the raised bloom
    // threshold below gives up, and it is what `hunts` asked for by a different route —
    // unlit rock is dark rather than exactly (0,0,0).
    exposure: 1.20, contrast: 1.20, saturation: 1.42,
    // The only lights in the room are the practicals, so they are the only thing that can
    // make a highlight — every blind round has said our frames have none. Round 5 set the
    // threshold at 0.72 to get one, and it worked; what it also did was halo every character
    // in the room. Measured: a lit sprite's face and a lamp's ground pool sit at *the same*
    // HDR value in here (both drop out of the bloom between threshold 1.8 and 2.4), so no
    // threshold separates them — the choice is which one to keep. At 0.72 the trainer under
    // the west lamp is a cream blob with no outline, no eye and no mouth; at 1.80 the
    // silhouette, the eye, the mouth and the shirt are all back, and the lamp pools still
    // glow. The 9 levels of p99 that costs are bought back by `exposure` above.
    bloom: 1.30, bloomThreshold: 1.80,
    // Measured, not taste: at 0.38 the frame's own corners sampled rgb(0,0,9) with a lift of
    // 0x0e1119 under them, and a quarter of `belowL8` was the vignette rather than the
    // scene. Neither cave reference has a dark corner in it.
    vignette: 0.20, grain: 0.020, haze: 0.55, stars: 0, lamps: 1.0,
    lift: c(0x0b1122), gain: c(0xfff2e2),
    // There is no sky in here. See `key()`'s note on `enclosed`.
    enclosed: 1,
  })),

  /** Open water: more airborne salt, a cooler bounce off the sea, a paler distance. */
  coast: tinted(OUTDOOR, (k) => ({
    hemiSky: pull(k.hemiSky, 0x63a8cf, 0.28),
    hemiGround: pull(k.hemiGround, 0x2c4a52, 0.45),
    fogDensity: k.fogDensity * 1.3,
    fog: pull(k.fog, isDark(k) ? 0x0d1c2e : 0x9dc6d6, 0.4),
    fogBoost: k.fogBoost * 1.08,
    haze: Math.min(1, k.haze + 0.16),
    saturation: k.saturation * 0.98,
  })),

  /** Snow: everything bounces, so the fill is big and the shadows go blue, not black. */
  tundra: tinted(OUTDOOR, (k) => ({
    hemiSky: pull(k.hemiSky, 0xa9c8ea, 0.35),
    hemiGround: pull(k.hemiGround, 0x7d97b4, 0.7),
    hemi: k.hemi * 1.25,
    fog: pull(k.fog, isDark(k) ? 0x1b2740 : 0xc3d8ea, 0.5),
    fogDensity: k.fogDensity * 1.45,
    saturation: k.saturation * 0.9,
    exposure: k.exposure * 0.92,
  })),

  /** Roofed, lit by lamps and windows; a constant look with a hint of the hour outside. */
  interior: OUTDOOR.map((k) => ({
    ...k,
    skyZenith: c(0x080a12), skyHorizon: c(0x101422), skyGround: c(0x07080e),
    ground: c(0x090a10),
    hemiSky: c(0x5a6480), hemiGround: c(0x2a2118), ambientColor: c(0xffe9cc),
    sunTint: c(0xffe2b8), sun: 1.9 + 1.9 * (k.hour > 6 && k.hour < 18 ? 1 : 0),
    hemi: 0.48, ambient: 0.055,
    bounce: 0.22, bounceColor: c(0xffd0a0), camFill: 0.34, camFillColor: c(0xffe6cc),
    fog: c(0x14161f), fogDensity: 0.010, fogBoost: 1.0,
    exposure: 0.62, contrast: 1.16, saturation: 1.26,
    bloom: 0.55, bloomThreshold: 1.10,
    vignette: 0.30, grain: 0.014, haze: 0.20, stars: 0, lamps: 1.0,
    lift: c(0x140f08), gain: c(0xfff6ea),
    enclosed: 1,
  })),
};

const LERP_FIELDS = ['sun', 'sunSize', 'hemi', 'ambient', 'bounce', 'camFill',
  'enclosed', 'fogDensity', 'fogBoost',
  'exposure', 'contrast', 'saturation', 'bloom', 'bloomThreshold', 'vignette', 'grain',
  'haze', 'stars', 'lamps'];
const COLOR_FIELDS = ['skyZenith', 'skyHorizon', 'skyGround', 'ground', 'hemiSky',
  'hemiGround', 'ambientColor', 'sunTint', 'bounceColor', 'camFillColor', 'fog', 'lift', 'gain'];

/** Interpolates a preset at `tod`, wrapping across midnight. */
export function blendPreset(tod, keys) {
  const t = ((tod % 24) + 24) % 24;
  const last = keys[keys.length - 1];
  let a = last, b = keys[0], span, frac;

  if (t < keys[0].hour || t >= last.hour) {
    span = (24 - a.hour) + b.hour;
    frac = span <= 0 ? 0 : ((t >= a.hour ? t - a.hour : t + 24 - a.hour) / span);
  } else {
    for (let i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i].hour && t < keys[i + 1].hour) { a = keys[i]; b = keys[i + 1]; break; }
    }
    span = b.hour - a.hour;
    frac = span <= 0 ? 0 : (t - a.hour) / span;
  }
  // Smoothstep, so the look eases into each keyframe instead of turning a corner.
  const s = frac * frac * (3 - 2 * frac);

  const out = {};
  for (const f of LERP_FIELDS) out[f] = a[f] + (b[f] - a[f]) * s;
  // Exposure spans 1.2..9.6 across the day. Lerping that linearly spends most of dusk
  // already at night levels; lerping the logarithm keeps each step the same number of
  // stops, which is how the eye reads a fade.
  out.exposure = Math.exp(Math.log(a.exposure) + (Math.log(b.exposure) - Math.log(a.exposure)) * s);
  for (const f of COLOR_FIELDS) out[f] = a[f].clone().lerp(b[f], s);
  return out;
}

/**
 * Weather rewrites the look on top of the blended keyframe (ARCHITECTURE §5.3).
 *
 * Everything here is a multiplier or a colour pull so a storm at dawn stays a dawn: the
 * hour still decides the palette, the weather decides how much air is in front of it.
 * `particles` is read by weather.js; the rest lands on the lights and the grade.
 *
 * @param {object} look   a blended keyframe (mutated in place and returned)
 * @param {{name:string,intensity:number}} weather
 */
export function applyWeather(look, weather) {
  const i = Math.max(0, Math.min(1, weather.intensity ?? 0));
  const name = weather.name ?? 'clear';
  look.particles = { kind: 'none', amount: 0 };
  if (i <= 0.001 || name === 'clear') return look;

  const grey = (col, t, hex) => col.lerp(c(hex), t);

  if (name === 'rain') {
    // An overcast sky: the disc is gone, the whole dome becomes the source, and the wet
    // ground darkens rather than brightens.
    look.sun *= 1 - 0.78 * i;
    look.hemi *= 1 + 0.35 * i;
    // With no disc there is nothing for the ground to bounce, but the whole dome becomes a
    // source, so the camera-side fill goes up as the anti-sun bounce goes away.
    look.bounce *= 1 - 0.70 * i;
    look.camFill *= 1 + 0.30 * i;
    grey(look.hemiSky, 0.55 * i, 0x69788c);
    grey(look.hemiGround, 0.45 * i, 0x2a3038);
    look.fogDensity *= 1 + 2.6 * i;
    grey(look.fog, 0.6 * i, 0x525f70);
    look.fogBoost = look.fogBoost * (1 - 0.35 * i) + 0.35 * i;
    look.saturation *= 1 - 0.30 * i;
    look.contrast *= 1 - 0.07 * i;
    look.exposure *= 1 - 0.10 * i;
    look.bloom *= 1 + 0.30 * i;
    look.vignette = Math.min(0.62, look.vignette + 0.10 * i);
    look.haze = Math.min(1, look.haze + 0.30 * i);
    look.lamps = Math.max(look.lamps, 0.55 * i);
    look.particles = { kind: 'rain', amount: i };
  } else if (name === 'fog') {
    // Fog is the one weather that *should* wash out — but it must wash out with distance,
    // so density climbs hard while the near-field grade stays honest.
    look.sun *= 1 - 0.55 * i;
    look.hemi *= 1 + 0.55 * i;
    look.bounce *= 1 - 0.55 * i;
    look.camFill *= 1 + 0.40 * i;
    // 7.5x was a white-out: the ground vanished by 20 units and there was nothing left to
    // light. 3.4x still hides the far side of the map and keeps the near field readable.
    look.fogDensity *= 1 + 3.4 * i;
    grey(look.fog, 0.5 * i, 0x9aa6b0);
    look.fogBoost = look.fogBoost * (1 - 0.45 * i) + (1.12) * 0.45 * i;
    look.saturation *= 1 - 0.34 * i;
    look.contrast *= 1 - 0.12 * i;
    look.bloom *= 1 + 0.5 * i;
    look.haze = Math.min(1, look.haze + 0.45 * i);
    look.lamps = Math.max(look.lamps, 0.45 * i);
    look.particles = { kind: 'mist', amount: i };
  } else if (name === 'snow') {
    // Snow bounces: the fill goes up and blue, the key softens, the air holds flakes.
    look.sun *= 1 - 0.42 * i;
    look.hemi *= 1 + 0.75 * i;
    // Snow bounces from the ground too, so this is the one weather that keeps its bounce.
    look.bounce *= 1 - 0.15 * i;
    look.camFill *= 1 + 0.55 * i;
    grey(look.hemiSky, 0.5 * i, 0xa8c4e4);
    grey(look.hemiGround, 0.6 * i, 0x8098b4);
    look.fogDensity *= 1 + 2.2 * i;
    grey(look.fog, 0.55 * i, 0xaebfd2);
    look.saturation *= 1 - 0.32 * i;
    look.contrast *= 1 - 0.05 * i;
    look.exposure *= 1 + 0.04 * i;
    look.bloom *= 1 + 0.25 * i;
    look.haze = Math.min(1, look.haze + 0.30 * i);
    look.lamps = Math.max(look.lamps, 0.4 * i);
    look.particles = { kind: 'snow', amount: i };
  }
  return look;
}

export const WEATHERS = ['clear', 'rain', 'fog', 'snow'];

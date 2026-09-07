/**
 * Time-of-day and biome look presets.
 *
 * Each biome defines keyframes at fixed hours; `blendPreset` interpolates between the two
 * that bracket the current time, wrapping across midnight. Keeping the look in data means a
 * critic's note ("dusk is too magenta") is a number change, not a shader rewrite.
 */

import * as THREE from 'three';

const c = (hex) => new THREE.Color(hex);

/** One keyframe. Colours are authored in sRGB and converted for the linear pipeline. */
function key(hour, o) {
  return {
    hour,
    skyZenith: c(o.zenith), skyHorizon: c(o.horizon), ground: c(o.ground), fog: c(o.fog),
    fogDensity: o.fogDensity, hemi: o.hemi, ambient: o.ambient, sunScale: o.sunScale,
    exposure: o.exposure, bloom: o.bloom, bloomThreshold: o.bloomThreshold ?? 0.72,
    saturation: o.saturation ?? 1.06, haze: o.haze ?? 0.35,
    lift: c(o.lift ?? 0x000000), gain: c(o.gain ?? 0xffffff),
  };
}

/** The outdoor default. Other biomes start from this and override what differs. */
const OUTDOOR = [
  key(0.0, { zenith: 0x060a1c, horizon: 0x12203c, ground: 0x070a12, fog: 0x0d1730,
    fogDensity: 0.020, hemi: 0.28, ambient: 0.10, sunScale: 0.85, exposure: 1.30,
    bloom: 0.95, bloomThreshold: 0.42, saturation: 0.90, haze: 0.20,
    lift: 0x060a14, gain: 0xc8d8ff }),
  key(5.4, { zenith: 0x1b3564, horizon: 0x6b5a7a, ground: 0x1a1a22, fog: 0x4a4560,
    fogDensity: 0.019, hemi: 0.55, ambient: 0.13, sunScale: 0.9, exposure: 1.18,
    bloom: 0.78, bloomThreshold: 0.55, saturation: 1.02, haze: 0.62,
    lift: 0x050308, gain: 0xffe8e0 }),
  key(7.0, { zenith: 0x4a86cf, horizon: 0xd8b39a, ground: 0x2b3020, fog: 0xc8b8b0,
    fogDensity: 0.014, hemi: 0.85, ambient: 0.15, sunScale: 1.0, exposure: 1.06,
    bloom: 0.60, bloomThreshold: 0.66, saturation: 1.08, haze: 0.52,
    lift: 0x020202, gain: 0xfff4ea }),
  key(12.0, { zenith: 0x2f74d0, horizon: 0xb9d9f2, ground: 0x39421f, fog: 0xb6d4ee,
    fogDensity: 0.0090, hemi: 1.05, ambient: 0.16, sunScale: 1.0, exposure: 1.00,
    bloom: 0.48, bloomThreshold: 0.78, saturation: 1.07, haze: 0.30,
    lift: 0x000000, gain: 0xffffff }),
  key(17.4, { zenith: 0x3a6fbe, horizon: 0xe8b787, ground: 0x33361d, fog: 0xd9b795,
    fogDensity: 0.0115, hemi: 0.92, ambient: 0.15, sunScale: 1.05, exposure: 1.04,
    bloom: 0.66, bloomThreshold: 0.62, saturation: 1.12, haze: 0.55,
    lift: 0x030100, gain: 0xfff0dc }),
  key(19.0, { zenith: 0x2b3f7d, horizon: 0xe0774f, ground: 0x241f1c, fog: 0xa5714f,
    fogDensity: 0.0150, hemi: 0.62, ambient: 0.14, sunScale: 1.10, exposure: 1.12,
    bloom: 0.86, bloomThreshold: 0.50, saturation: 1.16, haze: 0.72,
    lift: 0x060200, gain: 0xffe2c4 }),
  key(20.6, { zenith: 0x101a3c, horizon: 0x53406a, ground: 0x11121c, fog: 0x33304c,
    fogDensity: 0.0185, hemi: 0.38, ambient: 0.12, sunScale: 0.9, exposure: 1.24,
    bloom: 0.92, bloomThreshold: 0.44, saturation: 0.98, haze: 0.42,
    lift: 0x050810, gain: 0xd6e0ff }),
];

function override(base, hour, patch) {
  return base.map((k) => (Math.abs(k.hour - hour) < 0.01 ? { ...k, ...patch } : k));
}

/** Shifts every keyframe of a preset by a set of multipliers/colours. */
function tinted(base, fn) {
  return base.map((k) => ({ ...k, ...fn(k) }));
}

export const PRESETS = {
  meadow: OUTDOOR,

  city: tinted(OUTDOOR, (k) => ({
    // A town holds more haze from rooftops and, at night, sodium light bouncing off it.
    fogDensity: k.fogDensity * 0.85,
    ground: k.ground.clone().lerp(c(0x453d33), 0.45),
    ambient: k.ambient * 1.15,
    bloom: k.hour >= 19 || k.hour < 6 ? k.bloom * 1.25 : k.bloom,
    fog: k.hour >= 19 || k.hour < 6 ? k.fog.clone().lerp(c(0x40331f), 0.35) : k.fog,
  })),

  forest: tinted(OUTDOOR, (k) => ({
    // Light filtered through canopy: greener bounce, denser air, less sky.
    fogDensity: k.fogDensity * 1.9,
    fog: k.fog.clone().lerp(c(0x2c4a24), 0.45),
    ground: k.ground.clone().lerp(c(0x1d3316), 0.6),
    skyHorizon: k.skyHorizon.clone().lerp(c(0x6f9153), 0.28),
    hemi: k.hemi * 0.85,
    saturation: k.saturation * 1.04,
    haze: Math.min(1, k.haze + 0.15),
  })),

  cave: OUTDOOR.map((k) => ({
    ...k,
    // No sky at all: a cave is lit by its own openings and by whatever glows down there.
    skyZenith: c(0x05070c), skyHorizon: c(0x0a0d16), ground: c(0x05060a),
    fog: c(0x0b0e18), fogDensity: 0.055,
    hemi: 0.22, ambient: 0.06, sunScale: 0.0,
    exposure: 1.35, bloom: 1.15, bloomThreshold: 0.34, saturation: 0.94, haze: 0.9,
    lift: c(0x070604), gain: c(0xffd9b0),
  })),

  coast: tinted(OUTDOOR, (k) => ({
    fogDensity: k.fogDensity * 1.25,
    fog: k.fog.clone().lerp(c(0xbfd8e0), 0.4),
    ground: k.ground.clone().lerp(c(0x4a5a52), 0.5),
    haze: Math.min(1, k.haze + 0.2),
    saturation: k.saturation * 0.99,
  })),

  interior: OUTDOOR.map((k) => ({
    ...k,
    skyZenith: c(0x0a0e18), skyHorizon: c(0x121826), ground: c(0x0a0c12),
    fog: c(0x121826), fogDensity: 0.012,
    hemi: 0.5, ambient: 0.28, sunScale: 0.25,
    exposure: 1.05, bloom: 0.5, bloomThreshold: 0.7, saturation: 1.02, haze: 0.2,
  })),

  tundra: tinted(OUTDOOR, (k) => ({
    fog: k.fog.clone().lerp(c(0xd6e6f2), 0.55),
    fogDensity: k.fogDensity * 1.5,
    ground: k.ground.clone().lerp(c(0xa8bcc8), 0.6),
    saturation: k.saturation * 0.88,
  })),
};

const LERP_FIELDS = ['fogDensity', 'hemi', 'ambient', 'sunScale', 'exposure', 'bloom',
  'bloomThreshold', 'saturation', 'haze'];
const COLOR_FIELDS = ['skyZenith', 'skyHorizon', 'ground', 'fog', 'lift', 'gain'];

/** Interpolates a preset at `tod`, wrapping across midnight. */
export function blendPreset(tod, keys) {
  const t = ((tod % 24) + 24) % 24;
  let a = keys[keys.length - 1], b = keys[0], span, frac;

  if (t < keys[0].hour || t >= keys[keys.length - 1].hour) {
    a = keys[keys.length - 1]; b = keys[0];
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
  for (const f of COLOR_FIELDS) out[f] = a[f].clone().lerp(b[f], s);
  return out;
}

/**
 * Solar geometry and colour temperature.
 *
 * We want shadows that a player would accept without thinking: pointing away from a sun
 * that rises in the east, crosses the south, sets in the west, and is high at noon in
 * summer and low in winter. That is cheap to compute exactly, so we do.
 */

const DEG = Math.PI / 180;

/**
 * The fictional date the whole game is set on.
 *
 * Day 96 (early April at 36 N) puts the declination near +6 degrees, which gives:
 *   sunrise 5.70   noon altitude 60 deg, shadows 0.6x height   sunset 18.29
 *   golden hour 17.2-18.0, altitude 13 down to 5 deg, shadows 4x to 11x height
 *
 * A midsummer date (the previous default, day 140) put the sun 74 degrees up at noon, and a
 * 74-degree sun leaves almost no shadow to read: every prop sat on a dark smudge and the
 * frame went flat exactly when it should have been at its most legible. Early April keeps
 * shadows visible at every hour without making noon look like late afternoon.
 */
export const DAY_OF_YEAR = 96;

/**
 * @param {number} tod   hours, 0..24, 12 = solar noon
 * @param {number} latDeg fictional latitude, degrees north
 * @param {number} dayOfYear used for declination; defaults to `DAY_OF_YEAR`.
 * @returns {{altitude:number, azimuth:number, dir:{x:number,y:number,z:number}, dayFraction:number}}
 *   `altitude` and `azimuth` are radians; azimuth is measured clockwise from north.
 *   `dir` points from the world toward the sun in engine axes (+x east, +y up, +z south).
 */
export function solarPosition(tod, latDeg = 36, dayOfYear = DAY_OF_YEAR, look = null) {
  const lat = latDeg * DEG;
  // Cooper's equation for declination.
  const decl = 23.45 * DEG * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
  const hourAngle = (tod - 12) * 15 * DEG;

  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

  const cosAlt = Math.cos(altitude);
  let azimuth;
  if (Math.abs(cosAlt) < 1e-6) {
    azimuth = Math.PI;
  } else {
    const cosAz = (Math.sin(decl) - Math.sin(lat) * sinAlt) / (Math.cos(lat) * cosAlt);
    azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz)));
    if (hourAngle > 0) azimuth = 2 * Math.PI - azimuth;   // afternoon: west of south
  }

  // The true altitude decides the *day*: dawn, dusk and how much light there is are all
  // driven by where the sun really is, so they stay physical.
  const dayFraction = Math.max(0, sinAlt);

  // What gets *drawn*, though, is bent by the two art-direction knobs (altitude and azimuth offsets).
  // The offset rotates the arc off the camera's axis; the elevation is soft-capped by
  // `MAX · (1 − e^(−alt/MAX))`, which is monotone, holds 0 at 0, never reaches the cap and
  // has no plateau at noon — so the sun still climbs and sinks, it just never gets overhead.
  let shownAz = azimuth;
  let shownAlt = altitude;
  if (look) {
    shownAz = azimuth + (look.azimuthOffset ?? 0);
    const max = look.maxElevation ?? 0;
    if (max > 0 && altitude > 0) shownAlt = max * (1 - Math.exp(-altitude / max));
  }

  const shownCosAlt = Math.cos(shownAlt);
  // azimuth 0 = north (-z), pi/2 = east (+x)
  const x = Math.sin(shownAz) * shownCosAlt;
  const z = -Math.cos(shownAz) * shownCosAlt;
  const y = Math.sin(shownAlt);

  return { altitude: shownAlt, azimuth: shownAz, trueAltitude: altitude, trueAzimuth: azimuth,
    dir: { x, y, z }, dayFraction };
}

/**
 * Planckian locus approximation (Tanner Helland's fit), 1000–12000K, returned as a
 * three-compatible {r,g,b} in linear-ish sRGB primaries. Used to warm the sun near the
 * horizon instead of tinting the whole frame orange.
 */
export function kelvinToRGB(kelvin) {
  const t = Math.max(1000, Math.min(12000, kelvin)) / 100;
  let r, g, b;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  const clamp = (v) => Math.max(0, Math.min(255, v)) / 255;
  // Returned as a bare {r,g,b}: THREE.Color.copy() only reads those three fields, so the
  // caller can copy this straight into a light or a uniform without allocating a Color.
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

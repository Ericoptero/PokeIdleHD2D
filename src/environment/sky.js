/**
 * Solar geometry and colour temperature.
 *
 * We want shadows that a player would accept without thinking: pointing away from a sun
 * that rises in the east, crosses the south, sets in the west, and is high at noon in
 * summer and low in winter. That is cheap to compute exactly, so we do.
 */

const DEG = Math.PI / 180;

/**
 * @param {number} tod   hours, 0..24, 12 = solar noon
 * @param {number} latDeg fictional latitude, degrees north
 * @param {number} dayOfYear used for declination; defaults to a late-spring day so the
 *   default look is a generous, high sun.
 * @returns {{altitude:number, azimuth:number, dir:{x:number,y:number,z:number}, dayFraction:number}}
 *   `altitude` and `azimuth` are radians; azimuth is measured clockwise from north.
 *   `dir` points from the world toward the sun in engine axes (+x east, +y up, +z south).
 */
export function solarPosition(tod, latDeg = 36, dayOfYear = 140) {
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

  // azimuth 0 = north (-z), pi/2 = east (+x)
  const x = Math.sin(azimuth) * cosAlt;
  const z = -Math.cos(azimuth) * cosAlt;
  const y = Math.sin(altitude);

  return { altitude, azimuth, dir: { x, y, z }, dayFraction: Math.max(0, sinAlt) };
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

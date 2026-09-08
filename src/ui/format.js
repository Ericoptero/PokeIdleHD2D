/**
 * The strings the UI puts on screen. Pure, DOM-free, and therefore testable under Node —
 * `selftest.js` imports this file and `font.js` and nothing else.
 */

/** `12345.7` → `12,345`. Balances keep their fractions; only displays are floored (#16). */
export const fmt = (n) => Math.floor(Number(n) || 0).toLocaleString('en-US');

/** `1234567` → `1.2M`, for a column too narrow for the real number. */
export function shortNumber(n) {
  const v = Math.floor(Number(n) || 0);
  const abs = Math.abs(v);
  if (abs < 100000) return v.toLocaleString('en-US');
  for (const [scale, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (abs >= scale) return `${(v / scale).toFixed(abs / scale >= 100 ? 0 : 1)}${suffix}`;
  }
  return String(v);
}

/**
 * `18300` → `5 h 5 m`. `offline` formats its own durations and puts the words on the
 * payload; a payload that came from `preview()` carries only the seconds, so the same
 * shapes are derived here rather than demanded of the caller.
 */
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} m` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** `nidoran-f` → `Nidoran F`. Species keys are lower-case with dashes everywhere else. */
export function titleCase(raw) {
  return String(raw ?? '').replace(/(^|[-_ ])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase());
}

/** `17.53` → `17:31`. The clock reads hours-and-minutes off a float time of day. */
export function clockTime(tod) {
  const t = Number(tod);
  const safe = Number.isFinite(t) ? ((t % 24) + 24) % 24 : 0;
  const hh = Math.floor(safe);
  const mm = Math.floor((safe - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

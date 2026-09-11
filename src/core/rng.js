// @ts-check
/**
 * Seeded RNG. `Math.random()` is banned in src/ (ARCHITECTURE §2.5) — every random
 * decision the game makes must be replayable from a seed and an input log.
 *
 * xoshiro128** : 128 bits of state, fast, and free of the low-bit weakness that makes
 * xorshift128 unusable for gameplay rolls.
 */

/** FNV-1a over a string, used to derive stream seeds from labels. */
export function hashString(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** SplitMix32, used only to expand one seed into four state words. */
function splitmix32(a) {
  return function () {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0);
  };
}

export function makeRng(seed = 1337, label = 'root') {
  const mix = splitmix32((hashString(label) ^ (seed >>> 0)) >>> 0);
  let s0 = mix(), s1 = mix(), s2 = mix(), s3 = mix();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const rot = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;

  /** @returns {number} uniform in [0, 1) */
  function next() {
    const result = Math.imul(rot(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
    s3 = rot(s3, 11);
    return result / 4294967296;
  }

  const api = {
    seed, label,
    next,
    /** integer in [min, max] inclusive */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    /** float in [min, max) */
    float: (min, max) => min + next() * (max - min),
    bool: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** picks by weight; `weights[i]` need not sum to 1 */
    weighted(items, weights) {
      let total = 0;
      for (const w of weights) total += w;
      let r = next() * total;
      for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
      return items[items.length - 1];
    },
    /** Fisher–Yates, in place, deterministic */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    /** A child stream. Sibling streams never interfere, so call order across modules
     *  cannot perturb another module's results. */
    fork: (childLabel) => makeRng(seed, `${label}/${childLabel}`),
    /** Snapshot/restore for save games. */
    save: () => [s0, s1, s2, s3],
    load: ([a, b, c, d]) => { s0 = a >>> 0; s1 = b >>> 0; s2 = c >>> 0; s3 = d >>> 0; },
  };
  return api;
}

/** Deterministic value noise in [0,1), for scatter and variation. Not a stream. */
export function noise2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x27d4eb2d) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

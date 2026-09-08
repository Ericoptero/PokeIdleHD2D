/**
 * Composition primitives for the hunt biomes.
 *
 * A biome is a *place*, not noise with a tint, and the difference is almost entirely in
 * the shape of its regions. A rectangle of tall grass reads as a texture swatch; the same
 * area grown from a seeded blob with a ragged edge reads as a meadow. Everything here is a
 * deterministic function of `(cx, cz, seed)` so a map rebuilt from the same seed is the
 * same map, which is what makes a screenshot a regression test.
 */

import { noise2 } from '../core/rng.js';

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Interpolated value noise on a lattice of `period` cells, in [0,1).
 *
 * The interpolation is the point. Per-cell `noise2` gives neighbours unrelated values and
 * the eye finds the grid instantly (`tiles` measured exactly this — DECISIONS #30e); a
 * smoothed lattice gives patches many cells across with no step at any cell edge.
 */
export function valueNoise(x, z, seed, period = 8) {
  const fx = x / period, fz = z / period;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = smooth(fx - x0), tz = smooth(fz - z0);
  const n00 = noise2(x0, z0, seed), n10 = noise2(x0 + 1, z0, seed);
  const n01 = noise2(x0, z0 + 1, seed), n11 = noise2(x0 + 1, z0 + 1, seed);
  return lerp(lerp(n00, n10, tx), lerp(n01, n11, tx), tz);
}

/** Two octaves, weighted so the large lattice decides the shape and the small one frays it. */
export function fbm2(x, z, seed, period = 12, detail = 0.35) {
  const a = valueNoise(x, z, seed, period);
  const b = valueNoise(x, z, seed ^ 0x5bf03635, Math.max(2, period >> 2));
  return a * (1 - detail) + b * detail;
}

/**
 * `fbm2` sampled at a **domain-warped** position, which is the difference between a blob
 * and a shape.
 *
 * Round 1 thresholded plain `fbm2` and then ran `ragged` over the boundary, and the meadow's
 * tall grass came out a 15x16 rectangle with a one-cell wobble on it — measured off the
 * field itself, not guessed (DECISIONS #37). Two things conspire: a threshold on a smooth
 * lattice gives long axis-aligned level sets wherever the lattice gradient is small, and
 * `ragged` can only ever move the boundary by one cell because it flips *edge* cells. One
 * cell at 35 screen pixels per cell is not a shape.
 *
 * Warping the sample position by a few cells of independent noise moves the boundary by
 * `amp` cells instead of one, and it moves it *coherently* — the level set bends rather than
 * dissolving into speckle. The patch stays one patch; it just stops being a rectangle.
 */
export function warpedFbm(x, z, seed, { period = 6, detail = 0.4, amp = 3, warpPeriod = 5 } = {}) {
  const wx = (valueNoise(x, z, seed ^ 0x1d3a91, warpPeriod) - 0.5) * 2 * amp;
  const wz = (valueNoise(x, z, seed ^ 0x7c2e05, warpPeriod) - 0.5) * 2 * amp;
  return fbm2(x + wx, z + wz, seed, period, detail);
}

/**
 * A boolean cell field with the set operations a composed map actually needs.
 *
 * Regions are built by combining fields — "the clearing, grown two cells, minus the path"
 * — rather than by writing one predicate per cell with every rule tangled into it.
 */
export class Field {
  constructor(w, h, fn = null) {
    this.w = w; this.h = h;
    this.bits = new Uint8Array(w * h);
    if (fn) this.fill(fn);
  }

  idx(cx, cz) { return cz * this.w + cx; }
  inside(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }
  get(cx, cz) { return this.inside(cx, cz) ? this.bits[this.idx(cx, cz)] : 0; }
  set(cx, cz, v = 1) { if (this.inside(cx, cz)) this.bits[this.idx(cx, cz)] = v ? 1 : 0; }

  fill(fn) {
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) this.bits[this.idx(cx, cz)] = fn(cx, cz) ? 1 : 0;
    }
    return this;
  }

  clone() { const f = new Field(this.w, this.h); f.bits.set(this.bits); return f; }
  count() { let n = 0; for (const b of this.bits) n += b; return n; }

  union(other) { for (let i = 0; i < this.bits.length; i++) this.bits[i] |= other.bits[i]; return this; }
  subtract(other) { for (let i = 0; i < this.bits.length; i++) if (other.bits[i]) this.bits[i] = 0; return this; }
  intersect(other) { for (let i = 0; i < this.bits.length; i++) this.bits[i] &= other.bits[i]; return this; }
  invert() { for (let i = 0; i < this.bits.length; i++) this.bits[i] ^= 1; return this; }

  /** Grows the region by `n` cells (8-connected). */
  grow(n = 1) {
    for (let step = 0; step < n; step++) {
      const src = new Uint8Array(this.bits);
      for (let cz = 0; cz < this.h; cz++) {
        for (let cx = 0; cx < this.w; cx++) {
          if (src[this.idx(cx, cz)]) continue;
          let hit = 0;
          for (let dz = -1; dz <= 1 && !hit; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = cx + dx, z = cz + dz;
              if (this.inside(x, z) && src[this.idx(x, z)]) { hit = 1; break; }
            }
          }
          if (hit) this.bits[this.idx(cx, cz)] = 1;
        }
      }
    }
    return this;
  }

  /** Shrinks the region by `n` cells; outside the map counts as empty. */
  shrink(n = 1) {
    for (let step = 0; step < n; step++) {
      const src = new Uint8Array(this.bits);
      for (let cz = 0; cz < this.h; cz++) {
        for (let cx = 0; cx < this.w; cx++) {
          if (!src[this.idx(cx, cz)]) continue;
          let all = 1;
          for (let dz = -1; dz <= 1 && all; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = cx + dx, z = cz + dz;
              if (!this.inside(x, z) || !src[this.idx(x, z)]) { all = 0; break; }
            }
          }
          if (!all) this.bits[this.idx(cx, cz)] = 0;
        }
      }
    }
    return this;
  }

  /**
   * Frays the boundary with noise so an edge stops being a circle or a rectangle.
   * Interior cells and cells well outside are untouched — only the boundary band moves,
   * which is what keeps a patch one patch instead of dissolving into confetti.
   */
  ragged(seed, { amount = 0.55, period = 4 } = {}) {
    const src = new Uint8Array(this.bits);
    const isEdge = (cx, cz) => {
      const here = src[this.idx(cx, cz)];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, z = cz + dz;
          const there = this.inside(x, z) ? src[this.idx(x, z)] : 0;
          if (there !== here) return true;
        }
      }
      return false;
    };
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) {
        if (!isEdge(cx, cz)) continue;
        const n = valueNoise(cx, cz, seed, period);
        if (n < amount) this.bits[this.idx(cx, cz)] ^= 1;
      }
    }
    return this;
  }

  /**
   * Fills single-cell diagonal notches, which is what a 13-slot blob palette cannot draw
   * nicely inside a band.
   *
   * A trail that drifts one cell every few rows is a staircase, and at every step the cell
   * on the inside of the step has all four edge neighbours filled and one diagonal empty —
   * the palette's `inner_nw` case. Those slots carry a small wedge of the *other* material,
   * so a run of them paints a dashed green zigzag straight down the middle of a dirt track.
   * The notch is not a feature of the place; it is an artefact of quantising a curve onto a
   * grid, and one pass over a snapshot removes every one of them without touching the real
   * boundary.
   */
  closeCorners() {
    const src = new Uint8Array(this.bits);
    const at = (cx, cz) => (this.inside(cx, cz) ? src[this.idx(cx, cz)] : 0);
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) {
        if (src[this.idx(cx, cz)]) continue;
        const n = at(cx, cz - 1), s = at(cx, cz + 1), w = at(cx - 1, cz), e = at(cx + 1, cz);
        if ((n && w) || (n && e) || (s && w) || (s && e)) this.bits[this.idx(cx, cz)] = 1;
      }
    }
    return this;
  }

  /**
   * Scatters cells *outside* the boundary, thinning with distance, so a mass ends in
   * speckle instead of in a line.
   *
   * `ragged` moves the boundary; this one dissolves it. A patch of tall grass whose last
   * two cells are a broken fringe reads as vegetation that got there on its own; the same
   * patch with a clean edge reads as a mown lawn, and that is what the meadow's rectangles
   * actually were.
   */
  fringe(seed, { reach = 2, density = 0.55, period = 3 } = {}) {
    const src = new Uint8Array(this.bits);
    const at = (cx, cz) => (this.inside(cx, cz) ? src[this.idx(cx, cz)] : 0);
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) {
        if (src[this.idx(cx, cz)]) continue;
        let near = 0;
        for (let dz = -reach; dz <= reach && !near; dz++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (!at(cx + dx, cz + dz)) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dz));
            if (d <= reach) { near = reach + 1 - d; break; }
          }
        }
        if (!near) continue;
        const want = density * (near / reach);
        if (valueNoise(cx, cz, seed, period) < want) this.bits[this.idx(cx, cz)] = 1;
      }
    }
    return this;
  }

  /** Drops islands smaller than `min` cells, so a region has no stray single tiles. */
  despeckle(min = 3) {
    const seen = new Uint8Array(this.bits.length);
    const stack = [];
    for (let i = 0; i < this.bits.length; i++) {
      if (!this.bits[i] || seen[i]) continue;
      const blobCells = [];
      stack.length = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        blobCells.push(j);
        const cx = j % this.w, cz = (j / this.w) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = cx + dx, z = cz + dz;
          if (!this.inside(x, z)) continue;
          const k = this.idx(x, z);
          if (this.bits[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
      if (blobCells.length < min) for (const j of blobCells) this.bits[j] = 0;
    }
    return this;
  }

  /** The occupancy array `tiles.autotile.solvePlacements` wants. */
  occupancy() { return this.bits; }

  forEach(fn) {
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) if (this.bits[this.idx(cx, cz)]) fn(cx, cz);
    }
  }
}

/**
 * A meandering route down (or across) the map, as a list of centres, one per row.
 *
 * Two sines of unrelated period give a curve that neither repeats within a screen nor
 * reads as a random walk. `bias` pulls it towards a target so a path can be made to pass
 * through the place the map is about.
 */
export function meander(from, to, { amp = 6, period = 17, phase = 0, wobble = 3.7, seed = 0 } = {}) {
  const out = [];
  const j = noise2(seed, 991, 0x9e37) * Math.PI * 2;
  for (let i = 0; i <= to.length; i++) {
    const t = i / Math.max(1, to.length);
    const base = lerp(from.centre, to.centre, t);
    out.push(base
      + Math.sin(i / period * Math.PI * 2 + phase + j) * amp
      + Math.sin(i / (period * 0.41) * Math.PI * 2 + j * 1.7) * (amp / wobble));
  }
  return out;
}

/** A soft radial falloff in [0,1]: 1 at the centre of the ellipse, 0 at `1 + feather`. */
export function ellipseFalloff(cx, cz, { x, z, rx, rz, feather = 0.35 }) {
  const dx = (cx + 0.5 - x) / rx, dz = (cz + 0.5 - z) / rz;
  const d = Math.sqrt(dx * dx + dz * dz);
  return clamp01((1 + feather - d) / feather);
}

/**
 * Poisson-ish clump placement: candidate cells in a rect, accepted when far enough from
 * everything already accepted. A lattice with jitter reads as a lattice at a fixed camera;
 * this does not, and it still runs in one pass over the rect.
 */
export function scatterSpaced(rng, { rect, spacing = 3, tries = 1, accept = () => true }) {
  const placed = [];
  const { x, z, w, h } = rect;
  const order = [];
  for (let cz = z; cz < z + h; cz++) for (let cx = x; cx < x + w; cx++) order.push([cx, cz]);
  rng.shuffle(order);
  // `spacing` may be a **function of the cell**, and that is what turns a Poisson disc into
  // a wood. One radius everywhere gives a quasi-lattice — the eye finds the pitch in about a
  // second, which is what the critic measured as "seven evenly spaced crown rows at ~118px".
  // A radius driven by a low-frequency field gives clumps where it is small and glades where
  // it is large. Each accepted point remembers the radius it was accepted at, and a pair is
  // rejected on the larger of the two, so a sparse cell cannot be crowded by a dense one.
  const fn = typeof spacing === 'function' ? spacing : () => spacing;
  for (const [cx, cz] of order) {
    if (rng.next() > tries) continue;
    const s = fn(cx, cz);
    if (!(s > 0)) continue;
    let ok = true;
    for (const p of placed) {
      const dx = p[0] - cx, dz = p[1] - cz;
      const r = Math.max(s, p[2]);
      if (dx * dx + dz * dz < r * r) { ok = false; break; }
    }
    if (!ok || !accept(cx, cz)) continue;
    placed.push([cx, cz, s]);
  }
  return placed;
}

/**
 * Blends two 0xRRGGBB tints and adds a small per-cell dither.
 *
 * The dither is not decoration. A tint that varies smoothly still lands on a *cell*, so a
 * gradient across a floor quantises into bands with a hard step at every cell edge — which
 * is exactly the "hard-edged rectangular tint quilt" the forest floor shipped as. Breaking
 * the band edge with ±`jitter`/255 of noise costs nothing and removes the contour.
 */
export function mixTint(a, b, t, { jitter = 0, cx = 0, cz = 0, seed = 0 } = {}) {
  const k = clamp01(t);
  let out = 0;
  for (let ch = 0; ch < 3; ch++) {
    const shift = 16 - ch * 8;
    const av = (a >> shift) & 0xff, bv = (b >> shift) & 0xff;
    let v = av + (bv - av) * k;
    if (jitter) v += (noise2(cx, cz, (seed ^ 0x2f01) + ch * 7919) - 0.5) * 2 * jitter;
    out |= (v < 0 ? 0 : v > 255 ? 255 : Math.round(v)) << shift;
  }
  return out >>> 0;
}

/**
 * True when a model's geometry stays inside the cells it claims.
 *
 * Three AdAstra "1x1" path tiles do not: `sterr_patch` is a 2x2 bald patch and
 * `rot_dirtpatch` reaches half a cell west, while the catalog records both as one cell. A
 * scatter that trusts `w`/`h` therefore paints a track three cells wider than the path it
 * is supposed to be wearing, and the auto-tiled edge ends up stranded in the middle of a
 * field of dirt — which is exactly what the first forest looked like.
 */
export function snug(model, slack = 0.08) {
  const b = model?.bounds;
  if (!b) return true;
  const w = model.w ?? 1, h = model.h ?? 1;
  return b.min[0] >= -slack && b.max[0] <= w + slack
    && b.min[2] >= -slack && b.max[2] <= h + slack;
}

/**
 * The nearest cell a walker can actually stand on, spiralling out from a wish.
 *
 * Every camera framing teleports the party to a marker, so a marker on rock is a shot of
 * the party stacked on one cell with the queue collapsed behind it — which looks like a
 * rendering bug and is really a map bug. Markers are snapped through this on the way in.
 */
export function walkableNear(draft, cx, cz, maxR = 8) {
  if (draft.passable(cx, cz, 2)) return { cx, cz };
  for (let r = 1; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (draft.inside(x, z) && draft.passable(x, z, 2)) return { cx: x, cz: z };
      }
    }
  }
  return { cx, cz };
}

export { clamp01, lerp, smooth };

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
 * Where a biome stands its wild Pokemon.
 *
 * The whole-game critic's headline was that *nothing lives in the hunting grounds* — "not
 * one wild Pokemon appears in any of the sixteen hunt frames across four biomes and four
 * hours; the city plaza has more creatures in it than the hunting grounds do." Scattering
 * them evenly over the map does not fix that, because a camera at `distance` 27 sees about
 * 25 cells of a 64-cell map: an even scatter puts most of the wildlife outside every frame
 * that is ever shot, and the judged frame stays empty.
 *
 * So the scatter is gathered **around the markers**, `per` creatures each, nearest first,
 * with no cell used twice. The caller passes its markers in judging order — the framing the
 * blind A/B shoots first — because `hunts` takes only the first `WILD_CAP` of the list.
 *
 * @param {{next:() => number, shuffle:Function}} rng a `ctx.rng.fork` stream
 * @param {{w:number, h:number, markers:{cx:number,cz:number}[], radius?:number, per?:number,
 *          spacing?:number, seed?:number, accept:(cx:number,cz:number)=>boolean}} opts
 * @returns {{cx:number, cz:number, dir:number}[]}
 */
export function wildCells(rng, { w, h, markers, radius = 11, per = 3, spacing = 4.5, seed = 0, accept }) {
  const all = scatterSpaced(rng, { rect: { x: 2, z: 2, w: w - 4, h: h - 4 }, spacing, accept });
  const out = [];
  const taken = new Set();
  for (const m of markers) {
    if (!m) continue;
    const near = [];
    for (let i = 0; i < all.length; i++) {
      if (taken.has(i)) continue;
      // **Never in the lane.** Every framing teleports the party onto the marker and walks it
      // east along that row, so a creature standing on it ends up clipped through the
      // trainer — which reads as a rendering fault, not as wildlife. Two rows of clearance
      // is the width of the walk plus the sprite's own ground depth.
      if (Math.abs(all[i][1] - m.cz) <= 2 && all[i][0] > m.cx - 7 && all[i][0] < m.cx + 9) continue;
      const d = Math.max(Math.abs(all[i][0] - m.cx), Math.abs(all[i][1] - m.cz));
      if (d <= radius) near.push([i, d]);
    }
    // A stable sort on the scatter's own order, so the list is a pure function of the seed.
    near.sort((a, b) => a[1] - b[1]);
    for (const [i] of near.slice(0, per)) {
      taken.add(i);
      // Facing is seeded off the cell rather than off draw order, so adding a creature
      // somewhere else on the map cannot turn this one around.
      out.push({ cx: all[i][0], cz: all[i][1], dir: Math.floor(noise2(all[i][0], all[i][1], seed ^ 0x5ee1) * 4) & 3 });
    }
  }
  return out;
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
 * **Two tints, multiplied** — the operation `instanceColor` itself performs, done at author
 * time so one cell can carry two independent gradings at once.
 *
 * A tile's tint is a multiply into its albedo, so a biome that wants to say both "how much
 * canopy is over this cell" *and* "how far this cell is from the light the scene is built
 * around" has to compose the two itself. Laying the second over the first with `mixTint`
 * does not compose them, it throws the first away — which is how the forest floor's canopy
 * ramp disappeared the first time the sun pool was laid over it.
 */
export function mulTint(a, b) {
  let out = 0;
  for (let ch = 0; ch < 3; ch++) {
    const shift = 16 - ch * 8;
    const v = Math.round((((a >> shift) & 0xff) * ((b >> shift) & 0xff)) / 255);
    out |= (v < 0 ? 0 : v > 255 ? 255 : v) << shift;
  }
  return out >>> 0;
}

/**
 * **How lit a cell is by the scene's one practical**, in [0,1]: 1 inside the pool, 0 outside
 * it, smoothstepped, with the boundary broken by a low-frequency wobble so the edge of the
 * light is not a drawn ellipse.
 *
 * This is the shared half of "put a motivated light in the frame". A lamp registered with
 * `environment` lights the *geometry* around it and paints a pool on the floor — but only
 * while `look.lamps` is up, which is night and nothing else. The daylight half of the same
 * composition is albedo: the ground under the gap in the canopy keeps its full colour and
 * everything else is graded down and cooler, which is the only lever a biome has, because an
 * instanced tint is a multiply and can never brighten (`tiles/instanced.js`). One field, two
 * hours, one place — the same trick `biomes/cave.js` grades its floor with.
 *
 * @param {number} cx @param {number} cz
 * @param {{x:number,z:number,rx:number,rz:number,feather?:number,wobble?:number,period?:number}} spec
 * @param {number} seed
 */
export function litAt(cx, cz, spec, seed = 0) {
  const t = ellipseFalloff(cx, cz, spec);
  const wob = spec.wobble
    ? (valueNoise(cx, cz, seed, spec.period ?? 6) - 0.5) * 2 * spec.wobble
    : 0;
  return smooth(clamp01(t + wob));
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

/**
 * The nearest cell with a **clear east-west lane** through it — the marker rule this module
 * learned the hard way.
 *
 * Every camera framing teleports the party onto a marker and then walks it east (see
 * `hunts/index.js`), and two things have to be true of that row or the frame goes back to
 * being the one three blind A/B rounds rejected. `Line.place` lays the whole queue along the
 * walk direction at the teleport, so with `followerGapTiles` 2 and four members the tail sits
 * five cells behind the marker and the lead two ahead: a blocked cell in that span collapses
 * two walkers onto one tile. And `makeScriptedRoute` drops an impassable step *silently*, so
 * a blocked cell ahead does not stall the walk — it turns it north, with nothing in the
 * console to say so.
 *
 * `walkableNear` only promises the marker itself is standable. This promises the lane.
 *
 * **`ahead` is 8, and the 6 it used to be is why three shipped framings still filed north.**
 * The arithmetic, measured on the running page rather than remembered: `Line.place` puts the
 * lead at `cx + 2`, and `advanceTo(3, 7)` runs 22 sim ticks, which at `walkSecondsPerTile`
 * 0.25 is 4.4 tiles — so the lead ends at `cx + 6.4`, *stepping into* `cx + 7`. A lane
 * checked only to `cx + 6` therefore certified a row whose next cell is rock; the step is
 * dropped silently by `makeScriptedRoute`, the route falls through to its next heading, and
 * the queue turns north with nothing in the console. Probed before this change: the cave's
 * `pool` marker at (35, 25) is clear across `cx − 5 … cx + 6` and blocked at both `cx + 7`
 * and `cx + 8`, and the lead reported `dir 2` on `--preset pool` and `--preset close`. Eight
 * is the seven the walk needs plus one cell of margin.
 *
 * **`south` is the second half, and it is the `cave --preset close` regression.** The camera
 * sits south of its focus, so the cells *towards the viewer* are the bottom of the frame. A
 * marker one cell north of a terrace lip put the party on the lip: the trainer was cut off
 * at the waist, the lead's feet vanished into it, and the bottom third of the frame was the
 * flat dark top of the rock below. `passable` alone cannot see that, because a lip is two
 * walkable cells at different heights. So the lane also asks for `south` cells of walkable
 * ground below the marker, and for the whole span — lane and skirt — to be at **one
 * height**: no walker stands on a different level from the one in front of it, and nothing
 * within the frame's near half is a wall.
 *
 * @param {{inside:Function, passable:Function, heightAt:Function}} draft
 * @param {{back?:number, ahead?:number, south?:number, maxR?:number,
 *          bounds?:{x0:number,x1:number,z0:number,z1:number}}} [opts]
 */
export function laneNear(draft, cx, cz, {
  back = 5, ahead = 8, south = 0, maxR = 8, bounds = null,
} = {}) {
  const inRange = (x, z) => !bounds
    || (x >= bounds.x0 && x <= bounds.x1 && z >= bounds.z0 && z <= bounds.z1);
  const level = (x, z) => (typeof draft.heightAt === 'function' ? draft.heightAt(x, z) : 0);
  const clear = (x, z) => {
    const y0 = level(x, z);
    for (let dx = -back; dx <= ahead; dx++) {
      if (!draft.passable(x + dx, z, 3)) return false;
      if (Math.abs(level(x + dx, z) - y0) > 0.26) return false;
    }
    // The skirt the camera looks across. Checked on the *lane's* cells, not just the
    // marker's column, because a lip that starts one cell east is still in the near half.
    for (let dz = 1; dz <= south; dz++) {
      for (let dx = -2; dx <= 3; dx++) {
        if (!draft.passable(x + dx, z + dz, 0)) return false;
        if (Math.abs(level(x + dx, z + dz) - y0) > 0.26) return false;
      }
    }
    return true;
  };
  if (inRange(cx, cz) && clear(cx, cz)) return { cx, cz };
  for (let r = 1; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (draft.inside(x, z) && inRange(x, z) && clear(x, z)) return { cx: x, cz: z };
      }
    }
  }
  // Nothing in range satisfies the whole contract. Relax the *skirt* first — a framing with
  // a lip in the far corner of its near half is a worse picture, but a framing whose queue is
  // stacked on one cell facing north is the defect three blind rounds named, so the lane and
  // the level come first and the skirt is what gives.
  if (south > 0) return laneNear(draft, cx, cz, { back, ahead, south: 0, maxR, bounds });
  return walkableNear(draft, cx, cz, maxR);
}

export { clamp01, lerp, smooth };

// ---------------------------------------------------------------------------
// The hunt loop, and the slots on it (ARCHITECTURE §5.14, DECISIONS #65)
// ---------------------------------------------------------------------------

/**
 * Finds a **closed** circuit the party can walk forever, on the map that was actually built.
 *
 * Hand-written route strings were the obvious way to do this and they are the wrong one: a
 * route is a list of relative directions with no idea where it is, `makeScriptedRoute` skips a
 * blocked step, and three separate places in this module already document routes drifting off
 * their own path when the map grew an obstacle. A route authored against a map is only correct
 * until the composition changes, and the composition changes every round.
 *
 * So the loop is **derived from the draft**, after it is built, and it is a rectangle — because
 * a rectangle's perimeter is closed by construction and can be checked cell by cell in one
 * pass. The search walks candidate sizes from large to small and returns the first perimeter
 * that is passable the whole way round, so a biome gets the biggest circuit its terrain allows
 * rather than the one somebody guessed at.
 *
 * @param {import('../terrain/index.js').MapDraft} draft
 * @param {{cx:number, cz:number}} around  the marker to centre on
 * @param {{min?:number, max?:number, step?:number}} [opts]
 * @returns {{start:{cx:number,cz:number,dir:number}, route:string, cells:{cx:number,cz:number}[],
 *            w:number, h:number}|null}
 */
export function findLoop(draft, around, { min = 7, max = 20, step = 1, margin = 11 } = {}) {
  // `around` may be one cell or a list of them. A cave is a system of galleries and its
  // showcase marker sits in one of them; searching only there found nothing at all and left
  // the biome standing still, so every marker on the draft gets a turn (DECISIONS #65).
  const anchors = (Array.isArray(around) ? around : [around])
    .filter(Boolean)
    .map((a) => ({ cx: Math.round(a.cx ?? draft.w / 2), cz: Math.round(a.cz ?? draft.h / 2) }));
  if (!anchors.length) anchors.push({ cx: draft.w >> 1, cz: draft.h >> 1 });

  /** Walks the perimeter clockwise from the north-west corner, checking every step. */
  const perimeter = (x, z, w, h) => {
    const cells = [];
    const legs = [[EAST_, w - 1], [SOUTH_, h - 1], [WEST_, w - 1], [NORTH_, h - 1]];
    let cx = x; let cz = z;
    for (const [dir, n] of legs) {
      for (let i = 0; i < n; i++) {
        cells.push({ cx, cz });
        const nx = cx + DX[dir];
        const nz = cz + DZ[dir];
        // `passable` is asked in the direction of travel, because a ledge is one-way and a
        // loop that can only be walked anticlockwise is not a loop.
        if (!draft.passable(nx, nz, dir)) return null;
        cx = nx; cz = nz;
      }
    }
    // It has to come home. A rectangle always does, but asserting it here is what makes this
    // function's promise checkable rather than merely intended.
    return (cx === x && cz === z) ? cells : null;
  };

  // Largest first, and the anchors in the order the caller gave them, so a biome gets the
  // biggest circuit its terrain allows near the ground it thinks is worth looking at.
  for (let size = max; size >= min; size -= step) {
    for (let w = size; w >= min; w -= step) {
      const h = size;
      for (const anchor of anchors) {
        // Nudge around the anchor rather than only centring on it: a marker often sits against
        // a cliff, and a few cells of give is the difference between a loop and none.
        for (const [ox, oz] of NUDGES) {
          const x = anchor.cx - ((w / 2) | 0) + ox;
          const z = anchor.cz - ((h / 2) | 0) + oz;
          // **A camera-width clear of every edge.** The camera follows the trainer and the
          // trainer is ON the loop, so a circuit that runs near a border walks the frame off
          // the end of the world — the first meadow capture had a third of the screen in flat
          // sky (docs/progress/hunts/r6). At ppu 32 a 640-wide buffer sees twenty cells across
          // and about sixteen deep, so eleven is the half-width plus a tile of slack.
          if (x < margin || z < margin) continue;
          if (x + w > draft.w - margin || z + h > draft.h - margin) continue;
          const cells = perimeter(x, z, w, h);
          if (!cells) continue;
          return {
            start: { cx: x, cz: z, dir: EAST_ },
            route: `e${w - 1} s${h - 1} w${w - 1} n${h - 1}`,
            cells, w, h,
          };
        }
      }
    }
  }
  return null;
}

/**
 * Spawn slots for a loop: cells at Chebyshev distance **exactly 2** from the path.
 *
 * Two, and the arithmetic is the whole reason (§5.14): a tethered wild drifts one tile off its
 * slot and the encounter trigger reaches one tile from the walking head, so two is contact.
 * One closer and the party is permanently in a battle; one further and a lap never meets
 * anything.
 *
 * Slots are spread along the circuit rather than clustered, so a lap is a series of encounters
 * instead of one ambush. Deterministic: the walk order is the perimeter's own order and the
 * only randomness is which side of the path a slot sits on.
 *
 * @param {import('../terrain/index.js').MapDraft} draft
 * @param {{cx:number,cz:number}[]} loopCells
 * @param {{next:() => number}} rng
 * @param {{count?:number, accept?:(cx:number,cz:number)=>boolean}} [opts]
 */
export function slotsForLoop(draft, loopCells, rng, { count = 10, accept } = {}) {
  if (!loopCells?.length || count <= 0) return [];
  const near = (cx, cz) => loopCells.some((c) => Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) < 2);
  const taken = new Set();
  const out = [];
  const stride = Math.max(1, Math.floor(loopCells.length / count));

  for (let i = 0; i < loopCells.length && out.length < count; i += stride) {
    const c = loopCells[i];
    // The four cells two out from this step, shuffled so a lap does not always meet its
    // wildlife on the same shoulder.
    const candidates = [[2, 0], [-2, 0], [0, 2], [0, -2]];
    for (let k = candidates.length - 1; k > 0; k--) {
      const j = Math.floor(rng.next() * (k + 1));
      [candidates[k], candidates[j]] = [candidates[j], candidates[k]];
    }
    for (const [dx, dz] of candidates) {
      const cx = c.cx + dx;
      const cz = c.cz + dz;
      const key = `${cx},${cz}`;
      if (taken.has(key)) continue;
      if (!draft.inside(cx, cz)) continue;
      // A slot must be somewhere a creature can stand and drift on, and it must NOT be on the
      // path — `near` rejects anything within one cell of the circuit, which is what keeps the
      // distance at two rather than at "two or less".
      if (!draft.passable(cx, cz, 0)) continue;
      if (near(cx, cz)) continue;
      if (draft.occupied[draft.idx(cx, cz)]) continue;
      if (accept && !accept(cx, cz)) continue;
      taken.add(key);
      // Facing the path, so a wild reads as having noticed the party rather than as scenery.
      out.push({ cx, cz, dir: dx > 0 ? WEST_ : dx < 0 ? EAST_ : dz > 0 ? NORTH_ : SOUTH_ });
      break;
    }
  }
  return out;
}

/** `core/dir.js`'s numbers, spelled out locally so this file keeps its single core import. */
const SOUTH_ = 0; const WEST_ = 1; const NORTH_ = 2; const EAST_ = 3;
const DX = [0, -1, 0, 1];
const DZ = [1, 0, -1, 0];
/** Offsets tried around the anchor, nearest first. */
const NUDGES = (() => {
  const out = [];
  for (let r = 0; r <= 6; r++) {
    for (let ox = -r; ox <= r; ox++) {
      for (let oz = -r; oz <= r; oz++) {
        if (Math.max(Math.abs(ox), Math.abs(oz)) === r) out.push([ox, oz]);
      }
    }
  }
  return out;
})();

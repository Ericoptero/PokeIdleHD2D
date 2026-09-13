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
import { bfsCells } from '../core/path.js';

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Interpolated value noise on a lattice of `period` cells, in [0,1).
 *
 * The interpolation is the point. Per-cell `noise2` gives neighbours unrelated values and
 * the eye finds the grid instantly (`tiles` measured exactly this); a
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
 * field itself, not guessed. Two things conspire: a threshold on a smooth
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
// The hunt loop, and the slots on it (src/hunts/index.js)
// ---------------------------------------------------------------------------

/**
 * Finds a **closed** circuit the party can walk forever, on the map that was actually built.
 *
 * This is the fallback, not the plan. `stitchLoop` (below) is authored-first: a biome that
 * declares an ordered list of its own markers gets a circuit stitched through them, in the
 * order asked, on the draft that was actually built. Hand-written route *strings* are still
 * the wrong way to do it — a route is a list of relative directions with no idea where it is,
 * `makeScriptedRoute` skips a blocked step, and three separate places in this module already
 * document routes drifting off their own path when the map grew an obstacle — but a list of
 * marker names has none of that problem, because it is resolved against the draft on every
 * build rather than baked in once.
 *
 * `findLoop` is what runs when there is no authored list, or when stitching one fails: a
 * rectangle, because a rectangle's perimeter is closed by construction and can be checked cell
 * by cell in one pass. The search walks candidate sizes from large to small and returns the
 * first perimeter that is passable the whole way round, so a biome gets the biggest circuit
 * its terrain allows rather than the one somebody guessed at — a floor under the authored path,
 * not a replacement for it.
 *
 * @param {import('../terrain/index.js').MapDraft} draft
 * @param {{cx:number, cz:number}} around  the marker to centre on
 * @param {{min?:number, max?:number, step?:number}} [opts]
 * @returns {{start:{cx:number,cz:number,dir:number}, route:string, cells:{cx:number,cz:number}[],
 *            w:number, h:number}|null}
 */
export function findLoop(draft, around, {
  min = 7, max = 20, step = 1, margin = 11,
  corners = 12, depth = 3, preferTags = ['path'], rng = null, straightLead = 4,
} = {}) {
  // `around` may be one cell or a list of them. A cave is a system of galleries and its
  // showcase marker sits in one of them; searching only there found nothing at all and left
  // the biome standing still, so every marker on the draft gets a turn.
  const anchors = (Array.isArray(around) ? around : [around])
    .filter(Boolean)
    .map((a) => ({ cx: Math.round(a.cx ?? draft.w / 2), cz: Math.round(a.cz ?? draft.h / 2) }));
  if (!anchors.length) anchors.push({ cx: draft.w >> 1, cz: draft.h >> 1 });

  const base = findRectangle(draft, anchors, { min, max, step, margin, preferTags });
  if (!base) return null;

  // **The rectangle is the FLOOR, not the shape.** It is what can be guaranteed — a
  // perimeter that is closed by construction and checkable in one pass — and a circuit that
  // turns four square corners does not read as a trail through a wood. So it is bent: each
  // `bump` displaces a straight run one cell sideways, which adds four corners and **cannot
  // open the ring**, because it replaces a path between two cells with another path between
  // the same two cells. Every bump is verified against the draft before it is kept, and a map
  // with no room for any of them keeps the rectangle rather than failing.
  const cells = growCorners(draft, base.cells, {
    corners, depth, preferTags, rng, margin,
  });

  // **The ring must START on a straight, and long enough for the whole queue.**
  //
  // `hunts.enter` stands the trainer on `cells[0]` and the lead Pokemon — the walker that
  // follows the route — lands `gap` cells ahead of it. That is only on the ring when the first
  // `gap` steps all go the same way, which a rectangle gives for free at a corner and a bent
  // circuit does not: the coast at twelve corners started one cell before a turn, put the head
  // off the path, and spent 690 of 800 ticks away from its own loop while `audit` called the
  // loop clean — because it was. Nobody was standing on it.
  const ordered = rotateToStraight(cells, straightLead);

  return {
    start: { cx: ordered[0].cx, cz: ordered[0].cz, dir: dirBetween(ordered[0], ordered[1]) },
    route: routeOf(ordered),
    cells: ordered,
    corners: cornerCount(ordered),
    w: base.w,
    h: base.h,
  };
}

/**
 * Stitches a **closed** circuit through an ordered list of waypoints — the authored
 * counterpart to `findLoop` above, and the one that actually gets tried first: a biome that
 * declares its own markers in the order it wants them visited gets a circuit through exactly
 * those markers, on the draft that was actually built, rather than one `findRectangle` happened
 * to grow near them. `findLoop` is what a caller falls back to when this fails.
 *
 * `points` is a plain list of cells — the ring is implicitly closed, the last point connecting
 * back to the first — and this function knows nothing about marker *names*; resolving a name to
 * a cell is the caller's job (`hunts/index.js`), exactly as `findLoop`'s own `around` is already
 * cells, not names.
 *
 * One **leg** per consecutive pair of points (`a -> b`, including the wraparound), built by
 * trying, in order:
 *
 *   1. An **X-then-Z elbow** — straight along X at `a`'s row, then straight along Z at `b`'s
 *      column — and its mirror, a **Z-then-X elbow**. Whichever is fully passable and crosses
 *      more `preferTags` ground wins; tied, X-first wins, so the result has no hidden rng.
 *   2. `bfsCells`, when *neither* elbow is fully passable, followed by one straightening pass:
 *      a raw BFS leg is shortest but shaped like a staircase, and a staircase inflates
 *      `cornerCount` and can leave the ring with no straight run at all — the coast defect
 *      `findLoop`'s own header used to document. The pass looks for the two most distant
 *      indices on a shared row or column and, if the direct segment between them is passable,
 *      splices it in — a cosmetic repair, not a shortest-path guarantee.
 *
 * A leg that cannot be built by any of the above fails the **whole ring** — `onLegFailed` is
 * told which pair and `stitchLoop` returns `null` — because silently routing around a waypoint
 * hands back a circuit nobody authored, in a shape nobody reviewed.
 *
 * The assembled ring is then held to exactly the standard `findLoop`'s own bumps already meet:
 * closed and passable (`isClosedWalk`), every cell distinct (a folded-back ring sterilises its
 * own shoulders — see `applyBump`'s overlap check above, and `Line.step`'s own comment in
 * `src/simulation/line.js` on why a 180-degree reversal is never special-cased), every cell at
 * least `margin` from the map edge (the stitched cells between authored markers may not satisfy
 * the camera framing the markers themselves were snapped for), and an opening straight run at
 * least `straightLead` long — checked independently of `rotateToStraight`, because that helper
 * silently returns the ring **unchanged** when nothing qualifies rather than reporting failure.
 *
 * @param {import('../terrain/index.js').MapDraft} draft
 * @param {{cx:number, cz:number}[]} points  ordered waypoints; the ring closes last -> first
 * @param {{straightLead?:number, preferTags?:string[], margin?:number, maxTiles?:number,
 *          onLegFailed?:(info:{index:number, from:object, to:object}) => void,
 *          onReject?:(reason:string) => void}} [opts]
 * @returns {{start:{cx:number,cz:number,dir:number}, route:string, cells:{cx:number,cz:number}[],
 *            corners:number, w:number, h:number, source:'authored'}|null}
 */
export function stitchLoop(draft, points, opts = {}) {
  const {
    straightLead = 4,
    preferTags = ['path', 'tallgrass'],
    margin = 11,
    maxTiles = 4096,
    onLegFailed = null,
    onReject = null,
  } = opts;

  const reject = (reason) => {
    if (onReject) onReject(reason);
    return null;
  };

  if (!Array.isArray(points) || points.length < 3) {
    return reject('need at least 3 waypoints');
  }

  // One leg per consecutive pair, wrapping the last point back to the first — the ring is
  // implicitly closed, never asked for as an explicit N+1th point.
  const legs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const leg = buildLeg(draft, a, b, { preferTags, maxTiles });
    if (!leg) {
      if (onLegFailed) onLegFailed({ index: i, from: a, to: b });
      return null;
    }
    legs.push(leg);
  }

  // Concatenate: the first leg in full, then every later leg minus its first cell (which
  // duplicates the previous leg's last cell). The final cell of the last leg duplicates
  // `points[0]` again — the ring closing — so it is popped rather than kept twice.
  const cells = legs[0].slice();
  for (let i = 1; i < legs.length; i++) cells.push(...legs[i].slice(1));
  cells.pop();

  // Held to exactly the standard the found loop already meets, first failure wins.
  if (!isClosedWalk(draft, cells)) return reject('stitched ring is not a valid closed walk');

  const seen = new Set();
  for (const c of cells) {
    const k = `${c.cx},${c.cz}`;
    if (seen.has(k)) return reject(`stitched ring revisits cell (${k})`);
    seen.add(k);
  }

  for (const c of cells) {
    if (c.cx < margin || c.cz < margin || c.cx > draft.w - margin || c.cz > draft.h - margin) {
      return reject(`cell (${c.cx},${c.cz}) is within ${margin} of the map edge`);
    }
  }

  // `rotateToStraight` silently returns the ring UNCHANGED when nothing qualifies, so its
  // result has to be independently checked rather than trusted — the same check
  // `hunts/index.js`'s own `stageOnLoop`/`straightAt` makes on the ring it is handed.
  const ordered = rotateToStraight(cells, straightLead);
  const n = ordered.length;
  const dir0 = dirBetween(ordered[0], ordered[1]);
  let lead = 0;
  while (lead < straightLead
    && dirBetween(ordered[lead % n], ordered[(lead + 1) % n]) === dir0) lead++;
  if (lead < straightLead) return reject('no opening straight run long enough');

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const c of ordered) {
    if (c.cx < minX) minX = c.cx;
    if (c.cx > maxX) maxX = c.cx;
    if (c.cz < minZ) minZ = c.cz;
    if (c.cz > maxZ) maxZ = c.cz;
  }

  return {
    start: { cx: ordered[0].cx, cz: ordered[0].cz, dir: dirBetween(ordered[0], ordered[1]) },
    route: routeOf(ordered),
    cells: ordered,
    corners: cornerCount(ordered),
    w: maxX - minX + 1,
    h: maxZ - minZ + 1,
    source: 'authored',
  };
}

/** One straight-line step, checked in the direction of travel — `dirBetween`'s own rule. */
function stepDir(dCx, dCz) {
  if (dCx === 1) return EAST_;
  if (dCx === -1) return WEST_;
  return dCz === 1 ? SOUTH_ : NORTH_;
}

/**
 * Walks a straight run of `steps` unit steps from `from` along `(dCx, dCz)` — exactly one of
 * which is non-zero — pushing each new cell onto `out`. Returns the final cell, or `null` the
 * moment a step is not passable in the direction it is taken.
 */
function walkStraight(draft, from, dCx, dCz, steps, out) {
  const dir = stepDir(dCx, dCz);
  let cx = from.cx; let cz = from.cz;
  for (let i = 0; i < steps; i++) {
    const nx = cx + dCx; const nz = cz + dCz;
    if (!draft.passable(nx, nz, dir)) return null;
    out.push({ cx: nx, cz: nz });
    cx = nx; cz = nz;
  }
  return { cx, cz };
}

/**
 * One elbow leg from `a` to `b`, inclusive: straight along X then straight along Z (`xFirst`),
 * or the mirror. `null` the instant either arm is not fully passable.
 */
function elbowLeg(draft, a, b, xFirst) {
  const cells = [{ cx: a.cx, cz: a.cz }];
  const dCx = Math.sign(b.cx - a.cx);
  const dCz = Math.sign(b.cz - a.cz);
  if (xFirst) {
    if (dCx !== 0 && !walkStraight(draft, a, dCx, 0, Math.abs(b.cx - a.cx), cells)) return null;
    const mid = { cx: b.cx, cz: a.cz };
    if (dCz !== 0 && !walkStraight(draft, mid, 0, dCz, Math.abs(b.cz - a.cz), cells)) return null;
  } else {
    if (dCz !== 0 && !walkStraight(draft, a, 0, dCz, Math.abs(b.cz - a.cz), cells)) return null;
    const mid = { cx: a.cx, cz: b.cz };
    if (dCx !== 0 && !walkStraight(draft, mid, dCx, 0, Math.abs(b.cx - a.cx), cells)) return null;
  }
  return cells;
}

/** How many of a leg's cells carry any tag in `preferTags`. */
function legTagScore(draft, cells, preferTags) {
  if (!preferTags?.length) return 0;
  let n = 0;
  for (const c of cells) {
    const tags = draft.tagsAt(c.cx, c.cz);
    if (tags && tags.some((t) => preferTags.includes(t))) n++;
  }
  return n;
}

/** The direct line between two cells that share a row or column, inclusive of `b`, or `null`. */
function straightSegment(draft, a, b) {
  const dCx = Math.sign(b.cx - a.cx);
  const dCz = Math.sign(b.cz - a.cz);
  const steps = Math.max(Math.abs(b.cx - a.cx), Math.abs(b.cz - a.cz));
  const out = [];
  const end = walkStraight(draft, a, dCx, dCz, steps, out);
  return end ? out : null;
}

/**
 * One cosmetic repair pass over a raw BFS leg: a grid BFS staircases around obstacles one cell
 * at a time, and every one of those steps is a corner `cornerCount` will later count. Repeatedly
 * finds the most distant pair of indices that share a row or column and whose direct segment is
 * passable, and splices the staircase between them for the straight line — not a shortest-path
 * guarantee, just enough to stop a BFS leg from reading as a zigzag.
 */
function straightenLeg(draft, cells) {
  let list = cells;
  for (let pass = 0; pass < 6; pass++) {
    let bestI = -1; let bestJ = -1; let bestSeg = null; let bestLen = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = list.length - 1; j > i + 1; j--) {
        if (j - i <= bestLen) break;                 // nothing left this row can beat the best
        if (list[i].cx !== list[j].cx && list[i].cz !== list[j].cz) continue;
        const seg = straightSegment(draft, list[i], list[j]);
        if (!seg) continue;
        bestI = i; bestJ = j; bestSeg = seg; bestLen = j - i;
      }
    }
    if (bestI < 0) break;
    list = [...list.slice(0, bestI + 1), ...bestSeg, ...list.slice(bestJ + 1)];
  }
  return list;
}

/**
 * One leg of a stitched ring: the better of the two elbows when both are passable, whichever
 * one is when only one is, or a straightened BFS walk when neither is.
 */
function buildLeg(draft, a, b, { preferTags, maxTiles }) {
  const legXZ = elbowLeg(draft, a, b, true);
  const legZX = elbowLeg(draft, a, b, false);
  if (legXZ && legZX) {
    const scoreXZ = legTagScore(draft, legXZ, preferTags);
    const scoreZX = legTagScore(draft, legZX, preferTags);
    return scoreZX > scoreXZ ? legZX : legXZ;         // tie -> X-then-Z, deterministic
  }
  if (legXZ) return legXZ;
  if (legZX) return legZX;

  const passable = (cx, cz, dir) => draft.passable(cx, cz, dir);
  const bfs = bfsCells(a, b, passable, { maxTiles });
  if (!bfs) return null;
  return straightenLeg(draft, bfs);
}

/**
 * Rotates a closed ring so it begins at the start of a run of at least `minRun` steps.
 *
 * Prefers the longest run, so the queue has the most room to string itself out before the
 * first turn. Returns the ring unchanged when nothing is long enough — which can only happen
 * on a circuit bent past the point of having any straights, and is then correctly the caller's
 * problem rather than silently the wrong start.
 */
export function rotateToStraight(cells, minRun = 3) {
  const runs = straightRuns(cells).filter((r) => r.len >= minRun);
  if (!runs.length) return cells;
  const best = runs.reduce((a, b) => (b.len > a.len ? b : a));
  const n = cells.length;
  return Array.from({ length: n }, (_, i) => cells[(best.start + i) % n]);
}

/** The guaranteed circuit: the largest passable rectangle perimeter that fits. */
function findRectangle(draft, anchors, { min, max, step, margin, preferTags = [] }) {
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

  /**
   * **Every fitting rectangle is scored; the best one wins.**
   *
   * This used to return the FIRST rectangle that fit, walking height-major — `size` from `max`
   * down, and for each `size` a width from `size` down to `min`. So a **6x22 corridor** was
   * found and accepted before a 21x21 square was ever tried, because the whole width sweep at
   * size 22 runs before size 21 begins. Measured on the shipped meadow: the circuit came out a
   * 6x17 corridor at x 38-43, fifty cells of a 64x60 map, hugging one edge — with the campfire
   * that is the biome's only night practical **14 cells away** and the marker every showcase
   * frames 23 away. The party walked a corner of a map it never saw.
   *
   * Three things decide it now, and each is there for a reason a picture shows:
   *
   *   - **area**, because a bigger ring walks more of the map and holds more spawn slots;
   *   - **squareness**, because a corridor reads as a corridor and, at Chebyshev 2, its two
   *     sides compete for the same cells — which is why a narrow ring thins its own slots;
   *   - **composed ground**, the share of the ring standing on `preferTags`. This is what pulls
   *     the circuit onto the trail the biome laid, and with it past the lamps and props that
   *     make a frame worth looking at.
   *
   * Anchors keep their order as a gentle tie-break, so a biome's own `showcaseDefault` still
   * pulls the ring toward the place it wanted framed without being able to buy a bad shape.
   */
  const tagsOf = (cx, cz) => (typeof draft.tagsAt === 'function' ? draft.tagsAt(cx, cz) ?? [] : []);
  const wanted = new Set(preferTags ?? []);
  const composedFraction = (cells) => {
    if (!wanted.size || !cells.length) return 0;
    let n = 0;
    for (const c of cells) if (tagsOf(c.cx, c.cz).some((t) => wanted.has(t))) n++;
    return n / cells.length;
  };

  let best = null;
  for (let h = max; h >= min; h -= step) {
    for (let w = max; w >= min; w -= step) {
      for (let a = 0; a < anchors.length; a++) {
        const anchor = anchors[a];
        for (const [ox, oz] of NUDGES) {
          const x = anchor.cx - ((w / 2) | 0) + ox;
          const z = anchor.cz - ((h / 2) | 0) + oz;
          // **A camera-width clear of every edge.** The camera follows the trainer and the
          // trainer is ON the loop, so a circuit that runs near a border walks the frame off
          // the end of the world — the first meadow capture had a third of the screen in flat
          // sky. At ppu 32 a 640-wide buffer sees twenty cells across and about sixteen deep,
          // so eleven is the half-width plus a tile of slack.
          if (x < margin || z < margin) continue;
          if (x + w > draft.w - margin || z + h > draft.h - margin) continue;
          // Cheap rejections first: the score is only worth computing for a ring that closes.
          if (best && w * h <= best.floor) continue;
          const cells = perimeter(x, z, w, h);
          if (!cells) continue;
          const squareness = Math.min(w, h) / Math.max(w, h);
          const score = w * h
            * (0.45 + 0.55 * squareness)
            * (1 + 0.60 * composedFraction(cells))
            * (1 - 0.01 * Math.min(a, 20));
          if (!best || score > best.score) {
            // `floor` is the area below which no later candidate can possibly beat this one:
            // every multiplier above is at most `1 * 1.6 * 1`, so an area under `score / 1.6`
            // is hopeless. It turns an exhaustive sweep into one that stops looking early.
            best = { cells, w, h, x, z, score, floor: score / 1.6 };
          }
        }
      }
    }
  }
  return best;
}

/**
 * Bends a closed ring until it has about `corners` corners.
 *
 * One **bump** takes a straight run of the ring and pushes it `d` cells sideways. The run's
 * two end cells stay where they are, so the result is still one closed circuit through the
 * same cells as before plus the displaced middle — closure is structural, not checked
 * afterwards and hoped for.
 *
 * Bumps that would leave the map, cross the ring, land on impassable ground or come within a
 * cell of the ring elsewhere are rejected. Among the survivors the one that puts the most
 * `preferTags` cells under the party wins, so a circuit drifts onto the composed trail rather
 * than ignoring it.
 */
function growCorners(draft, ring, { corners, depth, preferTags, rng, margin }) {
  let cells = ring.slice();
  const want = Math.max(4, corners | 0);
  const next = rng ? () => rng.next() : () => 0.5;
  const tagged = (c) => (preferTags.some((t) => draft.tagsAt(c.cx, c.cz).includes(t)) ? 1 : 0);
  const score = (list) => list.reduce((a, c) => a + tagged(c), 0);

  // **A circuit may not balloon into the whole room.** Without this the same bump wins every
  // pass — the highest-scoring one is always the deepest on the longest run — and it just
  // deepens one notch over and over: a 92-cell rectangle became a 216-cell one, still with six
  // corners, because deepening a notch adds none after the first.
  const cap = Math.round(ring.length * 1.55);

  for (let pass = 0; pass < 64 && cornerCount(cells) < want; pass++) {
    const runs = straightRuns(cells).filter((r) => r.len >= 6);
    if (!runs.length) break;
    // Shuffled, so bumps land all round the ring instead of stacking on the longest run.
    for (let k = runs.length - 1; k > 0; k--) {
      const q = Math.floor(next() * (k + 1));
      [runs[k], runs[q]] = [runs[q], runs[k]];
    }

    const before = cornerCount(cells);
    const baseScore = score(cells);
    const candidates = [];
    for (const run of runs) {
      for (const side of [1, -1]) {
        for (let d = Math.max(1, depth | 0); d >= 1; d--) {
          const bumped = applyBump(draft, cells, run, side, d, margin);
          if (!bumped) continue;
          if (bumped.length > cap) continue;
          // The point of a bump is a corner. One that adds none is a longer walk for nothing.
          if (cornerCount(bumped) <= before) continue;
          candidates.push({ cells: bumped, gain: score(bumped) - baseScore, d });
          break;                       // deepest that fits on this run and side
        }
      }
      // Eight is plenty to choose between and keeps a 200-cell ring from being O(n^2) a pass.
      if (candidates.length >= 8) break;
    }
    if (!candidates.length) break;

    // Whichever puts the most `preferTags` ground under the party — the composed trail, in
    // practice — and the shallower one when they tie, because a shallow bend reads as a bend
    // and a deep one reads as a detour.
    candidates.sort((a, b) => b.gain - a.gain || a.d - b.d);
    cells = candidates[0].cells;
  }
  return cells;
}

/** Contiguous runs of the ring that travel in one direction. */
function straightRuns(cells) {
  const n = cells.length;
  const dirs = cells.map((c, i) => dirBetween(c, cells[(i + 1) % n]));
  const runs = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && dirs[i] === dirs[start]) continue;
    if (i - start >= 3) runs.push({ start, len: i - start, dir: dirs[start] });
    start = i;
  }
  return runs;
}

/**
 * Displaces the middle of one run sideways by `d`, keeping both ends anchored.
 *
 * Returns a new ring, or `null` when any of the new ground is unusable. The rejection tests
 * are the ones that keep a bump from turning a circuit into a figure of eight: the displaced
 * cells may not touch the rest of the ring, and every step of the new path is checked in the
 * direction it is walked.
 */
function applyBump(draft, cells, run, side, d, margin) {
  const n = cells.length;
  const dir = run.dir;
  // Left or right of travel, in the 4-way basis.
  const perp = side > 0 ? (dir + 1) & 3 : (dir + 3) & 3;

  // The two cells that stay put. Everything between them is replaced, so the ring is still one
  // path between the same two points and closure is structural rather than hoped for.
  //
  // **One cell in from each end of the run, not right at the corners.** At a corner the
  // perpendicular to this run is parallel to the adjacent one, so the ladder's first step
  // lands exactly ON the neighbouring side — every one of the eight candidates a pass
  // produced was rejected as an overlap, and the corner count never moved off four.
  const from = run.start + 2;
  const to = run.start + run.len - 2;
  if (to - from < 1) return null;
  const A = cells[(from - 1) % n];
  const L = to - from + 2;                      // steps along `dir` from A to B
  const at = (a, b) => ({ cx: A.cx + DX[perp] * a + DX[dir] * b, cz: A.cz + DZ[perp] * a + DZ[dir] * b });

  // A -> out to depth d -> along the run -> back in, landing exactly on B.
  //
  // The first cut stitched straight from A to the displaced run and the two are a knight's
  // move apart (one along `dir`, d along `perp`), so every candidate failed the closed-walk
  // check and NO bump was ever applied — four corners on every biome at every setting. The
  // ladder out and the ladder back are what make the two ends meet.
  const inserted = [];
  for (let a = 1; a <= d; a++) inserted.push(at(a, 0));
  for (let b = 1; b <= L; b++) inserted.push(at(d, b));
  for (let a = d - 1; a >= 1; a--) inserted.push(at(a, L));

  const keep = [];
  for (let i = 0; i < n; i++) if (i < from || i > to) keep.push(cells[i]);
  const occupied = new Set(keep.map((c) => `${c.cx},${c.cz}`));

  for (const c of inserted) {
    if (c.cx < margin || c.cz < margin) return null;
    if (c.cx > draft.w - margin || c.cz > draft.h - margin) return null;
    if (!draft.passable(c.cx, c.cz, 0)) return null;
    // Overlap only, not adjacency: the ladder's first cell is a diagonal step from A, which is
    // *supposed* to be beside the ring. What must not happen is the bump landing ON the ring
    // somewhere else and turning one circuit into a figure of eight.
    if (occupied.has(`${c.cx},${c.cz}`)) return null;
  }

  const out = [];
  for (let i = 0; i < from; i++) out.push(cells[i]);
  out.push(...inserted);
  for (let i = to + 1; i < n; i++) out.push(cells[i]);

  return isClosedWalk(draft, out) ? out : null;
}


/** Every consecutive pair one 4-way step apart, passable, and the last pair closing the ring. */
export function isClosedWalk(draft, cells) {
  const n = cells.length;
  if (n < 8) return false;
  for (let i = 0; i < n; i++) {
    const a = cells[i];
    const b = cells[(i + 1) % n];
    const dx = b.cx - a.cx;
    const dz = b.cz - a.cz;
    if (Math.abs(dx) + Math.abs(dz) !== 1) return false;
    const dir = dx === 1 ? EAST_ : dx === -1 ? WEST_ : dz === 1 ? SOUTH_ : NORTH_;
    if (!draft.passable(b.cx, b.cz, dir)) return false;
  }
  return true;
}

const dirBetween = (a, b) => {
  if (b.cx > a.cx) return EAST_;
  if (b.cx < a.cx) return WEST_;
  return b.cz > a.cz ? SOUTH_ : NORTH_;
};

/** How many times the walk turns. Four for a rectangle, and the number this file is about. */
export function cornerCount(cells) {
  const n = cells.length;
  let turns = 0;
  for (let i = 0; i < n; i++) {
    const a = dirBetween(cells[i], cells[(i + 1) % n]);
    const b = dirBetween(cells[(i + 1) % n], cells[(i + 2) % n]);
    if (a !== b) turns++;
  }
  return turns;
}

/** Run-length encodes a ring back into the `'e8 s10 w8 n10'` spelling `parseRoute` reads. */
export function routeOf(cells) {
  const n = cells.length;
  const letter = ['s', 'w', 'n', 'e'];
  const out = [];
  let run = 0;
  let dir = dirBetween(cells[0], cells[1]);
  for (let i = 0; i < n; i++) {
    const d = dirBetween(cells[i], cells[(i + 1) % n]);
    if (d === dir) { run++; continue; }
    out.push(`${letter[dir]}${run}`);
    dir = d; run = 1;
  }
  out.push(`${letter[dir]}${run}`);
  return out.join(' ');
}

/**
 * Spawn slots for a loop: cells at Chebyshev distance **exactly 2** from the path.
 *
 * Two, and the arithmetic is the whole reason (src/hunts/index.js): a tethered wild drifts one tile off its
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

      /**
       * **The approach, and why it is exactly one cell.**
       *
       * Every offset above is *axial* — `[±2,0]` or `[0,±2]` — so the midpoint between the
       * path cell and the slot is a single step off the circuit. It is Chebyshev 1 from the
       * slot, Chebyshev 1 from the path cell, and (because `near` has just rejected anything
       * within one cell of the circuit) it is **provably never a loop cell**. That is what
       * makes a detour a queued pair `[step, opposite(step)]` rather than a path search: the
       * head steps off, makes contact, fights, and steps back onto the cell it left, so the
       * route's index is untouched by construction.
       *
       * A slot you cannot step toward — or, on a one-way `ledge`, cannot step back from — is
       * not a slot. Rejecting it here rather than discovering it at the edge of a lap is what
       * keeps `strict` honest.
       */
      const step = dx > 0 ? EAST_ : dx < 0 ? WEST_ : dz > 0 ? SOUTH_ : NORTH_;
      const mx = c.cx + DX[step];
      const mz = c.cz + DZ[step];
      if (!draft.inside(mx, mz)) continue;
      if (!draft.passable(mx, mz, step)) continue;
      if (!draft.passable(c.cx, c.cz, (step + 2) & 3)) continue;

      taken.add(key);
      // Facing the path, so a wild reads as having noticed the party rather than as scenery.
      out.push({
        cx, cz,
        dir: dx > 0 ? WEST_ : dx < 0 ? EAST_ : dz > 0 ? NORTH_ : SOUTH_,
        // Where the party leaves the circuit, which way it steps, and where it stands to fight.
        from: { cx: c.cx, cz: c.cz },
        step,
        approach: { cx: mx, cz: mz },
      });
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

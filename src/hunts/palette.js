/**
 * The tile-selection layer every biome author goes through.
 *
 * Two rules the project already paid for are enforced here rather than repeated in four
 * map files:
 *
 *  - **Select by category and tag, never by name** (DECISIONS #6). AdAstra reuses one OBJ
 *    name for five different textures and the classifier names a model after its texture,
 *    so a name is an implementation detail of the build.
 *  - **A region that resolves nothing must say so** (DECISIONS #28b). `solveField` returns
 *    a field of −1 for a set id that is not in the tileset and places nothing, with a clean
 *    console and no missing model anywhere — which is exactly how the city's pond survived
 *    a whole screenshot round as an empty lawn.
 */

/** The registry's null object answers every property with a function — this is the tell. */
export const isLive = (api) => !!api && api.__missing === undefined;

/**
 * **The 13 blob signatures, so a case can be named back into a model.**
 *
 * `solvePlacements` hands back a *case name*; `tiles.autotile.solve(slug, set, sig)` takes a
 * *signature*. This table is the join, and it is the same one `src/tiles/autotile.js`
 * enumerates in `BLOB_CASES` — bit order N S W E NW NE SW SE.
 */
export const SET_CASE_SIG = {
  corner_nw: 10, edge_n: 14, corner_ne: 6,
  edge_w: 11, center: 255, edge_e: 7,
  corner_sw: 9, edge_s: 13, corner_se: 5,
  inner_nw: 239, inner_ne: 223, inner_sw: 191, inner_se: 127,
};

/**
 * **Every `set0` slot in `bw2-adastra` is drawn 180 degrees out, and the corners cannot be
 * turned back — so they are re-cast as the slot next door.**
 *
 * ## What the defect actually is, dumped from `pack.bin` rather than reasoned about
 *
 * The transition art of `set0` lives in `michi01a.png` (32x16; the grass fringe is rows 0-5,
 * the rest is dirt). Every `michi01a` face in the pack carries **`v = +0.0562 … +0.9438`** —
 * DS order, measured *down* from the image's top row — while the `michi01b` fill on the very
 * same models carries **`v = 0 … −0.9999`**, already negated into OpenGL order. `TextureLoader`
 * uploads with `flipY = true`, so the un-negated faces sample **inverted along whichever world
 * axis their `v` happens to run**, and the two materials of one tile disagree. (The `.obj`
 * mirror of the same model negates `v`, which is why reading the OBJ says the pack is fine and
 * reading `pack.bin` says it is not. `pack.bin` is what the game loads.) Repro:
 * `grass_path_side_edge_w` is model 8 at `groups[0].offset 3960`, `grass_path_center` is model 9.
 *
 * This supersedes both the "U runs backwards against world X" framing in
 * `docs/STATUS.json → integratorFindings` and the claim at `src/tiles/materials.js:597` that
 * "a horizontal tile is untouched by a V flip". A horizontal tile is untouched by a flip in
 * *height*; these tiles map `v` onto **X or Z**, and each one picks its own.
 *
 * ## Why a rotation fixes the four edges and not the eight corners
 *
 * `edge_w` maps `v` to world X, so its fringe lands east instead of west: a 180-degree turn is
 * a mirror in X *and* in Z, and a mirror in Z is a no-op on a vertical strip, so the turn is
 * exactly right. `edge_n`/`edge_s` map `v` to Z and are corrected by the same turn. That is
 * four of thirteen, and it is all round 5 shipped.
 *
 * An **outer corner** is not one quad: it is two triangles split on the tile's diagonal, one
 * carrying the north strip with `v` on Z and one carrying the west strip with `v` on X. Each
 * strip is flipped *out of its own triangle*, so all that survives is the sliver that grazes
 * the diagonal — the "green grass comma inside the tan" this module has shipped at every
 * meander step for five rounds. Rotating moves the comma; it cannot put the strips back,
 * because the flip happened in texture space before the triangle clipped it. An **inner
 * corner** is one triangle whose `v` runs from its right-angle corner to its hypotenuse, so
 * the flip puts the fringe *on* the hypotenuse: a green diagonal streak across the road.
 *
 * ## What this does instead
 *
 * Turn everything 180 degrees, and for the eight corners **draw a different slot**:
 *
 *  - an **outer corner** becomes the `edge_*` of whichever of its two exposed sides carries
 *    the longer unbroken shoulder, measured on the field itself. On a north-south trail that
 *    is the west or east side, so the fringe runs *through* the meander step unbroken instead
 *    of stopping at it; on an east-west track the same rule picks north or south. The short
 *    side of the step is left as a plain dirt/grass seam — one cell of it per step.
 *  - an **inner corner** becomes `center`: plain dirt. The artist's grass nub for that slot is
 *    unreachable, and the diagonal streak that stands in for it is worse than nothing.
 *
 * Measured offline on the shipped seed-1337 forest trail by rebuilding both ends from
 * `pack.bin` + `michi01a.png` (`tools`-free; the same 13 slots, the same solver convention,
 * `outsideIsFilled = true`): **green pixels enclosed by dirt on a scanline 960 -> 0**, and dirt
 * pixels meeting bare lawn with no fringe between them **720 -> 222**.
 *
 * The asset fix still belongs in the exporter — one rule covers every slot of every pack — and
 * the coreRequest against `tools/assets` is restated with the `pack.bin` repro above.
 *
 * @param {import('./compose.js').Field} field  the same field being drawn
 * @param {{outsideIsFilled?: boolean}} [opts]  must match what `draw` passes the solver
 * @returns {{rotate: Function, remap: Function}} spread into `palette.draw`'s options
 */
export function set0Outward(field, { outsideIsFilled = true } = {}) {
  const filled = (cx, cz) => ((cx < 0 || cz < 0 || cx >= field.w || cz >= field.h)
    ? (outsideIsFilled ? 1 : 0)
    : field.get(cx, cz));
  /** The neighbour that must be *empty* for a side to be exposed. */
  const OUT = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
  /** The axis a shoulder runs along: a north side runs east-west, a west side north-south. */
  const ALONG = { n: [1, 0], s: [1, 0], w: [0, 1], e: [0, 1] };
  /** How many cells in a row keep this side exposed, counting this one. */
  const shoulder = (cx, cz, side) => {
    const [dx, dz] = OUT[side], [ax, az] = ALONG[side];
    let n = 1;
    for (const s of [1, -1]) {
      let x = cx + ax * s, z = cz + az * s;
      while (filled(x, z) && !filled(x + dx, z + dz)) { n++; x += ax * s; z += az * s; }
    }
    return n;
  };
  /** The two sides an outer corner exposes, longitudinal one first so a tie takes it. */
  const EXPOSED = {
    corner_nw: ['w', 'n'], corner_ne: ['e', 'n'],
    corner_sw: ['w', 's'], corner_se: ['e', 's'],
  };
  return {
    rotate: () => 2,
    remap: (kase, cx, cz) => {
      const sides = EXPOSED[kase];
      if (sides) {
        const [a, b] = sides;
        return `edge_${shoulder(cx, cz, a) >= shoulder(cx, cz, b) ? a : b}`;
      }
      return kase.startsWith('inner_') ? 'center' : null;
    },
  };
}

export function makePalette(tiles, slug, log) {
  const missing = [];
  /** What the last `draw` did, so a selftest can assert the re-cast happened at all. */
  let lastDraw = null;

  /** Every model matching a query, in catalog order. */
  function all(query, why = '') {
    const hits = tiles.find(slug, query) ?? [];
    if (!hits.length) {
      const key = `${slug}:${JSON.stringify(query)}`;
      if (!missing.includes(key)) {
        missing.push(key);
        log.warn(`hunts: no tile in "${slug}" matches ${JSON.stringify(query)}${why ? ` (${why})` : ''}`);
      }
    }
    return hits;
  }

  /** The first match, or null. A null model is a no-op in `draft.place`, never a throw. */
  const one = (query, why = '') => all(query, why)[0] ?? null;

  /**
   * Position-stable variant choice. Same `(cx, cz, salt)` always gives the same model
   * regardless of the order cells are visited in, so a map rebuilt from one seed is the
   * same map even if the author loops over it differently next round.
   */
  const pick = (models, cx, cz, opts) => tiles.pick(models, cx, cz, opts) ?? null;

  /**
   * A palette handle, verified against what the tileset actually ships.
   * @returns {{id:string, kind:string, digsIn:boolean, underlay:boolean}|null}
   */
  function set(setId) {
    const sets = tiles.autotile.sets(slug) ?? [];
    const hit = sets.find((s) => s.id === setId);
    if (!hit) {
      log.warn(`hunts: "${slug}" has no autotile set "${setId}" — it has ${sets.map((s) => `${s.id}(${s.name})`).join(', ')}`);
      return null;
    }
    return hit;
  }

  /**
   * Draws an auto-tiled region into a draft through `solvePlacements`, which is the form
   * that carries the Y each case needs and can lay a water sheet under the whole region
   * first. `draft.autotile` places one model per cell at one Y and can express neither.
   *
   * @param {import('../terrain/draft.js').MapDraft} draft
   * @param {string} setId
   * @param {import('./compose.js').Field} field
   * @param {object} [opts] `underlay`, `y0`, `outsideIsFilled` go to the solver; `skip`,
   *   `tint`, `rotate` and `remap` are per-cell hooks; the rest (`collision`, `layer`,
   *   `tags`, `claim`) go to `draft.place`.
   * @returns {number} cells actually placed
   */
  function draw(draft, setId, field, opts = {}) {
    const info = set(setId);
    if (!info) return 0;
    const { underlay, y0, outsideIsFilled, skip, tint, rotate, remap, ...place } = opts;
    const covered = field.count();
    const solved = tiles.autotile.solvePlacements(slug, setId, field.occupancy(), field.w, field.h, {
      underlay: underlay ?? !!info.underlay,
      y0: y0 ?? 0,
      ...(outsideIsFilled === undefined ? {} : { outsideIsFilled }),
    });
    let placed = 0;
    let recast = 0;
    for (const p of solved) {
      // `remap` re-casts a solved *case* as a different case of the same set before the model
      // is looked up — the only lever that reaches a slot whose art is unusable at every
      // rotation. See `set0Outward`: an outer corner of `bw2-adastra`'s grass/path set draws
      // as a green comma inside the dirt at all four turns, and the slot next door draws the
      // shoulder correctly. The join goes through `autotile.solve`, which is the same lookup
      // the solver itself used, so a set that does not enumerate the substitute simply keeps
      // the solver's own choice rather than losing the cell.
      let modelId = p.modelId;
      const sub = typeof remap === 'function' ? remap(p.case, p.cx, p.cz) : null;
      if (sub && SET_CASE_SIG[sub] !== undefined) {
        const id = tiles.autotile.solve?.(slug, setId, SET_CASE_SIG[sub]) ?? -1;
        if (id >= 0) { modelId = id; recast++; }
      }
      const model = tiles.byId(slug, modelId);
      if (!model) continue;
      // `skip` exists for one shape of problem: a region that has to keep its *border* but
      // lose its *floor*, because something is going to be sunk into it. A pond dug into a
      // cave floor is the case — the water sheet sits at −0.25 and the floor quad at 0, so
      // laying both leaves the water buried under its own room with a clean console
      // (DECISIONS #28a, the same failure the city's pond had).
      if (skip && skip(p.cx, p.cz, p.case)) continue;
      // `tint` may be a function of the cell. A cave floor lit by a handful of warm bulbs is
      // not one colour, and an auto-tiled region that can only carry one tint is a region
      // that has to be one colour — which is how the cave came out "essentially every pixel
      // fully saturated in one hue" (DECISIONS #37).
      const t = typeof tint === 'function' ? tint(p.cx, p.cz, p.case) : tint;
      // `rotate` is the caller's chance to turn a solved case a quarter or half turn.
      // It exists for one reason and it is not decoration: every `michi01a` face of
      // bw2-adastra's `set0` samples its texture inverted along its own axis, so the strip of
      // grass the artist drew on the tile's *outer* edge lands on its *inner* one — which
      // draws a three-cell trail as three tan runs split by two grass ribbons (DECISIONS #49,
      // #53). The asset fix belongs in the exporter and is filed as a coreRequest; until then
      // a biome that knows its set is inverted can say so here, in one place, per case.
      const r = typeof rotate === 'function' ? rotate(p.case, p.cx, p.cz) : rotate;
      draft.place(model, p.cx, p.cz, {
        ...place, y: p.y, rot: (r ?? p.rot) & 3, claim: false, ...(t === undefined ? {} : { tint: t }),
      });
      placed++;
    }
    if (covered && !placed) {
      log.warn(`hunts: set "${setId}" covered ${covered} cells and resolved none of them — ` +
        'the region is invisible, not absent (DECISIONS #28b)');
    }
    lastDraw = { setId, covered, placed, recast };
    return placed;
  }

  return { slug, all, one, pick, set, draw, missing: () => missing.slice(), lastDraw: () => lastDraw };
}

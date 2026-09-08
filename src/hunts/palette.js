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
 * **The quarter turns that put `bw2-adastra`'s `set0` transition on the outside of a path.**
 *
 * Pass it as `draw`'s `rotate` on any region drawn with that set. It is a workaround for an
 * asset defect and it is written down here, once, rather than in each biome, because it is a
 * property of the *pack* and not of any map.
 *
 * What the defect is, measured in pixels on the shipped seed-1337 forest at 1920x1080
 * (`docs/progress/hunts/r5/road-before.png` against `docs/progress/hunts/r5/road-after.png`): the trail's cell field
 * is three cells wide, and it drew as a **294 px band split into three tan runs by two grass
 * ribbons** — because `edge_w` and `edge_e` come out of the pack mirrored about their own
 * centre, so the strip of grass the artist drew on the tile's *outer* edge is stamped on its
 * *inner* one. The band's outer edges met the lawn with no transition at all and the
 * transition ran down the middle of the road twice. Three rounds of this module's own header
 * claimed the trail was solved; this is what it actually looked like.
 *
 * `rot 2` is a 180-degree turn, which is a horizontal mirror *and* a vertical one — and a
 * vertical mirror is a no-op on a vertical strip of grass, so the turn is exactly the
 * correction those two cases need and nothing more. The four outer and four inner corner
 * cases are deliberately **not** turned: their art is diagonal, a quarter turn moves it to
 * the wrong diagonal, and they are a handful of cells at the trail's meander steps against
 * the ~200 cells of straight run that the two edge cases are. Shot both ways and looked at
 * before choosing (`docs/progress/hunts/r5/`).
 *
 * The real fix belongs in the exporter, where one rule covers every slot of every pack, and
 * is filed as a coreRequest against `tools/assets` — the same place DECISIONS #41a and the
 * `tiles` roof-sign defect already point.
 */
export const SET0_OUTWARD = { edge_w: 2, edge_e: 2 };

export function makePalette(tiles, slug, log) {
  const missing = [];

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
   * @param {object} [opts] `underlay`, `y0`, `outsideIsFilled` go to the solver; the rest
   *   (`collision`, `layer`, `tags`, `claim`) go to `draft.place`.
   * @returns {number} cells actually placed
   */
  function draw(draft, setId, field, opts = {}) {
    const info = set(setId);
    if (!info) return 0;
    const { underlay, y0, outsideIsFilled, skip, tint, rotate, ...place } = opts;
    const covered = field.count();
    const solved = tiles.autotile.solvePlacements(slug, setId, field.occupancy(), field.w, field.h, {
      underlay: underlay ?? !!info.underlay,
      y0: y0 ?? 0,
      ...(outsideIsFilled === undefined ? {} : { outsideIsFilled }),
    });
    let placed = 0;
    for (const p of solved) {
      const model = tiles.byId(slug, p.modelId);
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
      // It exists for one reason and it is not decoration: bw2-adastra's `set0` transition
      // slots come out of the pack **mirrored about their own centre**, so the strip of grass
      // the artist drew on the tile's *outer* edge lands on its *inner* one — which draws a
      // three-cell trail as three tan runs split by two grass ribbons (DECISIONS #49). The
      // asset fix belongs in the exporter and is filed as a coreRequest; until then a biome
      // that knows its set is mirrored can say so here, in one place, per case.
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
    return placed;
  }

  return { slug, all, one, pick, set, draw, missing: () => missing.slice() };
}

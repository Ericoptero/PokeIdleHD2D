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
    const { underlay, y0, outsideIsFilled, skip, tint, ...place } = opts;
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
      draft.place(model, p.cx, p.cz, {
        ...place, y: p.y, rot: p.rot, claim: false, ...(t === undefined ? {} : { tint: t }),
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

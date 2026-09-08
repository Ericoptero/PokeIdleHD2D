/**
 * Where the ground actually is.
 *
 * `terrain.height()` reports the *authored* elevation of a cell, which the demo city never
 * sets — it is a flat map, so every cell reads 0. The tiles standing on those cells are not
 * at 0: AdAstra's grass/path pieces are modelled at baseY 0.07 and its dirt at 0.125
 * (DECISIONS #7). A walker planted at `terrain.height()` therefore sinks its feet into the
 * road and its contact shadow disappears *under* the surface it is supposed to be touching.
 *
 * So the top of each cell is measured the same way `pokemon`'s showcase measures it: over the
 * loaded map's own placements, taking the highest `flat`-tagged model covering the cell. This
 * is a workaround for a gap in `terrain`, not a second source of truth — the moment
 * `terrain.height()` accounts for tile geometry this file can collapse to a passthrough.
 */

/** @param {object} ctx core context */
export function makeSurface(ctx) {
  let top = null;
  let w = 0, h = 0;

  function rebuild() {
    top = null; w = 0; h = 0;
    const terrain = ctx.get('terrain');
    const tiles = ctx.get('tiles');
    const draft = typeof terrain.draft === 'function' ? terrain.draft() : null;
    if (!draft || !draft.w || !draft.h) return false;
    w = draft.w; h = draft.h;
    const grid = new Float32Array(w * h);
    // The authored heightfield is the floor; tile geometry can only add to it.
    for (let cz = 0; cz < h; cz++) {
      for (let cx = 0; cx < w; cx++) grid[cz * w + cx] = draft.heightAt(cx, cz);
    }
    const ts = typeof tiles.get === 'function' ? tiles.get(draft.tileset) : null;
    if (ts?.byId) {
      for (const p of draft.placements) {
        const model = ts.byId.get(p.modelId);
        if (!model || !(model.tags ?? []).includes('flat')) continue;
        const y = (p.y ?? 0) + (model.baseY ?? 0);
        const rot = (p.rot ?? 0) & 1;
        const fw = rot ? (model.h ?? 1) : (model.w ?? 1);
        const fh = rot ? (model.w ?? 1) : (model.h ?? 1);
        for (let dz = 0; dz < fh; dz++) {
          for (let dx = 0; dx < fw; dx++) {
            const cx = p.cx + dx, cz = p.cz + dz;
            if (cx < 0 || cz < 0 || cx >= w || cz >= h) continue;
            const i = cz * w + cx;
            if (y > grid[i]) grid[i] = y;
          }
        }
      }
    }
    top = grid;
    return true;
  }

  /** Top of the walkable surface at a cell. Falls back to `terrain.height()`. */
  function at(cx, cz) {
    const x = Math.floor(cx), z = Math.floor(cz);
    if (top && x >= 0 && z >= 0 && x < w && z < h) return top[z * w + x];
    const terrain = ctx.get('terrain');
    return typeof terrain.height === 'function' ? (terrain.height(x, z) ?? 0) : 0;
  }

  /**
   * Height along a step, so a walker crossing onto a raised tile rises with it instead of
   * popping at the cell boundary.
   */
  function between(fromX, fromZ, toX, toZ, t) {
    const a = at(fromX, fromZ);
    const b = at(toX, toZ);
    return a + (b - a) * Math.min(1, Math.max(0, t));
  }

  return { rebuild, at, between, get ready() { return !!top; } };
}

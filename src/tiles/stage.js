/**
 * A placement list with no dependencies.
 *
 * `terrain` owns the real authoring surface (MapDraft) and every game scene goes through
 * it. The tiles showcase deliberately does not: `tiles` declares `needs: []`, so its own
 * proof must stand up when terrain is mid-edit or quarantined. This is that — thirty lines
 * of "put model at cell", which is all a tile gauntlet needs.
 */
export class Stage {
  constructor(w, h) {
    this.w = w; this.h = h;
    /** @type {import('./instanced.js').Placement[]} */
    this.placements = [];
    /** Ground placement per cell, so a later pass can re-tint the lawn under a footprint. */
    this.ground = new Array(w * h).fill(null);
  }

  inside(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }

  place(model, cx, cz, { y = 0, rot = 0, tint = 0xffffff, layer = 0 } = {}) {
    if (!model) return null;
    const p = { modelId: model.id, cx, cz, y, rot, tint, layer };
    this.placements.push(p);
    return p;
  }

  /**
   * Lays the lawn every stage sits on and remembers it so footprints can be highlighted.
   * `margin` runs the grass past the stage on every side: without it the showcase reads as
   * a slab floating in the void instead of as a piece of a world.
   */
  fillGround(pick, margin = 0, y = 0) {
    for (let cz = -margin; cz < this.h + margin; cz++) {
      for (let cx = -margin; cx < this.w + margin; cx++) {
        const model = typeof pick === 'function' ? pick(cx, cz) : pick;
        const p = this.place(model, cx, cz, { y, layer: -1 });
        if (p && this.inside(cx, cz)) this.ground[cz * this.w + cx] = p;
      }
    }
  }

  tintGround(cx, cz, hex) {
    const p = this.inside(cx, cz) ? this.ground[cz * this.w + cx] : null;
    if (p) p.tint = hex;
  }

  /** Swaps the ground model under one cell — a coastal set needs sea, not grass. */
  setGround(cx, cz, model, y = 0) {
    const p = this.inside(cx, cz) ? this.ground[cz * this.w + cx] : null;
    if (p && model) { p.modelId = model.id; p.y = y; }
  }

  /** Cuts the lawn away — a lake sits below the ground plane, not on it. */
  clearGround(cx, cz) {
    if (!this.inside(cx, cz)) return;
    const i = cz * this.w + cx;
    const p = this.ground[i];
    if (p) { p.removed = true; this.ground[i] = null; }
  }

  finalize() {
    this.placements = this.placements.filter((p) => !p.removed);
    this.placements.sort((a, b) => (a.layer - b.layer) || (a.cz - b.cz) || (a.cx - b.cx));
    return this;
  }
}

/**
 * MapDraft — the authoring surface scenes compose maps with.
 *
 * A draft holds cell-indexed arrays (height, collision, tags) and a flat placement list.
 * Everything is deterministic: given the same seed and the same author function you get
 * the same bytes, which is what makes a screenshot a regression test rather than a
 * snapshot of a mood.
 */

const COLLISION_PASSABLE = new Set(['walk', 'stairs', 'shallow', 'door']);

export class MapDraft {
  constructor({ id, w = 64, h = 64, tileset = 'bw2-adastra', seed = 1337 } = {}) {
    this.id = id;
    this.w = w; this.h = h;
    this.tileset = tileset;
    this.seed = seed;

    this.placements = [];
    this.height = new Float32Array(w * h);
    this.collision = new Array(w * h).fill('block');
    this.tags = new Array(w * h);
    /** Cells already claimed by a multi-cell model, so props do not grow inside a tree. */
    this.occupied = new Uint8Array(w * h);
    this.spawn = { cx: w >> 1, cz: h >> 1, dir: 0 };
    this.markers = new Map();
    this._finalized = false;
  }

  idx(cx, cz) { return cz * this.w + cx; }
  inside(cx, cz) { return cx >= 0 && cz >= 0 && cx < this.w && cz < this.h; }

  // --- cell state -----------------------------------------------------------

  setHeight(cx, cz, y) { if (this.inside(cx, cz)) this.height[this.idx(cx, cz)] = y; }
  heightAt(cx, cz) { return this.inside(cx, cz) ? this.height[this.idx(cx, cz)] : 0; }

  setCollision(cx, cz, kind) { if (this.inside(cx, cz)) this.collision[this.idx(cx, cz)] = kind; }
  collisionAt(cx, cz) { return this.inside(cx, cz) ? this.collision[this.idx(cx, cz)] : 'block'; }

  addTag(cx, cz, tag) {
    if (!this.inside(cx, cz)) return;
    const i = this.idx(cx, cz);
    (this.tags[i] ??= []).push(tag);
  }
  tagsAt(cx, cz) { return this.inside(cx, cz) ? (this.tags[this.idx(cx, cz)] ?? []) : []; }
  hasTag(cx, cz, tag) { return this.tagsAt(cx, cz).includes(tag); }

  /** Ledges are one-way: they may only be crossed travelling in their own direction. */
  passable(cx, cz, fromDir) {
    if (!this.inside(cx, cz)) return false;
    const kind = this.collisionAt(cx, cz);
    if (kind === 'ledge') {
      const dir = this.tagsAt(cx, cz).find((t) => t.startsWith('ledge:'));
      return dir ? Number(dir.slice(6)) === fromDir : false;
    }
    return COLLISION_PASSABLE.has(kind);
  }

  /** Named points scenes and NPCs refer to, e.g. `draft.mark('pokecenter-door', x, z)`. */
  mark(name, cx, cz, extra = {}) { this.markers.set(name, { cx, cz, ...extra }); }
  marker(name) { return this.markers.get(name) ?? null; }

  // --- placement ------------------------------------------------------------

  /**
   * @param {object} model  a tile model from tiles.find(); its `w`/`h` claim cells
   * @param {number} cx @param {number} cz
   * @param {{y?:number, rot?:0|1|2|3, tint?:number, collision?:string, tags?:string[],
   *          claim?:boolean, layer?:number}} [opts]
   */
  place(model, cx, cz, opts = {}) {
    if (!model) return null;
    if (this._finalized) throw new Error('MapDraft.place: draft is already finalized');
    const y = opts.y ?? this.heightAt(cx, cz);
    const p = { modelId: model.id, cx, cz, y, rot: opts.rot ?? 0, tint: opts.tint ?? 0xffffff, layer: opts.layer ?? 0 };
    this.placements.push(p);

    const rot = p.rot & 3;
    const fw = (rot & 1) ? (model.h ?? 1) : (model.w ?? 1);
    const fh = (rot & 1) ? (model.w ?? 1) : (model.h ?? 1);
    const collision = opts.collision ?? model.collision ?? 'block';

    for (let dz = 0; dz < fh; dz++) {
      for (let dx = 0; dx < fw; dx++) {
        const x = cx + dx, z = cz + dz;
        if (!this.inside(x, z)) continue;
        if (collision !== 'none') this.setCollision(x, z, collision);
        if (opts.claim !== false && (fw > 1 || fh > 1)) this.occupied[this.idx(x, z)] = 1;
        for (const t of opts.tags ?? []) this.addTag(x, z, t);
        for (const t of model.tags ?? []) if (t === 'tallgrass' || t === 'encounter') this.addTag(x, z, t);
      }
    }
    return p;
  }

  /** Fills a rectangle with a model (or a per-cell chooser). */
  fill(rect, chooser, opts = {}) {
    const { x = 0, z = 0, w = this.w, h = this.h } = rect;
    for (let cz = z; cz < z + h; cz++) {
      for (let cx = x; cx < x + w; cx++) {
        if (!this.inside(cx, cz)) continue;
        const model = typeof chooser === 'function' ? chooser(cx, cz) : chooser;
        if (model) this.place(model, cx, cz, typeof opts === 'function' ? opts(cx, cz) : opts);
      }
    }
  }

  /**
   * Auto-tiles a boolean field and places the resolved models. `mask(cx,cz)` decides
   * membership; the tiles module resolves each cell's 8-neighbour case.
   */
  autotile(tiles, setId, mask, opts = {}) {
    const occ = new Uint8Array(this.w * this.h);
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) if (mask(cx, cz)) occ[this.idx(cx, cz)] = 1;
    }
    const solved = tiles.autotile.solveField(this.tileset, setId, occ, this.w, this.h,
      { outsideIsFilled: opts.outsideIsFilled ?? true });
    const ts = tiles.get(this.tileset);
    let placed = 0;
    for (let cz = 0; cz < this.h; cz++) {
      for (let cx = 0; cx < this.w; cx++) {
        const id = solved[this.idx(cx, cz)];
        if (id < 0) continue;
        const model = ts?.byId.get(id);
        if (!model) continue;
        this.place(model, cx, cz, opts);
        placed++;
      }
    }
    return placed;
  }

  /** Places a model only where nothing multi-cell already sits. */
  scatter(rng, model, { rect, chance = 0.05, avoidTags = [], opts = {} } = {}) {
    const { x = 0, z = 0, w = this.w, h = this.h } = rect ?? {};
    let n = 0;
    for (let cz = z; cz < z + h; cz++) {
      for (let cx = x; cx < x + w; cx++) {
        if (!this.inside(cx, cz) || this.occupied[this.idx(cx, cz)]) continue;
        if (avoidTags.some((t) => this.hasTag(cx, cz, t))) continue;
        if (rng.next() > chance) continue;
        const m = typeof model === 'function' ? model(cx, cz) : model;
        if (m) { this.place(m, cx, cz, opts); n++; }
      }
    }
    return n;
  }

  finalize() {
    if (this._finalized) return this;
    // Sort transparent-ish layers last so water and foliage draw over their ground.
    this.placements.sort((a, b) => (a.layer - b.layer) || (a.cz - b.cz) || (a.cx - b.cx));
    this._finalized = true;
    return this;
  }
}

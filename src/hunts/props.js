/**
 * The rebuilt props, and the reason they need their own world.
 *
 * A `Placement` names a model id and nothing else, and `terrain.load` builds exactly one
 * `InstancedWorld` from exactly one tileset — so a `props` id put through an AdAstra draft
 * draws *AdAstra's* model of the same number, silently, because both ids exist
 *. Every biome that wants a barrel therefore collects its props here and
 * `hunts` builds them as a second world, while the draft gets only the collision.
 *
 * The fifteen props are authored geometry: a faceted prism with
 * up-and-outward normals rather than a sprite leaning back at 45 degrees. Two of them are
 * knowingly weaker — `hgss-overworld/water_rock` and `.../rock` carry the surrounding water
 * and grass baked into the sprite — and the coast is the one place the wet one belongs, so
 * it is used there and nowhere else.
 */

export function makePropYard(draft, tiles, slug = 'props') {
  const placements = [];

  /** Everything in the props set matching a query, in catalog order. */
  const find = (query) => tiles.find(slug, query) ?? [];

  /**
   * @param {object} model a model from `find`
   * @param {number} cx @param {number} cz
   * @param {{y?:number, rot?:0|1|2|3, layer?:number, blocks?:boolean}} [opts]
   */
  function place(model, cx, cz, opts = {}) {
    if (!model) return false;
    const w = model.w ?? 1, h = model.h ?? 1;
    if (cx < 0 || cz < 0 || cx + w > draft.w || cz + h > draft.h) return false;
    placements.push({
      modelId: model.id, cx, cz, y: opts.y ?? 0, rot: opts.rot ?? 0,
      tint: opts.tint ?? 0xffffff, layer: opts.layer ?? 4,
    });
    if (opts.blocks !== false) {
      for (let dz = 0; dz < h; dz++) {
        for (let dx = 0; dx < w; dx++) {
          if (draft.collisionAt(cx + dx, cz + dz) === 'walk') draft.setCollision(cx + dx, cz + dz, 'block');
        }
      }
    }
    return true;
  }

  return {
    find,
    place,
    count: () => placements.length,
    /** The shape `hunts.enter` builds a second `InstancedWorld` from. */
    extras: () => (placements.length ? [{ tileset: slug, placements }] : []),
  };
}

/**
 * The bridge from grid state to pixels.
 *
 * `simulation` owns *where* everyone is; `pokemon` owns *how a sprite is drawn* — the atlas,
 * the measured sprite sheet layouts, the 16-texels-per-unit density and the
 * 1/cos(pitch) stretch, and the contact shadow under each body. So nothing here
 * touches a sheet, a frame index or a quad: it reaches `pokemon` through `ctx.get` and asks
 * for actors.
 *
 * The one thing this file is careful about is the atlas. `pokemon.sprites.spawn()` prepares
 * whatever sheet it needs, so spawning a six-member party one at a time repacks and
 * re-uploads the atlas texture six times. Every sync therefore prepares the whole cast in a
 * single call first, and only then spawns.
 */

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

export class Cast {
  /** @param {object} ctx core context */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {{key:string, id:number}[]} one entry per staged walker, in line order */
    this.slots = [];
    this.generation = 0;
    this.pending = null;
  }

  /** True when `pokemon` is actually alive and exposing its sprite field. */
  get sprites() {
    const pokemon = this.ctx.get('pokemon');
    if (!isLive(pokemon)) return null;
    const s = pokemon.sprites;
    return s && typeof s.spawn === 'function' ? s : null;
  }

  /** Identity of a walker's art, so a resync only rebuilds what actually changed. */
  static keyOf(spec) {
    return spec.trainer
      ? `trainer:${spec.trainer}`
      : `pokemon:${typeof spec.species === 'object' ? spec.species?.name : spec.species}:${spec.shiny ? 1 : 0}`;
  }

  /**
   * Makes the staged actors match `specs`, spawning and removing only the difference.
   *
   * @param {{trainer?:string, species?:any, shiny?:boolean, scale?:number}[]} specs
   *   in line order: the lead first, then the trainer, then the rest of the party.
   * @returns {Promise<number>} how many actors are staged
   */
  async sync(specs) {
    const sprites = this.sprites;
    if (!sprites) return 0;
    const gen = ++this.generation;
    const keys = specs.map((s) => Cast.keyOf(s));

    // One atlas build for the whole cast, before anything is spawned.
    await sprites.prepare(specs.map((s) => (s.trainer ? { trainer: s.trainer } : { species: s.species, shiny: !!s.shiny })));
    if (gen !== this.generation) return this.slots.length;   // a newer sync overtook us

    for (let i = 0; i < keys.length; i++) {
      if (this.slots[i]?.key === keys[i]) continue;
      if (this.slots[i]) sprites.remove(this.slots[i].id);
      const id = await sprites.spawn({ ...specs[i], gait: 'idle', phase: 0, visible: false });
      if (gen !== this.generation) return this.slots.length;
      this.slots[i] = { key: keys[i], id };
    }
    for (let i = keys.length; i < this.slots.length; i++) {
      if (this.slots[i]) sprites.remove(this.slots[i].id);
    }
    this.slots.length = keys.length;
    return this.slots.length;
  }

  /** Pose one staged walker. Silently ignores a slot that has not spawned yet. */
  set(i, patch) {
    const slot = this.slots[i];
    if (!slot) return;
    this.sprites?.set(slot.id, patch);
  }

  /** Actor id of a staged walker, for callers that want to drive the field directly. */
  actorId(i) { return this.slots[i]?.id ?? 0; }

  count() { return this.slots.length; }

  clear() {
    const sprites = this.sprites;
    if (sprites) for (const slot of this.slots) if (slot) sprites.remove(slot.id);
    this.slots.length = 0;
    this.generation++;
  }
}

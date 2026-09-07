/**
 * pokemon — species data, party, and overworld sprites (ARCHITECTURE §5.5).
 *
 * SEED IMPLEMENTATION. The `pokemon` builder owns this folder and is expected to replace
 * the placeholder species table with the committed Gen 1-9 snapshot, and to finish the
 * sprite atlas and the follower animation.
 */

import { SHEET, spriteFrames } from './sprites.js';

export default {
  id: 'pokemon',
  needs: [],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['terrain', 'city', 'simulation'],

  async init(ctx) {
    const { log } = ctx;
    let table = null;
    try {
      const res = await fetch('/generated/species.json');
      if (res.ok) table = await res.json();
    } catch { /* falls through to the built-in starter set */ }
    if (!table) {
      log.warn('pokemon: /generated/species.json missing — running on the starter subset');
      table = (await import('./starter-species.js')).STARTERS;
    }

    const byId = new Map(table.map((s) => [s.id, s]));
    const byName = new Map(table.map((s) => [s.name, s]));
    const party = [];

    return {
      species: (k) => (typeof k === 'number' ? byId.get(k) : byName.get(String(k).toLowerCase())) ?? null,
      all: () => table,
      byGen: (n) => table.filter((s) => s.gen === n),
      byType: (t) => table.filter((s) => s.types.includes(t)),
      count: () => table.length,

      spriteSheet: (species, { shiny = false } = {}) =>
        `/assets/overworld/${species.name}/${shiny ? 'shiny' : 'normal'}.png`,
      frames: spriteFrames,
      SHEET,

      party: () => party.slice(),
      lead: () => party[0] ?? null,
      setLead(i) { if (party[i]) { const [p] = party.splice(i, 1); party.unshift(p); ctx.bus.emit('party:leadChanged', { instanceId: p.instanceId, species: p.species.name }); } },
      addToParty(inst) { if (party.length < 6) { party.push(inst); return true; } return false; },
      swap(i, j) { if (party[i] && party[j]) [party[i], party[j]] = [party[j], party[i]]; },

      createInstance({ species, level = 5, shiny = false, seed = 0 }) {
        const s = typeof species === 'object' ? species : this.species(species);
        if (!s) return null;
        return { instanceId: `${s.id}-${seed}-${level}`, species: s, level, shiny, hp: 1, exp: 0 };
      },
    };
  },

  async showcase(mode, ctx) {
    const { showcasePokemon } = await import('./showcase.js');
    return showcasePokemon(mode, ctx);
  },
};

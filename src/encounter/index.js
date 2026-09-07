/** encounter — spawn tables, catching, resolved battles (ARCHITECTURE §5.6). SEED. */
export default {
  id: 'encounter',
  needs: ['pokemon', 'terrain', 'economy'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],
  init(ctx) {
    const rng = ctx.rng.fork('encounter');
    let active = null;
    const TABLES = {
      city: ['patrat', 'poochyena'],
      meadow: ['starly', 'patrat', 'eevee'],
      forest: ['bulbasaur', 'sprigatito', 'starly'],
      cave: ['poochyena', 'charmander'],
      coast: ['squirtle', 'quaxly'],
    };
    return {
      tablesFor: (biome) => TABLES[biome] ?? TABLES.meadow,
      roll(biome, tod = 12, luck = 1) {
        const table = this.tablesFor(biome);
        if (rng.next() > 0.08 * luck) return null;
        const name = rng.pick(table);
        const species = ctx.get('pokemon').species(name);
        if (!species) return null;
        return { species, level: rng.int(2, 9), shiny: rng.next() < 1 / 4096, biome, tod };
      },
      begin(enc) { active = enc; ctx.bus.emit('encounter:started', { species: enc.species.name, level: enc.level, shiny: enc.shiny, biome: enc.biome }); },
      active: () => active,
      attempt() { const ok = rng.next() < 0.45; if (ok && active) ctx.bus.emit('catch:succeeded', { instanceId: `${active.species.id}`, species: active.species.name, shiny: active.shiny }); active = null; return ok; },
      flee() { active = null; },
      autoResolve(enc, partyPower = 1) {
        const power = Math.max(0.1, partyPower) / Math.max(1, enc.level);
        const win = rng.next() < Math.min(0.95, 0.35 + power * 0.4);
        return { outcome: win ? 'win' : 'flee', species: enc.species.name, rewards: { money: win ? 20 + enc.level * 4 : 0, exp: win ? enc.level * 7 : 0 } };
      },
    };
  },
  async showcase(mode, ctx) { await ctx.get('city').enter?.(); },
};

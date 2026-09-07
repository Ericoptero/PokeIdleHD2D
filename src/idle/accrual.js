/**
 * The single definition of what one second of idling produces. Pure, seeded, and shared
 * verbatim with `offline` — if these two ever disagree, players notice immediately, so
 * there is only one of them.
 *
 * @param {{party:object[], biome:string, luck:number}} state
 * @param {number} elapsedS
 * @param {number} seed
 */
export function simulate(state, elapsedS, seed) {
  const party = state.party ?? [];
  const power = party.reduce((a, p) => a + (p.level ?? 1), 0) || 1;
  const biomeBonus = { city: 0.7, meadow: 1.0, forest: 1.25, cave: 1.5, coast: 1.15 }[state.biome] ?? 1;
  const luck = state.luck ?? 1;

  const perSecond = {
    money: 0.9 * Math.sqrt(power) * biomeBonus,
    exp: 1.4 * power * biomeBonus,
    encounters: 0.05 * biomeBonus * luck,
  };

  // Deterministic fractional-encounter accumulation: no RNG needed for the expectation,
  // and the caller rolls the actual species with its own seeded stream.
  const encounters = perSecond.encounters * elapsedS;
  return {
    perSecond,
    elapsedS,
    money: perSecond.money * elapsedS,
    exp: perSecond.exp * elapsedS,
    encounters,
    wholeEncounters: Math.floor(encounters),
    seed,
  };
}

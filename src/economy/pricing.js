/**
 * What a Pokémon is worth.
 *
 * One number, derived, doing three jobs: the sell value when it is released, the threshold the
 * **pity** counter is measured against, and — through that — how many balls a
 * species is expected to cost. Deriving it rather than authoring it is the same argument as
 * every other table in this refactor: 1253 species is 1253 numbers to maintain and one of them
 * would always be wrong.
 *
 * Pure: no ctx, no clock, no RNG. It runs in Node.
 */

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * The anchor: what a perfectly ordinary Pokémon costs.
 *
 * Chosen from the ball line rather than picked: a Poké Ball is ₽200 and pity completes at
 * 1.25× the price, so this is **how many Poké Balls a guaranteed catch costs** on an ordinary
 * 255-rate common — and it is the one number to move if the early game feels slow.
 *
 * 1200 came out at five balls for a Caterpie once the base-stat term had dragged it down,
 * against a design target of six to ten; 1400 puts the commons at six to eight and leaves the
 * 45-rate line where it already was.
 */
export const BASE_PRICE = 1400;

/**
 * Capture rate is floored at 20 before it is used.
 *
 * The mainline's rarest rates are 3, and `(255/3)` raised to the exponent below is a factor of
 * 173 — a ₽207,000 Pokémon, which is not a grind, it is a wall. The floor caps the curve at
 * about ₽23,000 for anything at or below 20, which is roughly 115 Poké Balls: long, and
 * finishable.
 */
const RATE_FLOOR = 20;
const RATE_EXP = 1.16;
const BST_EXP = 0.6;

/**
 * The dearest a species may be, before the shiny multiplier.
 *
 * 188 Poké Balls to a guaranteed catch. The curve is a power law and a power law with no
 * ceiling produces numbers nobody will ever reach — a ₽45,800 Pokémon is not a goal, it is a
 * closed door.
 */
export const PRICE_CEILING = 30000;

/** Shinies are worth ten times as much — mainline `appraise` already uses that multiplier. */
export const SHINY_MULTIPLIER = 10;

/**
 * @param {{catchRate?:number, bst?:number, evo?:unknown[], prevo?:string|null}} species
 * @param {{shiny?:boolean}} [opts]
 * @returns {number} Poké Dollars
 */
export function speciesPrice(species, { shiny = false } = {}) {
  const rate = clamp(Number(species?.catchRate) || 255, RATE_FLOOR, 255);
  const bst = clamp(Number(species?.bst) || 300, 150, 780);

  // Rarity does most of the work, because rarity is what a player experiences as "hard to
  // get". Base-stat total is a gentler second term so a big common (Snorlax at 255) is still
  // worth more than a small one.
  const rarity = (255 / rate) ** RATE_EXP;
  const power = (bst / 400) ** BST_EXP;

  // A fully evolved Pokémon is the end of a road somebody walked. Half a step, not a jump:
  // the rarity term is already the headline.
  const finalForm = Array.isArray(species?.evo) && species.evo.length === 0 && species?.prevo ? 1.15 : 1;

  // **Rounded BEFORE the shiny multiplier**, so a shiny is exactly ten times the number the
  // player already saw. Rounding afterwards made a shiny Caterpie ₽9,100 against a printed
  // ₽900 — right to the pound and wrong to the eye.
  const base = Math.round((BASE_PRICE * rarity * power * finalForm) / 50) * 50;

  // **A ceiling, because a grind has to end.** Uncapped, a 780-BST rate-3 legendary came out
  // at ₽45,800 — 286 Poké Balls to a guaranteed catch. ₽30,000 is 188, which is long and
  // finishable; the rarity curve keeps its shape everywhere below it.
  const capped = Math.min(base, PRICE_CEILING);
  return Math.max(100, capped) * (shiny ? SHINY_MULTIPLIER : 1);
}

/**
 * How many of a ball it takes to reach the pity ceiling, at a given ball price.
 *
 * Not used by the game — this is the number the curve is *tuned* against, and it is exported so
 * the selftest can assert the gate rather than restate the formula.
 */
export const throwsToPity = (species, ballPrice = 200, opts) =>
  Math.ceil((speciesPrice(species, opts) * 1.25) / Math.max(1, ballPrice));

/**
 * What a defeated Pokémon leaves behind.
 *
 * `economy/items.js` has shipped twelve `category: 'treasure'` items since it was written —
 * mainline sell prices, no buy price, and **no way to obtain a single one of them**. Its own
 * header says they "exist only to be sold, which is the mainline's oldest money faucet and the
 * one that keeps hunting worthwhile". This is the faucet. It is also what pays for an evolution
 * (DECISIONS #62), which is why the same twelve items are on both sides of that trade: a lap of
 * a hunt is where the materials come from.
 *
 * Pure and **index-addressed**: `dropsFor(seed, index, …)` is a function of the encounter's
 * number and nothing else, so a hunt replayed by `offline` produces the same loot as the one
 * that was watched (DECISIONS #35(a)). No ctx, no clock, no `Math.random`.
 */

import { streamFor } from './rolls.js';

/**
 * Four ladders of three, which is exactly the twelve treasure items.
 *
 * Keyed by **biome** rather than by type, because loot is a property of the place you are
 * standing in — a cave gives up nuggets and bones, a shore gives up pearls. (Evolution
 * materials use the same twelve keyed by the Pokémon's own type; the two views of one small
 * catalogue are deliberate, and mean a player hunting for evolution materials has a *reason*
 * to pick one biome over another.)
 */
export const BIOME_LOOT = {
  forest: ['tinymushroom', 'bigmushroom', 'balmmushroom'],
  coast: ['pearl', 'bigpearl', 'pearlstring'],
  cave: ['nugget', 'rarebone', 'bignugget'],
  meadow: ['stardust', 'starpiece', 'cometshard'],
  city: ['stardust', 'starpiece', 'cometshard'],
};

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * How likely a defeated wild is to leave anything at all.
 *
 * Just under half. High enough that a lap of nine slots reliably pays, low enough that a drop
 * still reads as a find rather than as a tax the wildlife collects on the player's behalf.
 */
export const DROP_CHANCE = 0.46;

/**
 * Which rung of the biome's ladder a species drops from.
 *
 * The **capture rate**, because that is the one number in `species.json` that already means
 * "how unusual is this" — and it is the same number the catch odds and the price are built on,
 * so a rare Pokémon is expensive to catch, valuable to sell and generous when beaten, all from
 * one source of truth instead of three tables that would drift.
 */
export function rungFor(catchRate) {
  const r = Number(catchRate) || 255;
  if (r <= 60) return 2;
  if (r <= 150) return 1;
  return 0;
}

/**
 * The loot for encounter `index`.
 *
 * **Its own stream.** `root/encounter/drop/<index>` — never a continuation of the roll or the
 * battle, so adding a drop cannot renumber a species and a species that is not looked at still
 * costs the same draws (DECISIONS #35(a)).
 *
 * Draw order is a contract, like every other roll in this module: **whether, then which, then
 * how many, then the bonus coin.** All four are drawn unconditionally and the unused ones
 * discarded, because a conditional draw makes the stream position depend on state.
 *
 * @param {number} seed
 * @param {number} index
 * @param {{biome?:string, catchRate?:number, level?:number, shiny?:boolean}} enc
 * @returns {{id:string, n:number}[]}
 */
export function dropsFor(seed, index, { biome = 'meadow', catchRate = 255, level = 5, shiny = false } = {}) {
  const rng = streamFor(seed, 'drop', index);
  const rWhether = rng.next();
  const rWhich = rng.next();
  const rHowMany = rng.next();
  const rBonus = rng.next();

  const ladder = BIOME_LOOT[biome] ?? BIOME_LOOT.meadow;
  const rung = rungFor(catchRate);

  // A shiny always leaves something, and it leaves the good stuff. It is the rarest thing in
  // the game and beating one should not be able to pay nothing.
  if (!shiny && rWhether > DROP_CHANCE) return [];

  // `rWhich` steps the rung UP occasionally, never down: the rare drop from a common Pokémon
  // is the thing that makes a lap worth walking twice.
  const bumped = clamp(rung + (rWhich > 0.88 ? 1 : 0) + (shiny ? 1 : 0), 0, ladder.length - 1);
  const id = ladder[bumped];

  // One, usually. Level widens it slowly so a late hunt is worth more per kill than an early
  // one without the count running away — three is the ceiling.
  const n = clamp(1 + (rHowMany < clamp(level / 90, 0, 0.5) ? 1 : 0) + (shiny ? 1 : 0), 1, 3);

  const out = [{ id, n }];
  // A second, commoner item, sometimes. Two lines in a toast reads as a haul; three reads as
  // a spreadsheet.
  if (rBonus > 0.82 && bumped > 0) out.push({ id: ladder[0], n: 1 });
  return out;
}

/** Every item this module can ever hand out, for the seam that checks they are real. */
export const LOOT_IDS = [...new Set(Object.values(BIOME_LOOT).flat())];

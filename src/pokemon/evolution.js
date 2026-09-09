/**
 * What an evolution costs.
 *
 * Evolution used to fire by itself the moment a level threshold went past, which made it
 * something that *happened to* the player rather than something they did. It is now a
 * deliberate act with a price: **a level, and a pile of materials the player had to hunt for.**
 *
 * **The materials are the hunt gate.** ARCHITECTURE §0 says evolution happens only in a hunt;
 * that rule used to be a check on where you were standing, and it is now a check on what you
 * had to grind. Every material named here is a `category: 'treasure'` item from
 * `economy/items.js` — the twelve that have shipped since the economy was written with mainline
 * sell prices, no buy price, and **no way to obtain them at all**. They become the drop table
 * in phase 5, which is what makes an evolution a reason to go hunting rather than a number
 * going up on its own.
 *
 * Pure: no ctx, no clock, no DOM, no RNG. It runs in Node.
 *
 * > The item ids below are `economy`'s, named by string. That is a real coupling and the
 * > alternative is worse: routing a species' own evolution requirement through the wallet
 * > module would put creature data in the ledger. `pokemon` validates the ids against
 * > `economy.item(id)` when the ledger is live, so a rename fails loudly instead of silently
 * > costing nothing.
 */

/**
 * Four families of three, which is exactly the twelve treasure items the game ships.
 *
 * The rungs ascend in value (`sell` in `economy/items.js`), so an index into a family is a
 * difficulty dial: rung 0 is a common drop, rung 2 is the thing you go back for.
 */
export const MATERIAL_FAMILIES = {
  //          rung 0          rung 1         rung 2          sell:  250 / 2500 / 25000
  mushroom: ['tinymushroom', 'bigmushroom', 'balmmushroom'],
  //                                                         sell: 1400 / 4000 / 15000
  pearl: ['pearl', 'bigpearl', 'pearlstring'],
  //                                                         sell: 2000 / 9800 / 60000
  star: ['stardust', 'starpiece', 'cometshard'],
  //                                                         sell: 5000 / 5000 / 20000
  mineral: ['nugget', 'rarebone', 'bignugget'],
};

/**
 * Which family a species draws on, by its primary type.
 *
 * Thematic rather than balanced — a Grass-type wanting mushrooms and a Water-type wanting
 * pearls is the kind of thing a player reads once and never has to look up again. Balance
 * lives in the rung and the count below, which are the same for every family.
 */
const FAMILY_BY_TYPE = {
  grass: 'mushroom', bug: 'mushroom', poison: 'mushroom', fighting: 'mushroom',
  water: 'pearl', ice: 'pearl', flying: 'pearl',
  psychic: 'star', fairy: 'star', ghost: 'star', dark: 'star', dragon: 'star',
  fire: 'mineral', electric: 'mineral', steel: 'mineral',
  normal: 'mineral', rock: 'mineral', ground: 'mineral',
};

export const familyFor = (species) =>
  FAMILY_BY_TYPE[String(species?.types?.[0] ?? '').toLowerCase()] ?? 'mineral';

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * The rung, from what the Pokémon is *becoming*.
 *
 * Base-stat total, not the parent's, because the cost should track the prize: a Metapod is a
 * step on the way and a Dragonite is the end of a long road, and the player should feel the
 * difference at the counter rather than in a patch note.
 */
export function rungFor(childBst) {
  const bst = Number(childBst) || 300;
  if (bst < 420) return 0;
  if (bst < 520) return 1;
  return 2;
}

/**
 * How many, from the jump in power and how rare the result is.
 *
 * Two terms, both legible:
 *
 *   - **the jump** — `(childBst − parentBst) / 55`, so a typical +100 BST evolution is +2 and a
 *     cosmetic one is +0. This is what makes Magikarp → Gyarados (+340) expensive and
 *     Caterpie → Metapod (+10) nearly free.
 *   - **rarity** — the child's mainline capture rate, which `species.json` has carried since
 *     DECISIONS #61. A 45-rate result costs two more than a 255-rate one.
 *
 * Clamped to 2..12 so nothing is free and nothing is a wall.
 */
export function countFor(parentBst, childBst, childCatchRate) {
  const jump = Math.round(((Number(childBst) || 0) - (Number(parentBst) || 0)) / 55);
  const rate = Number(childCatchRate) || 45;
  const rarity = rate <= 45 ? 2 : rate <= 120 ? 1 : 0;
  return clamp(2 + Math.max(0, jump) + rarity, 2, 12);
}

/**
 * The full bill for one evolution: `[{ id, n }]`.
 *
 * A stone evolution keeps its stone **and** pays the materials. The stone is the mainline
 * requirement and the materials are this game's; dropping either would make one of the two
 * shopping trips pointless.
 */
export function materialsFor(parent, child, row, isItem = () => true) {
  const family = MATERIAL_FAMILIES[familyFor(parent)];
  const id = family[rungFor(child?.bst)] ?? family[0];
  const bill = [{ id, n: countFor(parent?.bst, child?.bst, child?.catchRate) }];
  // Showdown names evolution items this game does not stock — nine of them, all Gen 8/9
  // (`sweetapple`, `metalalloy`, `auspiciousarmor`, …). Asking for one would make those lines
  // unreachable forever, which breaks §0's promise that every line can be got to from a hunt.
  // An unknown item is dropped and the route becomes a plain level-and-materials evolution;
  // it is not invented as a real item, because inventing shop stock is `economy`'s call.
  if (row?.type === 'useItem' && row.item && isItem(row.item)) bill.unshift({ id: row.item, n: 1 });
  return bill;
}

/**
 * The level an evolution asks for.
 *
 * `evoLevel` where the mainline has one. Everything else — stones, trades, friendship, the
 * long tail of `levelMove` and `levelHold` — gets a level derived from the parent, so no line
 * in the game is unreachable and none of them is reachable at level 5 either.
 */
export const derivedLevel = (parentBst) => Math.max(20, Math.round((Number(parentBst) || 300) / 14));

export const levelFor = (parent, row) =>
  (Number.isFinite(row?.level) && row.type !== 'useItem' ? row.level : derivedLevel(parent?.bst));

/**
 * Everything the UI needs to draw a button and everything `evolve()` needs to spend.
 *
 * `have` is filled in by the caller (`pokemon` asks `economy.count`), so this stays pure and
 * the panel, the selftest and the showcase all read the same shape.
 */
export function requirementFor(parent, child, row, { count = () => 0, isItem } = {}) {
  const level = levelFor(parent, row);
  const materials = materialsFor(parent, child, row, isItem).map((m) => ({ ...m, have: count(m.id) }));
  const missing = materials.filter((m) => m.have < m.n);
  return {
    to: child.name,
    display: child.display ?? child.name,
    type: row?.type ?? 'levelUp',
    level,
    materials,
    missing,
  };
}

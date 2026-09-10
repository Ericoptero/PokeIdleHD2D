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
 * The per-row odds, chosen so the **aggregate** stays at `DROP_CHANCE`.
 *
 * A table's rows are independent coins, so adding rows raises the chance a win pays *anything*
 * even if no single row got likelier: at 0.46 / 0.28 / 0.15 the measured pay rate came out
 * **66.6 %**, a 45 % rise in hunt income smuggled in as a table shape. These are the numbers
 * that put it back — `1 − (1−0.30)(1−0.14)(1−0.08) = 0.446`, and `0.474` with a stature row —
 * and `selftest.js` measures the real rate over a sweep rather than trusting the arithmetic.
 */
const PLACE_CHANCE = 0.30;
const OWN_TYPE_CHANCE = 0.14;
const SECOND_TYPE_CHANCE = 0.08;

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
 * The twelve treasures, keyed by a Pokémon's own **type**.
 *
 * **Mirrored from `pokemon/evolution.js`, and policed by `tools/seams/run.js` rule 7.** That
 * module bills an evolution in these items keyed by the child's type; this one hands them out
 * keyed by the defeated wild's. Two views of one small catalogue, deliberately (DECISIONS
 * #68(a)) — and the reason it is worth a copy plus a check rather than a shared file is seam
 * rule 2: `encounter` may not import `pokemon`'s internals, and neither belongs in `core`.
 * Rule 5 sets the precedent, and it exists because exactly this kind of copy drifted once with
 * nothing able to notice.
 *
 * The pairing is what makes a hunt legible: the wood full of Grass types is where mushrooms
 * come from, and mushrooms are what a Grass evolution costs.
 */
export const MATERIAL_FAMILIES = {
  mushroom: ['tinymushroom', 'bigmushroom', 'balmmushroom'],
  pearl: ['pearl', 'bigpearl', 'pearlstring'],
  star: ['stardust', 'starpiece', 'cometshard'],
  mineral: ['nugget', 'rarebone', 'bignugget'],
};

/** Which family a type draws on. Mirrored; see `MATERIAL_FAMILIES`. */
export const FAMILY_BY_TYPE = {
  grass: 'mushroom', bug: 'mushroom', poison: 'mushroom', fighting: 'mushroom',
  water: 'pearl', ice: 'pearl', flying: 'pearl',
  psychic: 'star', fairy: 'star', ghost: 'star', dark: 'star', dragon: 'star',
  fire: 'mineral', electric: 'mineral', steel: 'mineral',
  normal: 'mineral', rock: 'mineral', ground: 'mineral',
};

export const familyFor = (type) => FAMILY_BY_TYPE[String(type ?? '').toLowerCase()] ?? 'mineral';

/**
 * **How many rows a table may have, and therefore how many draws one costs.**
 *
 * Four. The number is a *budget* rather than a limit: `dropsFor` draws a whether-coin and a
 * quantity for every one of the four rows whether the table has them or not, so a Caterpie and
 * a Dragonite consume the same nine numbers from `root/encounter/drop/<index>`. Without that,
 * the stream position would depend on which species a slot happened to be holding — and a slot
 * respawns a different species every time it refills, which would renumber every drop after it
 * (DECISIONS #35(a), #75).
 */
export const MAX_DROP_ROWS = 4;

/**
 * Species that drop something specific, overriding the derivation entirely.
 *
 * Empty on purpose. It is the seam for hand-authoring — a species whose loot should be a joke,
 * a callback or a quest item goes here and nothing else has to change — and an empty map is an
 * honest statement that nothing has earned one yet.
 *
 * @type {Object<string, {id:string, min:number, max:number, chance:number}[]>}
 */
export const SPECIES_DROPS = {};

/** The floor and ceiling on the chance a big species leaves its family's best rung. */
const STATURE_MIN = 0.03;
const STATURE_MAX = 0.10;
/** Base-stat total at which a species starts counting as big enough to leave the top rung. */
const STATURE_BST = 480;
const rowsCache = new Map();

/**
 * **The drop table for one species** — the shape the brief asks for, one row per item.
 *
 * Derived rather than authored, because 1253 hand-written tables is not a thing anyone would
 * keep correct. Four rows, each with a reason:
 *
 *   1. **its own type's material**, at the rung its capture rate earns — the main line;
 *   2. **its second type's**, a rung lower, so a Fire/Flying leaves mineral and pearl and a
 *      mono-type leaves a commoner second helping of its own;
 *   3. **its family's best rung** if it is a big species, scaled by base-stat total, so beating
 *      something substantial is occasionally worth going back for;
 *   4. **the biome's own ladder**, which is what keeps *where you hunt* a decision at all and
 *      is the whole of what this file used to be.
 *
 * A shiny doubles every chance and adds one to every count: it is the rarest thing in the game
 * and beating one must not be able to pay nothing.
 */
export function tableFor(species, biome = 'meadow', { shiny = false } = {}) {
  const name = typeof species === 'string' ? species : species?.name;
  /**
   * **The key is every input, not the name.** Keying on the name alone cached a nameless
   * caller's table under `null` and handed it back for the next one — so a rate-40 rare got a
   * rate-255 common's rows, and `selftest.js`'s "a rare species drops from a higher rung"
   * caught it. Anything `tableFor` reads has to be in here.
   */
  const types = (typeof species === 'object' && Array.isArray(species?.types) ? species.types : ['normal'])
    .map((t) => String(t).toLowerCase());
  const rate = Number(typeof species === 'object' ? species?.catchRate : 255) || 255;
  const bst = Number(typeof species === 'object' ? species?.bst : 300) || 300;
  const key = `${name}/${types.join('.')}/${rate}/${bst}/${biome}/${shiny ? 1 : 0}`;
  const hit = rowsCache.get(key);
  if (hit) return hit;

  let rows;
  const override = name ? SPECIES_DROPS[name] : null;
  if (override) {
    rows = override.map((r) => ({ ...r }));
  } else {
    const rung = rungFor(rate);
    const own = MATERIAL_FAMILIES[familyFor(types[0])];
    const second = MATERIAL_FAMILIES[familyFor(types[1] ?? types[0])];
    const place = BIOME_LOOT[biome] ?? BIOME_LOOT.meadow;

    /**
     * **The place leads and the species flavours it**, and that order is the balance decision.
     *
     * The obvious arrangement — the species' own type first — moves the main payout from
     * *rarity* to *typing*, because the four families do not carry the same money: `star` tops
     * out at a Comet Shard (₽60,000) and `pearl` at a Pearl String (₽15,000). Tried it and
     * measured it: a Gible in a forest went from a Balm Mushroom (₽25,000) to a Comet Shard at
     * the same 46 %, quadrupling the top of the drop curve as a side effect of a table shape.
     *
     * So row 0 is exactly what this file has always dropped — the biome's ladder at the rung
     * the capture rate earns — and the species rows sit under it at lower odds. The economics
     * are unchanged, and a table is now genuinely the species' own.
     */
    rows = [
      { id: place[rung], min: 1, max: 1, chance: PLACE_CHANCE },
      { id: own[rung], min: 1, max: 1, chance: OWN_TYPE_CHANCE },
      { id: second[clamp(rung - 1, 0, second.length - 1)], min: 1, max: 1, chance: SECOND_TYPE_CHANCE },
    ];
    // Something substantial is occasionally worth going back for. Its own family's best rung,
    // scaled by base-stat total — the only row where typing reaches the top of a ladder, and it
    // is rare enough that it reads as a find.
    if (bst >= STATURE_BST) {
      rows.push({
        id: own[own.length - 1], min: 1, max: 1,
        chance: clamp(STATURE_MIN + (bst - STATURE_BST) / 6000, STATURE_MIN, STATURE_MAX),
      });
    }
  }

  if (shiny) rows = rows.map((r) => ({ ...r, max: r.max + 1, chance: clamp(r.chance * 2, 0, 1) }));
  rows = rows.slice(0, MAX_DROP_ROWS);
  rowsCache.set(key, rows);
  return rows;
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
export function dropsFor(seed, index, {
  species = null, biome = 'meadow', catchRate = 255, level = 5, shiny = false,
} = {}) {
  const rng = streamFor(seed, 'drop', index);

  // **Eight draws, always.** One pair per row of the budget, taken before anything is decided
  // and discarded where a row does not exist. A species with a three-row table costs exactly
  // what a four-row one costs, so the slot that respawns a Dragonite where a Caterpie stood
  // cannot renumber the drop of every encounter after it.
  const rolls = [];
  for (let i = 0; i < MAX_DROP_ROWS; i++) rolls.push({ whether: rng.next(), qty: rng.next() });

  const table = tableFor(species ?? { name: null, types: ['normal'], catchRate, bst: 300 }, biome, { shiny });
  const out = [];
  for (let i = 0; i < MAX_DROP_ROWS; i++) {
    const row = table[i];
    if (!row) continue;                                  // the draw was taken; the row was not
    // A shiny always leaves its first row, whatever the coin said.
    if (!(shiny && i === 0) && rolls[i].whether > row.chance) continue;
    const span = Math.max(0, (row.max ?? 1) - (row.min ?? 1));
    // Level widens the count slowly, so a late hunt pays more per kill without running away.
    const wide = span > 0 && rolls[i].qty < clamp(level / 90, 0, 0.5) ? 1 : 0;
    out.push({ id: row.id, n: clamp((row.min ?? 1) + wide, 1, 3) });
  }
  // Merging duplicates is not tidying: a Bug type hunted in a mushroom wood draws the same
  // item from the place row and its own type row, and "2x Tiny Mushroom" is the right reading
  // of that — the wood pays double for what it is full of. Two lines in a toast reads as a
  // haul; four reads as a spreadsheet.
  const merged = new Map();
  for (const d of out) merged.set(d.id, Math.min(3, (merged.get(d.id) ?? 0) + d.n));
  return [...merged].slice(0, 3).map(([id, n]) => ({ id, n }));
}

/** Every item this module can ever hand out, for the seam that checks they are real. */
export const LOOT_IDS = [...new Set([
  ...Object.values(BIOME_LOOT).flat(),
  ...Object.values(MATERIAL_FAMILIES).flat(),
])];

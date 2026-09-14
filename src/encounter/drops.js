/**
 * What a defeated Pokémon leaves behind.
 *
 * `economy/items.js` has shipped twelve `category: 'treasure'` items since it was written —
 * mainline sell prices, no buy price, and **no way to obtain a single one of them**. Its own
 * header says they "exist only to be sold, which is the mainline's oldest money faucet and the
 * one that keeps hunting worthwhile". This is the faucet. It is also what pays for an evolution
 *, which is why the same twelve items are on both sides of that trade: a lap of
 * a hunt is where the materials come from.
 *
 * **Each species defines its own drops, globally, project-wide** — not derived from where it
 * was caught. `src/pokemon/tools/build-drops.js` computes the table once (type family,
 * capture-rate rung, base-stat-total stature bonus) and commits the result to
 * `public/generated/drops.json`; this file is a straight lookup into it, plus the shiny
 * doubling and the index-addressed roll. A species is no longer "the cave's own ladder" or
 * "the meadow's own ladder" — it is just itself, wherever it is caught.
 *
 * Pure and **index-addressed**: `dropsFor(seed, index, …)` is a function of the encounter's
 * number and nothing else, so a hunt replayed by `offline` produces the same loot as the one
 * that was watched. No ctx, no clock, no `Math.random` — the catalog is handed in by the
 * caller (`encounter/index.js`, which fetches `drops.json` once at init the same way
 * `pokemon/index.js` fetches `species.json`), not fetched here.
 */

import { streamFor } from './rolls.js';

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * **How many rows a table may have, and therefore how many draws one costs.**
 *
 * Three now (the derived catalog never emits more — `build-drops.js`), but the budget is
 * still a *ceiling*, drawn from unconditionally whether or not a species' own table has that
 * many rows: `dropsFor` draws a whether-coin and a quantity for every one of the three slots,
 * so a Caterpie and a Dragonite consume the same six numbers from
 * `root/encounter/drop/<index>`. Without that, the stream position would depend on which
 * species a slot happened to be holding — and a slot respawns a different species every time
 * it refills, which would renumber every drop after it.
 */
export const MAX_DROP_ROWS = 3;

/**
 * A species' own drop table, from the committed catalog — at most `MAX_DROP_ROWS` rows, each
 * `{id, min, max, chance}`. A shiny doubles every chance and adds one to every count: it is
 * the rarest thing in the game and beating one must not be able to pay nothing.
 *
 * @param {object|string} species a species record (`.name`) or a bare name
 * @param {Record<string, {id:string,min:number,max:number,chance:number}[]>} catalog
 *   `drops.json`, fetched once by the caller
 * @param {{shiny?:boolean}} [opts]
 */
export function tableFor(species, catalog, { shiny = false } = {}) {
  const name = typeof species === 'string' ? species : species?.name;
  const found = name ? catalog?.[name] : null;
  let rows = (found ?? []).map((r) => ({ ...r }));
  if (shiny) rows = rows.map((r) => ({ ...r, max: r.max + 1, chance: clamp(r.chance * 2, 0, 1) }));
  return rows.slice(0, MAX_DROP_ROWS);
}

/**
 * The loot for encounter `index`.
 *
 * **Its own stream.** `root/encounter/drop/<index>` — never a continuation of the roll or the
 * battle, so adding a drop cannot renumber a species and a species that is not looked at still
 * costs the same draws.
 *
 * Draw order is a contract, like every other roll in this module: **whether, then which, then
 * how many, then the bonus coin.** All are drawn unconditionally and the unused ones
 * discarded, because a conditional draw makes the stream position depend on state.
 *
 * @param {number} seed
 * @param {number} index
 * @param {{species?:object|string, catalog?:object, level?:number, shiny?:boolean}} enc
 * @returns {{id:string, n:number}[]}
 */
export function dropsFor(seed, index, {
  species = null, catalog = {}, level = 5, shiny = false,
} = {}) {
  const rng = streamFor(seed, 'drop', index);

  const rolls = [];
  for (let i = 0; i < MAX_DROP_ROWS; i++) rolls.push({ whether: rng.next(), qty: rng.next() });

  const table = tableFor(species, catalog, { shiny });
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
  // Merging duplicates is not tidying: a Bug type's own-type and second-type rows can name
  // the same family, and "2x Tiny Mushroom" is the right reading of that.
  const merged = new Map();
  for (const d of out) merged.set(d.id, Math.min(3, (merged.get(d.id) ?? 0) + d.n));
  return [...merged].slice(0, 3).map(([id, n]) => ({ id, n }));
}

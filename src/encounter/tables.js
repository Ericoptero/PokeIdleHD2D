/**
 * tables.js — turning a map's own authored `spawnPoints[]` into a weighted pick.
 *
 * There is no shared table catalog any more. Every map authors its own wildlife directly, as
 * a list of spawn points (`@/terrain/mapfile.js`'s `spawnPoints[]`), each with its own
 * `respawnSeconds` and its own weighted list of species
 * (`{name, chance, when?, bump?}` — `src/hunts/index.js`'s own copy of this same shape is
 * what a spawn point stands wildlife up from; this file's job is `idle`/`offline`'s
 * *background* simulation of "what would this map's wildlife have produced", which needs the
 * same weighted-pick contract but pooled across every spawn point on the map rather than
 * resolved one at a time).
 *
 * **`tablesFor` must return a plain `string[]`.** Three modules already consume it and all
 * three do the same thing with it — `idle/accrual.js` (`tables[floor(rng.next() * len)]`),
 * `offline/index.js` (carries it into idle's state) and `automation/index.js` (synthesises a
 * caught Pokemon from it). Returning `{species, weight}` objects would silently give them a
 * species named `[object Object]`. So the weighted table is **weight-expanded**: a row of
 * weight 20 occupies twenty of the ~120 slots, and a *uniform* pick from that array is
 * exactly the weighted pick. Those three modules get the right distribution for free without
 * knowing anything changed.
 *
 * The rows themselves are still reachable — `expand()` hangs `rows`, `mapId` and `tod` on the
 * array as non-enumerable properties, so a structured clone (which is what the bus and the
 * save both do) carries the plain string array and nothing else.
 */

/**
 * Time bands. Night is 18:00–04:00, which is also the window `economy`'s Dusk Ball asks
 * about (`items.js` `isNight`), so "the Dusk Ball is worth carrying when the nocturnal
 * wildlife is up" is true rather than a coincidence.
 */
export function todBand(tod) {
  const t = ((Number(tod) || 0) % 24 + 24) % 24;
  if (t >= 18 || t < 4) return 'night';
  if (t < 10) return 'morning';
  return 'day';
}

/**
 * Pools every spawn point's own species rows into one weighted list for the given hour —
 * `src/hunts/index.js`'s `rollSpeciesFor` does the same per-spawn-point pick live; this is
 * that same contract applied across a whole map at once, for `idle`/`offline`'s background
 * simulation. Species with the same name across different spawn points merge their weights
 * (a species common to three spawn points is three times as likely to be the one `idle`
 * simulates catching, matching how much of the map's grass it actually stands in).
 *
 * @param {{species?:{name:string,chance?:number,when?:string,bump?:number}[]}[]} spawnPoints
 * @param {number} tod
 * @returns {{n:string,w:number,bump:number}[]}
 */
export function rowsFromSpawnPoints(spawnPoints, tod) {
  const band = todBand(tod);
  const merged = new Map();
  for (const point of spawnPoints ?? []) {
    for (const row of point.species ?? []) {
      if (row.when && row.when !== 'any' && row.when !== band) continue;
      const w = Number(row.chance) || 0;
      if (w <= 0) continue;
      const prev = merged.get(row.name);
      if (prev) prev.w += w;
      else merged.set(row.name, { n: row.name, w, bump: Number(row.bump) || 0 });
    }
  }
  return [...merged.values()];
}

/**
 * Weight-expansion: `rows` → a `string[]` a uniform pick samples correctly from.
 *
 * Largest-remainder apportionment, so the slot counts are the closest integers to the true
 * proportions and the result does not depend on row order beyond a documented tie-break
 * (higher weight first, then name). Every row is guaranteed at least one slot: a species
 * that appears in the table must be catchable, and a rounding rule that silently deleted
 * the rarest row would be the worst possible failure mode for a Pokedex.
 */
export function expand(rows, { slots = 120, mapId = null, tod = null } = {}) {
  const out = [];
  if (!rows.length) return out;

  const total = rows.reduce((n, r) => n + r.w, 0) || rows.length;
  const target = Math.max(rows.length, slots);
  const parts = rows.map((r) => {
    const exact = (r.w / total) * target;
    const base = Math.max(1, Math.floor(exact));
    return { row: r, base, rem: exact - Math.floor(exact) };
  });
  let used = parts.reduce((n, p) => n + p.base, 0);
  const order = [...parts].sort((a, b) =>
    (b.rem - a.rem) || (b.row.w - a.row.w) || (a.row.n < b.row.n ? -1 : 1));
  for (let i = 0; used < target; i++, used++) order[i % order.length].base++;

  for (const p of parts) for (let i = 0; i < p.base; i++) out.push(p.row.n);

  // The rows themselves, for anything that wants the weights back. Non-enumerable so a
  // structured clone (the bus, and the save) carries a plain array of strings and nothing
  // else — `idle` puts this straight into its state object.
  const hide = (k, v) => Object.defineProperty(out, k, { value: v, enumerable: false });
  hide('rows', rows.map((r) => ({ species: r.n, weight: r.w, bump: r.bump })));
  hide('mapId', mapId);
  hide('tod', tod);
  hide('band', tod == null ? null : todBand(tod));
  return out;
}

/** `{ species: levels }` for the rows that out-class their spawn point. Fed to `rolls.rollAt`. */
export function bumpsFor(rows) {
  const out = {};
  for (const r of rows) if (r.bump) out[r.n] = r.bump;
  return out;
}

/** Row count for the showcase readout. */
export function summary(rows) {
  return { rows: rows.length };
}

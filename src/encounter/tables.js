/**
 * tables.js — what lives where, and when.
 *
 * Five built-in tables (`TABLE_IDS`, the same ids `idle/accrual.js` prices), each split
 * into morning / day / night the way the mainline splits a route's grass. A row is
 *
 *     { n: species name, w: relative weight, r: mainline capture rate, when: band, bump: levels }
 *
 * ## Three things about the shape that are load-bearing
 *
 * **`tablesFor` must return a plain `string[]`.** Three modules already consume it and all
 * three do the same thing with it — `idle/accrual.js` (`tables[floor(rng.next() * len)]`),
 * `offline/index.js` (carries it into idle's state) and `automation/index.js` (synthesises a
 * caught Pokemon from it). Returning `{species, weight}` objects would silently give them a
 * species named `[object Object]`. So the weighted table is **weight-expanded**: a row of
 * weight 20 occupies twenty of the ~120 slots, and a *uniform* pick from that array is
 * exactly the weighted pick. Those three modules get the right distribution for free
 * without knowing anything changed, and src/encounter/index.js's "weighted species table" is honoured
 * literally rather than as a shape nobody could consume.
 *
 * The rows themselves are still reachable — `expand()` hangs `rows`, `biome` and `tod` on
 * the array as non-enumerable properties, so a structured clone (which is what the bus and
 * the save both do) carries the plain string array and nothing else.
 *
 * **Capture rates are the real mainline numbers**, authored per row, because the whole
 * point of `economy`'s eighteen balls is that a Caterpie (255) and a Gible (45) are
 * different problems. `rolls.js` carries a BST-derived proxy for species that are not in
 * any table; nothing in these tables needs it.
 *
 * **`bump` is how a rare species stays rare *and* dangerous.** Levels come from the
 * party-scaled band (`rolls.levelBand`), and a pseudo-legendary rolled at the bottom of a
 * level-5 party's band would be a level-3 Larvitar. `bump` adds levels on top of the band
 * for the handful of rows that should out-class the route.
 */

/**
 * The built-in table ids — the same ids `idle/accrual.js`'s yield profiles and
 * `economy/drops.js`'s loot ladders are keyed by, so a hunt's wildlife, its pay and its loot
 * never disagree about which place it is.
 *
 * **Enumerating this used to be how a caller decided whether an id was legal at all**
 * (`encounter/index.js`'s old `BIOMES.includes(biome) ? biome : 'meadow'`). Since P5, a
 * map's table id is a property the map itself declares (`terrain.handle().encounterTable`,
 * sourced from `encounters.table` in a `.map.json`) and is no longer restricted to
 * membership in this list — `rowsFor`'s own `TABLES[id] ?? TABLES.meadow` fallback, below,
 * is what actually decides "known or not" now. Kept as `BIOMES` (not renamed — `studio/
 * inspector.js` imports it by this name for its own "Tabela de encontro" dropdown) as
 * exactly that: the catalog of tables this file ships out of the box, for anything that
 * wants to list or validate them (this file's own `validate()`, the showcase, the studio's
 * picker) — a brand-new map is free to declare a `table` id that is not in this list at all
 * and simply inherit `TABLES.meadow` until someone authors it one.
 */
export const BIOMES = ['city', 'meadow', 'forest', 'cave', 'coast'];

/**
 * Time bands. Night is 18:00–04:00, which is also the window `economy`'s Dusk Ball asks
 * about (`items.js` `isNight`), so "the Dusk Ball is worth carrying when the nocturnal
 * table is up" is true rather than a coincidence.
 */
export function todBand(tod) {
  const t = ((Number(tod) || 0) % 24 + 24) % 24;
  if (t >= 18 || t < 4) return 'night';
  if (t < 10) return 'morning';
  return 'day';
}

const R = (n, w, r, when = 'any', bump = 0) => ({ n, w, r, when, bump });

/** @type {Object<string, {n:string,w:number,r:number,when:string,bump:number}[]>} */
export const TABLES = {
  /**
   * **The lobby has no wildlife, and the key stays anyway.**
   *
   * The terrain layout keeps the city's 23 rows on the argument that a walkable map the player
   * drives is played differently from a hunt. The spawn-slot model removed the tall-grass step roll everywhere,
   * so nothing can read them: the city is a lobby now — a Center, a Mart, a plaza — and the
   * hunt is the only place a wild Pokemon exists.
   *
   * Emptied and not deleted, because `rowsFor` falls back to **meadow** for any table id it
   * does not recognise (`TABLES[id] ?? TABLES.meadow`, below). Dropping the `city` entry —
   * or its explicit `encounters.table:'city'` on `demo-city.map.json`/`pokecenter.map.json`
   * (P5: `terrain.handle().encounterTable`) — would therefore have the lobby quietly
   * spawning the meadow's wildlife through `idle` rather than none at all — a silent wrong
   * answer in place of a loud empty one.
   */
  city: [],

  // Route grass. The broadest table and the softest — this is where a new save actually
  // fills a Pokedex.
  meadow: [
    R('patrat', 18, 255, 'day'), R('lillipup', 16, 255, 'day'), R('sentret', 12, 255, 'morning'),
    R('starly', 14, 255, 'morning'), R('bunnelby', 12, 255, 'day'), R('skwovet', 10, 255, 'day'),
    R('lechonk', 10, 255, 'day'), R('buneary', 6, 190, 'morning'), R('minccino', 5, 255, 'day'),
    R('audino', 4, 255, 'day'), R('deerling', 8, 190, 'day'),
    R('pidgey', 12, 255, 'any'), R('rattata', 12, 255, 'any'), R('oddish', 10, 255, 'any'),
    R('hoppip', 8, 255, 'any'), R('cottonee', 8, 190, 'any'), R('petilil', 8, 190, 'any'),
    R('sunkern', 6, 235, 'any'), R('marill', 6, 190, 'any'), R('wooper', 6, 255, 'any'),
    R('azurill', 5, 150, 'any'),
    R('hoothoot', 18, 255, 'night'), R('purrloin', 14, 255, 'night'), R('poochyena', 14, 255, 'night'),
    R('munna', 8, 190, 'night'), R('drowzee', 6, 190, 'night'), R('zubat', 12, 255, 'night'),
    R('murkrow', 6, 30, 'night'), R('misdreavus', 4, 45, 'night', 2), R('clefairy', 4, 150, 'night', 1),
    R('eevee', 2, 45, 'any', 2),
  ],

  // Deep cover. Bugs and grass by day, ghosts and spores by night; `idle` pays it 1.35× on
  // encounters and 1.45× on experience, so it is the training biome.
  forest: [
    R('caterpie', 18, 255, 'day'), R('weedle', 16, 255, 'day'), R('sewaddle', 14, 255, 'day'),
    R('kricketot', 12, 255, 'morning'), R('shroomish', 10, 255, 'day'), R('seedot', 10, 255, 'day'),
    R('deerling', 10, 190, 'day'), R('paras', 8, 190, 'day'), R('pansage', 6, 190, 'day'),
    R('foongus', 8, 190, 'day'), R('applin', 4, 255, 'day', 1),
    R('oddish', 12, 255, 'any'), R('bellsprout', 12, 255, 'any'), R('budew', 8, 255, 'any'),
    R('cherubi', 8, 190, 'any'), R('combee', 6, 120, 'any'), R('sunkern', 6, 235, 'any'),
    R('ferroseed', 4, 255, 'any'), R('larvesta', 1, 45, 'any', 4),
    R('venonat', 14, 190, 'night'), R('spinarak', 12, 255, 'night'), R('hoothoot', 14, 255, 'night'),
    R('pineco', 8, 190, 'night'), R('gastly', 6, 190, 'night'), R('joltik', 10, 190, 'night'),
    R('woobat', 10, 190, 'night'), R('phantump', 4, 120, 'night', 2),
  ],

  // Underground. The Dusk Ball is a flat 3× here at every hour (`economy/items.js`), which
  // is the reason a cave hunt is worth stocking for, and `idle` pays it 1.75× on research.
  cave: [
    R('zubat', 22, 255, 'any'), R('geodude', 18, 255, 'any'), R('roggenrola', 16, 255, 'any'),
    R('woobat', 14, 190, 'any'), R('sandshrew', 10, 255, 'any'), R('diglett', 10, 255, 'any'),
    R('machop', 8, 180, 'any'), R('aron', 8, 180, 'any'), R('dwebble', 8, 190, 'any'),
    R('drilbur', 8, 120, 'any'), R('nosepass', 5, 255, 'any'), R('rockruff', 6, 190, 'morning'),
    R('onix', 4, 45, 'any', 2), R('carbink', 2, 60, 'any', 3),
    R('axew', 2, 75, 'any', 3), R('gible', 1, 45, 'any', 4), R('larvitar', 1, 45, 'any', 4),
    R('golbat', 8, 90, 'night', 3), R('gastly', 10, 190, 'night'), R('litwick', 6, 190, 'night'),
    R('yamask', 5, 190, 'night'), R('sableye', 3, 45, 'night', 2),
  ],

  // Shoreline and shallows. The Dive Ball and the Net Ball both key off this biome, so it is
  // the one place a 3.5× ball is available to a starting wallet.
  coast: [
    R('wingull', 20, 190, 'day'), R('krabby', 14, 225, 'day'), R('tentacool', 14, 190, 'day'),
    R('staryu', 8, 225, 'day'), R('shellder', 10, 190, 'day'), R('corphish', 10, 205, 'day'),
    R('buizel', 10, 190, 'day'), R('finneon', 8, 190, 'morning'), R('spheal', 6, 255, 'morning'),
    R('wailmer', 5, 125, 'day', 2), R('mantyke', 2, 25, 'day', 2),
    R('magikarp', 14, 255, 'any'), R('psyduck', 10, 190, 'any'), R('marill', 8, 190, 'any'),
    R('wooper', 8, 255, 'any'), R('shellos', 8, 190, 'any'), R('alomomola', 3, 75, 'any', 2),
    R('feebas', 1, 255, 'any'),
    R('chinchou', 12, 190, 'night'), R('remoraid', 10, 190, 'night'), R('frillish', 8, 190, 'night'),
    R('luvdisc', 6, 225, 'night'), R('dratini', 1, 45, 'night', 4),
  ],
};

/**
 * RETIRED. The per-step chance a cell of tall grass produced a Pokemon, which
 * was the whole of the random-encounter system: `encounter.roll()` compared `stepValue(seed,
 * steps++)` against it on every `player:enteredTile`. A hunt meets its wildlife where the
 * wildlife is standing now, so nothing rolls and there is no rate to declare. The `step/0`
 * stream pin retired with it; the `roll/7` and `catch/5/1` pins did not move, which is the
 * evidence the index space survived.
 */

/** Every capture rate any table declares, flattened once at module load. */
const CATCH_RATE = new Map();
for (const rows of Object.values(TABLES)) for (const row of rows) CATCH_RATE.set(row.n, row.r);

/** The mainline capture rate for a species this module can spawn, or `null`. */
export function authoredCatchRate(name) {
  return CATCH_RATE.get(String(name ?? '').toLowerCase()) ?? null;
}

/** The rows live in `biome` during the band `tod` falls in. */
export function rowsFor(biome, tod = 12) {
  const rows = TABLES[biome] ?? TABLES.meadow;
  const band = todBand(tod);
  return rows.filter((r) => r.when === 'any' || r.when === band);
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
export function expand(rows, { slots = 120, biome = null, tod = null } = {}) {
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
  hide('rows', rows.map((r) => ({ species: r.n, weight: r.w, catchRate: r.r, when: r.when, bump: r.bump })));
  hide('biome', biome);
  hide('tod', tod);
  hide('band', tod == null ? null : todBand(tod));
  return out;
}

/** `{ species: levels }` for the rows that out-class their route. Fed to `rolls.rollAt`. */
export function bumpsFor(rows) {
  const out = {};
  for (const r of rows) if (r.bump) out[r.n] = r.bump;
  return out;
}

/**
 * Every species name every table can spawn, checked against a lookup.
 *
 * A typo here is invisible at runtime — `pokemon.species('poochyeena')` returns null, the
 * encounter is dropped and the grass just quietly stops working. So this runs once at
 * `init` and once in `selftest.js`, and it is a `warn` in the browser (a handled path must
 * not cost tools/shots/shoot.js's zero-error budget) and a hard failure in the seam suite.
 */
export function validate(lookup) {
  const bad = [];
  const seen = new Set();
  for (const [biome, rows] of Object.entries(TABLES)) {
    for (const r of rows) {
      const key = `${biome}:${r.n}`;
      if (seen.has(key)) { bad.push(`${key} is listed twice`); continue; }
      seen.add(key);
      if (!lookup(r.n)) bad.push(`${key} is not a species`);
      if (!(r.r >= 3 && r.r <= 255)) bad.push(`${key} capture rate ${r.r} out of range`);
      if (!(r.w > 0)) bad.push(`${key} weight ${r.w} is not positive`);
    }
    // A table with **no rows at all** is a deliberate empty — as in the city —
    // and asking which hours it covers is asking the wrong question. A table with rows that
    // leave an hour bare is still a bug: a lap at that hour would meet nothing and the player
    // would have no way to tell that from a broken trigger.
    if (!rows.length) continue;
    for (const band of ['morning', 'day', 'night']) {
      if (!rows.some((r) => r.when === 'any' || r.when === band)) {
        bad.push(`${biome} has nothing to spawn at ${band}`);
      }
    }
  }
  return bad;
}

/** Row count per biome, for the showcase readout. */
export function summary() {
  return Object.entries(TABLES).map(([biome, rows]) => ({
    biome,
    rows: rows.length,
    morning: rows.filter((r) => r.when === 'any' || r.when === 'morning').length,
    day: rows.filter((r) => r.when === 'any' || r.when === 'day').length,
    night: rows.filter((r) => r.when === 'any' || r.when === 'night').length,
  }));
}

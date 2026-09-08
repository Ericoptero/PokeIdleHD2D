/**
 * Sorting and duplicate rules.
 *
 * Two properties every comparator here has, and they are not free:
 *
 * **Total.** Every comparator ends in the same tiebreak chain — catch ordinal, then uid —
 * so no two entries ever compare equal. A comparator that returns 0 for two Pokémon makes
 * the result depend on `Array.prototype.sort`'s implementation, and "same seed, same world"
 * (ARCHITECTURE §2.5) then stops being true across browsers. Ending on the ordinal costs
 * one comparison and buys a sort that is identical everywhere.
 *
 * **Direction-safe.** `desc` flips the *primary* key only. Sorting by level descending
 * should still break ties by IV descending and then by catch order ascending; negating the
 * whole comparator would reverse the tiebreaks too and shuffle equal-level Pokémon around
 * for no reason the player can see.
 */

import { ivPct } from './dex.js';

/** Type order for the `type` sort — the mainline's own chart order. */
const TYPE_RANK = new Map([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
].map((t, i) => [t, i]));

const num = (v) => (Number.isFinite(v) ? v : 0);
/** Unknown species sort after every known one instead of colliding at 0. */
const dexOf = (e) => (Number.isFinite(e.dexId) ? e.dexId : 1e9);

/**
 * @typedef {Object} SortMode
 * @property {string} id
 * @property {string} label
 * @property {string} blurb    one line, shown in the UI next to the mode
 * @property {(a:Object,b:Object)=>number} key   primary comparison, ascending
 */

/** @type {Record<string, SortMode>} */
export const SORT_MODES = {
  species: {
    id: 'species', label: 'Dex number', blurb: 'national order, base forms before their variants',
    key: (a, b) => dexOf(a) - dexOf(b)
      || Number(!!a.form) - Number(!!b.form)
      || String(a.form ?? '').localeCompare(String(b.form ?? '')),
  },
  name: {
    id: 'name', label: 'Name', blurb: 'alphabetical by display name',
    key: (a, b) => String(a.display).localeCompare(String(b.display)),
  },
  level: {
    id: 'level', label: 'Level', blurb: 'highest level first',
    key: (a, b) => num(b.level) - num(a.level),
  },
  iv: {
    id: 'iv', label: 'IV total', blurb: 'best rolls first, out of 186',
    key: (a, b) => num(b.ivTotal) - num(a.ivTotal),
  },
  bst: {
    id: 'bst', label: 'Base stats', blurb: 'strongest species first',
    key: (a, b) => num(b.bst) - num(a.bst),
  },
  shiny: {
    id: 'shiny', label: 'Shiny', blurb: 'shinies to the front, then dex order',
    key: (a, b) => Number(!!b.shiny) - Number(!!a.shiny) || dexOf(a) - dexOf(b),
  },
  type: {
    id: 'type', label: 'Type', blurb: 'grouped by primary type, chart order',
    key: (a, b) => (TYPE_RANK.get(a.types?.[0]) ?? 99) - (TYPE_RANK.get(b.types?.[0]) ?? 99)
      || dexOf(a) - dexOf(b),
  },
  caught: {
    id: 'caught', label: 'Date caught', blurb: 'oldest first — the order they arrived',
    key: (a, b) => num(a.ordinal) - num(b.ordinal),
  },
  favourite: {
    id: 'favourite', label: 'Favourites', blurb: 'starred first, then dex order',
    key: (a, b) => Number(!!b.favourite) - Number(!!a.favourite) || dexOf(a) - dexOf(b),
  },
  duplicates: {
    id: 'duplicates', label: 'Duplicates', blurb: 'biggest piles first, best of each pile leading',
    // `count` is stamped on by `sortEntries` before the comparator runs; without it a
    // per-entry comparator cannot see how many siblings an entry has.
    key: (a, b) => num(b._dupCount) - num(a._dupCount)
      || dexOf(a) - dexOf(b)
      || num(b.ivTotal) - num(a.ivTotal),
  },
};

export const SORT_IDS = Object.keys(SORT_MODES);

/** Secondary keys, applied in order after the primary and never flipped by `desc`. */
const TIEBREAK = [
  (a, b) => num(b.ivTotal) - num(a.ivTotal),
  (a, b) => num(b.level) - num(a.level),
  (a, b) => num(a.ordinal) - num(b.ordinal),
  (a, b) => String(a.uid).localeCompare(String(b.uid)),
];

/**
 * @param {Object[]} entries
 * @param {string} mode  a key of SORT_MODES
 * @param {{desc?:boolean}} [opts]
 * @returns {Object[]} a new array; the input is not touched
 */
export function sortEntries(entries, mode = 'species', { desc = false } = {}) {
  const spec = SORT_MODES[mode] ?? SORT_MODES.species;
  const list = entries.slice();

  if (spec.id === 'duplicates') {
    const counts = new Map();
    for (const e of list) counts.set(e.species, (counts.get(e.species) ?? 0) + 1);
    for (const e of list) e._dupCount = counts.get(e.species) ?? 1;
  }

  const sign = desc ? -1 : 1;
  list.sort((a, b) => {
    const primary = spec.key(a, b);
    if (primary !== 0) return primary * sign;
    for (const t of TIEBREAK) {
      const v = t(a, b);
      if (v !== 0) return v;
    }
    return 0;
  });

  if (spec.id === 'duplicates') for (const e of list) delete e._dupCount;
  return list;
}

/**
 * Groups a storage list by species.
 * @returns {{species:string, display:string, dexId:number|null, count:number,
 *            shiny:number, best:Object, entries:Object[]}[]} biggest pile first
 */
export function groupBySpecies(entries) {
  const groups = new Map();
  for (const e of entries) {
    let g = groups.get(e.species);
    if (!g) groups.set(e.species, (g = { species: e.species, display: e.display, dexId: e.dexId, count: 0, shiny: 0, entries: [] }));
    g.count++;
    if (e.shiny) g.shiny++;
    g.entries.push(e);
  }
  for (const g of groups.values()) {
    g.entries = sortEntries(g.entries, 'iv');
    g.best = g.entries[0] ?? null;
  }
  return [...groups.values()].sort((a, b) =>
    b.count - a.count || (a.dexId ?? 1e9) - (b.dexId ?? 1e9) || a.species.localeCompare(b.species));
}

/** How a release rule decides which one of a pile to keep. */
export const KEEP_RULES = Object.freeze({
  iv: { id: 'iv', label: 'best IVs', pick: (list) => sortEntries(list, 'iv')[0] },
  level: { id: 'level', label: 'highest level', pick: (list) => sortEntries(list, 'level')[0] },
  bst: { id: 'bst', label: 'strongest species', pick: (list) => sortEntries(list, 'bst')[0] },
  first: { id: 'first', label: 'the one caught first', pick: (list) => sortEntries(list, 'caught')[0] },
  last: { id: 'last', label: 'the one caught last', pick: (list) => sortEntries(list, 'caught').at(-1) },
});

/**
 * Works out which duplicates a rule would release. **Pure** — it mutates nothing, which is
 * the whole point: `automation` has to be able to show a player what a rule will do before
 * it does it, and an auto-release that cannot be previewed is one nobody will ever enable.
 *
 * @param {Object[]} entries          everything in storage
 * @param {Object} [rule]
 * @param {string} [rule.keep]        a key of KEEP_RULES
 * @param {number} [rule.keepPerSpecies]  how many of each species survive (default 1)
 * @param {boolean} [rule.protectShiny]
 * @param {boolean} [rule.protectFavourite]
 * @param {number} [rule.minIvPct]    never release above this IV percentage
 * @param {number} [rule.minLevel]    never release at or above this level
 * @param {Set<string>} [rule.protectedUids]  party members, usually
 * @param {number} [rule.max]         cap on how many the rule may take at once
 * @returns {{release:Object[], keep:Object[], reasons:Object}}
 */
export function planDuplicateRelease(entries, rule = {}) {
  const {
    keep = 'iv', keepPerSpecies = 1,
    protectShiny = true, protectFavourite = true,
    minIvPct = null, minLevel = null,
    protectedUids = new Set(), max = Infinity,
  } = rule;

  const picker = KEEP_RULES[keep] ?? KEEP_RULES.iv;
  const release = [];
  const kept = [];
  const reasons = { shiny: 0, favourite: 0, protected: 0, iv: 0, level: 0, quota: 0, capped: 0 };

  for (const group of groupBySpecies(entries)) {
    // The keepers come off the front of the rule's own ordering, so "keep 2, best IVs"
    // keeps the two best and not the two the map happened to yield first.
    const ordered = [];
    const pool = group.entries.slice();
    while (pool.length && ordered.length < Math.max(1, keepPerSpecies)) {
      const pick = picker.pick(pool);
      ordered.push(pick);
      pool.splice(pool.indexOf(pick), 1);
    }
    kept.push(...ordered);
    reasons.quota += ordered.length;

    for (const e of pool) {
      if (protectShiny && e.shiny) { kept.push(e); reasons.shiny++; continue; }
      if (protectFavourite && e.favourite) { kept.push(e); reasons.favourite++; continue; }
      if (protectedUids.has(e.uid) || protectedUids.has(e.instanceId)) { kept.push(e); reasons.protected++; continue; }
      if (minIvPct != null && ivPct(e.ivTotal) >= minIvPct) { kept.push(e); reasons.iv++; continue; }
      if (minLevel != null && e.level >= minLevel) { kept.push(e); reasons.level++; continue; }
      release.push(e);
    }
  }

  // Deterministic order for the cap: oldest catches go first, which is both the least
  // surprising thing to lose and stable across replays.
  release.sort((a, b) => num(a.ordinal) - num(b.ordinal) || String(a.uid).localeCompare(String(b.uid)));
  if (release.length > max) {
    reasons.capped = release.length - max;
    kept.push(...release.splice(max));
  }
  return { release, keep: kept, reasons, rule: { keep: picker.id, keepPerSpecies, protectShiny, protectFavourite, minIvPct, minLevel, max } };
}

/**
 * The dex — what has been seen, what has been caught, and what that adds up to.
 *
 * Pure data. Nothing in this file knows about `ctx`, the bus, three.js or the DOM: it takes
 * a species table in and answers questions about it, which is what makes the whole thing
 * runnable in Node (`selftest.js`) and replayable from a save.
 *
 * ### The dex universe is read out of the data, never hardcoded
 *
 * `public/generated/species.json` ships 1253 sheets, of which **995** are distinct species
 * (`form === null`) and 258 are alternate forms — Alolan Rattata, Pikachu in a cap, and so
 * on. A form shares its base's national dex number, so counting sheets would report a dex
 * of 1253 and a Pikachu-heavy save as further along than it is. Completion is therefore
 * measured against base forms only, and forms are counted separately as a bonus track.
 *
 * Generation and type totals come from the same pass, so if a later species build adds the
 * missing Gen 9 sheets the denominators move on their own.
 *
 * ### Two "best IV" numbers, because they answer different questions
 *
 * `bestOwned` is the best one you still have — it has to be recomputed when that Pokémon is
 * released, or the box screen would keep advertising a Pokémon that is gone. `bestEver` is
 * monotone and survives a release, because "did I ever roll a perfect one" is a different
 * question from "what is in my box right now", and a player who releases a 31/31/31 by
 * accident should still see that it happened.
 */

/** Stat keys in the mainline's own order. */
export const IV_KEYS = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);
export const IV_MAX = 31;
/** 6 × 31. A "perfect" Pokémon. */
export const IV_TOTAL_MAX = IV_KEYS.length * IV_MAX;

/** Type order used for every type breakdown, so two runs list them the same way. */
export const TYPE_ORDER = Object.freeze([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
]);

/** @param {Object} ivs @returns {number} 0..186 */
export function ivTotal(ivs) {
  if (!ivs) return 0;
  let sum = 0;
  for (const k of IV_KEYS) {
    const v = Number(ivs[k]);
    sum += Number.isFinite(v) ? Math.max(0, Math.min(IV_MAX, v)) : 0;
  }
  return sum;
}

/** @returns {number} 0..100 */
export const ivPct = (total) => +((total / IV_TOTAL_MAX) * 100).toFixed(1);

/** The mainline's own appraisal wording, keyed off the IV total. */
export function ivGrade(total) {
  if (total >= 181) return 'flawless';
  if (total >= 151) return 'fantastic';
  if (total >= 121) return 'very good';
  if (total >= 91) return 'pretty good';
  if (total >= 61) return 'decent';
  return 'so-so';
}

const empty = () => 0;

/**
 * @param {Object} opts
 * @param {Array}  opts.table    every species sheet (`public/generated/species.json`)
 * @param {Function} [opts.onUnknown]  called once per unrecognised species key
 */
export function makeDex({ table = [], onUnknown = null } = {}) {
  /** name -> species sheet */
  const sheets = new Map();
  for (const s of table) if (s?.name) sheets.set(String(s.name).toLowerCase(), s);

  // --- the universe, measured from the table ---------------------------------
  const baseForms = table.filter((s) => !s.form);
  const universe = {
    species: baseForms.length,
    forms: table.length - baseForms.length,
    sheets: table.length,
    /** gen -> count of base forms */
    byGen: new Map(),
    /** type -> count of base forms carrying it */
    byType: new Map(),
  };
  for (const s of baseForms) {
    universe.byGen.set(s.gen, (universe.byGen.get(s.gen) ?? 0) + 1);
    for (const t of s.types ?? []) universe.byType.set(t, (universe.byType.get(t) ?? 0) + 1);
  }
  const gens = [...universe.byGen.keys()].sort((a, b) => a - b);
  const types = TYPE_ORDER.filter((t) => universe.byType.has(t))
    .concat([...universe.byType.keys()].filter((t) => !TYPE_ORDER.includes(t)).sort());

  /** key -> record */
  const records = new Map();
  const unknownReported = new Set();

  function sheetFor(key) {
    const s = sheets.get(key);
    if (s) return s;
    if (!unknownReported.has(key)) {
      unknownReported.add(key);
      onUnknown?.(key);
    }
    return null;
  }

  /**
   * A record exists the moment a species is *seen*; before that the species is simply
   * absent from the map, which keeps `records.size` meaningful.
   */
  function ensure(key) {
    let r = records.get(key);
    if (r) return r;
    const s = sheetFor(key);
    r = {
      key,
      id: s?.id ?? null,
      display: s?.display ?? key.replace(/(^|[-_])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()),
      base: s?.base ?? key,
      form: s?.form ?? null,
      gen: s?.gen ?? null,
      types: s?.types ?? [],
      bst: s?.bst ?? 0,
      known: !!s,
      seen: 0, caught: 0, released: 0, owned: 0,
      shinySeen: 0, shinyCaught: 0, shinyOwned: 0,
      firstSeenOrdinal: null, firstCaughtOrdinal: null,
      firstSeenSim: null, firstCaughtSim: null,
      levelMax: 0,
      bestOwned: null,
      bestEver: null,
    };
    records.set(key, r);
    return r;
  }

  const summary = (entry) => ({
    uid: entry.uid,
    total: entry.ivTotal,
    pct: ivPct(entry.ivTotal),
    grade: ivGrade(entry.ivTotal),
    ivs: { ...entry.ivs },
    level: entry.level,
    shiny: !!entry.shiny,
  });

  const better = (a, b) =>
    !b ? true : a.ivTotal !== b.total ? a.ivTotal > b.total : a.level > b.level;

  return {
    // --- the universe -------------------------------------------------------
    universe: {
      species: universe.species, forms: universe.forms, sheets: universe.sheets,
      gens: gens.slice(),
      types: types.slice(),
      genTotal: (g) => universe.byGen.get(g) ?? 0,
      typeTotal: (t) => universe.byType.get(t) ?? 0,
    },
    sheet: (key) => sheets.get(String(key).toLowerCase()) ?? null,

    // --- recording ----------------------------------------------------------
    /** An encounter began. Seeing a form counts the form; completion counts its base. */
    see(key, { shiny = false, ordinal = 0, simTime = 0 } = {}) {
      const r = ensure(key);
      r.seen++;
      if (shiny) r.shinySeen++;
      if (r.firstSeenOrdinal === null) { r.firstSeenOrdinal = ordinal; r.firstSeenSim = simTime; }
      return r;
    },

    /**
     * A Pokémon was caught. `stored` is false when storage was full and it never reached a
     * box: the dex still remembers meeting it — that is what a dex is — but nothing may
     * claim to *own* it, so the owned counts and the best-owned line are left alone.
     *
     * @returns {{record:Object, isNewSpecies:boolean}}
     */
    add(entry, { stored = true } = {}) {
      const r = ensure(entry.species);
      const isNew = r.caught === 0;
      r.caught++;
      if (entry.shiny) r.shinyCaught++;
      if (stored) {
        r.owned++;
        if (entry.shiny) r.shinyOwned++;
        if (better(entry, r.bestOwned)) r.bestOwned = summary(entry);
      }
      if (r.firstSeenOrdinal === null) { r.firstSeenOrdinal = entry.ordinal; r.firstSeenSim = entry.simTime; r.seen++; }
      if (r.firstCaughtOrdinal === null) { r.firstCaughtOrdinal = entry.ordinal; r.firstCaughtSim = entry.simTime; }
      r.levelMax = Math.max(r.levelMax, entry.level);
      if (better(entry, r.bestEver)) r.bestEver = summary(entry);
      return { record: r, isNewSpecies: isNew };
    },

    /**
     * An entry left storage. `remaining` is every entry of that species still held, so the
     * best-owned line can be rebuilt rather than left pointing at something released.
     */
    remove(entry, remaining = [], { released = true } = {}) {
      const r = records.get(entry.species);
      if (!r) return null;
      r.owned = Math.max(0, r.owned - 1);
      if (entry.shiny) r.shinyOwned = Math.max(0, r.shinyOwned - 1);
      if (released) r.released++;
      if (r.bestOwned?.uid === entry.uid) {
        r.bestOwned = null;
        for (const e of remaining) if (better(e, r.bestOwned)) r.bestOwned = summary(e);
      }
      return r;
    },

    /**
     * Rebuilds every "currently owned" figure from the live storage. Used after a bulk
     * release and after a save is loaded, where walking the deltas would be both slower and
     * a chance to drift.
     */
    recount(entries = []) {
      for (const r of records.values()) { r.owned = 0; r.shinyOwned = 0; r.bestOwned = null; }
      for (const e of entries) {
        const r = ensure(e.species);
        r.owned++;
        if (e.shiny) r.shinyOwned++;
        if (better(e, r.bestOwned)) r.bestOwned = summary(e);
        if (better(e, r.bestEver)) r.bestEver = summary(e);
      }
    },

    // --- reading ------------------------------------------------------------
    get: (key) => records.get(String(key).toLowerCase()) ?? null,
    has: (key) => records.has(String(key).toLowerCase()),
    size: () => records.size,
    /** Every record, in national dex order; unknown keys sort last. */
    all() {
      return [...records.values()].sort((a, b) =>
        (a.id ?? 1e9) - (b.id ?? 1e9) || a.key.localeCompare(b.key));
    },
    seenKeys: () => [...records.values()].filter((r) => r.seen > 0).map((r) => r.key),
    caughtKeys: () => [...records.values()].filter((r) => r.caught > 0).map((r) => r.key),

    /**
     * Completion, sliced the three ways a player actually reads it: overall, by generation
     * and by type. Base forms only in every denominator — see the header.
     */
    completion() {
      const seenIds = new Set();
      const caughtIds = new Set();
      const ownedIds = new Set();
      const genSeen = new Map(), genCaught = new Map(), genOwned = new Map();
      const typeSeen = new Map(), typeCaught = new Map(), typeOwned = new Map();
      let formsSeen = 0, formsCaught = 0;

      for (const r of records.values()) {
        if (!r.known || r.id === null) continue;
        if (r.form) {
          if (r.seen > 0) formsSeen++;
          if (r.caught > 0) formsCaught++;
          continue;                       // a form does not fill its base's dex slot
        }
        if (r.seen > 0) {
          seenIds.add(r.id);
          genSeen.set(r.gen, (genSeen.get(r.gen) ?? 0) + 1);
          for (const t of r.types) typeSeen.set(t, (typeSeen.get(t) ?? 0) + 1);
        }
        if (r.caught > 0) {
          caughtIds.add(r.id);
          genCaught.set(r.gen, (genCaught.get(r.gen) ?? 0) + 1);
          for (const t of r.types) typeCaught.set(t, (typeCaught.get(t) ?? 0) + 1);
        }
        if (r.owned > 0) {
          ownedIds.add(r.id);
          genOwned.set(r.gen, (genOwned.get(r.gen) ?? 0) + 1);
          for (const t of r.types) typeOwned.set(t, (typeOwned.get(t) ?? 0) + 1);
        }
      }

      const pct = (n, d) => (d > 0 ? +((n / d) * 100).toFixed(1) : 0);
      return {
        total: universe.species,
        seen: seenIds.size,
        caught: caughtIds.size,
        owned: ownedIds.size,
        seenPct: pct(seenIds.size, universe.species),
        caughtPct: pct(caughtIds.size, universe.species),
        /** A "living dex" holds one of every species at once, not merely caught-then-released. */
        livingPct: pct(ownedIds.size, universe.species),
        forms: { total: universe.forms, seen: formsSeen, caught: formsCaught, pct: pct(formsCaught, universe.forms) },
        byGen: gens.map((g) => {
          const total = universe.byGen.get(g) ?? 0;
          return {
            gen: g, total,
            seen: genSeen.get(g) ?? empty(), caught: genCaught.get(g) ?? empty(), owned: genOwned.get(g) ?? empty(),
            pct: pct(genCaught.get(g) ?? 0, total),
          };
        }),
        byType: types.map((t) => {
          const total = universe.byType.get(t) ?? 0;
          return {
            type: t, total,
            seen: typeSeen.get(t) ?? empty(), caught: typeCaught.get(t) ?? empty(), owned: typeOwned.get(t) ?? empty(),
            pct: pct(typeCaught.get(t) ?? 0, total),
          };
        }),
      };
    },

    // --- persistence --------------------------------------------------------
    /**
     * Only what cannot be derived from the boxes: the counters, the firsts, and the
     * best-ever line. Owned counts and best-owned are rebuilt by `recount()` on load, which
     * makes them impossible to desync from the storage they describe.
     */
    serialize() {
      const out = {};
      for (const r of records.values()) {
        out[r.key] = [
          r.seen, r.caught, r.released, r.shinySeen, r.shinyCaught,
          r.firstSeenOrdinal, r.firstCaughtOrdinal,
          r.firstSeenSim === null ? null : +r.firstSeenSim.toFixed(2),
          r.firstCaughtSim === null ? null : +r.firstCaughtSim.toFixed(2),
          r.levelMax,
          r.bestEver ? [r.bestEver.total, r.bestEver.level, r.bestEver.shiny ? 1 : 0, IV_KEYS.map((k) => r.bestEver.ivs[k])] : null,
        ];
      }
      return out;
    },

    deserialize(data) {
      records.clear();
      unknownReported.clear();
      for (const [key, v] of Object.entries(data ?? {})) {
        if (!Array.isArray(v)) continue;
        const r = ensure(key);
        [r.seen, r.caught, r.released, r.shinySeen, r.shinyCaught,
          r.firstSeenOrdinal, r.firstCaughtOrdinal, r.firstSeenSim, r.firstCaughtSim, r.levelMax] = v;
        const best = v[10];
        if (Array.isArray(best)) {
          const ivs = {};
          IV_KEYS.forEach((k, i) => { ivs[k] = best[3]?.[i] ?? 0; });
          r.bestEver = { uid: null, total: best[0], pct: ivPct(best[0]), grade: ivGrade(best[0]), ivs, level: best[1], shiny: !!best[2] };
        }
      }
    },
  };
}

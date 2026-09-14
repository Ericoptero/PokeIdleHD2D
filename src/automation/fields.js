/**
 * The fact schema — the other half of "rules are data".
 *
 * A rule can only ask about what is listed here. Each field declares its `type`, its
 * `label`, its unit, its legal range or enum values and which operators apply, so a rule
 * editor can be generated from this table alone: `ui` renders a field picker, then an
 * operator picker filtered by `type`, then the right value control. There is no
 * hard-coded checkbox anywhere, and adding a new thing a player can test is one entry in
 * this file plus one line in the matching fact builder.
 *
 * ### Three subject kinds
 *
 * | kind     | the subject is…                | who evaluates it |
 * | -------- | ------------------------------ | ---------------- |
 * | `wild`   | a wild Pokémon in front of you | hunt, catch, ball |
 * | `stored` | one already in a box           | release |
 * | `item`   | a stack in the bag             | sell, restock |
 *
 * Every kind also gets the shared `world` fields (biome, time, wallet, box pressure), so a
 * rule like "only sell while I have under ₽5,000" or "stop releasing once the box is under
 * half full" is expressible without a second rule system.
 *
 * ### Facts are flat, plain and built once
 *
 * A fact object is `{ [fieldId]: value }` and nothing else — no getters, no prototypes, no
 * lazy lookups. Compiled rules index it directly, so evaluating a rule set over a 900-slot
 * box is a few hundred property reads. The cost of *building* facts is paid once per
 * subject, not once per rule, which is what keeps a twenty-rule ruleset the same price as
 * a two-rule one.
 */

import { operatorsFor } from './ops.js';

/**
 * The built-in table ids, in the order the pickers should list them.
 *
 * P5: a map's own gameplay-profile id (`terrain.handle().encounterTable`) is no longer
 * restricted to this list — `encounter/tables.js`'s own `TABLES[id] ?? TABLES.meadow`
 * fallback accepts any id and degrades gracefully. This stays as the enum a rule editor's
 * "Biome" field *suggests* (`WORLD_FIELDS`, below), because it is the set every fresh save
 * ships with; it is descriptive metadata for the picker, not a whitelist the `biome` fact
 * is checked against.
 */
export const BIOMES = Object.freeze(['city', 'meadow', 'forest', 'cave', 'coast']);

/** The 18 types, so a "never release a Dragon" rule can offer a real list. */
export const TYPES = Object.freeze([
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
]);

export const ITEM_CATEGORIES = Object.freeze([
  'ball', 'medicine', 'treasure', 'candy', 'evolution', 'held', 'lure',
]);

export const ORIGINS = Object.freeze(['wild', 'gift', 'restore', 'trade']);

const IV_TOTAL_MAX = 186;

/**
 * A capture rate the species snapshot does not carry.
 *
 * `public/generated/species.json` was built from the overworld sprite sheets and has no
 * `captureRate` column, but the ball maths in `economy` needs one and a flat 45 would make
 * every ball comparison identical for a Caterpie and a Dragonite. This is a **declared
 * proxy**, not a claim to be the mainline table: it is monotone decreasing in base-stat
 * total, deterministic, and lands on the familiar landmarks — an early bug (BST ~195) comes
 * out near 255, a mid-game evolution (BST ~450) near 60, a pseudo-legendary (BST 600) near
 * 10 and a box legendary (BST 680+) at the floor of 3.
 *
 * Everything downstream treats it as an input, so swapping in a real table later changes
 * one function.
 */
export function catchRateFor(bst) {
  const b = Number.isFinite(bst) && bst > 0 ? bst : 300;
  const t = Math.max(0, Math.min(1, (b - 190) / (720 - 190)));
  return Math.max(3, Math.min(255, Math.round(255 * Math.pow(1 - t, 2.2))));
}

/**
 * Shared context fields. Present on every subject kind, because "what else is true right
 * now" is a legitimate part of nearly every rule a player writes.
 * @type {Object[]}
 */
const WORLD_FIELDS = [
  { id: 'biome', label: 'Biome', type: 'enum', values: BIOMES, group: 'world',
    blurb: 'Where the hunt is happening.' },
  { id: 'tod', label: 'Time of day', type: 'number', unit: 'h', min: 0, max: 24, step: 0.5, group: 'world',
    blurb: 'In-game hours, 0–24.' },
  { id: 'night', label: 'Night', type: 'bool', group: 'world',
    blurb: 'True between 20:00 and 04:00 — when Dusk Balls are worth carrying.' },
  { id: 'money', label: 'Money', type: 'number', unit: '₽', min: 0, step: 100, group: 'world' },
  { id: 'research', label: 'Research', type: 'number', unit: '◈', min: 0, step: 10, group: 'world' },
  { id: 'bp', label: 'Battle Points', type: 'number', unit: 'BP', min: 0, step: 1, group: 'world' },
  { id: 'shards', label: 'Shards', type: 'number', unit: '◆', min: 0, step: 1, group: 'world' },
  { id: 'ballsInBag', label: 'Balls in bag', type: 'number', min: 0, step: 1, group: 'world',
    blurb: 'Every ball category summed — what auto-catch has left to spend.' },
  { id: 'boxFree', label: 'Free box slots', type: 'number', min: 0, step: 1, group: 'world' },
  { id: 'boxUsed', label: 'Stored Pokémon', type: 'number', min: 0, step: 1, group: 'world' },
  { id: 'boxFull', label: 'Boxes full', type: 'bool', group: 'world' },
  { id: 'dexCaught', label: 'Dex caught', type: 'number', min: 0, step: 1, group: 'world' },
];

/** Fields shared by anything that *is* a Pokémon, wild or stored. */
const SPECIES_FIELDS = [
  { id: 'species', label: 'Species', type: 'text', suggest: 'species', group: 'species',
    blurb: 'Lower-case species key, e.g. "gengar".' },
  { id: 'dexId', label: 'Dex number', type: 'number', min: 1, max: 1025, step: 1, group: 'species' },
  { id: 'gen', label: 'Generation', type: 'number', min: 1, max: 9, step: 1, group: 'species' },
  { id: 'types', label: 'Types', type: 'list', values: TYPES, group: 'species' },
  { id: 'bst', label: 'Base stat total', type: 'number', min: 175, max: 780, step: 5, group: 'species' },
  { id: 'level', label: 'Level', type: 'number', min: 1, max: 100, step: 1, group: 'individual' },
  { id: 'shiny', label: 'Shiny', type: 'bool', group: 'individual' },
];

/** @type {Object<string, Object[]>} */
export const FIELD_SETS = {
  wild: [
    ...SPECIES_FIELDS,
    { id: 'catchRate', label: 'Capture rate', type: 'number', min: 3, max: 255, step: 1, group: 'individual',
      blurb: 'Derived from base-stat total; 255 is trivially catchable, 3 is a legendary.' },
    { id: 'hpFraction', label: 'Target HP', type: 'number', unit: '×', min: 0.01, max: 1, step: 0.05, group: 'individual',
      blurb: 'Fraction of health left. An auto-resolved win leaves the target low.' },
    { id: 'newSpecies', label: 'New to the dex', type: 'bool', group: 'progress',
      blurb: 'Never caught before — the target worth spending a good ball on.' },
    { id: 'everCaught', label: 'Already caught', type: 'bool', group: 'progress' },
    { id: 'ownedCount', label: 'Copies held', type: 'number', min: 0, step: 1, group: 'progress' },
    { id: 'value', label: 'Release value', type: 'number', unit: '₽', min: 0, step: 50, group: 'progress',
      blurb: 'What `economy.appraise` says it is worth if let go.' },
    ...WORLD_FIELDS,
  ],

  stored: [
    ...SPECIES_FIELDS,
    { id: 'ivPct', label: 'IV %', type: 'number', unit: '%', min: 0, max: 100, step: 1, group: 'individual',
      blurb: '0–100 across all six stats. 100 is flawless.' },
    { id: 'ivTotal', label: 'IV total', type: 'number', min: 0, max: IV_TOTAL_MAX, step: 1, group: 'individual' },
    { id: 'bestIv', label: 'Best single IV', type: 'number', min: 0, max: 31, step: 1, group: 'individual' },
    { id: 'favourite', label: 'Favourite', type: 'bool', group: 'individual' },
    { id: 'inParty', label: 'In the party', type: 'bool', group: 'individual' },
    { id: 'origin', label: 'Origin', type: 'enum', values: ORIGINS, group: 'individual' },
    { id: 'ball', label: 'Caught with', type: 'text', group: 'individual' },
    { id: 'copies', label: 'Copies held', type: 'number', min: 1, step: 1, group: 'duplicates',
      blurb: 'How many of this species are in storage, including this one.' },
    { id: 'rank', label: 'Rank among copies', type: 'number', min: 1, step: 1, group: 'duplicates',
      blurb: '1 is the best of its species under the automation\'s keep order.' },
    { id: 'onlyCopy', label: 'Only copy', type: 'bool', group: 'duplicates',
      blurb: 'True when releasing it would empty the living dex entry.' },
    { id: 'value', label: 'Release value', type: 'number', unit: '₽', min: 0, step: 50, group: 'duplicates' },
    { id: 'ageS', label: 'Held for', type: 'number', unit: 's', min: 0, step: 30, group: 'duplicates',
      blurb: 'Simulated seconds since it was caught.' },
    ...WORLD_FIELDS,
  ],

  item: [
    { id: 'id', label: 'Item', type: 'text', suggest: 'item', group: 'item' },
    { id: 'name', label: 'Item name', type: 'text', group: 'item' },
    { id: 'category', label: 'Category', type: 'enum', values: ITEM_CATEGORIES, group: 'item' },
    { id: 'tier', label: 'Tier', type: 'number', min: 1, max: 5, step: 1, group: 'item' },
    { id: 'count', label: 'Held', type: 'number', min: 0, step: 1, group: 'item' },
    { id: 'unitValue', label: 'Sells for', type: 'number', unit: '₽', min: 0, step: 10, group: 'item' },
    { id: 'stackValue', label: 'Stack is worth', type: 'number', unit: '₽', min: 0, step: 100, group: 'item' },
    { id: 'price', label: 'Costs', type: 'number', unit: '₽', min: 0, step: 50, group: 'item',
      blurb: '0 when the item is not for sale anywhere you can reach.' },
    { id: 'currency', label: 'Bought with', type: 'enum', values: ['money', 'bp', 'research', 'shards'], group: 'item' },
    { id: 'isBall', label: 'Is a ball', type: 'bool', group: 'item' },
    { id: 'sellable', label: 'Can be sold', type: 'bool', group: 'item',
      blurb: 'Key items and Master Balls are worth nothing and are never sold.' },
    ...WORLD_FIELDS,
  ],
};

/** kind -> id -> field, built once. */
const INDEX = new Map(
  Object.entries(FIELD_SETS).map(([kind, list]) => [kind, new Map(list.map((f) => [f.id, f]))]),
);

export const KINDS = Object.freeze(Object.keys(FIELD_SETS));

/** @returns {Object|null} the field descriptor, or null if the kind cannot test it. */
export const field = (kind, id) => INDEX.get(kind)?.get(id) ?? null;

/**
 * The schema `ui` renders from: every field with its type, unit, range, enum values and
 * the operator ids that are legal on it.
 */
export function schemaFor(kind) {
  return (FIELD_SETS[kind] ?? []).map((f) => ({ ...f, ops: operatorsFor(f.type) }));
}

// ---------------------------------------------------------------------------
// Fact builders
// ---------------------------------------------------------------------------

const lower = (s) => String(s ?? '').toLowerCase();

/** Shared half of every fact object. Built once per evaluation pass, not per subject. */
export function worldFacts(w = {}) {
  const tod = Number.isFinite(w.tod) ? w.tod : 12;
  return {
    biome: w.biome ?? 'meadow',
    // The active map's category tags (P5) — not a rule-editor field yet (no shipped
    // automation asks about it), but threaded through so `automation/index.js`'s own
    // `ballContext()` can hand it to `economy.catchOdds` the same way `encounter` does,
    // without a second lookup of `terrain.handle()`.
    tags: Array.isArray(w.tags) ? w.tags : [],
    tod,
    night: tod >= 20 || tod < 4,
    money: w.money ?? 0,
    research: w.research ?? 0,
    bp: w.bp ?? 0,
    shards: w.shards ?? 0,
    ballsInBag: w.ballsInBag ?? 0,
    boxFree: w.boxFree ?? 0,
    boxUsed: w.boxUsed ?? 0,
    boxFull: !!w.boxFull,
    dexCaught: w.dexCaught ?? 0,
  };
}

/**
 * Facts for a wild encounter.
 * @param {Object} subject `{ species, level, shiny, hpFraction, newSpecies, ownedCount, value }`
 * @param {Object} world   the object `worldFacts` returned
 */
export function wildFacts(subject, world) {
  const s = subject.species ?? {};
  const bst = Number.isFinite(subject.bst) ? subject.bst
    : Number.isFinite(s.bst) ? s.bst
      : sumStats(s.baseStats);
  return {
    ...world,
    species: lower(s.name ?? subject.speciesName ?? subject.species),
    dexId: s.id ?? subject.dexId ?? 0,
    gen: s.gen ?? subject.gen ?? 0,
    types: s.types ?? subject.types ?? [],
    bst,
    level: Math.max(1, Math.round(subject.level ?? 5)),
    shiny: !!subject.shiny,
    catchRate: Number.isFinite(subject.catchRate) ? subject.catchRate : catchRateFor(bst),
    hpFraction: Number.isFinite(subject.hpFraction) ? subject.hpFraction : 1,
    newSpecies: !!subject.newSpecies,
    everCaught: !subject.newSpecies,
    ownedCount: subject.ownedCount ?? 0,
    value: subject.value ?? 0,
  };
}

/**
 * Facts for something already in storage. `copies`, `rank` and `onlyCopy` are supplied by
 * the caller because they are a property of the *pile*, not of the individual — working
 * them out per subject would turn a box scan into a quadratic one.
 */
export function storedFacts(entry, world, extra = {}) {
  const ivTotal = entry.ivTotal ?? 0;
  return {
    ...world,
    species: lower(entry.species),
    dexId: entry.dexId ?? 0,
    gen: entry.gen ?? 0,
    types: entry.types ?? [],
    bst: entry.bst ?? 0,
    level: entry.level ?? 1,
    shiny: !!entry.shiny,
    ivTotal,
    ivPct: +((ivTotal / IV_TOTAL_MAX) * 100).toFixed(1),
    bestIv: extra.bestIv ?? bestIvOf(entry.ivs),
    favourite: !!entry.favourite,
    inParty: !!extra.inParty,
    origin: entry.origin ?? 'wild',
    ball: lower(entry.ball ?? ''),
    copies: extra.copies ?? 1,
    rank: extra.rank ?? 1,
    onlyCopy: (extra.copies ?? 1) <= 1,
    value: extra.value ?? 0,
    ageS: extra.ageS ?? 0,
  };
}

/** Facts for one bag stack. */
export function itemFacts(def, count, world, extra = {}) {
  const unit = extra.unitValue ?? def.sell ?? 0;
  return {
    ...world,
    id: lower(def.id),
    name: def.name ?? def.id,
    category: def.category ?? 'held',
    tier: def.tier ?? 1,
    count,
    unitValue: unit,
    stackValue: unit * count,
    price: extra.price ?? def.price ?? 0,
    currency: def.currency ?? 'money',
    isBall: def.category === 'ball',
    sellable: unit > 0,
  };
}

function sumStats(stats) {
  if (!stats) return 300;
  let n = 0;
  for (const k in stats) n += Number(stats[k]) || 0;
  return n > 0 ? n : 300;
}

function bestIvOf(ivs) {
  if (!ivs) return 0;
  let best = 0;
  for (const k in ivs) { const v = Number(ivs[k]) || 0; if (v > best) best = v; }
  return best;
}

/**
 * accrual.js — the one and only definition of what a second of idling produces.
 *
 * `simulate(state, elapsedS, seed)` is a PURE function: no clocks, no ctx, no module
 * lookups, no `Math.random`. `src/offline/` calls the very same function for closed-tab
 * catch-up (ARCHITECTURE §5.7), so if these two ever disagreed the player would see one
 * number while the tab was open and a different one after coming back. There is exactly
 * one implementation, and this is it.
 *
 * ## The property everything else leans on: exact chunk additivity
 *
 * Draining a three-hour gap has to happen in bounded slices or the page freezes, and
 * offline applies the same gap in a single call. Those two must agree *exactly*, so the
 * model is built to be additive in `elapsedS`:
 *
 *   - Continuous currencies (money, exp, research) are `rate(state) * elapsedS`. The rate
 *     depends on `state` only, never on `elapsedS`, so splitting the interval splits the
 *     product and nothing else.
 *   - Discrete events (encounters) are indexed by *cumulative* encounter progress carried
 *     in `state.progress.encounters`. Encounter number N is always rolled from
 *     `makeRng(seed, 'idle/encounter/N')` — its own stream — so which chunk boundary it
 *     happens to land in cannot change what it is.
 *
 * The discrete half is therefore *exactly* invariant: the same encounters, the same wins,
 * catches and shinies, whatever the chunking. The continuous half is invariant up to
 * IEEE-754 summation error only — adding 10800 products is not bit-identical to one
 * multiplication — so the honest claim, and the one `selftest.js` asserts, is: discrete
 * results identical, continuous results within 1e-9 relative. The showcase prints both.
 *
 * ## Reading the model
 *
 * A party member's contribution is `level^0.85 x (BST/300) x slot x affinity x shiny`.
 * Levels matter most, species quality matters, later party slots fall off so a sixth
 * member is a real but diminishing gain, the lead is worth extra (the lead walks in
 * front — ARCHITECTURE §0), and a Pokemon whose type suits the biome earns more there.
 * That is the whole reason to think about party composition, which is the point of an
 * idle game's core loop.
 */

import { makeRng } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Tunables. These live here rather than in core/config.js because they are the
// balance table, not session knobs; the showcase and the seams read them by name.
// ---------------------------------------------------------------------------

/**
 * The balance table. `src/economy/pacing.js` mirrors these into its own `INCOME_MODEL` and
 * projects its shop prices against them, so changing a number here moves the price of a
 * Poke Ball three modules away. Change both, or neither.
 */

/** Money per second at power 1.0, before biome and unlock multipliers. */
export const BASE_MONEY = 0.85;
/** Experience per second at power 1.0. */
export const BASE_EXP = 2.4;
/** Research (spent on unlocks) per second at power 1.0. */
export const BASE_RESEARCH = 0.045;
/** Encounters per second at biome weight 1.0 — one every ~40 s. */
export const BASE_ENCOUNTERS = 0.025;
/** A trainer with no party still works the route, so the game is never fully stalled. */
export const TRAINER_BASE_POWER = 0.6;
/** Overall diminishing return on party power for money, so parties scale but do not run away. */
export const MONEY_POWER_EXP = 0.92;

/** Party slot falloff. Slot 0 is the lead and is boosted separately. */
export const SLOT_FALLOFF = [1, 0.82, 0.68, 0.56, 0.46, 0.38];
/** The lead Pokemon leads — ARCHITECTURE §0 — and is paid for it. */
export const LEAD_BONUS = 1.25;
/** A shiny is rare enough to be worth keeping in the party. */
export const SHINY_BONUS = 1.5;
/** Base shiny rate, and the rate once `shiny-charm` is unlocked. */
export const SHINY_RATE = 1 / 4096;
export const SHINY_RATE_CHARM = 1 / 1365;

/**
 * Biome profiles. A biome is a *choice*: the city pays well and spawns almost nothing,
 * caves are rare-hunting grounds, forests train fastest. `hunts` and `city` set the biome
 * through `terrain`, and this table is what makes the choice matter.
 */
export const BIOMES = {
  city:   { label: 'City',   money: 1.55, exp: 0.55, research: 0.80, encounters: 0.35, favours: { normal: 1.20, electric: 1.30, steel: 1.12, psychic: 1.15 } },
  meadow: { label: 'Meadow', money: 1.00, exp: 1.00, research: 1.00, encounters: 1.00, favours: { normal: 1.18, fairy: 1.28, grass: 1.15, flying: 1.12 } },
  forest: { label: 'Forest', money: 0.85, exp: 1.45, research: 1.20, encounters: 1.35, favours: { grass: 1.38, bug: 1.32, poison: 1.14, dark: 1.08 } },
  cave:   { label: 'Cave',   money: 0.70, exp: 1.20, research: 1.75, encounters: 1.60, favours: { rock: 1.42, ground: 1.36, steel: 1.22, dark: 1.18 } },
  coast:  { label: 'Coast',  money: 1.15, exp: 1.05, research: 1.30, encounters: 1.15, favours: { water: 1.40, flying: 1.22, ice: 1.15, fighting: 1.06 } },
};
export const DEFAULT_BIOME = 'meadow';

/**
 * Unlocks. Multiplicative, permanent, and never on by default — ARCHITECTURE §5.11 says
 * automation is something the player unlocks and configures, and the production layer
 * follows the same rule. `automation` and `economy` decide *when* one is granted; `idle`
 * only reads the set it is handed.
 */
export const UNLOCKS = {
  'route-permit':     { name: 'Route Permit',     blurb: 'Work the routes between towns.',      cost: 8,   money: 1.12 },
  'amulet-coin':      { name: 'Amulet Coin',      blurb: 'Every payout is larger.',             cost: 40,  money: 1.35 },
  'merchant-network': { name: 'Merchant Network', blurb: 'Sell where the price is best.',       cost: 220, money: 1.30, research: 1.10 },
  'lucky-egg':        { name: 'Lucky Egg',        blurb: 'The party learns faster.',            cost: 55,  exp: 1.50 },
  'training-gear':    { name: 'Training Gear',    blurb: 'Weighted gear on every member.',      cost: 180, exp: 1.35 },
  'field-notes':      { name: 'Field Notes',      blurb: 'Sightings become research.',          cost: 30,  research: 1.60 },
  'poke-radar':       { name: 'Poke Radar',       blurb: 'Finds far more wild Pokemon.',        cost: 90,  encounters: 1.45 },
  'lure-module':      { name: 'Lure Module',      blurb: 'Draws wild Pokemon to you.',          cost: 260, encounters: 1.30, research: 1.10 },
  'auto-battler':     { name: 'Auto Battler',     blurb: 'Wild battles resolve themselves.',    cost: 120, battle: true },
  'auto-catch':       { name: 'Auto Catch',       blurb: 'Throws a ball at what it can catch.', cost: 300, catch: true },
  'type-scanner':     { name: 'Type Scanner',     blurb: 'Biome type bonuses hit harder.',      cost: 340, affinity: 1.30 },
  'shiny-charm':      { name: 'Shiny Charm',      blurb: 'Shinies appear three times as often.', cost: 900, charm: true },
  'night-shift':      { name: 'Night Shift',      blurb: 'Paid extra for working after dark.',  cost: 150, night: 1.25 },
};

/** Levelled upgrades: id -> { name, per, cap, field }. `per` is the multiplier per level. */
export const UPGRADES = {
  'wage-tier':    { name: 'Wage Tier',    field: 'money',      per: 1.10, cap: 25 },
  'study-tier':   { name: 'Study Tier',   field: 'exp',        per: 1.09, cap: 25 },
  'search-tier':  { name: 'Search Tier',  field: 'encounters', per: 1.07, cap: 20 },
  'lab-tier':     { name: 'Lab Tier',     field: 'research',   per: 1.12, cap: 20 },
};

/** Items an auto-catch run consumes and an auto-battle run occasionally finds. */
export const BALL_ITEM = 'pokeball';

/**
 * Beyond this many discrete encounters in ONE call we stop materialising individual
 * rolls and finish the remainder at the running mean. A drained gap never reaches it
 * (chunks are bounded); a pathological offline call would, and freezing the page to roll
 * a hundred thousand encounters would be the worse failure.
 */
export const MAX_RESOLVED = 20000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PartyMember
 * @property {{name:string, types?:string[], baseStats?:Object<string,number>}} species
 * @property {number} level
 * @property {boolean} [shiny]
 * @property {string} [instanceId]
 */

/**
 * Everything the model is allowed to know. Assembled by `idle` from the live modules and
 * by `offline` from the save; nothing here is read from a global.
 *
 * @typedef {Object} IdleState
 * @property {PartyMember[]} [party]
 * @property {string} [biome]
 * @property {number} [luck]        1 = neutral; automation buffs may raise it
 * @property {number} [efficiency]  1 online; offline passes config.offlineEfficiency
 * @property {number} [tod]         hours 0..24, for time-of-day unlocks
 * @property {string[]} [unlocks]
 * @property {Object<string,number>} [upgrades]  id -> level
 * @property {string[]} [tables]    species names available in this biome (encounter.tablesFor)
 * @property {number} [balls]       balls in the bag; auto-catch cannot exceed them
 * @property {{encounters:number, seconds:number}} [progress] cumulative, carried between calls
 */

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

const EMPTY = Object.freeze([]);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function bstOf(species) {
  const s = species?.baseStats;
  if (!s) return 300;
  let total = 0;
  for (const k in s) total += s[k] ?? 0;
  return total > 0 ? total : 300;
}

function speedOf(species) {
  return species?.baseStats?.spe ?? 50;
}

/** The strongest affinity among a species' types, so dual types do not multiply out. */
function affinityOf(species, favours, scale) {
  const types = species?.types ?? EMPTY;
  let best = 1;
  for (const t of types) {
    const f = favours[t];
    if (f && f > best) best = f;
  }
  // `type-scanner` sharpens the bonus rather than adding a flat multiplier, so it is
  // worth more to a party that already suits the biome.
  return best === 1 ? 1 : 1 + (best - 1) * scale;
}

function multiplierChain(unlocks, upgrades, tod) {
  const chain = { money: 1, exp: 1, research: 1, encounters: 1 };
  const affinityScale = { value: 1 };
  const flags = { battle: false, catch: false, charm: false };
  const applied = [];

  for (const id of unlocks) {
    const u = UNLOCKS[id];
    if (!u) continue;
    let note = null;
    if (u.money) { chain.money *= u.money; note = `money x${u.money}`; }
    if (u.exp) { chain.exp *= u.exp; note = `exp x${u.exp}`; }
    if (u.research) { chain.research *= u.research; note = note ? `${note}, research x${u.research}` : `research x${u.research}`; }
    if (u.encounters) { chain.encounters *= u.encounters; note = note ? `${note}, enc x${u.encounters}` : `enc x${u.encounters}`; }
    if (u.affinity) { affinityScale.value *= u.affinity; note = `affinity x${u.affinity}`; }
    if (u.night) {
      const dark = tod >= 20 || tod < 4;
      if (dark) { chain.money *= u.night; note = `night x${u.night}`; }
      else note = 'night (inactive)';
    }
    if (u.battle) flags.battle = true;
    if (u.catch) flags.catch = true;
    if (u.charm) flags.charm = true;
    applied.push({ id, name: u.name, note: note ?? (u.battle ? 'auto battle' : u.catch ? 'auto catch' : 'shiny x3') });
  }

  for (const id in upgrades) {
    const spec = UPGRADES[id];
    const level = Math.max(0, Math.min(spec?.cap ?? 0, Math.floor(upgrades[id] ?? 0)));
    if (!spec || level <= 0) continue;
    const mult = Math.pow(spec.per, level);
    chain[spec.field] *= mult;
    applied.push({ id, name: `${spec.name} ${level}`, note: `${spec.field} x${mult.toFixed(2)}` });
  }

  return { chain, affinityScale: affinityScale.value, flags, applied };
}

/**
 * The full per-second picture, with every contribution kept separate so the HUD can show
 * a player *why* a number is what it is. Depends on `state` alone — never on elapsed time.
 *
 * @param {IdleState} state
 */
export function production(state) {
  const party = state?.party ?? EMPTY;
  const biomeId = state?.biome && BIOMES[state.biome] ? state.biome : DEFAULT_BIOME;
  const biome = BIOMES[biomeId];
  const luck = Number.isFinite(state?.luck) ? state.luck : 1;
  const efficiency = Number.isFinite(state?.efficiency) ? state.efficiency : 1;
  const tod = Number.isFinite(state?.tod) ? state.tod : 12;
  const unlocks = state?.unlocks ?? EMPTY;
  const upgrades = state?.upgrades ?? {};

  const { chain, affinityScale, flags, applied } = multiplierChain(unlocks, upgrades, tod);

  // Auto-catch needs balls in the bag. This is a *gate*, evaluated once from the snapshot,
  // not a running budget: a per-encounter budget would make the result depend on where the
  // chunk boundaries fell. The bag is reconciled between gaps instead, so an empty bag
  // turns auto-catch off for the next one.
  if (flags.catch && Number.isFinite(state?.balls) && state.balls <= 0) flags.catch = false;

  const members = [];
  let power = TRAINER_BASE_POWER;
  let speedSum = 0;
  for (let i = 0; i < party.length && i < SLOT_FALLOFF.length; i++) {
    const p = party[i];
    if (!p?.species) continue;
    const level = Math.max(1, p.level ?? 1);
    const levelFactor = Math.pow(level, 0.85);
    const stat = bstOf(p.species) / 300;
    const slot = SLOT_FALLOFF[i] * (i === 0 ? LEAD_BONUS : 1);
    const affinity = affinityOf(p.species, biome.favours, affinityScale);
    const shiny = p.shiny ? SHINY_BONUS : 1;
    const contribution = levelFactor * stat * slot * affinity * shiny;
    power += contribution;
    speedSum += speedOf(p.species);
    members.push({
      slot: i, name: p.species.name, level, shiny: !!p.shiny,
      types: p.species.types ?? EMPTY,
      bst: Math.round(stat * 300), levelFactor, slotMult: slot, affinity, contribution,
      lead: i === 0,
    });
  }
  for (const m of members) m.share = power > 0 ? m.contribution / power : 0;

  // A fast party runs into more wild Pokemon; a slow one plods. A trainer with no party
  // walks at a perfectly ordinary speed.
  const pace = members.length ? 1 + 0.35 * ((speedSum / members.length) / 100 - 0.5) : 1;

  const perSecond = {
    money: BASE_MONEY * Math.pow(power, MONEY_POWER_EXP) * biome.money * chain.money * efficiency,
    exp: BASE_EXP * power * biome.exp * chain.exp * efficiency,
    research: BASE_RESEARCH * Math.pow(power, 0.6) * biome.research * chain.research * efficiency,
    encounters: BASE_ENCOUNTERS * biome.encounters * chain.encounters * luck * pace * efficiency,
  };

  return {
    biome: biomeId, biomeLabel: biome.label, power, pace, efficiency, luck, tod,
    /** The strongest member's level. Wild levels and battle odds are keyed to this. */
    topLevel: members.length ? Math.max(...members.map((m) => m.level)) : 5,
    members, chain, flags, applied, affinityScale, perSecond,
  };
}

// One-entry memo. The gap drainer snapshots its state object once and then calls
// `simulate` with that same object thousands of times; recomputing the whole breakdown
// each step would be the only expensive thing in this file.
let memoState = null;
let memoValue = null;

function productionCached(state) {
  if (state && memoState === state) return memoValue;
  const value = production(state);
  memoState = state;
  memoValue = value;
  return value;
}

// ---------------------------------------------------------------------------
// Discrete encounters
// ---------------------------------------------------------------------------

/** Levels scale with the party so a mature save is not fighting level-3 wildlife forever. */
function wildLevelBand(prod) {
  const top = prod.topLevel;
  return { min: Math.max(2, Math.round(top * 0.6)), max: Math.max(3, Math.round(top * 1.15) + 1) };
}

/**
 * Resolves encounter number `index`. Its stream is derived from the index alone, so the
 * same seed always produces the same encounter in the same slot no matter how the elapsed
 * time was chopped up — that is what makes the whole model chunk-invariant.
 */
export function rollEncounter(index, seed, prod, opts) {
  const rng = makeRng(seed, `idle/encounter/${index}`);
  const tables = opts.tables?.length ? opts.tables : EMPTY;
  const species = tables.length ? tables[Math.floor(rng.next() * tables.length)] : null;
  const band = opts.band;
  const level = band.min + Math.floor(rng.next() * (band.max - band.min + 1));
  const shiny = rng.next() < (prod.flags.charm ? SHINY_RATE_CHARM : SHINY_RATE);

  // A resolved battle, not a turn-by-turn one (ARCHITECTURE §5.6): a level comparison with
  // a seeded roll. It is keyed to the strongest member's LEVEL, not to total party power —
  // power is a sum over six members, so using it made every encounter a foregone win the
  // moment the bench filled up (97 % wins, measured). The wild level band scales with the
  // same number, so the odds stay interesting at every stage instead of trending to 1.
  const advantage = prod.topLevel / Math.max(2, level);
  const winChance = prod.flags.battle ? clamp(0.26 + 0.40 * advantage, 0.12, 0.95) : 0;
  const win = rng.next() < winChance;

  let caught = false;
  if (win && prod.flags.catch) {
    // A ball is thrown only at something already beaten, and a shiny is harder to keep.
    const catchChance = clamp(0.38 + 0.30 * (advantage - 1), 0.08, 0.70) * (shiny ? 0.75 : 1);
    caught = rng.next() < catchChance;
  }

  // Rewards. Losing an encounter still teaches the party something, which keeps a weak
  // party from stalling completely.
  const scale = 1 + level * 0.16;
  const rewards = {
    money: win ? Math.round(8 * scale * prod.chain.money) : 0,
    exp: Math.round((win ? 6 : 1.5) * scale * prod.chain.exp),
    research: win ? +(0.35 * scale * prod.chain.research).toFixed(3) : 0,
  };
  if (shiny) { rewards.money *= 6; rewards.research = +(rewards.research * 4).toFixed(3); }

  // Auto-battling occasionally turns up a spare ball; auto-catching spends one.
  const foundBall = win && prod.flags.battle && rng.next() < 0.08;

  return { index, species, level, shiny, win, caught, foundBall, rewards };
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

const ZERO_PROGRESS = Object.freeze({ encounters: 0, seconds: 0 });

/**
 * What `elapsedS` seconds of idling produced, from `state`, under `seed`.
 *
 * Pure. Additive in `elapsedS` (see the file header). Safe to call with a three-hour
 * `elapsedS` or with one second, and the sum of the parts equals the whole.
 *
 * @param {IdleState} state
 * @param {number} elapsedS
 * @param {number} seed
 * @returns {Object} gains
 */
export function simulate(state, elapsedS, seed = 0) {
  const dt = Number.isFinite(elapsedS) && elapsedS > 0 ? elapsedS : 0;
  const prod = productionCached(state);
  const p = state?.progress ?? ZERO_PROGRESS;
  const p0 = Number.isFinite(p.encounters) ? p.encounters : 0;
  const seconds0 = Number.isFinite(p.seconds) ? p.seconds : 0;

  const passive = {
    money: prod.perSecond.money * dt,
    exp: prod.perSecond.exp * dt,
    research: prod.perSecond.research * dt,
  };

  const encounterProgress = prod.perSecond.encounters * dt;
  const p1 = p0 + encounterProgress;

  // Whole encounters are the integers in (p0, p1]. Chunking the interval cannot add or
  // drop one, and cannot renumber one, so a drained gap equals a single offline call.
  const first = Math.floor(p0) + 1;
  const last = Math.floor(p1);

  const battle = { money: 0, exp: 0, research: 0 };
  const events = [];
  let wholeEncounters = 0;
  let wins = 0, catches = 0, shinies = 0, ballsFound = 0, ballsSpent = 0;
  let truncated = false;

  if (last >= first) {
    const count = last - first + 1;
    const band = wildLevelBand(prod);
    const opts = { tables: state?.tables ?? EMPTY, band };
    const resolveCount = Math.min(count, MAX_RESOLVED);

    for (let i = 0; i < resolveCount; i++) {
      const e = rollEncounter(first + i, seed, prod, opts);
      battle.money += e.rewards.money;
      battle.exp += e.rewards.exp;
      battle.research += e.rewards.research;
      if (e.win) wins++;
      if (e.caught) { catches++; ballsSpent++; }
      if (e.shiny) shinies++;
      if (e.foundBall) ballsFound++;
      // Keep the head of the list for the UI; the totals above already have all of it.
      // (The list is the one part of the result that chunking changes, which is why the
      // digest below is computed from the totals and never from the list.)
      if (events.length < 64 || e.shiny) events.push(e);
    }
    wholeEncounters = count;

    if (count > resolveCount) {
      truncated = true;
      const k = (count - resolveCount) / resolveCount;
      battle.money += battle.money * k;
      battle.exp += battle.exp * k;
      battle.research += battle.research * k;
      wins = Math.round(wins * (1 + k));
      catches = Math.round(catches * (1 + k));
      shinies = Math.round(shinies * (1 + k));
    }
  }

  // Found balls are a gain and are reported as one. Balls *spent* are reported separately
  // rather than as a negative item, because the bag belongs to `economy`: it clamps the
  // spend to what is actually there, and an empty bag closes the auto-catch gate on the
  // next gap. Netting them here would let this module quietly overdraw someone else's bag.
  const items = {};
  if (ballsFound > 0) items[BALL_ITEM] = ballsFound;

  return {
    elapsedS: dt,
    seed,
    perSecond: prod.perSecond,
    // Totals the caller banks. `money` is the headline number and stays a plain float so
    // the seed-era callers (offline) keep working unchanged.
    money: passive.money + battle.money,
    exp: passive.exp + battle.exp,
    research: passive.research + battle.research,
    tokens: passive.research + battle.research,   // economy's wallet calls research "tokens"
    passive,
    battle,
    encounters: encounterProgress,
    wholeEncounters,
    events,
    wins, catches, shinies, items, ballsUsed: ballsSpent, truncated,
    power: prod.power,
    biome: prod.biome,
    flags: prod.flags,
    progress: { encounters: p1, seconds: seconds0 + dt },
  };
}

/** Convenience: the per-second vector alone, for HUDs and the `rate()` API. */
export function rateOf(state) {
  return production(state).perSecond;
}

/**
 * A stable digest of a gains object, used by the self-test and the showcase to compare
 * two runs bit-for-bit without printing a wall of numbers.
 */
export function digest(gains) {
  const parts = [
    gains.money.toFixed(9), gains.exp.toFixed(9), gains.research.toFixed(9),
    gains.encounters.toFixed(9), String(gains.wholeEncounters),
    String(gains.wins), String(gains.catches), String(gains.shinies),
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

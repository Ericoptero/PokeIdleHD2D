/**
 * Permanent upgrades — the part of the economy that turns money back into income.
 *
 * ### The shape of a cost curve, and why these numbers
 *
 * Every track is `cost(n) = round(base · growth^n)` for the *next* level `n`, and every
 * effect is **additive** on a base of 1: level `n` of Payday is `1 + 0.06n`, not `1.06^n`.
 * Additive gain against geometric cost is the whole tuning trick. It gives:
 *
 *   • an early game where a level is minutes and the effect is obvious (+6% on a small
 *     number is still a visible jump on the HUD),
 *   • a mid game where each level costs roughly a constant *fraction* of your income,
 *     because income has been rising with it,
 *   • a late game that decays gracefully instead of exploding: level 55 of Payday costs
 *     ~11× level 40 but only adds the same +6%, so the track ends by itself and the player
 *     moves to the next sink rather than hitting a wall.
 *
 * `growth` is picked per track from how much the effect is worth. Payday multiplies *all*
 * money, so it has the gentlest growth (1.23) across the most levels (50); Apricorn Press
 * only discounts balls, a small slice of spend, so it is short (20 levels) and steep (1.33)
 * and is meant to be finished and forgotten.
 *
 * The absolute numbers are large because `idle`'s faucet is: a level-5 party already earns
 * about ₽50,000 an hour and a level-100 one about ₽1.4M (see `pacing.js`). Prices that
 * looked like mainline prices — ₽1,500 for the first upgrade — were bought out inside the
 * first two minutes. These were fitted against that faucet, not guessed.
 *
 * Measured pacing for the whole set is in `pacing.js` — the numbers there are printed by a
 * simulation of this exact table, not estimated.
 */

/**
 * @typedef {Object} UpgradeDef
 * @property {string} id
 * @property {string} name
 * @property {'money'|'bp'|'shards'} currency
 * @property {number} base       cost of level 1
 * @property {number} growth     cost multiplier per level
 * @property {number} max        levels available
 * @property {string} effectKey  key in `multipliers()`
 * @property {number} perLevel   added per level (a fraction for multipliers, a count for flats)
 * @property {'mult'|'flat'} mode
 * @property {Object} [unlock]   requirement snapshot keys, all must be met
 * @property {string} desc
 */

/** @type {UpgradeDef[]} */
export const UPGRADES = [
  {
    id: 'payday', name: 'Payday Fund', currency: 'money',
    base: 12000, growth: 1.23, max: 50, effectKey: 'moneyGain', perLevel: 0.06, mode: 'mult',
    desc: '+6% money from every source per level, to +300%. The first purchase and the last one you finish.',
  },
  {
    id: 'exp_share', name: 'Exp. Share Network', currency: 'money',
    base: 15000, growth: 1.25, max: 40, effectKey: 'expGain', perLevel: 0.07, mode: 'mult',
    desc: '+7% EXP per level. Levels are power, power is idle income — this pays back indirectly but forever.',
  },
  {
    id: 'expedition', name: 'Expedition Permits', currency: 'research',
    base: 150, growth: 1.23, max: 40, effectKey: 'encounterRate', perLevel: 0.05, mode: 'mult',
    unlock: { dexCaught: 5 },
    desc: '+5% encounter rate per level, bought with Research. More encounters is more of everything downstream.',
  },
  {
    id: 'capsule_lab', name: 'Capsule Lab', currency: 'research',
    base: 260, growth: 1.25, max: 25, effectKey: 'catchRate', perLevel: 0.03, mode: 'mult',
    unlock: { dexCaught: 10 },
    desc: '+3% catch rate per level, stacking with the ball. Caps at +75% — about one ball tier, for Research.',
  },
  {
    id: 'market_licence', name: 'Market Licence', currency: 'money',
    base: 30000, growth: 1.29, max: 25, effectKey: 'sellValue', perLevel: 0.04, mode: 'mult',
    unlock: { totalEarned: 50000 },
    desc: '+4% on everything you sell per level. Loot-heavy play makes this the strongest money track.',
  },
  {
    id: 'apricorn_press', name: 'Apricorn Press', currency: 'money',
    base: 50000, growth: 1.33, max: 20, effectKey: 'ballDiscount', perLevel: 0.015, mode: 'mult',
    unlock: { itemsBought: 50 },
    desc: '−1.5% on ball prices per level, to −30%. Short and steep: finish it and forget it.',
  },
  {
    id: 'bag_upgrade', name: 'Bag Expansion', currency: 'money',
    base: 25000, growth: 1.70, max: 9, effectKey: 'bagSlots', perLevel: 100, mode: 'flat',
    desc: '+100 to every stack cap per level, from 99 up to 999.',
  },
  {
    id: 'veteran_coach', name: 'Veteran Coach', currency: 'bp',
    base: 35, growth: 1.27, max: 20, effectKey: 'bpGain', perLevel: 0.05, mode: 'mult',
    unlock: { battlesWon: 25 },
    desc: '+5% BP per level. BP only comes from battles, so this is the only way to speed the BP shelf up.',
  },
  {
    id: 'daycare', name: 'Day Care Contract', currency: 'bp',
    base: 60, growth: 1.33, max: 12, effectKey: 'offlineHours', perLevel: 1, mode: 'flat',
    unlock: { battlesWon: 50 },
    desc: '+1 hour of offline accrual per level, on top of the 12-hour cap. Twelve levels doubles a day away.',
  },
  {
    id: 'dowsing_rig', name: 'Dowsing Rig', currency: 'shards',
    base: 50, growth: 1.25, max: 20, effectKey: 'shardFind', perLevel: 0.05, mode: 'mult',
    unlock: { shardsEarned: 50 },
    desc: '+5% shards per level. Pays for itself in shards, which is the point: the shard economy is closed.',
  },
  {
    id: 'shiny_lens', name: 'Shiny Lens', currency: 'shards',
    base: 110, growth: 1.40, max: 10, effectKey: 'shinyOdds', perLevel: 0.10, mode: 'mult',
    unlock: { dexCaught: 25 },
    desc: '+10% shiny odds per level. With the Shiny Charm that is 1/4096 → about 1/1500.',
  },
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, Object.freeze(u)]));
Object.freeze(UPGRADES);

export function upgrade(id) {
  return BY_ID.get(String(id)) ?? null;
}

/** Cost of the level after `level` (0-based: `costOf(u, 0)` is the first purchase). */
export function costOf(def, level) {
  if (!def || level >= def.max) return Infinity;
  return Math.max(1, Math.round(def.base * Math.pow(def.growth, level)));
}

/** Closed-form cost of buying `count` levels starting from `level`. */
export function bulkCost(def, level, count) {
  if (!def) return Infinity;
  const n = Math.min(count, def.max - level);
  if (n <= 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += costOf(def, level + i);
  return sum;
}

/** The full price of a maxed track, for the pacing tables. */
export function trackTotal(def) {
  return bulkCost(def, 0, def.max);
}

/** Every effect key an upgrade can move, with its identity value. */
export const EFFECT_BASE = Object.freeze({
  moneyGain: 1, expGain: 1, encounterRate: 1, catchRate: 1, shinyOdds: 1,
  sellValue: 1, ballDiscount: 1, bpGain: 1, shardFind: 1,
  offlineHours: 0, bagSlots: 0,
});

/**
 * Folds a `{ id: level }` map into a multiplier snapshot. Pure, so `pacing.js` and the
 * showcase can project a hypothetical build without touching live state. `defs` exists so
 * the pacing fitter can score a *candidate* price table without mutating this one.
 */
export function foldUpgrades(levels = {}, { defs = UPGRADES, into = null } = {}) {
  const out = into ?? { ...EFFECT_BASE };
  for (const def of defs) {
    const lvl = Math.max(0, Math.min(def.max, Math.floor(levels[def.id] ?? 0)));
    if (!lvl) continue;
    if (def.mode === 'flat') out[def.effectKey] += def.perLevel * lvl;
    else if (def.effectKey === 'ballDiscount') out.ballDiscount -= def.perLevel * lvl;
    else out[def.effectKey] += def.perLevel * lvl;
  }
  out.ballDiscount = Math.max(0.5, out.ballDiscount);
  return out;
}

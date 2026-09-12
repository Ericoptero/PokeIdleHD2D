// @ts-check
/**
 * Stats, levels and experience — the arithmetic that turns a species plus six IVs plus a level
 * into a body that can take a hit.
 *
 * Mainline formulae, with two deliberate simplifications: **no EVs
 * and no natures.** Neither is reachable in this game — nothing trains, nothing breeds — and a
 * nature that silently multiplied a stat the player could not see or change would be a number
 * with no story attached to it.
 *
 * Pure: no ctx, no clock, no DOM, no three, no RNG. It runs in Node.
 */

/** The five non-HP stats, in the order every table in this project already uses. */
export const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'];

/**
 * The mainline stat formulae (Gen 3+), with EV terms dropped.
 *
 *   HP    = floor((2·base + iv) · level / 100) + level + 10
 *   other = floor((2·base + iv) · level / 100) + 5
 *
 * Shedinja's 1 HP is a species-level special case in the real games and is not one here: it
 * would need an ability, and there are none.
 *
 * @param {{hp:number,atk:number,def:number,spa:number,spd:number,spe:number}} base
 * @param {object} ivs   0..31 per key; missing keys read as 0
 * @param {number} level 1..100
 */
export function statsOf(base, ivs = {}, level = 5) {
  const L = Math.max(1, Math.min(100, Math.floor(level)));
  const iv = (k) => Math.max(0, Math.min(31, Math.floor(ivs?.[k] ?? 0)));
  const out = { hp: Math.floor(((2 * (base?.hp ?? 50) + iv('hp')) * L) / 100) + L + 10 };
  for (const k of STAT_KEYS) out[k] = Math.floor(((2 * (base?.[k] ?? 50) + iv(k)) * L) / 100) + 5;
  return out;
}

/**
 * Stat-stage multipliers, -6..+6.
 *
 * Two different tables in the real games: attack/defence/speed use (2+n)/2 going up and
 * 2/(2−n) going down; accuracy and evasion use thirds. Only the first is modelled, because
 * accuracy stages need moves this engine falls back to plain damage for anyway.
 */
export function stageMultiplier(stage) {
  const n = Math.max(-6, Math.min(6, Math.floor(stage ?? 0)));
  return n >= 0 ? (2 + n) / 2 : 2 / (2 - n);
}

/**
 * Cumulative experience at `level`, per growth rate.
 *
 * `species.json` carries PokeAPI's `growth_rate_id` spelled out; the two odd
 * ones are the mainline *erratic* and *fluctuating* curves, whose piecewise definitions are
 * transcribed here rather than approximated — a curve that is nearly right is a level-up that
 * happens at the wrong time forever.
 *
 * @param {string} growthRate
 * @param {number} level
 */
export function expAtLevel(growthRate, level) {
  const n = Math.max(1, Math.min(100, Math.floor(level)));
  if (n === 1) return 0;
  switch (growthRate) {
    case 'fast': return Math.floor((4 * n ** 3) / 5);
    case 'slow': return Math.floor((5 * n ** 3) / 4);
    case 'medium-slow':
      return Math.max(0, Math.floor((6 * n ** 3) / 5 - 15 * n ** 2 + 100 * n - 140));
    case 'erratic':
      if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
      if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
      if (n <= 98) return Math.floor((n ** 3 * (1911 - 10 * n)) / 1500);
      return Math.floor((n ** 3 * (160 - n)) / 100);
    case 'fluctuating':
      if (n <= 15) return Math.floor((n ** 3 * ((Math.floor((n + 1) / 3) + 24) / 50)));
      if (n <= 36) return Math.floor((n ** 3 * ((n + 14) / 50)));
      return Math.floor((n ** 3 * ((Math.floor(n / 2) + 32) / 50)));
    case 'medium':
    default: return n ** 3;
  }
}

/** Experience still owed to reach `level + 1`. */
export const expToNextLevel = (growthRate, level) =>
  Math.max(0, expAtLevel(growthRate, level + 1) - expAtLevel(growthRate, level));

/**
 * The level a total experience score buys. Monotone and clamped at 100; a binary search would
 * be faster and this is called once per level-up, not once per frame.
 */
export function levelForExp(growthRate, exp) {
  const e = Math.max(0, exp ?? 0);
  let level = 1;
  while (level < 100 && expAtLevel(growthRate, level + 1) <= e) level++;
  return level;
}

/**
 * Experience a win is worth (Gen 5 formula, wild, no traded/lucky-egg terms).
 *
 *   exp = baseExp · defeatedLevel / 7
 *
 * The Gen 5 shape rather than Gen 1's `/7 · a` because it scales with the *loser's* level
 * only, which is what an idle game wants: grinding a level-3 Caterpie with a level-40 lead
 * should not pay, and here it does not.
 */
export const expYield = (baseExp, defeatedLevel) =>
  Math.max(1, Math.floor(((baseExp ?? 60) * Math.max(1, defeatedLevel)) / 7));

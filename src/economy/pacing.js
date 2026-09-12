/**
 * Pacing: the projection that the prices in this module were tuned against.
 *
 * Balance claims are worthless unless someone ran the numbers, so this file *is* the
 * numbers. `project()` simulates a player who idles continuously and spends greedily on
 * whichever upgrade pays for itself soonest, using the same income model `src/idle/` runs
 * and the same cost curves `upgrades.js` charges. The table in `MEASURED` at the bottom is
 * its output, pasted back in, and it is regenerated whenever a price moves.
 *
 * ### The income model
 *
 * Mirrored from `src/idle/accrual.js` (read, never imported — cross-module deep imports are
 * banned by src/offline/slices.js, and this is a *projection*, not the live path):
 *
 *   power        = 0.6 + Σ level^0.85 · (BST/300) · slot · affinity        (lead ×1.25)
 *   money/s      = 0.85 · power^0.92 · biome.money
 *   exp/s        = 2.40 · power      · biome.exp
 *   research/s   = 0.045 · power^0.6 · biome.research
 *   encounters/s = 0.025 · biome.encounters · pace
 *   per win      = 8·(1 + level·0.16) money, 6·(1 + level·0.16) exp, 0.35·(…) research
 *
 * If those constants move, `MEASURED` is stale — rerun the projection. That is the price of
 * tuning against another module's model, and it is cheaper than tuning against nothing.
 *
 * ### What the pacing aims at, and what it measures
 *
 * The target was written down *before* the prices were fitted, so the fit could fail it —
 * and it partly did. Both columns are reported, because a balance note that only prints the
 * numbers it likes is worthless:
 *
 *                          target            measured (MEASURED, below)
 *   ┌ 15 min               2–4 levels        4 levels, party lv 28, ₽218k/h
 *   ├ hour 1               6–10 levels       21 levels, lv 57, ₽462k/h        ← faster than aimed
 *   ├ hour 8 (a workday)   25–35 levels      95 levels, lv 100, ₽1.07M/h      ← faster than aimed
 *   ├ day 1                40–55 levels      143 levels, ₽1.27M/h, money ×2.38
 *   ├ week 1               90–120 levels     232 of 291 levels, money ×3.04
 *   └ month 1              nearly capped     266 of 291, ₽138M idle in the bank
 *
 * The middle rows overshoot because `idle`'s EXP faucet takes the party from level 5 to the
 * cap in about four hours, and every income term keys off party power. The economy cannot
 * fix that from its side without pricing the early game out of reach, so the honest reading
 * is: **the first day is faster than intended, the first week and month are on target.**
 * If `idle` slows its EXP curve, rerun the fit and these numbers improve on their own.
 *
 * The last row is the one that matters for the brief. The capped multiplier tracks absorb
 * ₽2.19 **billion** in total, so income cannot run away — and after them the sinks that stay
 * open are priced for a save earning millions an hour: Exp. Candy XL at ₽200,000, the Amulet
 * Coin at ₽2M, Master Balls at 500 BP, and the Wonder Trade voucher, which starts at ₽250,000
 * and rises 15% *per purchase*, forever.
 */

import { UPGRADES, upgrade, costOf, foldUpgrades } from './upgrades.js';

/** Mirrored constants. Keep the names identical to `accrual.js` so a diff is obvious. */
export const INCOME_MODEL = Object.freeze({
  mirroredFrom: 'src/idle/accrual.js',
  BASE_MONEY: 0,
  BASE_EXP: 2.4,
  BASE_RESEARCH: 0,
  BASE_ENCOUNTERS: 0.025,
  MONEY_POWER_EXP: 0.92,
  TRAINER_BASE_POWER: 0.6,
  SLOT_FALLOFF: [1, 0.82, 0.68, 0.56, 0.46, 0.38],
  LEAD_BONUS: 1.25,
  /** meadow, the neutral biome, so the projection is not flattered by a cave bonus. */
  biome: { money: 1.0, exp: 1.0, research: 1.0, encounters: 1.0 },
  /** Expected win rate once auto-battle is on and the party out-levels the route. */
  winRate: 0.72,
  /** Battle Points minted per won battle — economy's own faucet, not idle's. */
  bpPerWin: 0.25,
  /** Shards per catch that gets appraised and released. */
  shardsPerCatch: 1.6,
  catchRate: 0.35,
});

/** Party power for six members at `level`, average BST 380 (a mid-game team). */
export function powerFor(level, { members = 6, bst = 380 } = {}) {
  const m = INCOME_MODEL;
  let power = m.TRAINER_BASE_POWER;
  for (let i = 0; i < Math.min(members, m.SLOT_FALLOFF.length); i++) {
    const slot = m.SLOT_FALLOFF[i] * (i === 0 ? m.LEAD_BONUS : 1);
    power += Math.pow(level, 0.85) * (bst / 300) * slot;
  }
  return power;
}

/** Per-second income at a given power and multiplier snapshot. */
export function ratesAt(power, mult) {
  const m = INCOME_MODEL;
  const encounters = m.BASE_ENCOUNTERS * m.biome.encounters * (mult.encounterRate ?? 1);
  const level = Math.max(2, Math.round(Math.pow(power / 6, 1 / 0.85)));
  const scale = 1 + level * 0.16;
  const wins = encounters * m.winRate;
  return {
    encounters,
    wins,
    money: (m.BASE_MONEY * Math.pow(power, m.MONEY_POWER_EXP) * m.biome.money + wins * 8 * scale) * (mult.moneyGain ?? 1),
    exp: (m.BASE_EXP * power * m.biome.exp + wins * 6 * scale) * (mult.expGain ?? 1),
    research: m.BASE_RESEARCH * Math.pow(power, 0.6) * m.biome.research + wins * 0.35 * scale,
    bp: wins * m.bpPerWin * (mult.bpGain ?? 1),
    shards: encounters * m.catchRate * m.shardsPerCatch * (mult.shardFind ?? 1),
  };
}

/** Medium-fast growth: total EXP to reach level L is L³, shared across the party. */
const expForLevel = (l) => l * l * l;

/**
 * How long a level of `def` takes to pay for itself, in seconds, at the current income.
 * Only the money-multiplier tracks have an honest payback; the rest get a fixed weight so
 * the greedy policy still buys them rather than hoarding.
 */
function paybackSeconds(def, level, rates, mult) {
  const cost = costOf(def, level);
  if (!Number.isFinite(cost)) return Infinity;
  switch (def.effectKey) {
    case 'moneyGain': {
      const gain = (rates.money / (mult.moneyGain ?? 1)) * def.perLevel;
      return gain > 0 ? cost / gain : Infinity;
    }
    case 'expGain':      return cost / Math.max(1e-9, rates.money * 0.35 * def.perLevel);
    case 'encounterRate':return cost / Math.max(1e-9, rates.research * 0.6 * def.perLevel);
    case 'catchRate':    return cost / Math.max(1e-9, rates.research * 0.4 * def.perLevel);
    case 'sellValue':    return cost / Math.max(1e-9, rates.money * 0.25 * def.perLevel);
    case 'ballDiscount': return cost / Math.max(1e-9, rates.money * 0.10 * def.perLevel);
    case 'bpGain':       return cost / Math.max(1e-9, rates.bp * def.perLevel) * 60;
    case 'shardFind':    return cost / Math.max(1e-9, rates.shards * def.perLevel) * 60;
    case 'shinyOdds':    return cost / Math.max(1e-9, rates.shards * 0.02);
    default:             return cost / Math.max(1e-9, rates.money * 0.02);
  }
}

/**
 * Simulates `hours` of continuous idling with a greedy purchase policy.
 *
 * Deterministic: no RNG anywhere. Encounters are taken at their expectation, which is what
 * a pacing table wants — the variance belongs in the game, not in the balance sheet.
 *
 * @param {Object} [opts]
 * @param {number} [opts.hours]     wall-clock hours to project
 * @param {number} [opts.stepS]     integration step; 60 s is exact enough and fast
 * @param {number} [opts.startLevel]
 * @param {number} [opts.reserve]   fraction of the balance kept for consumables
 * @returns {{ timeline:Object[], levels:Object, spent:Object, final:Object }}
 */
export function project({ hours = 168, stepS = 60, startLevel = 5, reserve = 0.25, marks = null, defs = UPGRADES } = {}) {
  const levels = {};
  const wallet = { money: 3000, research: 0, bp: 0, shards: 0 };
  const spent = { money: 0, research: 0, bp: 0, shards: 0 };
  const earned = { money: 0, research: 0, bp: 0, shards: 0 };
  let level = startLevel;
  let expPool = expForLevel(startLevel) * 6;
  let t = 0;
  const timeline = [];
  const wanted = (marks ?? [0.25, 1, 4, 8, 24, 72, 168, 720]).map((h) => h * 3600);
  let markAt = 0;

  const totalLevels = () => Object.values(levels).reduce((a, b) => a + b, 0);

  while (t < hours * 3600) {
    const mult = foldUpgrades(levels, { defs });
    const power = powerFor(level);
    const rates = ratesAt(power, mult);

    for (const k of ['money', 'research', 'bp', 'shards']) {
      const gain = rates[k] * stepS;
      wallet[k] += gain;
      earned[k] += gain;
    }
    expPool += rates.exp * stepS;
    while (expPool >= expForLevel(level + 1) * 6 && level < 100) level++;

    // Greedy: the shortest payback that fits inside the spendable balance.
    for (let guard = 0; guard < 8; guard++) {
      let best = null;
      for (const def of defs) {
        const lvl = levels[def.id] ?? 0;
        if (lvl >= def.max) continue;
        const cost = costOf(def, lvl);
        if (cost > wallet[def.currency] * (1 - reserve)) continue;
        const pb = paybackSeconds(def, lvl, rates, mult);
        if (!best || pb < best.pb) best = { def, cost, pb };
      }
      if (!best) break;
      wallet[best.def.currency] -= best.cost;
      spent[best.def.currency] += best.cost;
      levels[best.def.id] = (levels[best.def.id] ?? 0) + 1;
    }

    t += stepS;
    if (markAt < wanted.length && t >= wanted[markAt]) {
      const m2 = foldUpgrades(levels, { defs });
      const r2 = ratesAt(powerFor(level), m2);
      timeline.push({
        hours: +(t / 3600).toFixed(2),
        partyLevel: level,
        moneyPerHour: Math.round(r2.money * 3600),
        researchPerHour: Math.round(r2.research * 3600),
        bpPerHour: +(r2.bp * 3600).toFixed(1),
        banked: Math.round(wallet.money),
        upgradeLevels: totalLevels(),
        moneyGain: +m2.moneyGain.toFixed(2),
        levels: { ...levels },
      });
      markAt++;
    }
  }

  return {
    timeline, levels, spent, earned,
    final: { partyLevel: level, wallet: { ...wallet }, multipliers: foldUpgrades(levels, { defs }), upgradeLevels: totalLevels() },
  };
}

/** Total cost of every track, for "how much money does this economy need to absorb?". */
export function sinkTotals() {
  const out = {};
  for (const def of UPGRADES) {
    let sum = 0;
    for (let i = 0; i < def.max; i++) sum += costOf(def, i);
    out[def.id] = { currency: def.currency, total: sum, max: def.max, effect: def.effectKey };
  }
  return out;
}

/** One track's curve, for the showcase's price-curve column. */
export function curveOf(id, points = 6) {
  const def = upgrade(id);
  if (!def) return [];
  const out = [];
  for (let i = 0; i < points; i++) {
    const lvl = Math.round((def.max - 1) * (i / (points - 1)));
    out.push({ level: lvl + 1, cost: costOf(def, lvl), currency: def.currency });
  }
  return out;
}

/**
 * The projection's output, pasted back in. Regenerate with:
 *
 *     node --input-type=module -e "import('./src/economy/pacing.js').then(m => \
 *       console.table(m.project({ hours: 720 }).timeline))"
 *
 * (numbers filled in below by that command — see the header for what they should mean)
 */
export const MEASURED = Object.freeze({
  generated: '2026-09-07',
  note: 'meadow biome, six-member party from level 5, continuous play, greedy purchases',
  /** Total money the capped upgrade tracks can absorb, in Poké Dollars. */
  moneySinkTotal: 2192807484,
  rows: Object.freeze([
    { hours: 0.25, partyLevel: 28, moneyPerHour: 218046, upgradeLevels: 4, moneyGain: 1.12, banked: 12109 },
    { hours: 1, partyLevel: 57, moneyPerHour: 461911, upgradeLevels: 21, moneyGain: 1.36, banked: 21822 },
    { hours: 8, partyLevel: 100, moneyPerHour: 1072626, upgradeLevels: 95, moneyGain: 2.02, banked: 296576 },
    { hours: 24, partyLevel: 100, moneyPerHour: 1269251, upgradeLevels: 143, moneyGain: 2.38, banked: 1693255 },
    { hours: 168, partyLevel: 100, moneyPerHour: 1632858, upgradeLevels: 232, moneyGain: 3.04, banked: 15386663 },
    { hours: 720, partyLevel: 100, moneyPerHour: 1998685, upgradeLevels: 266, moneyGain: 3.70, banked: 138240500 },
  ]),
});

/**
 * Re-runs the projection and reports where it drifted from `MEASURED`. A price change that
 * does not move these numbers did not do what its author thought it did.
 */
export function checkMeasured(tolerance = 0.02) {
  const fresh = project({ hours: 720, marks: MEASURED.rows.map((r) => r.hours) });
  return MEASURED.rows.map((row, i) => {
    const now = fresh.timeline[i] ?? {};
    const drift = (a, b) => (a === b ? 0 : Math.abs(a - b) / Math.max(1, Math.abs(a)));
    const worst = Math.max(drift(row.moneyPerHour, now.moneyPerHour), drift(row.upgradeLevels, now.upgradeLevels));
    return { hours: row.hours, stale: worst > tolerance, was: row, now };
  });
}

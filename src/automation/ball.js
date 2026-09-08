/**
 * Auto-ball selection — the optimiser.
 *
 * `economy.recommendBall()` answers a different question: *which ball has the biggest
 * multiplier*, ties to the cheapest. That is the right answer for a shop display and the
 * wrong one for an automation, because it will burn a 15 BP Quick Ball on a Rattata that a
 * ₽200 Poké Ball catches four times out of five.
 *
 * This file asks the question an idle player actually has: **what is the cheapest way to
 * end up holding this Pokémon?** For every ball in the bag it computes
 *
 * ```
 *   odds     = economy.catchOdds({ ball, catchRate, hpFraction, status, context })
 *   cost₽    = price, with BP converted at `bpWeight` (BP is the scarce currency)
 *   expected = cost₽ / odds            ← money-equivalent cost per Pokémon actually kept
 * ```
 *
 * and then picks according to the target's **tier**, which the rule engine assigns:
 *
 * | tier     | objective                                                    | typical target |
 * | -------- | ------------------------------------------------------------ | -------------- |
 * | `secure` | highest odds that clears `oddsFloor`, cheapest among equals   | shiny, new dex |
 * | `value`  | lowest `expected` among balls clearing `minOdds`              | anything else  |
 * | `cheap`  | lowest cash cost with non-trivial odds                        | fodder to sell |
 * | `skip`   | nothing is thrown                                             | not worth it   |
 *
 * ### Why the answer differs from the multiplier table
 *
 * `expected` is not monotone in the multiplier, because the capture curve saturates: once a
 * ball is already at 97 % a better ball buys 3 % for several times the price, and the
 * ranking inverts. A Nest Ball on a level-4 target beats an Ultra Ball on cost per catch,
 * and on a level-40 target it is exactly a Poké Ball at five times the price. That is the
 * whole reason this is an optimisation and not a preference list.
 *
 * ### Safety
 *
 * Reserves are absolute: a ball is only considered while `count > reserve`, so "keep one
 * Master Ball forever" is expressible and enforced here rather than trusted to a rule. The
 * Master Ball has a second gate on top — it is only ever considered for a `secure` target
 * that nothing else can reach — because "it never fails" makes it win every optimisation
 * it is allowed into.
 *
 * Pure: no ctx, no bus, no RNG. Everything it needs about balls arrives through the
 * `evaluator` object, so `selftest.js` runs it in Node against a stub.
 */

/** Balls whose price is in BP, converted at `settings.bpWeight` money per point. */
const MONEY = 'money';

/**
 * What the optimiser needs to know about the ball line. `index.js` builds this from
 * `economy`; `selftest.js` builds it from a table.
 *
 * @typedef {Object} BallEvaluator
 * @property {() => {id:string, name:string, price:number, currency:string, count:number, when:string}[]} balls
 * @property {(id:string, context:Object) => number} multiplier
 * @property {(opts:Object) => number} odds
 */

export const DEFAULT_SETTINGS = Object.freeze({
  /** A `secure` target wants at least this chance from one throw. */
  oddsFloor: 0.9,
  /** Below this, a throw is a waste of a ball whatever the tier. */
  minOdds: 0.12,
  /** Money-equivalent of one Battle Point. BP only comes from wins, so it is dear. */
  bpWeight: 2500,
  /** Hard cap on what one `secure` throw may cost, in money-equivalent. */
  maxSpend: 25000,
  /** Never spend the last N of these. */
  reserve: { masterball: 1 },
  /** The Master Ball is only considered when nothing else reaches this. */
  masterFloor: 0.25,
  /** Assumed health of an auto-resolved target: it lost the battle first. */
  hpFraction: 0.35,
});

/** Money-equivalent price of one ball, or null when it cannot be bought at all. */
export function priceOf(def, settings) {
  const currency = def.currency ?? MONEY;
  const price = Number(def.price);
  if (!Number.isFinite(price) || price <= 0) {
    // A Premier Ball has no price: it arrives free with Poké Balls. Value it at what the
    // ball it substitutes for costs, so the optimiser prefers spending it — which is
    // exactly what a player does with a drawer full of them.
    return { money: 0, currency, free: true };
  }
  if (currency === 'bp') return { money: price * settings.bpWeight, currency, free: false };
  if (currency === MONEY) return { money: price, currency, free: false };
  // research / shards are not ball currencies today; price them out of reach rather than
  // guessing an exchange rate that would silently become a balance decision.
  return { money: Infinity, currency, free: false };
}

/**
 * Scores every ball in the bag against one target.
 *
 * @param {BallEvaluator} evaluator
 * @param {Object} target   `{ catchRate, hpFraction, status, context }`
 * @param {Object} settings
 * @returns {Object[]} one row per ball, richest information first (unsorted)
 */
export function rankBalls(evaluator, target, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings, reserve: { ...DEFAULT_SETTINGS.reserve, ...(settings.reserve ?? {}) } };
  const context = target.context ?? {};
  const rows = [];
  for (const def of evaluator.balls()) {
    const reserve = s.reserve[def.id] ?? 0;
    const spendable = Math.max(0, (def.count ?? 0) - reserve);
    const multiplier = evaluator.multiplier(def.id, context);
    const odds = evaluator.odds({
      ball: def.id,
      catchRate: target.catchRate ?? 45,
      hpFraction: target.hpFraction ?? s.hpFraction,
      status: target.status ?? 'none',
      context,
    });
    const price = priceOf(def, s);
    const expected = odds > 0 ? price.money / odds : Infinity;
    rows.push({
      id: def.id,
      name: def.name ?? def.id,
      when: def.when ?? null,
      count: def.count ?? 0,
      reserve,
      spendable,
      multiplier,
      odds,
      cost: price.money,
      currency: price.currency,
      free: price.free,
      /** Money-equivalent cost per Pokémon actually caught. The number that decides. */
      expected,
      usable: spendable > 0,
    });
  }
  return rows;
}

/**
 * Picks a ball for one target.
 *
 * @returns {{ball:string|null, odds:number, expected:number, cost:number, tier:string,
 *            why:string, table:Object[], considered:number}}
 */
export function chooseBall(evaluator, target, tier = 'value', settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings, reserve: { ...DEFAULT_SETTINGS.reserve, ...(settings.reserve ?? {}) } };
  const table = rankBalls(evaluator, target, s);
  const none = (why) => ({ ball: null, odds: 0, expected: Infinity, cost: 0, tier, why, table, considered: 0 });

  if (tier === 'skip') return none('rule said skip');

  // The Master Ball is held back from every ordinary comparison; it re-enters below only
  // for a `secure` target nothing else can reach.
  const pool = table.filter((r) => r.usable && r.id !== 'masterball');
  if (!pool.length && !table.some((r) => r.usable)) return none('no ball in the bag');

  if (tier === 'secure') {
    const clearing = pool.filter((r) => r.odds >= s.oddsFloor && r.cost <= s.maxSpend);
    if (clearing.length) {
      // Everything here is good enough; take the cheapest, then the best odds as a
      // tiebreak so a free Premier Ball does not beat a Great Ball at equal price.
      clearing.sort((a, b) => a.cost - b.cost || b.odds - a.odds || a.id.localeCompare(b.id));
      const pick = clearing[0];
      return decide(pick, tier, `${pct(pick.odds)} ≥ floor ${pct(s.oddsFloor)}, cheapest that clears it`, table, clearing.length);
    }
    const best = bestBy(pool, (a, b) => b.odds - a.odds || a.cost - b.cost || a.id.localeCompare(b.id));
    const master = table.find((r) => r.id === 'masterball' && r.usable);
    if (master && (!best || best.odds < s.masterFloor)) {
      return decide(master, tier, `nothing else reaches ${pct(s.masterFloor)} — the Master Ball is spent`, table, pool.length + 1);
    }
    if (!best) return none('no ball in the bag');
    if (best.odds < s.minOdds) return none(`best odds ${pct(best.odds)} below the ${pct(s.minOdds)} floor`);
    return decide(best, tier, `nothing clears ${pct(s.oddsFloor)}; best available is ${pct(best.odds)}`, table, pool.length);
  }

  if (tier === 'cheap') {
    const viable = pool.filter((r) => r.odds >= s.minOdds);
    if (!viable.length) return none(`nothing reaches the ${pct(s.minOdds)} floor`);
    viable.sort((a, b) => a.cost - b.cost || b.odds - a.odds || a.id.localeCompare(b.id));
    const pick = viable[0];
    return decide(pick, tier, `cheapest ball above ${pct(s.minOdds)}`, table, viable.length);
  }

  // `value`: minimise money-equivalent cost per catch.
  const viable = pool.filter((r) => r.odds >= s.minOdds && Number.isFinite(r.expected));
  if (!viable.length) {
    const fallback = bestBy(pool, (a, b) => b.odds - a.odds);
    if (!fallback || fallback.odds < s.minOdds) return none(`nothing reaches the ${pct(s.minOdds)} floor`);
    return decide(fallback, tier, 'no priced ball is viable; best odds taken', table, pool.length);
  }
  viable.sort((a, b) => a.expected - b.expected || b.odds - a.odds || a.id.localeCompare(b.id));
  const pick = viable[0];
  const runnerUp = viable[1];
  const why = runnerUp
    ? `₽${Math.round(pick.expected).toLocaleString('en-US')}/catch beats ${runnerUp.name} at ₽${Math.round(runnerUp.expected).toLocaleString('en-US')}`
    : `₽${Math.round(pick.expected).toLocaleString('en-US')} per catch`;
  return decide(pick, tier, why, table, viable.length);
}

function decide(row, tier, why, table, considered) {
  return {
    ball: row.id, name: row.name, odds: row.odds, multiplier: row.multiplier,
    expected: row.expected, cost: row.cost, currency: row.currency,
    tier, why, table, considered,
  };
}

function bestBy(list, cmp) {
  if (!list.length) return null;
  return list.slice().sort(cmp)[0];
}

const pct = (n) => `${(n * 100).toFixed(n >= 0.995 ? 0 : 1)}%`;

/**
 * Builds the evaluator from a live `economy`. Kept here so `index.js` stays about wiring
 * and this file stays the only place that knows what a ball costs.
 */
export function evaluatorFrom(economy) {
  const list = typeof economy.items === 'function'
    ? economy.items((i) => i.category === 'ball')
    : [];
  return {
    balls: () => list.map((def) => ({
      id: def.id,
      name: def.name,
      price: def.price ?? 0,
      currency: def.currency ?? MONEY,
      when: def.when ?? null,
      count: typeof economy.count === 'function' ? (economy.count(def.id) ?? 0) : 0,
    })),
    multiplier: (id, context) => (typeof economy.catchMultiplier === 'function'
      ? economy.catchMultiplier(id, context) ?? 0 : 0),
    odds: (opts) => (typeof economy.catchOdds === 'function' ? economy.catchOdds(opts) ?? 0 : 0),
  };
}

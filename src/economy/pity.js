/**
 * The pity ledger: every ball thrown at a species, remembered, until one of them works.
 *
 * The rule (DECISIONS #61): each throw adds **the ball's price** to a running sum kept per
 * species. Below 90 % of that species' price the catch chance is exactly what the Gen 3/4
 * formula says. From 90 % it climbs, reaching certainty at 125 %. A successful catch resets the
 * sum to zero.
 *
 * ## It is a lerp over the finished probability, not a term inside the formula
 *
 * `items.js catchOdds` multiplies `a` by `bonus` *inside* the mainline formula, where `p → 1`
 * only at `a ≥ 255` — so the multiplier that would reach certainty depends on the capture rate,
 * the HP, the ball and the status all at once, and **no fixed value can mean "maximum at 125 %
 * of the price"**. So `catchOdds` stays pure and untouched and this wraps it:
 *
 *     t    = clamp((sum / price − 0.90) / (1.25 − 0.90), 0, 1)
 *     odds = p0 + (1 − p0) · t
 *
 * At 0.90 that is `p0` exactly, which is the requirement; at 1.25 it is 1; and it is monotone
 * in between, so a player never sees their odds go down for throwing another ball.
 *
 * Pure: no ctx, no clock, no RNG. It runs in Node.
 */

/** Where the ramp starts and where it finishes, as fractions of the species' price. */
export const PITY_START = 0.90;
export const PITY_FULL = 1.25;

/**
 * What one Battle Point is worth in Poké Dollars.
 *
 * A **third** copy of the same number: `automation/ball.js` calls it `bpWeight` and uses it to
 * rank balls by cost-per-catch, and `economy/pacing.js` will need it too. It is here because a
 * Quick Ball costs 15 BP and a pity sum that ignored BP-priced balls would let the shop's most
 * expensive shelf count for nothing.
 */
export const BP_MONEY_EQUIVALENT = 2500;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Save slice version. `restore` migrates forward and refuses a newer one (§5). */
export const PITY_VERSION = 1;

/**
 * @param {{price:(species:string) => number, item:(id:string) => object|null}} deps
 */
export function makePity({ price, item }) {
  /** species -> money-equivalent spent on it since the last catch. */
  const sums = new Map();

  const key = (species) => String(species?.name ?? species ?? '').toLowerCase();

  /** What one ball adds. Money is money; BP converts; a free ball adds nothing. */
  function valueOf(ballId) {
    const def = item?.(ballId);
    if (!def) return 0;
    const p = Number(def.price) || 0;
    if (!p) return 0;
    return def.currency === 'bp' ? p * BP_MONEY_EQUIVALENT : p;
  }

  /**
   * How far along a species is, as a fraction of its own price.
   * @returns {{sum:number, price:number, ratio:number, t:number}}
   */
  function meter(species) {
    const k = key(species);
    const sum = sums.get(k) ?? 0;
    const p = Math.max(1, Number(price?.(species)) || 1);
    const ratio = sum / p;
    return { sum, price: p, ratio, t: clamp01((ratio - PITY_START) / (PITY_FULL - PITY_START)) };
  }

  return {
    meter,
    spent: (species) => sums.get(key(species)) ?? 0,

    /**
     * Adds a throw to the ledger and answers the meter **after** it.
     *
     * After, and it matters: the throw that crosses 125 % should be the one that succeeds, not
     * the one after it (DECISIONS #62 records the same choice for evolution materials).
     */
    credit(species, ballId) {
      const k = key(species);
      const v = valueOf(ballId);
      if (v > 0) sums.set(k, (sums.get(k) ?? 0) + v);
      return meter(species);
    },

    /** The floor applied to a finished probability. Monotone, and `p0` exactly below 90 %. */
    apply(p0, species) {
      const m = meter(species);
      const base = clamp01(Number(p0) || 0);
      return { odds: base + (1 - base) * m.t, p0: base, t: m.t, sum: m.sum, price: m.price };
    },

    /** A catch clears the debt. Every species keeps its own. */
    reset(species) { sums.delete(key(species)); },
    clear: () => sums.clear(),

    serialize: () => ({ v: PITY_VERSION, sums: Object.fromEntries(sums) }),
    restore(value) {
      if (!value || typeof value !== 'object') return false;
      if (Number(value.v) > PITY_VERSION) return false;
      sums.clear();
      for (const [k, n] of Object.entries(value.sums ?? {})) {
        if (Number.isFinite(n) && n > 0) sums.set(String(k).toLowerCase(), n);
      }
      return true;
    },
  };
}

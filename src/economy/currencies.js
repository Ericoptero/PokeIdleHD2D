/**
 * The four currencies, and the rule that keeps them from collapsing into one.
 *
 * A single currency in an idle game always ends the same way: one income stat gets
 * multiplied, every price becomes trivial, and the shop stops being a decision. So each
 * currency here is minted by a *different activity* and is spent on a *different shelf*,
 * and **none of them can be exchanged for another**. If you want stones you have to
 * release duplicates; if you want a Quick Ball you have to actually win battles.
 *
 *   money    ₽   idle accrual, battle payouts, selling loot  → balls, medicine, EXP candy
 *   research ◈   field work: encounters seen, routes worked  → field upgrades, unlocks
 *   bp       BP  battles won (and only battles won)          → apricorn balls, trade items
 *   shards   ◆   appraising and releasing Pokémon            → evolution stones, charms
 *
 * `research` is the currency `src/idle/accrual.js` mints (it reports it as both `research`
 * and `tokens`, and its comment says "economy's wallet calls research tokens"), so
 * `tokens` is an alias for it rather than a currency of its own. The seed module's
 * `wallet.tokens` therefore keeps working.
 */

/** @typedef {'money'|'research'|'bp'|'shards'} CurrencyId */

export const CURRENCIES = Object.freeze([
  Object.freeze({
    id: 'money', name: 'Poké Dollars', short: 'Money', symbol: '₽', colour: '#ffd76a',
    minted: 'idle accrual, battle payouts, selling items',
    /** Fractions are carried, never floored away — see `state.js`. */
    fractional: true,
    start: 3000,
  }),
  Object.freeze({
    id: 'research', name: 'Research Points', short: 'Research', symbol: '◈', colour: '#7fe6c4',
    minted: 'idle field work and sightings',
    fractional: true,
    start: 0,
  }),
  Object.freeze({
    id: 'bp', name: 'Battle Points', short: 'BP', symbol: 'BP', colour: '#8fd2ff',
    minted: 'won battles, streak bonuses',
    fractional: true,
    start: 0,
  }),
  Object.freeze({
    id: 'shards', name: 'Evolution Shards', short: 'Shards', symbol: '◆', colour: '#c6a8ff',
    minted: 'appraising and releasing Pokémon, rare drops',
    fractional: false,
    start: 0,
  }),
]);

export const CURRENCY_IDS = Object.freeze(CURRENCIES.map((c) => c.id));

const BY_ID = new Map(CURRENCIES.map((c) => [c.id, c]));

/** Old names other modules may still pass. `tokens` was the seed's second currency. */
const ALIASES = Object.freeze({
  tokens: 'research',      // src/idle/accrual.js reports research under this name
  rp: 'research',
  coins: 'money', cash: 'money', pokedollars: 'money', pokedollar: 'money',
  battlepoints: 'bp', bpoints: 'bp',
  shard: 'shards',
});

/** @returns {CurrencyId|null} */
export function normaliseCurrency(id) {
  if (typeof id !== 'string') return null;
  const key = id.toLowerCase();
  if (BY_ID.has(key)) return /** @type {CurrencyId} */ (key);
  return ALIASES[key] ?? null;
}

export function currency(id) {
  return BY_ID.get(normaliseCurrency(id) ?? '') ?? null;
}

/**
 * Compact money for a HUD: 12,400 stays readable, 1.24M stays short. Deliberately not
 * `toLocaleString` past a million — a nine-digit number in a 12 px chip is unreadable.
 */
export function formatAmount(n, { compact = true } = {}) {
  const v = Math.floor(n);
  if (!compact || Math.abs(v) < 1e5) return v.toLocaleString('en-US');
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [scale, suffix] of units) {
    if (Math.abs(v) >= scale) {
      const scaled = v / scale;
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2)}${suffix}`;
    }
  }
  return String(v);
}

export function formatCurrency(id, n, opts) {
  const c = currency(id);
  if (!c) return formatAmount(n, opts);
  return c.id === 'money' ? `${c.symbol}${formatAmount(n, opts)}` : `${formatAmount(n, opts)} ${c.symbol}`;
}

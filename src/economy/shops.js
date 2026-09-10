/**
 * The shelves: which shop sells what, when it unlocks, and what it charges today.
 *
 * A shop is a *gate*, not a menu. The Mart's stock list is the game's difficulty curve
 * written down — a Great Ball appears at 5 species caught, an Ultra Ball at 15, a Repeat
 * Ball at 35 — so the player's catching power grows with the dex rather than with their
 * bank balance. That is also why the strong balls are on the BP shelf: money inflates,
 * battles do not.
 *
 * Prices are computed, never stored:
 *
 *   price = round(base × ballDiscount(if a ball) × dealDiscount(if today's deal))
 *   sell  = round(item.sell × sellValue)
 *
 * so an upgrade bought in `upgrades.js` moves every price in the shop immediately, and
 * nothing has to be re-stamped.
 *
 * The daily deal is derived from the in-game day index and the world seed with a hash, not
 * from a stream — so it is the same on every machine, in every replay, and asking for the
 * deal twice does not consume randomness.
 */

import { hashString } from '../core/rng.js';
import { item, ITEMS } from './items.js';

/** @typedef {{ dexCaught?:number, totalEarned?:number, itemsBought?:number, battlesWon?:number, shardsEarned?:number, playSeconds?:number }} Progress */

/** `{ key: threshold }` — every key must be met. Empty means always available. */
const met = (req, progress) => {
  if (!req) return true;
  for (const [k, v] of Object.entries(req)) if ((progress?.[k] ?? 0) < v) return false;
  return true;
};

/**
 * Human sentence for a locked entry, so the shop can say *why*. Kept short on purpose: it
 * sits in a narrow column beside a price, and "8 caught" survives that column where
 * "8 species caught" gets truncated into nonsense.
 */
export function requirementText(req) {
  if (!req) return '';
  const words = {
    dexCaught: 'caught', totalEarned: '₽ earned', itemsBought: 'bought',
    battlesWon: 'wins', shardsEarned: '◆ earned', playSeconds: 's played',
  };
  const compact = (v) => (v >= 1e6 ? `${v / 1e6}M` : v >= 1000 ? `${v / 1000}k` : String(v));
  return Object.entries(req).map(([k, v]) => `${compact(v)} ${words[k] ?? k}`).join(', ');
}

/**
 * @typedef {Object} ShopDef
 * @property {string} id
 * @property {string} name
 * @property {string} blurb
 * @property {Progress} [unlock]
 * @property {{id:string, unlock?:Progress, limit?:number}[]} stock  in shelf order
 */

/** @type {ShopDef[]} */
export const SHOPS = [
  {
    id: 'mart', name: 'Poké Mart', blurb: 'Balls, medicine and lures. Open from the first minute.',
    stock: [
      { id: 'pokeball' },
      { id: 'potion' },
      { id: 'greatball', unlock: { dexCaught: 5 } },
      { id: 'superpotion', unlock: { dexCaught: 5 } },
      { id: 'nestball', unlock: { dexCaught: 8 } },
      { id: 'fullheal', unlock: { dexCaught: 10 } },
      { id: 'lure', unlock: { itemsBought: 10 } },
      { id: 'ultraball', unlock: { dexCaught: 15 } },
      { id: 'hyperpotion', unlock: { dexCaught: 15 } },
      { id: 'expcandy_xs', unlock: { battlesWon: 10 } },
      { id: 'netball', unlock: { dexCaught: 20 } },
      { id: 'superlure', unlock: { dexCaught: 20 } },
      { id: 'expcandy_s', unlock: { dexCaught: 20 } },
      { id: 'ether', unlock: { battlesWon: 10 } },
      { id: 'revive', unlock: { battlesWon: 20 } },
      { id: 'maxether', unlock: { dexCaught: 20 } },
      { id: 'duskball', unlock: { dexCaught: 25 } },
      { id: 'diveball', unlock: { dexCaught: 25 } },
      { id: 'timerball', unlock: { dexCaught: 30 } },
      { id: 'repeatball', unlock: { dexCaught: 35 } },
    ],
  },
  {
    id: 'dept', name: 'Department Store', blurb: 'The big bottles and the big candy. Opens once you are earning.',
    unlock: { totalEarned: 150000 },
    stock: [
      { id: 'maxpotion' },
      { id: 'healball' },
      { id: 'expcandy_m' },
      { id: 'fullrestore', unlock: { totalEarned: 400000 } },
      { id: 'maxrevive', unlock: { totalEarned: 400000 } },
      { id: 'luxuryball', unlock: { dexCaught: 40 } },
      { id: 'maxlure', unlock: { dexCaught: 40 } },
      { id: 'expcandy_l', unlock: { totalEarned: 1000000 } },
      { id: 'expcandy_xl', unlock: { totalEarned: 5000000 } },
      { id: 'amuletcoin', unlock: { totalEarned: 2000000 }, limit: 1 },
    ],
  },
  {
    id: 'exchange', name: 'Battle Point Exchange', blurb: 'Apricorn balls and trade items. Battle Points only.',
    unlock: { battlesWon: 10 },
    stock: [
      { id: 'quickball' },
      { id: 'levelball' },
      { id: 'heavyball' },
      { id: 'fastball', unlock: { battlesWon: 40 } },
      { id: 'moonball', unlock: { battlesWon: 40 } },
      { id: 'rarecandy', unlock: { battlesWon: 60 } },
      { id: 'goldenlure', unlock: { battlesWon: 80 } },
      { id: 'linkcable', unlock: { dexCaught: 30 } },
      { id: 'kingsrock', unlock: { dexCaught: 30 } },
      { id: 'metalcoat', unlock: { dexCaught: 30 } },
      { id: 'dragonscale', unlock: { dexCaught: 30 } },
      { id: 'upgradechip', unlock: { dexCaught: 45 } },
      { id: 'dubiousdisc', unlock: { dexCaught: 45 } },
      { id: 'protector', unlock: { dexCaught: 45 } },
      { id: 'electirizer', unlock: { dexCaught: 45 } },
      { id: 'magmarizer', unlock: { dexCaught: 45 } },
      { id: 'reapercloth', unlock: { dexCaught: 60 } },
      { id: 'razorclaw', unlock: { dexCaught: 60 } },
      { id: 'razorfang', unlock: { dexCaught: 60 } },
      { id: 'ovalstone', unlock: { dexCaught: 60 } },
      { id: 'masterball', unlock: { battlesWon: 500 }, limit: 1 },
    ],
  },
  {
    id: 'shardstall', name: 'Shard Stall', blurb: 'Evolution stones for shards. Shards come from released Pokémon.',
    unlock: { shardsEarned: 20 },
    stock: [
      { id: 'firestone' }, { id: 'waterstone' }, { id: 'thunderstone' }, { id: 'leafstone' },
      { id: 'moonstone' }, { id: 'sunstone', unlock: { dexCaught: 25 } },
      { id: 'shinystone', unlock: { dexCaught: 40 } }, { id: 'duskstone', unlock: { dexCaught: 40 } },
      { id: 'dawnstone', unlock: { dexCaught: 40 } }, { id: 'icestone', unlock: { dexCaught: 40 } },
      { id: 'shinycharm', unlock: { dexCaught: 150 }, limit: 1 },
    ],
  },
];

const BY_ID = new Map(SHOPS.map((s) => [s.id, s]));
Object.freeze(SHOPS);

export function shop(id) { return BY_ID.get(String(id)) ?? null; }

/** Every shop that stocks an item, in shelf order. */
export function shopsSelling(itemId) {
  return SHOPS.filter((s) => s.stock.some((e) => e.id === itemId));
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** The deal is 25% off, and it lasts one in-game day. */
export const DEAL_DISCOUNT = 0.25;

/**
 * Today's deal. Deterministic in `(day, seed)` alone: same seed, same day, same deal, on
 * every machine and in every replay. Only items that can be bought with money are eligible
 * — a 25%-off Master Ball would be a very funny bug.
 */
export function dealFor(day, seed = 0) {
  const pool = ITEMS.filter((i) => i.price != null && (i.currency ?? 'money') === 'money' && i.category !== 'held');
  if (!pool.length) return null;
  const h = hashString(`deal:${Math.floor(day)}`, (seed >>> 0) || 0x811c9dc5);
  return { itemId: pool[h % pool.length].id, discount: DEAL_DISCOUNT, day: Math.floor(day) };
}

/**
 * @param {string} itemId
 * @param {Object} o
 * @param {Object} o.multipliers   from `state.multipliers()`
 * @param {{itemId:string, discount:number}|null} [o.deal]
 * @returns {{price:number, currency:string, base:number, discount:number}|null}
 */
export function priceOf(itemId, { multipliers = {}, deal = null } = {}) {
  const def = item(itemId);
  if (!def || def.price == null) return null;
  const currency = def.currency ?? 'money';
  let price = def.price;
  let discount = 0;
  if (def.category === 'ball' && currency === 'money') {
    const d = multipliers.ballDiscount ?? 1;
    discount += 1 - d;
    price *= d;
  }
  if (deal && deal.itemId === def.id) {
    discount += deal.discount;
    price *= 1 - deal.discount;
  }
  return { price: Math.max(1, Math.round(price)), currency, base: def.price, discount };
}

/** What a shop pays for one. Always ≤ half the buy price, so buy→sell can never profit. */
export function sellValueOf(itemId, { multipliers = {} } = {}) {
  const def = item(itemId);
  if (!def) return 0;
  const raw = Math.round((def.sell ?? 0) * (multipliers.sellValue ?? 1));
  if (def.price != null && (def.currency ?? 'money') === 'money') {
    // Never let the sell multiplier overtake the (discounted) buy price.
    const buy = priceOf(def.id, { multipliers })?.price ?? def.price;
    return Math.max(0, Math.min(raw, Math.floor(buy * 0.9)));
  }
  return Math.max(0, raw);
}

/**
 * The shelf as the player sees it: every entry, unlocked or not, with its price today and
 * the reason it is locked. Locked entries are returned rather than hidden — a shop that
 * shows you what you are working towards is a progression system; one that hides it is a
 * menu that changes behind your back.
 */
export function stockOf(shopId, { progress = {}, multipliers = {}, deal = null, owned = () => 0, boughtToday = () => 0 } = {}) {
  const def = shop(shopId);
  if (!def) return [];
  const shopUnlocked = met(def.unlock, progress);
  return def.stock.map((entry) => {
    const it = item(entry.id);
    const price = priceOf(entry.id, { multipliers, deal });
    const unlocked = shopUnlocked && met(entry.unlock, progress);
    const limitLeft = entry.limit == null ? Infinity : Math.max(0, entry.limit - boughtToday(entry.id));
    return {
      id: entry.id,
      name: it?.name ?? entry.id,
      category: it?.category ?? 'item',
      desc: it?.desc ?? '',
      when: it?.when ?? '',
      price: price?.price ?? null,
      base: price?.base ?? null,
      currency: price?.currency ?? 'money',
      discount: price?.discount ?? 0,
      onDeal: !!(deal && deal.itemId === entry.id),
      sell: sellValueOf(entry.id, { multipliers }),
      owned: owned(entry.id),
      unlocked,
      limit: entry.limit ?? null,
      limitLeft,
      requires: unlocked ? '' : requirementText(shopUnlocked ? entry.unlock : def.unlock),
    };
  });
}

/** Shop headers, with their own lock state. */
export function shopList({ progress = {} } = {}) {
  return SHOPS.map((s) => ({
    id: s.id, name: s.name, blurb: s.blurb,
    unlocked: met(s.unlock, progress),
    requires: met(s.unlock, progress) ? '' : requirementText(s.unlock),
    size: s.stock.length,
  }));
}

/** Where an item can be bought right now, cheapest first. */
export function bestSource(itemId, { progress = {}, multipliers = {}, deal = null } = {}) {
  const options = [];
  for (const s of shopsSelling(itemId)) {
    if (!met(s.unlock, progress)) continue;
    const entry = s.stock.find((e) => e.id === itemId);
    if (!met(entry.unlock, progress)) continue;
    const price = priceOf(itemId, { multipliers, deal });
    if (price) options.push({ shopId: s.id, ...price, limit: entry.limit ?? null });
  }
  options.sort((a, b) => a.price - b.price);
  return options[0] ?? null;
}

export { met as requirementMet };

/**
 * The ledger: wallet, bag, upgrade levels, lifetime statistics, timed buffs.
 *
 * Everything that mutates economy state goes through here, and every mutation is
 * observable. `index.js` is the module wrapper; this file is the model, and it is written
 * with no `ctx`, no bus and no DOM so it can be exercised from Node and from the showcase's
 * self-test without a browser.
 *
 * ### Two decisions worth knowing about
 *
 * **Balances are floats, displays are integers.** `idle` banks money 20 times a second in
 * slices of a few hundredths of a Poké Dollar. The seed floored each slice, which rounded
 * every one of them to zero — the idle loop paid nothing at all. Here the balance keeps its
 * fraction and only the *display* is floored, so a 0.04 ₽ credit is 0.04 ₽ and forty of
 * them are worth ₽1.6.
 *
 * **Income is multiplied on the way in, by reason.** `add('money', n, 'idle')` is income
 * and gets the Payday multiplier; `add('money', n, 'sell:nugget')` is a sale that already
 * had the Market Licence multiplier applied to it, and `add('money', n, 'refund')` is a
 * refund and must not grow. That is what `INCOME_REASONS` is for. It means an upgrade
 * bought here raises the idle rate without `idle` having to know this module exists —
 * which matters, because `idle` currently does not.
 */

import { CURRENCIES, CURRENCY_IDS, normaliseCurrency } from './currencies.js';
import { item, stackCap, ITEMS } from './items.js';
import { UPGRADES, upgrade, costOf, foldUpgrades, EFFECT_BASE } from './upgrades.js';

/** Reasons that count as income and are multiplied. Prefix match, so `battle:win` counts. */
export const INCOME_REASONS = Object.freeze([
  'idle', 'offline', 'battle', 'encounter', 'auto-hunt', 'hunt', 'quest', 'reward', 'loot', 'drop',
]);
/** Reasons that are explicitly *not* multiplied, even if they look like income. */
export const RAW_REASONS = Object.freeze([
  'sell', 'refund', 'grant', 'restore', 'debug', 'test', 'buy', 'spend', 'cheat',
]);

const isIncome = (reason) => {
  const r = String(reason ?? '').toLowerCase();
  if (RAW_REASONS.some((p) => r.startsWith(p))) return false;
  return INCOME_REASONS.some((p) => r === p || r.startsWith(`${p}:`) || r.startsWith(`${p}-`));
};

/** Which multiplier a currency's income uses. Research arrives pre-multiplied by `idle`. */
const INCOME_KEY = Object.freeze({ money: 'moneyGain', bp: 'bpGain', shards: 'shardFind', research: null });

const SAVE_VERSION = 2;
const clean = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);

/**
 * @param {Object} [opts]
 * @param {(change:Object)=>void} [opts.onChange]  every mutation, already shaped for the bus
 * @param {()=>number} [opts.now]                  wall clock in ms, injectable for tests
 */
export function makeEconomyState({ onChange = () => {}, now = () => Date.now() } = {}) {
  /**
   * Exact balances, fractions included. Every wallet opens at **zero**: the starting purse
   * is *credited* by `index.js` at init instead of being assigned here, so the opening
   * balance travels down the same path as every other payment and fires the same
   * `economy:changed`. A HUD that renders from that event therefore shows ₽3,000 on the
   * first frame instead of ₽0 until the first idle payout lands.
   */
  const wallet = Object.fromEntries(CURRENCIES.map((c) => [c.id, 0]));
  /** @type {Map<string, number>} */
  const bag = new Map();
  /** @type {Record<string, number>} */
  const levels = {};
  /** @type {{key:string, mult:number, until:number, id:string}[]} */
  let buffs = [];

  const stats = {
    earned: Object.fromEntries(CURRENCY_IDS.map((c) => [c, 0])),
    spent: Object.fromEntries(CURRENCY_IDS.map((c) => [c, 0])),
    itemsBought: 0, itemsSold: 0, itemsUsed: 0, upgradesBought: 0,
    battlesWon: 0, ballsThrown: 0, pokemonAppraised: 0,
    sessionStartMs: now(),
  };

  /** Multipliers are recomputed on any change and cached — they are read every frame. */
  let cache = null;
  const invalidate = () => { cache = null; };

  function multipliers() {
    if (cache) return cache;
    const out = foldUpgrades(levels);
    // Held items you own are permanent multipliers (Amulet Coin, Shiny Charm, …).
    for (const def of ITEMS) {
      if (!def.passive) continue;
      if ((bag.get(def.id) ?? 0) > 0) out[def.passive.key] = (out[def.passive.key] ?? 1) * def.passive.mult;
    }
    // Timed buffs from lures.
    const t = now();
    for (const b of buffs) if (b.until > t) out[b.key] = (out[b.key] ?? 1) * b.mult;
    cache = Object.freeze(out);
    return cache;
  }

  // ---------------------------------------------------------------- currency

  const balance = (c = 'money') => Math.floor(exact(c));
  function exact(c = 'money') {
    const id = normaliseCurrency(c);
    return id ? wallet[id] : 0;
  }

  /**
   * @param {string} c currency id or alias
   * @param {number} n signed amount; positive income is multiplied unless `raw`
   * @param {string|{reason?:string, raw?:boolean}} [reason]
   * @returns {number} the new displayed balance
   */
  function add(c, n, reason = '') {
    const id = normaliseCurrency(c);
    const amount = clean(typeof n === 'number' ? n : Number(n), 0);
    const opts = typeof reason === 'object' && reason ? reason : { reason: String(reason ?? '') };
    if (!id) { onChange({ kind: 'error', message: `unknown currency "${c}"` }); return 0; }
    if (amount === 0) return balance(id);

    let credited = amount;
    const key = INCOME_KEY[id];
    if (amount > 0 && key && !opts.raw && isIncome(opts.reason)) credited = amount * multipliers()[key];

    const before = wallet[id];
    wallet[id] = Math.max(0, before + credited);
    const applied = wallet[id] - before;
    /**
     * **`earned: false` means it was not earned**, and the shop gates depend on the difference.
     *
     * `progress().totalEarned` is `floor(stats.earned.money)` and it is what every money-priced
     * shelf is unlocked against — the Department Store at ₽150,000, Full Restore at ₽400,000.
     * At the old ₽3,000 opening balance counting the start credit was noise; at the brief's
     * `FIELD_START_MONEY` of ₽100,000 it would put a brand-new save two thirds of the way to a
     * gate it is meant to earn. "Total earned" has to mean the player earned it, or the gate is
     * measuring the wrong thing.
     */
    if (applied > 0) { if (opts.earned !== false) stats.earned[id] += applied; } else stats.spent[id] -= applied;
    invalidate();
    onChange({
      kind: 'currency', currency: id, delta: applied, base: amount,
      total: Math.floor(wallet[id]), exact: wallet[id], reason: opts.reason ?? '',
    });
    return balance(id);
  }

  const canAfford = (c, n) => exact(c) + 1e-9 >= n;

  /** Spends if the balance covers it, otherwise changes nothing and returns false. */
  function spend(c, n, reason = '') {
    const id = normaliseCurrency(c);
    const cost = clean(Number(n), 0);
    if (!id || cost < 0) return false;
    if (!canAfford(id, cost)) return false;
    add(id, -cost, { reason: reason || 'spend', raw: true });
    return true;
  }

  // -------------------------------------------------------------------- bag

  const count = (id) => bag.get(String(id)) ?? 0;

  /** @returns {number} how many actually fit (stack caps are real, and sellable) */
  function give(id, n = 1, reason = 'grant') {
    const def = item(id);
    if (!def || n <= 0) return 0;
    const cap = stackCap(def.id, multipliers().bagSlots / 100);
    const have = count(def.id);
    const room = Math.max(0, cap - have);
    const added = Math.min(Math.floor(n), room);
    if (added <= 0) return 0;
    bag.set(def.id, have + added);
    if (def.passive) invalidate();
    onChange({ kind: 'item', item: def.id, delta: added, total: have + added, reason });
    return added;
  }

  function take(id, n = 1, reason = 'use') {
    const def = item(id);
    if (!def) return false;
    const have = count(def.id);
    const want = Math.floor(n);
    if (want <= 0 || have < want) return false;
    const left = have - want;
    if (left > 0) bag.set(def.id, left); else bag.delete(def.id);
    if (def.passive) invalidate();
    onChange({ kind: 'item', item: def.id, delta: -want, total: left, reason });
    return true;
  }

  const inventory = () => Object.fromEntries([...bag.entries()].filter(([, n]) => n > 0));

  /**
   * Loot the player has told the game never to sell **automatically**.
   *
   * Per save rather than per item definition, because the definition is shared and frozen and
   * the lock is a preference. And it gates the *automatic* sale only: `sell()` by hand still
   * works, because a lock that blocked the shop counter would be a trap — the player is
   * standing there asking for it.
   */
  const sellLock = new Set();

  // --------------------------------------------------------------- upgrades

  const levelOf = (id) => Math.floor(levels[id] ?? 0);

  function setLevel(id, level) {
    const def = upgrade(id);
    if (!def) return false;
    const lvl = Math.max(0, Math.min(def.max, Math.floor(level)));
    if (lvl === levelOf(id)) return false;
    levels[id] = lvl;
    invalidate();
    onChange({ kind: 'upgrade', upgrade: def.id, level: lvl, effect: def.effectKey });
    return true;
  }

  function nextCost(id) {
    const def = upgrade(id);
    return def ? costOf(def, levelOf(def.id)) : Infinity;
  }

  // ------------------------------------------------------------------ buffs

  function addBuff(id, { key, mult, seconds }) {
    const t = now();
    buffs = buffs.filter((b) => b.until > t);
    const existing = buffs.find((b) => b.id === id);
    if (existing) existing.until += seconds * 1000;          // stacking a lure extends it
    else buffs.push({ id, key, mult, until: t + seconds * 1000 });
    invalidate();
    onChange({ kind: 'buff', buff: id, key, mult, until: t + seconds * 1000 });
  }

  function activeBuffs() {
    const t = now();
    const live = buffs.filter((b) => b.until > t);
    if (live.length !== buffs.length) { buffs = live; invalidate(); }
    return live.map((b) => ({ ...b, secondsLeft: Math.max(0, (b.until - t) / 1000) }));
  }

  // ------------------------------------------------------------------- save

  /** JSON-safe. `offline`'s save document stores this under `slices.economy`. */
  function serialize() {
    return {
      v: SAVE_VERSION,
      wallet: Object.fromEntries(CURRENCY_IDS.map((c) => [c, +wallet[c].toFixed(4)])),
      bag: inventory(),
      sellLock: [...sellLock].sort(),
      upgrades: { ...levels },
      stats: {
        earned: { ...stats.earned }, spent: { ...stats.spent },
        itemsBought: stats.itemsBought, itemsSold: stats.itemsSold, itemsUsed: stats.itemsUsed,
        upgradesBought: stats.upgradesBought, battlesWon: stats.battlesWon,
        ballsThrown: stats.ballsThrown, pokemonAppraised: stats.pokemonAppraised,
      },
      buffs: buffs.map((b) => ({ id: b.id, key: b.key, mult: b.mult, until: b.until })),
    };
  }

  /**
   * Forward-migrating and defensive: a save written by an older build, or a corrupted one,
   * must leave the player with a working economy rather than a white screen. Unknown item
   * and upgrade ids are dropped, not preserved — they are almost always renames.
   */
  function restore(data) {
    if (!data || typeof data !== 'object') return false;
    let s = data;
    // v1 saves, and the shape `src/offline/slices.js`'s adapter writes for a module that has
    // no `saveState()` yet, both keep the bag under a different name.
    if ((s.v ?? 1) < 2) s = { ...s, v: 2, bag: s.bag ?? s.items ?? s.inventory ?? {}, upgrades: s.upgrades ?? {} };

    for (const c of CURRENCY_IDS) {
      const v = clean(Number(s.wallet?.[c]), NaN);
      if (Number.isFinite(v)) wallet[c] = Math.max(0, v);
    }
    // `tokens` from a pre-research save.
    const legacy = clean(Number(s.wallet?.tokens), 0);
    if (legacy > 0 && !Number.isFinite(Number(s.wallet?.research))) wallet.research = legacy;

    // An older save slice has no lock list, and an empty one is the right
    // default — nothing was locked, because nothing could be. Slice-level, so the document
    // version does not move (src/offline/slices.js: `loadState` tolerates an older slice).
    sellLock.clear();
    for (const id of Array.isArray(s.sellLock) ? s.sellLock : []) if (item(id)) sellLock.add(id);

    bag.clear();
    for (const [id, n] of Object.entries(s.bag ?? {})) {
      if (item(id) && Number.isFinite(Number(n)) && Number(n) > 0) bag.set(id, Math.floor(Number(n)));
    }
    for (const k of Object.keys(levels)) delete levels[k];
    for (const [id, lvl] of Object.entries(s.upgrades ?? {})) {
      const def = upgrade(id);
      if (def) levels[id] = Math.max(0, Math.min(def.max, Math.floor(Number(lvl) || 0)));
    }
    for (const [k, v] of Object.entries(s.stats ?? {})) {
      if (k === 'earned' || k === 'spent') {
        for (const c of CURRENCY_IDS) stats[k][c] = clean(Number(v?.[c]), 0);
      } else if (k in stats) stats[k] = clean(Number(v), 0);
    }
    const t = now();
    buffs = (Array.isArray(s.buffs) ? s.buffs : [])
      .filter((b) => b && typeof b.key === 'string' && Number(b.until) > t)
      .map((b) => ({ id: String(b.id), key: b.key, mult: clean(Number(b.mult), 1), until: Number(b.until) }));

    invalidate();
    onChange({ kind: 'restored', wallet: { ...wallet } });
    return true;
  }

  return {
    // wallet
    balance, exact, add, spend, canAfford,
    wallet: () => ({ ...wallet }),
    // bag
    count, give, take, inventory,
    bagSize: () => [...bag.values()].reduce((a, b) => a + b, 0),
    /** The auto-sell lock. `sell()` by hand ignores it; `automation`'s pass does not. */
    sellLocked: (id) => sellLock.has(String(id)),
    sellLocks: () => [...sellLock].sort(),
    setSellLock(id, on = true) {
      const def = item(id);
      if (!def) return false;
      if (on) sellLock.add(def.id); else sellLock.delete(def.id);
      onChange({ kind: 'sellLock', item: def.id, locked: on });
      return true;
    },
    // upgrades
    levelOf, setLevel, nextCost,
    levels: () => ({ ...levels }),
    // derived
    multipliers, invalidate,
    effectBase: () => ({ ...EFFECT_BASE }),
    // buffs
    addBuff, activeBuffs,
    // bookkeeping
    stats: () => JSON.parse(JSON.stringify(stats)),
    bump(key, n = 1) { if (key in stats) { stats[key] = clean(stats[key], 0) + n; } },
    // persistence
    serialize, restore, SAVE_VERSION,
    /** All upgrade definitions, so callers do not have to import a second module. */
    upgradeDefs: () => UPGRADES,
  };
}

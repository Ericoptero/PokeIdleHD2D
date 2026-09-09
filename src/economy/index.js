/**
 * economy — currency, items and the shop (ARCHITECTURE §5.9).
 *
 * The contract is six functions — `balance`, `add`, `spend`, `inventory`, `buy`, `sell`,
 * `prices` — and everything else here exists to make those six mean something:
 *
 *   currencies.js  four currencies, each minted by a different activity, none exchangeable
 *   items.js       ~70 items; mainline ball multipliers, mainline loot values, honest sells
 *   upgrades.js    eleven permanent tracks with geometric costs and additive effects
 *   shops.js       four shelves with progression gates and a deterministic daily deal
 *   state.js       the ledger: wallet, bag, levels, buffs, save slice
 *   pacing.js      the projection those prices were tuned against, runnable in Node
 *
 * ### Three seams worth understanding
 *
 * **Upgrades feed the idle rate without `idle` knowing.** `idle` banks its accrual with
 * `add('money', n, 'idle')`. `state.add` recognises `idle` as an income reason and applies
 * the Payday multiplier on the way in, so a purchase made here raises the idle rate on the
 * next tick with no cross-module wiring at all. Research arrives already multiplied by
 * `idle`'s own chain and is deliberately *not* multiplied again.
 *
 * **Determinism.** No `Math.random()`, and no RNG stream at all in the money path. The one
 * random-looking thing — the daily deal — is a hash of `(in-game day, world seed)`, so it
 * is stable across machines, replays and repeated reads. Catch *rolls* stay in `encounter`
 * where the encounter's own stream lives; this module hands out the multiplier and the
 * odds, and never rolls them.
 *
 * **Persistence.** `saveState()` / `loadState()` are the native seam `src/offline/slices.js`
 * prefers, so the wallet, bag, upgrade levels and lifetime statistics survive a reload the
 * moment `offline` hydrates.
 */

import { speciesPrice } from './pricing.js';
import { makePity } from './pity.js';
import { trainerFromWins } from './trainer.js';
import { CURRENCIES, formatCurrency } from './currencies.js';
import { ITEMS, item, itemsBy, ballMultiplier, catchOdds, stackCap } from './items.js';
import { UPGRADES, upgrade, costOf, bulkCost, foldUpgrades } from './upgrades.js';
import {
  shop, shopList, stockOf, priceOf, sellValueOf, dealFor, bestSource, requirementMet,
} from './shops.js';
import { makeEconomyState } from './state.js';
import { project, sinkTotals, curveOf, INCOME_MODEL } from './pacing.js';

/**
 * Battle Points minted per won battle. BP is the only currency the player cannot earn by
 * waiting, which is what keeps the Quick Ball shelf behind actual play.
 */
const BP_PER_WIN = 0.25;
/** Shards from a wild catch appraised in the field. Releasing one pays much more. */
const SHARDS_PER_CATCH = 0.4;

/** The uncapped late-game money sink. See `vouchers()`. */
const VOUCHER_BASE = 250000;
const VOUCHER_GROWTH = 1.15;

/**
 * Items that also unlock something inside `idle`'s own model. Only forwarded where this
 * module cannot express the effect itself: shiny rolls happen inside `idle`'s encounter
 * resolution, so the charm has to be granted there. Money and EXP multipliers are *not*
 * forwarded — `add()` already applies those, and granting them twice would double-count.
 */
const IDLE_UNLOCKS = Object.freeze({ shinycharm: 'shiny-charm' });   // idle.grant(id)

export default {
  id: 'economy',
  needs: [],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],

  init(ctx) {
    const { bus, config, clock } = ctx;

    /**
     * A species object from whatever the caller had.
     *
     * Callers hand over a name, a species object or an encounter, and the price needs
     * `catchRate` and `bst` — so `pokemon` is asked through `ctx.get`, and a quarantined
     * `pokemon` degrades to a flat ordinary price rather than to a crash.
     */
    const resolveSpecies = (x) => {
      if (x && typeof x === 'object' && (x.bst || x.catchRate)) return x;
      const name = typeof x === 'string' ? x : x?.species ?? x?.name;
      if (!name) return null;
      const pk = ctx.get('pokemon');
      const live = !!pk && pk.__missing === undefined;
      return (live && typeof pk.species === 'function' ? pk.species(name) : null) ?? { name, catchRate: 255, bst: 300 };
    };

    /** The per-species ball ledger. Prices come from this module; the roll never does. */
    const pity = makePity({ price: (sp) => speciesPrice(sp), item });

    const state = makeEconomyState({
      onChange(change) {
        // §4 lists exactly one economy event, and this is it. Item, upgrade and buff
        // changes go to local subscribers instead of inventing bus events the contract
        // does not have — see the coreRequest in the round report.
        if (change.kind === 'currency') {
          bus.emit('economy:changed', {
            currency: change.currency,
            delta: +change.delta.toFixed(4),
            total: change.total,
            reason: change.reason ?? '',
          });
        }
        for (const fn of subscribers) {
          try { fn(change); } catch { /* a subscriber's bug is not the ledger's problem */ }
        }
      },
    });

    /** @type {Set<(change:Object)=>void>} */
    const subscribers = new Set();

    // The opening purse and kit. Mainline starts you with a few balls and a Potion, and so
    // do we. The money is credited rather than assigned (see `state.js`) so the HUD has an
    // `economy:changed` to render from before anything else happens.
    for (const c of CURRENCIES) {
      if (c.start > 0) state.add(c.id, c.start, { reason: 'start', raw: true });
    }
    state.give('pokeball', 10, 'start');
    state.give('potion', 3, 'start');

    /** Purchases of limited stock, per in-game day, so `limit` means "per day". */
    let limitDay = -1;
    const boughtToday = new Map();
    let vouchersBought = 0;

    /** In-game days since boot; the deal and the daily limits turn over on it. */
    const dayIndex = () => Math.floor((clock?.simTime ?? 0) / (config.secondsPerGameHour * 24));

    function rolloverDay() {
      const d = dayIndex();
      if (d !== limitDay) { limitDay = d; boughtToday.clear(); }
      return d;
    }

    const deal = () => dealFor(rolloverDay(), config.seed);
    const boughtTodayOf = (id) => { rolloverDay(); return boughtToday.get(id) ?? 0; };

    /**
     * Species this module has watched being caught. `collection` is the authority on the
     * dex and its number wins when it is live — but the Mart's shelves are gated on the
     * dex, and a shop that silently locks every shelf because another module is absent or
     * quarantined is a worse failure than a slightly stale count. So economy keeps its own
     * tally from the bus and takes whichever is larger.
     */
    const seenCaught = new Set();

    /** The snapshot every unlock gate is evaluated against. */
    function progress() {
      const s = state.stats();
      const dex = ctx.get('collection').stats?.();
      return {
        dexCaught: Math.max(seenCaught.size, Number.isFinite(dex?.caught) ? dex.caught : 0),
        totalEarned: Math.floor(s.earned.money),
        shardsEarned: Math.floor(s.earned.shards),
        researchEarned: Math.floor(s.earned.research),
        itemsBought: s.itemsBought,
        battlesWon: s.battlesWon,
        playSeconds: Math.floor(clock?.simTime ?? 0),
        trainerLevel: trainerFromWins(state.stats().battlesWon ?? 0).level,
      };
    }

    const shopContext = () => ({
      progress: progress(),
      multipliers: state.multipliers(),
      deal: deal(),
      owned: (id) => state.count(id),
      boughtToday: boughtTodayOf,
    });

    // ---------------------------------------------------------------- faucets
    //
    // BP and shards are minted here because they are *economy's* currencies: nobody else
    // should have to know the rate. Money is not minted here — `idle` banks its own accrual
    // and battle payout through `add()`, and `automation` credits `autoResolve` rewards, so
    // crediting `encounter:resolved.rewards.money` as well would pay for the same battle
    // twice the moment `encounter` starts emitting the event.
    //
    // Catches are counted from whichever source speaks first. `idle` reports catches in its
    // tick today and does not emit `catch:succeeded`; when it (or `encounter`) starts to,
    // that event becomes the authority and the tick's count is ignored, so no catch is ever
    // paid for twice whichever way that lands.
    let sawCatchEvent = false;

    bus.on('idle:tick', (payload) => {
      const g = payload?.gains;
      if (!g) return;
      const wins = Number(g.wins) || 0;
      const catches = Number(g.catches) || 0;
      if (wins > 0) {
        state.bump('battlesWon', wins);
        state.add('bp', wins * BP_PER_WIN, 'battle');
      }
      if (catches > 0 && !sawCatchEvent) state.add('shards', catches * SHARDS_PER_CATCH, 'loot');
    });

    bus.on('encounter:resolved', (payload) => {
      if (payload?.outcome !== 'win') return;
      state.bump('battlesWon', 1);
      state.add('bp', BP_PER_WIN, 'battle');
    });

    /**
     * Re-announces every non-zero balance once the game is up. Module init order puts
     * `economy` before `ui` (both declare no dependencies, and the topological sort breaks
     * ties alphabetically), so the opening purse is credited before anything is listening
     * and a HUD that renders only from `economy:changed` would sit at ₽0 until the first
     * idle payout. This is a re-statement, not a payment: `delta` is 0 and no balance moves.
     */
    bus.once?.('boot:ready', () => announce('sync'));

    function announce(reason = 'sync') {
      for (const c of CURRENCIES) {
        const total = state.balance(c.id);
        if (total > 0) bus.emit('economy:changed', { currency: c.id, delta: 0, total, reason });
      }
    }

    bus.on('catch:succeeded', (payload) => {
      // A catch clears that species' debt and nobody else's (DECISIONS #61).
      if (payload?.species) pity.reset(resolveSpecies(payload.species));
      sawCatchEvent = true;
      if (payload?.species) seenCaught.add(String(payload.species));
      state.add('shards', SHARDS_PER_CATCH, 'loot');
    });

    // ------------------------------------------------------------------- api

    /** Buying is the only place a price is charged, so it is the only place gates apply. */
    function buy(id, n = 1, { shopId = null } = {}) {
      const def = item(id);
      const qty = Math.floor(n);
      if (!def || qty <= 0) return false;
      const c = shopContext();

      const source = shopId
        ? (shop(shopId)?.stock.some((e) => e.id === id) && requirementMet(shop(shopId).unlock, c.progress)
          ? { shopId, ...(priceOf(id, c) ?? {}) } : null)
        : bestSource(id, c);
      if (!source || !Number.isFinite(source.price)) return false;

      const entry = shop(source.shopId)?.stock.find((e) => e.id === id);
      if (!requirementMet(entry?.unlock, c.progress)) return false;
      if (entry?.limit != null && boughtTodayOf(id) + qty > entry.limit) return false;

      // Stack caps are checked before the money moves: a purchase that cannot fit in the
      // bag must not silently vanish.
      const cap = stackCap(id, c.multipliers.bagSlots / 100);
      if (state.count(id) + qty > cap) return false;

      const total = source.price * qty;
      if (!state.spend(source.currency, total, `buy:${id}`)) return false;

      state.give(id, qty, `buy:${id}`);
      state.bump('itemsBought', qty);
      boughtToday.set(id, boughtTodayOf(id) + qty);

      // Ten Poké Balls, one Premier Ball. The oldest freebie in the series.
      if (id === 'pokeball' && qty >= 10) state.give('premierball', Math.floor(qty / 10), 'premier-bonus');
      if (def.passive && IDLE_UNLOCKS[id]) ctx.get('idle').grant?.(IDLE_UNLOCKS[id]);
      return true;
    }

    function sell(id, n = 1) {
      const def = item(id);
      const qty = Math.floor(n);
      if (!def || qty <= 0) return false;
      const unit = sellValueOf(id, { multipliers: state.multipliers() });
      if (unit <= 0) return false;                       // key items and Master Balls
      if (!state.take(id, qty, `sell:${id}`)) return false;
      state.add('money', unit * qty, `sell:${id}`);
      state.bump('itemsSold', qty);
      return true;
    }

    /**
     * Consumes one item and returns what it *means*. Economy owns the item and the bag;
     * the module that owns the target applies the effect, so nothing here reaches into
     * `pokemon` to set HP.
     *
     * @returns {{kind:string, [k:string]:any}|null} null if the item is missing or inert
     */
    function useItem(id, target = null) {
      const def = item(id);
      if (!def) return null;
      let effect = null;
      if (def.buff) effect = { kind: 'buff', ...def.buff };
      else if (def.heal) effect = { kind: 'heal', ...def.heal, target };
      else if (def.exp) effect = { kind: 'exp', exp: def.exp, target };
      else if (def.evolution) effect = { kind: 'evolve', ...def.evolution, target };
      if (!effect) return null;
      if (!state.take(id, 1, `use:${id}`)) return null;
      state.bump('itemsUsed', 1);
      if (effect.kind === 'buff') state.addBuff(id, def.buff);
      return { item: id, ...effect };
    }

    /**
     * Throws a ball: spends it, and reports the odds. **It does not roll.** The roll
     * belongs to `encounter`, which owns the encounter's RNG stream — a module that both
     * spends the ball and decides the outcome would make catch results depend on shop
     * state, and determinism would be gone.
     */
    function throwBall(ballId, context = {}, { catchRate = 45, hpFraction = 1, status = 'none' } = {}) {
      const def = item(ballId);
      if (!def || def.category !== 'ball') return { thrown: false, reason: 'not a ball', odds: 0, multiplier: 0 };
      if (!state.take(ballId, 1, `throw:${ballId}`)) {
        return { thrown: false, reason: 'none in the bag', odds: 0, multiplier: 0 };
      }
      state.bump('ballsThrown', 1);
      const multiplier = ballMultiplier(ballId, context);
      const p0 = catchOdds({
        ball: ballId, catchRate, hpFraction, status, context,
        bonus: state.multipliers().catchRate,
      });

      // **The ledger is credited before the odds are read**, so the throw that crosses 125 % is
      // the one that succeeds rather than the one after it (DECISIONS #61). This module still
      // does not roll: it spends the ball, remembers what was spent, and reports a number —
      // `encounter` compares it to a coin from its own stream (#35(d)).
      const species = context?.species ?? null;
      if (species) pity.credit(species, ballId);
      const floored = species ? pity.apply(p0, species) : { odds: p0, p0, t: 0, sum: 0, price: 0 };

      return {
        thrown: true, ball: ballId, multiplier,
        odds: floored.odds, p0: floored.p0, pity: floored.t,
        spent: floored.sum, price: floored.price,
      };
    }

    /** The best ball in the bag for this encounter; ties go to the cheapest. */
    function recommendBall(context = {}, { owned = true } = {}) {
      const balls = itemsBy((i) => i.category === 'ball' && (!owned || state.count(i.id) > 0));
      let best = null;
      for (const def of balls) {
        const m = ballMultiplier(def.id, context);
        if (m >= 255) return { id: def.id, multiplier: m, reason: 'never fails' };
        const price = def.price ?? 0;
        if (!best || m > best.multiplier + 1e-9 || (Math.abs(m - best.multiplier) < 1e-9 && price < best.price)) {
          best = { id: def.id, multiplier: m, price, reason: def.when || `${m}×` };
        }
      }
      return best;
    }

    /**
     * What a Pokémon is worth if you let it go. Base-stat total and level carry it, shinies
     * are worth ten times as much, and the whole thing is deterministic in the instance —
     * `automation`'s auto-release rules need to be able to promise a number before acting.
     */
    function appraise(instance) {
      if (!instance) return { money: 0, shards: 0 };
      const level = Math.max(1, Number(instance.level) || 1);
      const stats = instance.species?.baseStats ?? {};
      let bst = 0;
      for (const k in stats) bst += Number(stats[k]) || 0;
      if (!bst) bst = 300;
      const shinyMult = instance.shiny ? 10 : 1;
      const mult = state.multipliers();
      return {
        money: Math.round(6 * level * (bst / 300) * shinyMult * mult.sellValue),
        shards: Math.max(1, Math.round((1 + level / 10) * (bst / 400) * shinyMult * mult.shardFind)),
      };
    }

    /** Credits an appraisal. `collection`/`automation` call this when they release one. */
    function release(instance) {
      const value = appraise(instance);
      if (value.money > 0) state.add('money', value.money, 'sell:pokemon');
      if (value.shards > 0) state.add('shards', value.shards, { reason: 'release', raw: true });
      state.bump('pokemonAppraised', 1);
      return value;
    }

    /**
     * The uncapped sink. Every multiplier track has a cap, so income cannot run away; this
     * is where the money goes afterwards. A voucher's price grows 15% per purchase and its
     * reward is a Pokémon — collection progress, which does not inflate income — so a
     * month-old save with ₽138M banked (see `pacing.js`) always has something to want.
     */
    function vouchers() {
      const price = Math.round(VOUCHER_BASE * Math.pow(VOUCHER_GROWTH, vouchersBought));
      return { bought: vouchersBought, price, currency: 'money', growth: VOUCHER_GROWTH };
    }

    function buyVoucher() {
      const { price } = vouchers();
      if (!state.spend('money', price, 'buy:voucher')) return null;
      const index = vouchersBought++;
      // A ticket, not a Pokémon: `collection` and `pokemon` own what a Pokémon *is*. The
      // stream is forked per voucher so the ticket is the same on every replay.
      const rng = ctx.rng.fork(`economy/voucher/${index}`);
      const roll = rng.next();
      const tier = roll > 0.98 ? 'rare' : roll > 0.8 ? 'uncommon' : 'common';
      bus.emit('ui:toast', { text: `Wonder Trade voucher #${index + 1} — ${tier}`, kind: 'info' });
      return { index, tier, roll, price };
    }

    /**
     * Invariants that must hold whatever the player does. Run by the showcase (and cheap
     * enough to run anywhere): a shop that can be farmed by buying and reselling, or a
     * price that goes negative, is the kind of bug that only shows up in a save file three
     * days later.
     */
    function selfTest() {
      const results = [];
      const check = (name, ok, detail = '') => results.push({ name, ok, detail });
      const mult = state.multipliers();

      let worst = null;
      for (const def of ITEMS) {
        if (def.price == null || (def.currency ?? 'money') !== 'money') continue;
        const buyPrice = priceOf(def.id, { multipliers: mult })?.price ?? def.price;
        const sellPrice = sellValueOf(def.id, { multipliers: mult });
        if (sellPrice >= buyPrice && (!worst || sellPrice - buyPrice > worst.gap)) {
          worst = { id: def.id, gap: sellPrice - buyPrice };
        }
      }
      check('no buy→sell arbitrage', !worst, worst ? `${worst.id} resells for +${worst.gap}` : `${ITEMS.length} items`);

      // The same has to hold for a maxed-out save, where sell values are 2x higher and
      // ball prices 30% lower. This is the check that actually bites.
      const maxed = foldUpgrades(Object.fromEntries(UPGRADES.map((u) => [u.id, u.max])));
      let maxedWorst = null;
      for (const def of ITEMS) {
        if (def.price == null || (def.currency ?? 'money') !== 'money') continue;
        const buyPrice = priceOf(def.id, { multipliers: maxed })?.price ?? def.price;
        const sellPrice = sellValueOf(def.id, { multipliers: maxed });
        if (sellPrice >= buyPrice) maxedWorst = { id: def.id, buyPrice, sellPrice };
      }
      check('no arbitrage at max upgrades', !maxedWorst,
        maxedWorst ? `${maxedWorst.id}: buy ${maxedWorst.buyPrice}, sell ${maxedWorst.sellPrice}` : 'sell < buy everywhere');

      const ball = ballMultiplier('duskball', { tod: 22 });
      check('conditional balls evaluate', ball === 3, `dusk ball at 22:00 = ${ball}×`);
      const day = ballMultiplier('duskball', { tod: 12 });
      check('conditional balls fall back', day === 1, `dusk ball at noon = ${day}×`);

      const d1 = dealFor(7, config.seed), d2 = dealFor(7, config.seed);
      check('daily deal is deterministic', d1.itemId === d2.itemId, `day 7 → ${d1.itemId}`);

      const before = state.balance('money');
      state.add('money', 100, { reason: 'test', raw: true });
      state.spend('money', 100, 'test');
      check('add/spend round-trips', state.balance('money') === before, `${before} → ${state.balance('money')}`);

      const over = state.spend('money', state.exact('money') + 1000, 'test');
      check('cannot overdraw', over === false, 'spend beyond balance refused');

      const snapshot = state.serialize();
      check('save slice is JSON-safe', typeof JSON.stringify(snapshot) === 'string', `${Object.keys(snapshot).length} keys`);

      const costs = UPGRADES.map((u) => costOf(u, u.max - 1) / costOf(u, 0));
      check('every track ends dearer than it starts', costs.every((r) => r > 1), `steepest ×${Math.max(...costs).toFixed(0)}`);

      return { ok: results.every((r) => r.ok), results };
    }

    const api = {
      // --- ARCHITECTURE §5.9 ------------------------------------------------
      balance: (c = 'money') => state.balance(c),
      add: (c, n, reason) => state.add(c, n, reason),
      spend: (c, n, reason) => state.spend(c, n, reason),
      inventory: () => state.inventory(),
      buy, sell,
      prices() {
        const c = shopContext();
        const out = {};
        for (const def of ITEMS) {
          const p = priceOf(def.id, c);
          if (p) out[def.id] = p.price;
        }
        return out;
      },

      // --- wallet -----------------------------------------------------------
      wallet: () => state.wallet(),
      exact: (c) => state.exact(c),
      canAfford: (c, n) => state.canAfford(c, n),
      currencies: () => CURRENCIES.map((c) => ({ ...c, balance: state.balance(c.id) })),
      format: (c, n) => formatCurrency(c, n ?? state.balance(c)),

      // --- bag --------------------------------------------------------------
      count: (id) => state.count(id),
      give: (id, n = 1, reason = 'grant') => state.give(id, n, reason) > 0,
      take: (id, n = 1, reason = 'use') => state.take(id, n, reason),
      capacity: (id) => stackCap(id, state.multipliers().bagSlots / 100),
      item: (id) => item(id),
      items: (filter) => (typeof filter === 'function' ? ITEMS.filter(filter) : ITEMS.slice()),
      useItem, throwBall, recommendBall,

      // --- catching ---------------------------------------------------------
      catchMultiplier: (ballId, context) => ballMultiplier(ballId, context),

      /**
       * The trainer's level, `travel`'s gate (§5.16).
       *
       * Derived from `battlesWon`, which this module has counted since it was written — so
       * there is no new state, no save slice and no migration, and a level that disagreed with
       * the battle count is not expressible (DECISIONS #70).
       */
      trainer: () => trainerFromWins(progress().battlesWon),

      // --- what a Pokemon is worth, and the pity that follows from it (§5.9) ---
      /** Derived from capture rate, base-stat total and whether it is a final form. */
      speciesPrice: (nameOrSpecies, opts) => speciesPrice(resolveSpecies(nameOrSpecies), opts),
      /** The meter a UI draws: how much has been spent on this species against its price. */
      pity: (species) => pity.meter(resolveSpecies(species)),
      /** The floor, applied to a finished probability. Never lowers it. */
      applyPity: (p0, species) => pity.apply(p0, resolveSpecies(species)),
      /** Odds INCLUDING the pity floor, without spending a ball. For the panel. */
      oddsWithPity(opts, species) {
        const base = catchOdds({ ...opts, bonus: (opts?.bonus ?? 1) * state.multipliers().catchRate });
        return species ? pity.apply(base, resolveSpecies(species)) : { odds: base, p0: base, t: 0 };
      },
      catchOdds: (opts) => catchOdds({ ...opts, bonus: (opts?.bonus ?? 1) * state.multipliers().catchRate }),

      // --- shops ------------------------------------------------------------
      shops: () => shopList({ progress: progress() }),
      stock: (shopId) => stockOf(shopId, shopContext()),
      sellValue: (id) => sellValueOf(id, { multipliers: state.multipliers() }),
      deal,
      source: (id) => bestSource(id, shopContext()),

      // --- upgrades ---------------------------------------------------------
      upgrades() {
        const p = progress();
        return UPGRADES.map((def) => {
          const level = state.levelOf(def.id);
          return {
            id: def.id, name: def.name, desc: def.desc, currency: def.currency,
            level, max: def.max, cost: costOf(def, level),
            effect: def.effectKey, perLevel: def.perLevel, mode: def.mode,
            value: def.mode === 'flat' ? def.perLevel * level : 1 + def.perLevel * level,
            unlocked: requirementMet(def.unlock, p),
            affordable: state.canAfford(def.currency, costOf(def, level)),
          };
        });
      },
      upgradeLevel: (id) => state.levelOf(id),
      upgradeCost: (id, n = 1) => bulkCost(upgrade(id), state.levelOf(id), n),
      buyUpgrade(id, n = 1) {
        const def = upgrade(id);
        if (!def || !requirementMet(def.unlock, progress())) return 0;
        let bought = 0;
        for (let i = 0; i < n; i++) {
          const level = state.levelOf(def.id);
          const cost = costOf(def, level);
          if (!Number.isFinite(cost)) break;
          if (!state.spend(def.currency, cost, `buy:upgrade:${def.id}`)) break;
          state.setLevel(def.id, level + 1);
          state.bump('upgradesBought', 1);
          bought++;
        }
        return bought;
      },
      multipliers: () => state.multipliers(),
      buffs: () => state.activeBuffs(),

      // --- Pokémon values ---------------------------------------------------
      appraise, release,

      // --- the uncapped sink ------------------------------------------------
      vouchers, buyVoucher,

      // --- reporting --------------------------------------------------------
      /** Re-states current balances on the bus for anything that subscribed late. */
      announce,
      progress, stats: () => state.stats(),
      sinks: sinkTotals,
      curve: curveOf,
      project: (opts) => project(opts),
      incomeModel: () => ({ ...INCOME_MODEL }),
      selfTest,

      /** Item, upgrade and buff changes, which §4 has no bus event for. */
      onChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },

      // --- persistence (the native seam src/offline/slices.js prefers) -------
      saveState: () => ({ ...state.serialize(), vouchers: vouchersBought, pity: pity.serialize() }),
      loadState(value) {
        const ok = state.restore(value);
        if (Number.isFinite(value?.vouchers)) vouchersBought = Math.max(0, Math.floor(value.vouchers));
        // The ledger is the one piece of state here a player would genuinely resent losing:
        // forty balls into a Gible and a reload puts them back at zero.
        if (value?.pity) pity.restore(value.pity);
        return ok;
      },
    };

    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseEconomy } = await import('./showcase.js');
    return showcaseEconomy(mode, ctx);
  },
};

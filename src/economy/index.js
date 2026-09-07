/** economy — currency, items, shop (ARCHITECTURE §5.9). SEED. */
export default {
  id: 'economy',
  needs: [],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],
  init(ctx) {
    const wallet = { money: 3000, tokens: 0 };
    const inventory = new Map([['pokeball', 10], ['greatball', 0]]);
    const PRICES = { pokeball: 200, greatball: 600, ultraball: 1200, potion: 300 };
    return {
      balance: (c = 'money') => wallet[c] ?? 0,
      add(c, n, reason = '') { wallet[c] = (wallet[c] ?? 0) + n; ctx.bus.emit('economy:changed', { currency: c, delta: n, total: wallet[c], reason }); return wallet[c]; },
      spend(c, n, reason = '') { if ((wallet[c] ?? 0) < n) return false; return this.add(c, -n, reason) !== false; },
      inventory: () => Object.fromEntries(inventory),
      count: (id) => inventory.get(id) ?? 0,
      give(id, n = 1) { inventory.set(id, (inventory.get(id) ?? 0) + n); },
      take(id, n = 1) { const have = inventory.get(id) ?? 0; if (have < n) return false; inventory.set(id, have - n); return true; },
      prices: () => ({ ...PRICES }),
      buy(id, n = 1) { const cost = (PRICES[id] ?? 0) * n; if (!this.spend('money', cost, `buy ${id}`)) return false; this.give(id, n); return true; },
      sell(id, n = 1) { if (!this.take(id, n)) return false; this.add('money', Math.floor((PRICES[id] ?? 0) * 0.5) * n, `sell ${id}`); return true; },
    };
  },
  async showcase(mode, ctx) { await ctx.get('city').enter?.(); },
};

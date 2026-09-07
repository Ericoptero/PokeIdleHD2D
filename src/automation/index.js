/** automation — auto-hunt, auto-catch, auto-sell (ARCHITECTURE §5.11). SEED. */
export default {
  id: 'automation',
  needs: ['encounter', 'economy', 'collection'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],
  init(ctx) {
    const rules = { autoHunt: false, autoCatch: false, autoSell: false, releaseDuplicates: false };
    return {
      rules: () => ({ ...rules }),
      set(patch) { Object.assign(rules, patch); ctx.bus.emit('automation:changed', { ...rules }); },
      unlocked: () => Object.keys(rules),
    };
  },
  tick(dt, ctx) {
    const a = ctx.get('automation');
    if (!a.rules?.().autoHunt) return;
    const enc = ctx.get('encounter').roll?.(ctx.get('terrain').handle?.()?.biome ?? 'meadow');
    if (!enc) return;
    const res = ctx.get('encounter').autoResolve?.(enc, 5);
    if (res?.rewards?.money) ctx.get('economy').add?.('money', res.rewards.money, 'auto-hunt');
  },
  async showcase(mode, ctx) { await ctx.get('city').enter?.(); },
};

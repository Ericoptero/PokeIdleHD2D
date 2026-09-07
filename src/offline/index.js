/**
 * offline — catch-up for time the game was closed (ARCHITECTURE §5.8).
 * SEED. Uses idle.simulate verbatim, capped and discounted.
 */
const KEY = 'pokeidle.save';
const BROKEN = 'pokeidle.save.broken';
const VERSION = 1;

export default {
  id: 'offline',
  needs: ['idle'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],

  init(ctx) {
    const { config, bus, log } = ctx;
    let save = load();

    function load() {
      let raw = null;
      try { raw = localStorage.getItem(KEY); } catch { return fresh(); }
      if (!raw) return fresh();
      try {
        const parsed = JSON.parse(raw);
        return migrate(parsed);
      } catch (err) {
        // A corrupt save is moved aside, never repaired in place.
        try { localStorage.setItem(BROKEN, raw); localStorage.removeItem(KEY); } catch {}
        log.error('offline: save was unreadable and has been quarantined', err);
        return fresh();
      }
    }
    function fresh() { return { v: VERSION, lastSeenMs: Date.now(), totals: { money: 0 } }; }
    function migrate(s) {
      let out = s;
      while ((out.v ?? 0) < VERSION) out = { ...out, v: (out.v ?? 0) + 1 };
      return out;
    }

    const awayS = Math.max(0, (Date.now() - (save.lastSeenMs ?? Date.now())) / 1000);
    const capped = awayS > config.offlineCapS;
    const applied = Math.min(awayS, config.offlineCapS);

    let summary = null;
    if (applied > 60) {
      const gains = ctx.get('idle').simulate?.(
        { party: ctx.get('pokemon').party?.() ?? [], biome: 'meadow', luck: 1 },
        applied * config.offlineEfficiency, config.seed);
      if (gains) {
        ctx.get('economy').add?.('money', Math.floor(gains.money), 'offline');
        summary = { awayS, applied, gains, capped };
        bus.emit('offline:applied', { awayS, gains, capped });
      }
    }

    const persist = () => {
      save.lastSeenMs = Date.now();
      try { localStorage.setItem(KEY, JSON.stringify(save)); } catch { /* private mode */ }
    };
    let debounce = null;
    const schedule = () => { clearTimeout(debounce); debounce = setTimeout(persist, 2000); };
    addEventListener('visibilitychange', persist);
    addEventListener('pagehide', persist);
    bus.on('economy:changed', schedule);

    return { summary: () => summary, save: () => ({ ...save }), persist, awayS: () => awayS };
  },

  async showcase(mode, ctx) { await ctx.get('city').enter?.(); },
};

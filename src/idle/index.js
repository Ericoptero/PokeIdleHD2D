/**
 * idle — accrual while the tab is alive but possibly backgrounded (ARCHITECTURE §5.7).
 *
 * A backgrounded tab stops rAF and throttles setTimeout to about 1 Hz, so the heartbeat
 * lives in a Web Worker and the main thread reconciles against Date.now(). There is exactly
 * one implementation of "what happens per second" — `simulate` — and `offline` calls the
 * same function, so the two can never drift apart.
 */

import { simulate } from './accrual.js';

export default {
  id: 'idle',
  needs: ['simulation', 'economy', 'encounter'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],

  init(ctx) {
    const { config, bus, log } = ctx;
    let lastWallMs = Date.now();
    let pending = 0;
    let worker = null;

    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = () => reconcile();
      worker.postMessage({ type: 'start', intervalMs: config.idleHeartbeatMs });
    } catch (err) {
      log.warn('idle: worker unavailable, falling back to a timer', err);
      setInterval(() => reconcile(), config.idleHeartbeatMs);
    }

    function reconcile() {
      const now = Date.now();
      const elapsed = Math.max(0, (now - lastWallMs) / 1000);
      lastWallMs = now;
      pending += elapsed;
    }
    document.addEventListener('visibilitychange', reconcile);

    const state = () => ({
      party: ctx.get('pokemon').party?.() ?? [],
      biome: ctx.get('terrain').handle?.()?.biome ?? 'meadow',
      luck: 1,
    });

    return {
      simulate,
      rate: () => simulate(state(), 1, config.seed).perSecond,
      pending: () => pending,
      /** Drains at most `capS` seconds so a long gap does not freeze the frame. */
      flush(capS = 30) {
        if (pending <= 0) return null;
        const chunk = Math.min(pending, capS);
        pending -= chunk;
        const gains = simulate(state(), chunk, config.seed);
        ctx.get('economy').add?.('money', Math.floor(gains.money), 'idle');
        bus.emit('idle:tick', { elapsedS: chunk, gains });
        return gains;
      },
      dispose() { worker?.terminate(); },
    };
  },

  tick(dt, ctx) { ctx.get('idle').flush?.(30); },

  async showcase(mode, ctx) {
    const { showcaseIdle } = await import('./showcase.js');
    return showcaseIdle(mode, ctx);
  },
};

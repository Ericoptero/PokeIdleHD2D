/**
 * idle — accrual while the tab is alive but possibly backgrounded (ARCHITECTURE §5.7).
 *
 * The shape of the problem: a backgrounded tab stops `requestAnimationFrame` completely
 * and throttles main-thread timers to about 1 Hz (and much worse after a few minutes).
 * An idle game that counts frames therefore stops being an idle game the moment the player
 * looks at something else — which is most of the time.
 *
 * So this module is built out of four pieces that each do one job:
 *
 *   accrual.js    the PURE production model. `simulate(state, elapsedS, seed)`. Shared
 *                 verbatim with `offline`, so "what happens per second" has exactly one
 *                 implementation and the two can never drift apart.
 *   worker.js     a heartbeat in a dedicated worker, which survives background throttling
 *                 far better than anything on the main thread.
 *   heartbeat.js  transport management: worker, timer fallback, drift and missed-beat
 *                 telemetry.
 *   drain.js      turns owed seconds into gains in bounded slices, so a three-hour gap
 *                 costs a few milliseconds per frame instead of one long freeze.
 *
 * And one rule holds them together: **no heartbeat is ever trusted for how much time
 * passed.** Every beat, every frame and every `visibilitychange` does the same thing —
 * reconcile against `Date.now()` and queue the real elapsed wall time. A missed beat, a
 * throttled worker, a suspended laptop or a clock that jumps all resolve to the same
 * answer, because the answer always comes from the wall clock and never from the pulse.
 */

import { simulate, production, rateOf, digest, BIOMES, UNLOCKS, UPGRADES, BALL_ITEM, DEFAULT_BIOME } from './accrual.js';
import { makeHeartbeat } from './heartbeat.js';
import { makeDrain, emptyGains, mergeGains, CATCHUP_S } from './drain.js';

/** How often banked gains are handed to `economy` and announced on the bus. */
const EMIT_INTERVAL_MS = 1000;
/** Drain budget per rendered frame. 4 ms of a 16.6 ms frame, so 60 fps survives a catch-up. */
const FRAME_BUDGET_MS = 4;
/** Drain budget on a heartbeat beat — this runs while the tab is hidden, so keep it small. */
const BEAT_BUDGET_MS = 6;
/** Samples kept for the rate history graph: two minutes at 1 Hz. */
const HISTORY_CAPACITY = 120;
/** State is rebuilt at most this often; bus events invalidate it sooner. */
const STATE_TTL_MS = 500;

/** @type {{dispose:Function}|null} */
let live = null;

export default {
  id: 'idle',
  needs: ['simulation', 'economy', 'encounter'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],

  init(ctx) {
    const { config, bus, log } = ctx;
    const seed = config.seed >>> 0;

    // --- clock ---------------------------------------------------------------
    // Everything time-related goes through `now()`. It is `Date.now()` plus an offset that
    // only the diagnostic hooks move, which is what lets the showcase and the seams stage
    // a three-hour gap in a test without waiting three hours — and what keeps the rest of
    // the module honest, because there is no other clock in here to reach for.
    let clockOffsetMs = 0;
    const now = () => Date.now() + clockOffsetMs;

    // --- idle-owned state ----------------------------------------------------
    const own = {
      biome: null,                    // set only when nothing else knows better
      luck: 1,
      efficiency: 1,
      unlocks: new Set(),
      upgrades: {},
      progress: { encounters: 0, seconds: 0 },
    };
    const totals = { money: 0, exp: 0, research: 0, encounters: 0, wins: 0, catches: 0, shinies: 0, seconds: 0, ballsShort: 0 };
    const carry = { money: 0, tokens: 0 };
    const clockHealth = { backwards: 0, capped: 0, cappedS: 0, lastGapS: 0 };
    const visibility = {
      hidden: typeof document !== 'undefined' ? !!document.hidden : false,
      /** Seconds handed to `encounter` because the player was watching, and how many times. */
      watchedS: 0,
      watchedCount: 0,
      hiddenCount: 0, hiddenTotalS: 0, hiddenSinceMs: 0,
      accruedWhileHiddenS: 0, moneyWhileHidden: 0, framesWhileHidden: 0,
    };
    const history = [];
    /** Gains banked but not yet announced, so the bus is not flooded at 60 Hz. */
    let bankBuffer = emptyGains();
    let lastEmitMs = now();
    let lastWallMs = now();
    let lastCatchup = null;
    /** Gains accumulated across the passes of one catch-up, for its summary. */
    let catchupAcc = null;

    // --- live state assembly -------------------------------------------------
    // The pure model is told everything it needs; it never reaches for a module itself.
    let cachedState = null;
    let cachedAt = 0;
    const invalidate = () => { cachedState = null; };

    function buildState() {
      const pokemon = ctx.get('pokemon');
      const terrain = ctx.get('terrain');
      const encounter = ctx.get('encounter');
      const economy = ctx.get('economy');
      const environment = ctx.get('environment');

      const handle = terrain.handle?.();
      const biome = handle?.biome ?? own.biome ?? DEFAULT_BIOME;
      const tod = environment.getTimeOfDay?.() ?? config.tod;
      const party = pokemon.party?.() ?? [];
      const tables = encounter.tablesFor?.(biome, tod) ?? [];
      const balls = economy.count?.(BALL_ITEM);

      return {
        party: Array.isArray(party) ? party : [],
        biome: BIOMES[biome] ? biome : DEFAULT_BIOME,
        tod: Number.isFinite(tod) ? tod : 12,
        luck: Number.isFinite(own.luck) ? own.luck : 1,
        efficiency: own.efficiency,
        unlocks: [...own.unlocks],
        upgrades: { ...own.upgrades },
        tables: Array.isArray(tables) ? tables : [],
        // `encounter`'s own rolls, battle and drops. One index space, live and offline
        // (DECISIONS #69). A quarantined `encounter` hands over nothing and `accrual.js`
        // falls back to its own model, which is a visible degradation rather than a silent
        // disagreement about what encounter 400 was.
        pure: (() => {
          // The registry's null object answers every property with a function — checking the
          // value, not `typeof`, is the tell (§2.1).
          const e = ctx.get('encounter');
          const live = !!e && e.__missing === undefined;
          return live && typeof e.pure === 'function' ? e.pure() : null;
        })(),
        balls: Number.isFinite(balls) ? balls : undefined,
        progress: { ...own.progress },
      };
    }

    function state() {
      const t = now();
      if (!cachedState || t - cachedAt > STATE_TTL_MS) {
        cachedState = buildState();
        cachedAt = t;
      }
      return cachedState;
    }

    // A gap snapshots the state once and reuses it for every slice: a gap is a replay of
    // time that has already passed, so it is settled by the party that existed then —
    // which is also exactly what `offline` does with its single call.
    // The drain measures its own budgets with `performance.now()`, not with `now()`: a
    // budget is a duration, and durations must not be measured on a clock that can jump.
    const drain = makeDrain({ seed, snapshotState: () => state() });

    // --- who is running the hunt ---------------------------------------------
    /**
     * `'encounter' | 'idle' | 'offline'` — the one thing stepping the hunt right now.
     *
     * `offline` is never this module's answer: a closed tab has no `idle` running to ask. What
     * this distinguishes is a tab you are **watching**, where `encounter` steps a real fight on
     * the map, from a tab that is **backgrounded**, where nothing is drawing and the fold is the
     * only thing that can move the game on.
     *
     * It reads this module's own `visibility.hidden` rather than `document.hidden` directly, so
     * `debug.setHidden()` — which a showcase already uses to exercise the hidden-tab bookkeeping
     * in a headless capture — steers it too.
     */
    function driver() {
      if (typeof document === 'undefined') return 'idle';
      return visibility.hidden ? 'idle' : 'encounter';
    }

    /**
     * Hands the encounter counter across when the driver changes.
     *
     * There is one index space (`root/encounter/roll/N`, DECISIONS #61(f)) and two counters
     * walking it — this module's `own.progress.encounters` and `encounter`'s own. Left
     * unsynchronised they drift apart and index N is resolved twice against different party
     * state, which is the disagreement #61(f) was written to prevent, arriving from the other
     * end. Whole encounters are the integers in `(p0, p1]` (`accrual.js`), so the floor of this
     * module's float is exactly how many it has finished.
     */
    function handOver(to) {
      const e = ctx.get('encounter');
      if (!e || e.__missing !== undefined) return;
      if (to === 'idle' && typeof e.progress === 'function') {
        const n = e.progress().encounters;
        if (Number.isFinite(n)) own.progress.encounters = Math.max(own.progress.encounters, n);
      } else if (to === 'encounter' && typeof e.setProgress === 'function') {
        e.setProgress({ encounters: Math.floor(own.progress.encounters) });
      }
    }

    // --- reconciliation ------------------------------------------------------
    /**
     * The heart of the module. Measures real elapsed wall time since the last call and
     * queues it. Called from beats, frames and visibilitychange — whichever happens first
     * wins, and the other two then measure zero, so no second is ever counted twice.
     */
    function reconcile(reason) {
      const t = now();
      let dt = (t - lastWallMs) / 1000;
      lastWallMs = t;

      if (!Number.isFinite(dt) || dt < 0) {
        // The wall clock moved backwards: an NTP correction, a DST jump, or a user
        // setting the system clock. Award nothing and resync rather than paying out a
        // negative second or trusting a clock we just caught lying.
        clockHealth.backwards++;
        return 0;
      }
      const cap = Math.max(60, config.offlineCapS);
      if (dt > cap) {
        // A gap this long is `offline`'s business, not ours (ARCHITECTURE §5.8): the tab
        // was asleep, not merely backgrounded. Clamp so a laptop shut for three days does
        // not pay out three days at online rates.
        clockHealth.capped++;
        clockHealth.cappedS += dt - cap;
        dt = cap;
      }
      clockHealth.lastGapS = dt;
      // **Exactly one thing runs the hunt at a time** (DECISIONS #72). A visible tab is driven
      // by `encounter`, which walks the loop, engages slots and steps real fights; this module
      // folds a *model* of the same loop. Both were running at once — `document.hidden` was
      // tracked for reporting and never as a gate — and it was harmless only because the fold
      // wrote nothing back. It stops being harmless the moment `gains.progress` carries party
      // HP and a bag, at which point two drivers damage one party and spend one bag twice.
      //
      // The second is still *measured* and `lastWallMs` still advances, so a second discarded
      // here can never be paid twice later; it is simply not this module's second.
      if (dt > 0) {
        if (driver() === 'idle') drain.queue(dt, reason);
        else { visibility.watchedS += dt; visibility.watchedCount++; }
      }
      return dt;
    }

    // --- banking -------------------------------------------------------------
    /** Gains become currency here, and nowhere else. */
    function bank(gains) {
      totals.money += gains.money;
      totals.exp += gains.exp;
      totals.research += gains.research;
      totals.encounters += gains.wholeEncounters;
      totals.wins += gains.wins;
      totals.catches += gains.catches;
      totals.shinies += gains.shinies;
      totals.seconds += gains.elapsedS;
      own.progress.encounters += gains.encounters;
      own.progress.seconds += gains.elapsedS;

      const economy = ctx.get('economy');
      // Fractional carry: crediting `floor()` every time would quietly shave a fraction of
      // a coin off every payment, and at 60 payments a second that is most of the income.
      carry.money += gains.money;
      const money = Math.floor(carry.money);
      if (money > 0) { carry.money -= money; economy.add?.('money', money, 'idle'); }
      carry.tokens += gains.research;
      const tokens = Math.floor(carry.tokens);
      if (tokens > 0) { carry.tokens -= tokens; economy.add?.('tokens', tokens, 'idle'); }

      for (const id in gains.items) {
        if (gains.items[id] > 0) economy.give?.(id, gains.items[id]);
      }
      // Auto-catch spends balls, clamped to what is in the bag: the model resolved the
      // catches against the gate it was given, and going negative in someone else's
      // inventory would be worse than paying for a few of them out of goodwill. An empty
      // bag closes the gate on the next snapshot, which is the self-correcting part.
      if (gains.ballsUsed > 0) {
        const have = economy.count?.(BALL_ITEM) ?? 0;
        const spend = Math.min(have, gains.ballsUsed);
        if (spend > 0) economy.take?.(BALL_ITEM, spend);
        totals.ballsShort += gains.ballsUsed - spend;
      }

      // The party learns from idling. This call sat here pointing at a method that did not
      // exist for the whole life of the project (DECISIONS #61) — every point of experience
      // the game produced was discarded by a `typeof` guard that always failed.
      //
      // `source: 'idle'` and not `'hunt'`: experience is granted, and the evolution it
      // unlocks is deliberately NOT taken. §0's rule is that a Pokemon evolves in a hunt, and
      // a backgrounded tab is not one — the pending evolution is reported and waits.
      const pokemon = ctx.get('pokemon');
      if (typeof pokemon.grantPartyExp === 'function') pokemon.grantPartyExp(gains.exp, { source: 'idle' });

      if (visibility.hidden) visibility.moneyWhileHidden += gains.money;
    }

    function announce(gains) {
      const payload = {
        elapsedS: +gains.elapsedS.toFixed(3),
        gains: {
          money: +gains.money.toFixed(3),
          exp: +gains.exp.toFixed(2),
          research: +gains.research.toFixed(3),
          encounters: gains.wholeEncounters,
          wins: gains.wins, catches: gains.catches, shinies: gains.shinies,
          perSecond: gains.perSecond,
          biome: gains.biome,
          // The bus spy keeps the last 256 payloads; a full encounter log would push
          // everything else out of it, so only the interesting ones travel.
          events: gains.events.filter((e) => e.shiny || e.caught).slice(0, 8),
        },
      };
      bus.emit('idle:tick', payload);
      history.push({
        atMs: now(), money: totals.money, seconds: totals.seconds,
        rate: gains.perSecond?.money ?? 0, hidden: visibility.hidden,
      });
      if (history.length > HISTORY_CAPACITY) history.shift();
    }

    function flushBank(force = false) {
      const t = now();
      if (bankBuffer.elapsedS <= 0) { if (force) lastEmitMs = t; return null; }
      if (!force && t - lastEmitMs < EMIT_INTERVAL_MS && bankBuffer.elapsedS < CATCHUP_S) return null;
      const gains = bankBuffer;
      bankBuffer = emptyGains();
      lastEmitMs = t;
      bank(gains);
      announce(gains);
      return gains;
    }

    /**
     * Banking and announcing after a drain pass. Shared by the frame and beat paths.
     *
     * A catch-up usually spans several passes, and each pass may bank on its own 1 Hz
     * cadence, so the summary is accumulated across the whole gap rather than read off the
     * last flush — otherwise "you idled three hours" would report the final slice.
     */
    function afterDrain(report) {
      if (report.gains) mergeGains(bankBuffer, report.gains);
      if (report.catchup && report.gains) mergeGains(catchupAcc ??= emptyGains(), report.gains);

      if (report.finished && catchupAcc) {
        flushBank(true);
        const total = catchupAcc.elapsedS;
        // Everything here is accumulated over the whole gap, whichever pass drained which
        // slice — a heartbeat beat can land between two frames and take a bite out of it,
        // and the summary has to add up regardless.
        lastCatchup = {
          atMs: now(), seconds: total, steps: report.gains?.gapSteps ?? 0, ms: report.gains?.gapMs ?? 0,
          calls: report.gains?.gapCalls ?? 0, worstMs: report.gains?.gapWorstMs ?? 0,
          worstStepMs: report.gains?.gapWorstStepMs ?? 0,
          money: catchupAcc.money, encounters: catchupAcc.wholeEncounters,
          wins: catchupAcc.wins, catches: catchupAcc.catches, shinies: catchupAcc.shinies,
          hidden: visibility.hidden,
        };
        if (total >= 30) {
          // A silent jump in the money counter reads as a bug, so say what happened.
          bus.emit('ui:toast', {
            text: `Idled ${formatDuration(total)} — ₽${Math.floor(catchupAcc.money).toLocaleString('en-US')}` +
              (catchupAcc.wholeEncounters ? ` · ${catchupAcc.wholeEncounters} encounters` : ''),
            kind: 'idle',
          });
        }
        catchupAcc = null;
      } else {
        flushBank(false);
      }
      return report;
    }

    /** One drain pass on the frame path: reconcile, drain inside the budget, bank. */
    function pump({ budgetMs, maxSteps, reason }) {
      reconcile(reason);
      return afterDrain(drain.run({ budgetMs, maxSteps }));
    }

    // --- heartbeat -----------------------------------------------------------
    const heartbeat = makeHeartbeat({
      intervalMs: Math.max(100, config.idleHeartbeatMs),
      log,
      onBeat() {
        // The path that runs while the tab is hidden and no frame is being drawn. This is
        // the whole reason the worker exists: without it, a backgrounded tab would bank
        // nothing until the player came back.
        const dt = reconcile('beat');
        if (visibility.hidden) visibility.accruedWhileHiddenS += dt;
        pumpFromBeat();
      },
    });

    /** The same pass, from a heartbeat beat — the path a hidden tab runs on. */
    function pumpFromBeat() {
      return afterDrain(drain.run({ budgetMs: BEAT_BUDGET_MS, maxSteps: 256 }));
    }

    // --- visibility ----------------------------------------------------------
    function onVisibilityChange() {
      // Measure the gap BEFORE flipping the flag, so the seconds that elapsed while the
      // tab was hidden are attributed to being hidden.
      const dt = reconcile('visibilitychange');
      const hidden = !!document.hidden;
      if (visibility.hidden) {
        visibility.accruedWhileHiddenS += dt;
        visibility.hiddenTotalS += (now() - visibility.hiddenSinceMs) / 1000;
      }
      if (hidden && !visibility.hidden) { visibility.hiddenCount++; visibility.hiddenSinceMs = now(); }
      visibility.hidden = hidden;
      // The counter changes hands at the edge, before either side takes another index.
      handOver(hidden ? 'idle' : 'encounter');
      // Coming back should feel instant, so drain hard for one call rather than waiting
      // for the frame budget to nibble at it.
      if (!hidden) pump({ budgetMs: 12, maxSteps: 2048, reason: 'visible' });
      else flushBank(true);
    }
    const hasDocument = typeof document !== 'undefined';
    if (hasDocument) {
      document.addEventListener('visibilitychange', onVisibilityChange);
      addEventListener('pagehide', () => flushBank(true));
    }

    // --- diagnostics ---------------------------------------------------------
    function formatDuration(s) {
      const t = Math.max(0, Math.round(s));
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
      if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
      return `${sec}s`;
    }

    const api = {
      // --- the ARCHITECTURE §5.7 contract ------------------------------------
      /** The pure model. `offline` calls this exact function. */
      simulate,
      /** Per-second production right now: `{ money, exp, research, encounters }`. */
      rate: () => rateOf(state()),
      /** Seconds owed but not yet turned into gains. */
      pending: () => drain.pending(),
      /**
       * Drains up to `capS` seconds immediately and banks the result.
       * @returns {Object|null} the gains, or null if nothing was owed.
       */
      flush(capS = 30) {
        reconcile('flush');
        const report = drain.run({ budgetMs: 16, maxSteps: 4096, maxS: capS });
        if (!report.gains) return null;
        mergeGains(bankBuffer, report.gains);
        return flushBank(true);
      },

      // --- depth: reading the model ------------------------------------------
      /** The live state handed to the pure model. Safe to inspect, cheap, cached. */
      state,
      /** The full per-second breakdown: party contributions, multiplier chain, flags. */
      production: () => production(state()),
      /** Lifetime totals, including fractional currency not yet banked. */
      totals: () => ({ ...totals, carry: { ...carry } }),
      /** 1 Hz samples of banked money, for graphs. */
      history: () => history.slice(),
      /** What the gap drainer has been doing, slice by slice. */
      trace: () => drain.trace(),
      progress: () => drain.progress(),
      lastCatchup: () => (lastCatchup ? { ...lastCatchup } : null),
      formatDuration,

      // --- depth: driving the model ------------------------------------------
      catalog: () => ({ unlocks: { ...UNLOCKS }, upgrades: { ...UPGRADES }, biomes: { ...BIOMES } }),
      unlocks: () => [...own.unlocks],
      has: (id) => own.unlocks.has(id),
      /** Grants an unlock. `economy`/`automation` decide when; `idle` only applies it. */
      grant(id) {
        if (!UNLOCKS[id]) { log.warn(`idle.grant: no unlock "${id}"`); return false; }
        own.unlocks.add(id); invalidate(); return true;
      },
      revoke(id) { const had = own.unlocks.delete(id); invalidate(); return had; },
      upgrades: () => ({ ...own.upgrades }),
      setUpgrade(id, level) {
        const spec = UPGRADES[id];
        if (!spec) { log.warn(`idle.setUpgrade: no upgrade "${id}"`); return false; }
        own.upgrades[id] = Math.max(0, Math.min(spec.cap, Math.floor(level)));
        invalidate(); return true;
      },
      /** Only used when no map is loaded; a loaded map's biome always wins. */
      setBiome(b) { own.biome = BIOMES[b] ? b : null; invalidate(); return own.biome; },
      setLuck(n) { own.luck = Number.isFinite(n) ? Math.max(0, n) : 1; invalidate(); },
      setEfficiency(n) { own.efficiency = Number.isFinite(n) ? Math.max(0, n) : 1; invalidate(); },

      // --- depth: the save seam (`offline` owns the file, we own the shape) ---
      snapshot: () => ({
        v: 1,
        progress: { ...own.progress },
        totals: { ...totals },
        carry: { ...carry },
        unlocks: [...own.unlocks],
        upgrades: { ...own.upgrades },
        lastSeenMs: lastWallMs,
      }),
      /**
       * Restores a save slice. Also the seam `offline` should use after applying a
       * closed-tab gap: `simulate()` returns the `progress` it ended on, so
       * `idle.restore({ progress: gains.progress })` carries the cumulative encounter
       * index forward. Without that, the first encounters of the new session replay the
       * indices `offline` just resolved — and the player is shown the same shiny twice.
       */
      restore(s) {
        if (!s || typeof s !== 'object') return false;
        // A save is untrusted input: it may be old, hand-edited, or half-written. Every
        // field is coerced and only known keys are taken, so a corrupt slice degrades to
        // zeroes instead of putting NaN in the player's wallet.
        const num = (v) => (Number.isFinite(+v) ? +v : 0);
        if (s.progress) own.progress = { encounters: num(s.progress.encounters), seconds: num(s.progress.seconds) };
        if (s.totals) for (const k in totals) if (k in s.totals) totals[k] = num(s.totals[k]);
        if (s.carry) { carry.money = num(s.carry.money); carry.tokens = num(s.carry.tokens); }
        if (Array.isArray(s.unlocks)) { own.unlocks.clear(); for (const id of s.unlocks) if (UNLOCKS[id]) own.unlocks.add(id); }
        if (s.upgrades) { own.upgrades = {}; for (const id in s.upgrades) if (UPGRADES[id]) own.upgrades[id] = s.upgrades[id]; }
        invalidate();
        return true;
      },
      /** Wall time of the last reconciliation — what `offline` should persist. */
      lastSeenMs: () => lastWallMs,

      // --- depth: telemetry ---------------------------------------------------
      heartbeat: () => heartbeat.stats(),
      /**
       * Which of the three things is stepping the hunt. Published, and drawn by `?debug=1`,
       * because "exactly one driver at a time" is a claim a screenshot should be able to
       * settle rather than one a comment asserts (DECISIONS #72).
       */
      driver,
      diagnostics: () => ({
        seed,
        driver: driver(),
        transport: heartbeat.transport,
        heartbeat: heartbeat.stats(),
        drain: drain.stats(),
        clock: { ...clockHealth, offsetMs: clockOffsetMs, nowMs: now() },
        visibility: {
          ...visibility,
          hiddenNowS: visibility.hidden ? (now() - visibility.hiddenSinceMs) / 1000 : 0,
        },
        totals: { ...totals },
        pendingS: drain.pending(),
      }),
      digest,

      /**
       * Diagnostics only. Moves this module's view of the wall clock so a test or the
       * showcase can stage a three-hour background gap without waiting three hours. The
       * production path never touches it.
       */
      debug: {
        advanceWallMs(ms) {
          const n = Number(ms) || 0;
          clockOffsetMs += n;
          return clockOffsetMs;
        },
        now,
        pump: (opts = {}) => pump({ budgetMs: 4, maxSteps: 512, reason: 'debug', ...opts }),
        setHidden(hidden) {
          if (!!hidden !== visibility.hidden) handOver(hidden ? 'idle' : 'encounter');
          // Lets the showcase exercise the hidden-tab bookkeeping in a headless capture,
          // where the page is always technically visible.
          if (hidden && !visibility.hidden) { visibility.hiddenCount++; visibility.hiddenSinceMs = now(); }
          else if (!hidden && visibility.hidden) visibility.hiddenTotalS += (now() - visibility.hiddenSinceMs) / 1000;
          visibility.hidden = !!hidden;
        },
        reconcile,
        /** The snapshot the last gap opened with, so a caller can reproduce it exactly. */
        lastGap: () => drain.lastGap(),
        lastCatchupGap: () => drain.lastCatchupGap(),
        state: buildState,
      },

      /** Called from the descriptor's frame hook; kept on the API so it is testable. */
      _frame() {
        if (visibility.hidden) visibility.framesWhileHidden++;
        pump({ budgetMs: FRAME_BUDGET_MS, maxSteps: 512, reason: 'frame' });
        heartbeat.check(visibility.hidden);
      },
    };

    // Bus events that change what a second is worth. Cheap to rebuild, so the list is
    // generous rather than clever.
    const offs = [
      bus.on('world:loaded', invalidate),
      bus.on('world:unloaded', invalidate),
      bus.on('party:leadChanged', invalidate),
      bus.on('collection:added', invalidate),
      bus.on('catch:succeeded', invalidate),
      bus.on('tod:changed', invalidate),
    ];

    live = {
      dispose() {
        for (const off of offs) { try { off(); } catch { /* already gone */ } }
        heartbeat.dispose();
        if (hasDocument) document.removeEventListener('visibilitychange', onVisibilityChange);
        if (typeof window !== 'undefined' && window.__IDLE__ === api) delete window.__IDLE__;
        live = null;
      },
    };

    // A named diagnostic surface, in the spirit of core's `window.__LOG__`: a critic can
    // open the console on a running build and read the model without a debugger.
    if (typeof window !== 'undefined') window.__IDLE__ = api;

    // Warm the model once, off the critical path. Without this the first slice of the
    // first gap pays V8's compilation cost inside a frame budget it is then measured
    // against — 8 ms rather than 1 ms, measured. One microscopic call fixes it.
    try { simulate(buildState(), 1e-6, seed); } catch { /* a cold module is not fatal */ }

    log.info(`idle: ready — heartbeat on ${heartbeat.transport}, seed ${seed}`);
    return api;
  },

  /**
   * Draining belongs on the frame hook, not the tick hook: the budget it honours is a
   * per-frame millisecond budget, and `tick` can run up to eight times per frame.
   */
  frame(dt, alpha, ctx) {
    ctx.get('idle')._frame?.();
  },

  dispose() { live?.dispose?.(); },

  async showcase(mode, ctx) {
    const { showcaseIdle } = await import('./showcase.js');
    return showcaseIdle(mode, ctx);
  },
};

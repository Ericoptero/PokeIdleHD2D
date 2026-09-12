/**
 * drain.js — turning a pile of owed seconds into gains without freezing the page.
 *
 * When the player comes back after three hours, the module owes them 10 800 seconds of
 * production. Applying that as one call would be fine arithmetically but would also mean
 * resolving thousands of encounters inside a single frame; do it on a slower machine, or
 * after twelve hours, and the tab visibly locks up. So the debt is drained in slices,
 * bounded twice over: by a step count and by a wall-clock millisecond budget per call. The
 * gap disappears over a handful of frames instead of one long stall, and the frame loop
 * keeps hitting 60 fps while it happens.
 *
 * Slicing is only safe because `accrual.simulate` is additive (see its header): the sum of
 * the slices equals the single call, exactly for every discrete event and to within
 * floating-point summation error for the continuous currencies. Two consequences worth
 * stating plainly:
 *
 *   - The state is snapshotted ONCE when a gap opens, and every slice of that gap uses it.
 *     A gap is a replay of time that has already passed; the party that earned it is the
 *     party that existed then, which is also exactly what `offline` does with one call.
 *   - Step size adapts. Anything under `MIN_STEP_S * maxSteps` (about eight minutes at the
 *     default ceiling) runs in the fixed 1-second steps src/idle/index.js asks for. Beyond
 *     that, 1-second steps would mean 43 200 calls for a twelve-hour gap, so slices widen
 *     just enough to fit the step ceiling — which changes nothing, because the model is
 *     additive. Each trace entry records the slice width actually used.
 */

import { simulate } from './accrual.js';

/** The step size src/idle/index.js specifies, and the one used whenever the backlog is small. */
export const MIN_STEP_S = 1;
/** Widest slice a big backlog may use. Wide enough to drain 12 h in a few frames. */
export const MAX_STEP_S = 300;
/** Below this, a backlog is just normal frame-to-frame accrual, not a catch-up. */
export const CATCHUP_S = 5;
/** How many drain slices to remember for the debug panel. */
const TRACE_CAPACITY = 48;

export function emptyGains() {
  return {
    elapsedS: 0, money: 0, exp: 0, research: 0,
    passive: { money: 0, exp: 0, research: 0 },
    battle: { money: 0, exp: 0, research: 0 },
    encounters: 0, wholeEncounters: 0, wins: 0, catches: 0, shinies: 0, ballsUsed: 0,
    items: {}, events: [], truncated: false, perSecond: null, biome: null,
  };
}

export function mergeGains(acc, g) {
  acc.elapsedS += g.elapsedS;
  acc.money += g.money;
  acc.exp += g.exp;
  acc.research += g.research;
  acc.passive.money += g.passive.money;
  acc.passive.exp += g.passive.exp;
  acc.passive.research += g.passive.research;
  acc.battle.money += g.battle.money;
  acc.battle.exp += g.battle.exp;
  acc.battle.research += g.battle.research;
  acc.encounters += g.encounters;
  acc.wholeEncounters += g.wholeEncounters;
  acc.wins += g.wins;
  acc.catches += g.catches;
  acc.shinies += g.shinies;
  acc.ballsUsed += g.ballsUsed ?? 0;
  acc.truncated = acc.truncated || g.truncated;
  acc.perSecond = g.perSecond;
  acc.biome = g.biome;
  for (const k in g.items) acc.items[k] = (acc.items[k] ?? 0) + g.items[k];
  for (const e of g.events) if (acc.events.length < 64 || e.shiny) acc.events.push(e);
  return acc;
}

/**
 * @param {Object} opts
 * @param {number} opts.seed
 * @param {() => Object} opts.snapshotState  called once per gap; must return a stable object
 * @param {() => number} [opts.now]  monotonic, for budgets and timings — never a wall clock
 */
export function makeDrain({ seed, snapshotState, now = () => performance.now() }) {
  /** Seconds owed but not yet assigned to a gap. */
  let queued = 0;
  /** The gap currently being drained, if any. */
  let gap = null;
  const traceRing = [];
  /** The last gap's opening snapshot, kept so a caller can reproduce it in one call. */
  let lastGap = null;
  /** The same, but only for catch-ups — the ones anyone actually wants to reproduce. */
  let lastCatchupGap = null;
  const stats = { gaps: 0, catchups: 0, steps: 0, ms: 0, secondsDrained: 0, maxGapS: 0, longestCallMs: 0 };

  function pushTrace(entry) {
    traceRing.push(entry);
    if (traceRing.length > TRACE_CAPACITY) traceRing.shift();
  }

  function openGap() {
    const totalS = queued;
    queued = 0;
    // One clone per gap, then `progress` is advanced in place. Keeping the object's
    // identity stable across the slices is what lets accrual.js reuse its production
    // breakdown instead of recomputing it for every one of ten thousand steps.
    const source = snapshotState();
    const state = { ...source, progress: { ...(source.progress ?? { encounters: 0, seconds: 0 }) } };
    gap = {
      state,
      totalS,
      remainingS: totalS,
      startedMs: now(),
      steps: 0,
      ms: 0,
      calls: 0,
      catchup: totalS >= CATCHUP_S,
      worstCallMs: 0,
      worstStepMs: 0,
    };
    // Recorded with the progress it *started* from (the live one is advanced in place), so
    // `simulate(lastGap.state, lastGap.totalS, seed)` reproduces the gap exactly. That is
    // the comparison the showcase prints and the one `offline` would perform.
    lastGap = { state: { ...state, progress: { ...state.progress } }, totalS, at: now() };
    stats.gaps++;
    if (gap.catchup) { stats.catchups++; lastCatchupGap = lastGap; }
    if (totalS > stats.maxGapS) stats.maxGapS = totalS;
    return gap;
  }

  return {
    /** Owe the player `seconds` more. Reasons are kept for the debug panel only. */
    queue(seconds, reason = 'tick') {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      queued += seconds;
      if (gap) gap.lastReason = reason;
      else this.lastReason = reason;
    },

    /** Seconds still owed, whether or not a gap is open. */
    pending: () => queued + (gap ? gap.remainingS : 0),

    /** The gap in flight, for progress bars and toasts. */
    progress: () => (gap ? {
      active: true,
      catchup: gap.catchup,
      totalS: gap.totalS,
      remainingS: gap.remainingS,
      done: gap.totalS > 0 ? 1 - gap.remainingS / gap.totalS : 1,
      steps: gap.steps,
      ms: gap.ms,
      calls: gap.calls,
    } : { active: false, catchup: false, totalS: 0, remainingS: 0, done: 1, steps: 0, ms: 0, calls: 0 }),

    /**
     * Drains what it can inside the budget.
     *
     * @param {Object} [opts]
     * @param {number} [opts.budgetMs]  wall-clock ceiling for this call
     * @param {number} [opts.maxSteps]  ceiling on `simulate` calls
     * @param {number} [opts.maxS]      ceiling on simulated seconds (the src/idle/index.js `flush(cap)`)
     * @returns {{appliedS:number, steps:number, ms:number, worstStepMs:number,
     *            gains:Object|null, remainingS:number, finished:boolean, catchup:boolean}}
     */
    run({ budgetMs = 4, maxSteps = 512, maxS = Infinity } = {}) {
      if (!gap && queued <= 0) {
        return { appliedS: 0, steps: 0, ms: 0, worstStepMs: 0, gains: null, remainingS: 0, finished: true, catchup: false };
      }
      if (!gap) openGap();

      const t0 = now();
      const gains = emptyGains();
      let steps = 0;
      let appliedS = 0;
      // The slowest individual step, from the clock read the budget check makes anyway.
      // It separates "the budget logic let a call run long" from "V8 paused us mid-call",
      // which is the difference between a bug and a garbage collection.
      let last = t0;
      let worstStepMs = 0;

      while (gap.remainingS > 1e-9 && steps < maxSteps && appliedS < maxS) {
        // Small backlogs use the 1-second steps the architecture asks for. A large one
        // widens its slices so the whole gap fits in a bounded number of steps — safe
        // because the model is additive, and necessary because 12 h of 1-second steps is
        // 43 200 calls.
        const wide = Math.min(MAX_STEP_S, Math.max(MIN_STEP_S, gap.remainingS / maxSteps));
        const stepS = Math.min(
          gap.remainingS <= MIN_STEP_S ? gap.remainingS : Math.max(MIN_STEP_S, wide),
          gap.remainingS,
          maxS - appliedS,
        );
        if (stepS <= 0) break;

        const g = simulate(gap.state, stepS, seed);
        // The gap's own cumulative progress carries between slices; nothing else does,
        // and it is written in place so the state object stays identical throughout.
        gap.state.progress.encounters = g.progress.encounters;
        gap.state.progress.seconds = g.progress.seconds;
        mergeGains(gains, g);
        gap.remainingS -= stepS;
        appliedS += stepS;
        steps++;

        // The budget is checked after every step, not every sixteenth. A wide slice can
        // resolve dozens of encounters, so a coarser check overshot the frame budget by
        // an order of magnitude on a twelve-hour gap — measured, not guessed.
        const t = now();
        if (t - last > worstStepMs) worstStepMs = t - last;
        last = t;
        if (t - t0 >= budgetMs) break;
      }

      const ms = now() - t0;
      gap.steps += steps;
      gap.ms += ms;
      gap.calls++;
      if (ms > gap.worstCallMs) gap.worstCallMs = ms;
      if (worstStepMs > gap.worstStepMs) gap.worstStepMs = worstStepMs;
      stats.steps += steps;
      stats.ms += ms;
      stats.secondsDrained += appliedS;
      if (ms > stats.longestCallMs) stats.longestCallMs = ms;

      const finished = gap.remainingS <= 1e-9;
      const wasCatchup = gap.catchup;
      const totalS = gap.totalS;

      if (wasCatchup) {
        pushTrace({
          atMs: now(), appliedS: +appliedS.toFixed(3), steps, ms: +ms.toFixed(2),
          worstStepMs: +worstStepMs.toFixed(2),
          remainingS: +gap.remainingS.toFixed(2), stepS: steps ? +(appliedS / steps).toFixed(2) : 0,
          finished,
        });
      }

      if (finished) {
        gains.gapTotalS = totalS;
        gains.gapSteps = gap.steps;
        gains.gapMs = +gap.ms.toFixed(2);
        gains.gapCalls = gap.calls;
        gains.gapWorstMs = +gap.worstCallMs.toFixed(2);
        gains.gapWorstStepMs = +gap.worstStepMs.toFixed(2);
        gap = null;
      }

      return {
        appliedS, steps, ms, worstStepMs, gains: appliedS > 0 ? gains : null,
        remainingS: this.pending(), finished, catchup: wasCatchup,
      };
    },

    trace: () => traceRing.slice(),
    /** The opening snapshot of the most recent gap: `{ state, totalS, at }` or null. */
    lastGap: () => lastGap,
    /** The same for the most recent *catch-up* gap, whichever pass happened to drain it. */
    lastCatchupGap: () => lastCatchupGap,
    stats: () => ({ ...stats, queued, pending: queued + (gap ? gap.remainingS : 0) }),
    /** Drops everything owed. Used only when a save is restored over the top. */
    reset() { queued = 0; gap = null; lastGap = null; lastCatchupGap = null; traceRing.length = 0; },
  };
}

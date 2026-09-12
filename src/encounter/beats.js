/**
 * beats.js — when each strike of a turn gets its moment.
 *
 * `battle/engine.js`'s `turn()` already decides who acts first (priority, then speed, then a
 * coin — its own header calls the draw order a contract) and already returns both sides'
 * events in that order. What this file adds is purely a *timeline*: one beat per strike,
 * strictly after the one before it, so `encounter` can drain a turn's strikes one at a time
 * instead of emitting all of them in the same tick.
 *
 * Pure — a function of the strikes and the beat lengths, nothing else. `selftest.js` pins it
 * without a browser.
 */

/**
 * @param {import('../battle/strike.js').Strike[]} strikes  in the order `battle.strikesOf`
 *   already returns them — this file does not reorder them, only times them.
 * @param {{actionSteps:number, itemSteps:number, reviveSteps:number}} beats
 * @returns {{strike: object, at: number}[]} `at` is an offset from the moment the turn's
 *   playback starts, strictly increasing, one entry per strike, in the same order they arrived.
 */
export function planBeats(strikes, beats) {
  const { actionSteps, itemSteps, reviveSteps } = beats;
  let at = 0;
  const plan = [];
  for (const strike of strikes ?? []) {
    plan.push({ strike, at });
    const span = strike?.cause === 'item'
      ? (strike.use === 'revive' ? reviveSteps : itemSteps)
      : actionSteps;
    at += Math.max(1, Math.round(span));
  }
  return plan;
}

/** The total span a plan occupies — the step its last beat's own duration finishes on. */
export function planSpan(plan, lastBeat) {
  if (!plan.length) return 0;
  return plan[plan.length - 1].at + Math.max(1, Math.round(lastBeat));
}

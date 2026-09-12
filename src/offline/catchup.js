/**
 * Closed-tab catch-up (src/offline/index.js). Pure: no DOM, no module lookups, no clock of
 * its own — every input is an argument, so the whole thing is testable from node and the
 * same inputs always produce the same payload.
 *
 * The shape of the deal:
 *   1. `awayS` is wall time between the save's `lastSeenMs` and now. It is *not* trusted:
 *      a clock can move backwards, a save can carry a nonsense anchor.
 *   2. It is clamped to `config.offlineCapS` (12 h by default).
 *   3. The clamped time is discounted by an efficiency curve — full rate for a grace
 *      period, then a half-life decay down to a floor — and integrated exactly, so
 *      `effectiveS` is a real number of "active-equivalent" seconds.
 *   4. `idle.simulate(state, effectiveS, seed)` is called **once**, verbatim. There is
 *      exactly one implementation of what a second produces and offline does not own a
 *      second one; discounting happens in the time axis, never in the rewards.
 */

/** Sub-second clock wobble (NTP nudges, DST) that is not worth telling anyone about. */
const CLOCK_JITTER_MS = 2000;

export const CURVE_DEFAULTS = {
  /** Seconds of catch-up granted at the full active rate before the decay starts. */
  graceS: 1800,
  /** Time for the surplus above the floor to halve. */
  halfLifeS: 3600,
  /** The rate the curve decays towards, as a fraction of the active rate. */
  floor: 0.55,
  /** Below this much time away, there is nothing worth showing the player. */
  minS: 60,
  /** An anchor further back than this is a broken save, not a long holiday. */
  maxPlausibleS: 10 * 365 * 24 * 3600,
};

const LN2 = Math.LN2;

/** Efficiency at `t` seconds into the absence, in [floor, 1]. */
export function efficiencyAt(t, { graceS, halfLifeS, floor } = CURVE_DEFAULTS) {
  if (t <= graceS) return 1;
  if (halfLifeS <= 0) return floor;
  return floor + (1 - floor) * Math.pow(2, -(t - graceS) / halfLifeS);
}

/**
 * ∫₀ᵀ efficiency(t) dt, in closed form. Exact rather than sampled, so the number does not
 * depend on a step size and two builds can never disagree about what an absence was worth.
 */
export function effectiveSeconds(T, curve = CURVE_DEFAULTS) {
  const { graceS, halfLifeS, floor } = curve;
  if (!(T > 0)) return 0;
  if (T <= graceS) return T;
  const d = T - graceS;
  if (halfLifeS <= 0) return graceS + floor * d;
  const decayed = ((1 - floor) * halfLifeS / LN2) * (1 - Math.pow(2, -d / halfLifeS));
  return graceS + floor * d + decayed;
}

/** Formats a duration the way a summary card should read: two units, largest first. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} m` : `${h} h`;
  return `${m} m`;
}

/**
 * Splits the absence into bands the summary can draw as a bar: one grace band at full
 * rate, then one band per half-life, then whatever is left as a tail. Each band's
 * `effectiveS` comes from the exact integral, so the bands sum to `effectiveSeconds(T)`.
 */
export function bandsFor(T, curve = CURVE_DEFAULTS, maxBands = 4) {
  if (!(T > 0)) return [];
  const { graceS, halfLifeS } = curve;
  const edges = [0];
  if (graceS > 0 && graceS < T) edges.push(graceS);
  let e = Math.max(graceS, 0);
  for (let i = 0; i < maxBands && e + halfLifeS < T && halfLifeS > 0; i++) {
    e += halfLifeS;
    edges.push(e);
  }
  edges.push(T);

  const bands = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i], to = edges[i + 1];
    if (to - from <= 1e-6) continue;
    const eff = effectiveSeconds(to, curve) - effectiveSeconds(from, curve);
    bands.push({
      fromS: from, toS: to, seconds: to - from,
      effectiveS: eff,
      avgEfficiency: eff / (to - from),
      label: formatDuration(to - from),
    });
  }
  return bands;
}

/**
 * The whole catch-up decision, as one pure function.
 *
 * @param {object} a
 * @param {number} a.nowMs
 * @param {number|null|undefined} a.lastSeenMs   anchor from the save
 * @param {number} a.capS                        config.offlineCapS
 * @param {object} [a.curve]                     CURVE_DEFAULTS, overridden from config
 * @param {boolean} [a.firstLaunch]
 * @param {object} a.state                       the state idle.simulate wants
 * @param {number} a.seed
 * @param {(state:object, elapsedS:number, seed:number) => object} a.simulate
 * @returns {object} the decision plus, when it paid out, the raw gains.
 */
export function computeCatchUp({
  nowMs, lastSeenMs, capS, curve = CURVE_DEFAULTS, firstLaunch = false,
  state = {}, seed = 0, simulate,
}) {
  const c = { ...CURVE_DEFAULTS, ...curve };
  const base = {
    reason: 'ok', ok: false,
    nowMs, lastSeenMs: lastSeenMs ?? null,
    rawAwayS: 0, awayS: 0, clockSkewS: 0,
    capS, capped: false, cappedS: 0,
    effectiveS: 0, efficiencyAvg: 0, bands: [],
    gains: null, repairAnchor: false, curve: c,
  };

  if (firstLaunch || !Number.isFinite(lastSeenMs)) {
    // Nothing accrued before the first launch, and a save with no usable anchor is the
    // same situation from the player's side.
    return { ...base, reason: firstLaunch ? 'first-launch' : 'no-anchor', repairAnchor: !firstLaunch };
  }

  const deltaMs = nowMs - lastSeenMs;

  if (deltaMs < -CLOCK_JITTER_MS) {
    // The wall clock moved backwards — a manual change, a VM restore, a big NTP step. The
    // anchor is in the future, so every future session would compute a negative absence
    // and silently never pay out again; it is moved to now and nothing is granted for a
    // gap we cannot account for.
    return { ...base, reason: 'clock-rewound', clockSkewS: -deltaMs / 1000, repairAnchor: true };
  }
  if (deltaMs < 0) {
    return { ...base, reason: 'too-short', clockSkewS: -deltaMs / 1000, repairAnchor: true };
  }

  const rawAwayS = deltaMs / 1000;
  if (rawAwayS > c.maxPlausibleS) {
    // An anchor at the epoch, or a clock that jumped forward a decade. Treated as a broken
    // anchor rather than as the longest holiday in history.
    return { ...base, reason: 'implausible', rawAwayS, repairAnchor: true };
  }
  if (rawAwayS < c.minS) {
    return { ...base, reason: 'too-short', rawAwayS, awayS: rawAwayS };
  }

  const cappedS = Math.min(rawAwayS, capS);
  const effectiveS = effectiveSeconds(cappedS, c);
  const gains = simulate(state, effectiveS, seed);

  return {
    ...base,
    ok: true,
    reason: 'ok',
    rawAwayS,
    awayS: rawAwayS,
    capped: rawAwayS > capS,
    cappedS,
    effectiveS,
    efficiencyAvg: cappedS > 0 ? effectiveS / cappedS : 0,
    bands: bandsFor(cappedS, c),
    gains,
  };
}

/**
 * The payload the `ui` module renders as the "while you were away" modal. Deliberately
 * plain and structured-cloneable, and deliberately explicit about the difference between
 * what was *computed* and what was actually *granted* — a summary that claims experience
 * was awarded when no module accepted it would be a lie told by the game.
 */
export function makeSummary(decision, { applied = {}, pending = {}, notes = [], save = {} } = {}) {
  const g = decision.gains ?? {};
  return {
    payload: 1,
    reason: decision.reason,
    from: decision.lastSeenMs,
    to: decision.nowMs,
    awayS: decision.awayS,
    awayText: formatDuration(decision.awayS),
    capped: decision.capped,
    capS: decision.capS,
    capText: formatDuration(decision.capS),
    creditedS: decision.cappedS,
    creditedText: formatDuration(decision.cappedS),
    effectiveS: decision.effectiveS,
    effectiveText: formatDuration(decision.effectiveS),
    efficiency: decision.efficiencyAvg,
    bands: decision.bands.map((b) => ({ ...b })),
    gains: {
      money: g.money ?? 0,
      exp: g.exp ?? 0,
      encounters: g.encounters ?? 0,
      wholeEncounters: g.wholeEncounters ?? 0,
    },
    applied: { ...applied },
    pending: { ...pending },
    notes: [...notes],
    save: { ...save },
  };
}

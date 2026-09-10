/**
 * The turn engine.
 *
 * Pure in the strong sense `src/encounter/rolls.js` established (DECISIONS #35(a)): no `ctx`,
 * no clock, no module lookups, no `Math.random`. A turn is a function of
 * `(state, seed, encounterIndex, turnNo)` and nothing else, which is what lets the visible
 * fight step one turn per few sim ticks while `offline` runs the identical code in a loop
 * (ARCHITECTURE §5.17).
 *
 * ## The draw order is a contract
 *
 * Written out here because it is the thing that must never move (DECISIONS #61(g)):
 *
 *   1. speed-tie coin
 *   2. per acting side, in speed order:
 *        paralysis skip -> confusion self-hit -> accuracy -> crit -> damage band
 *        -> multi-hit count -> secondary chance -> flinch
 *   3. end of turn: burn/poison tick -> sleep counter -> freeze thaw -> confusion counter
 *
 * **New draws go on the END.** And every draw above is taken **unconditionally**, with the
 * value discarded when it does not apply — a draw that only happens under a condition makes
 * the stream position depend on state, and then the same seed replays differently depending on
 * what happened three turns ago. `rolls.rollAt` already works this way (it draws all six IVs
 * whether the caller looks at them or not); this is the same rule at turn scale.
 */

import { makeRng } from '../core/rng.js';
import { effectiveness, STAB } from './types.js';
import { statsOf, stageMultiplier, STAT_KEYS } from './stats.js';
import { PHYSICAL, SPECIAL, STATUS, resolveMove, movesFor, choose, STRUGGLE_ID } from './moves.js';

/** `ctx.rng` is `makeRng(seed,'root')` and `fork` appends, so this is `ctx.rng.fork('battle')`. */
export const STREAM_ROOT = 'root/battle';

/** One turn's own stream. See the header: addressed, never continued. */
export const streamFor = (seed, index, turn) => makeRng(seed, `${STREAM_ROOT}/${index}/${turn}`);

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/** The ceiling on how many actions one `between` call may land before a turn. */
export const MAX_BETWEEN = 4;

/** Statuses that stop a Pokemon acting, and the ones that only cost it HP. */
const MAJOR = new Set(['brn', 'par', 'psn', 'tox', 'slp', 'frz']);

/**
 * A combatant: everything the engine needs and nothing it does not.
 *
 * Deliberately **not** a `pokemon` instance (§5.17). It is a plain structured-cloneable record,
 * so `offline` can carry a party through a fold and a selftest can build one by hand.
 */
export function makeCombatant({
  species, level = 5, ivs = {}, shiny = false, moves, hp, status = null, instanceId = null,
  priority = [],
} = {}) {
  const name = typeof species === 'string' ? species : species?.name;
  const base = typeof species === 'object' ? species.baseStats : null;
  const types = (typeof species === 'object' ? species.types : null) ?? ['normal'];
  const stats = statsOf(base ?? { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe: 50 }, ivs, level);
  return {
    instanceId, species: name, display: (typeof species === 'object' && species.display) || name,
    level, shiny, types: types.map((t) => String(t).toLowerCase()),
    stats, maxHp: stats.hp, hp: hp ?? stats.hp,
    moves: moves ?? movesFor(name, level, { priority }),
    status,
    // Counters live beside the status rather than inside it, so a save can carry both.
    sleepTurns: 0, toxicTurns: 0,
    volatile: { confusion: 0, flinch: false },
    stages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  };
}

/** A deep-enough copy: the engine never mutates its input, so a caller can keep the old state. */
const cloneSide = (c) => ({
  ...c,
  types: [...c.types], stats: { ...c.stats },
  moves: c.moves.map((m) => ({ ...m })),
  volatile: { ...c.volatile }, stages: { ...c.stages },
});

/** The opening state of a fight. `a` acts for the player; `b` is the wild. */
export function begin(a, b) {
  return { a: cloneSide(a), b: cloneSide(b), turn: 0, over: false, winner: null };
}

/** A stat as it stands after stages. HP is never staged. */
const stat = (c, k) => Math.max(1, Math.floor(c.stats[k] * stageMultiplier(c.stages[k] ?? 0)));

/**
 * The mainline damage formula (Gen 5+), with the terms this game has no source for removed.
 *
 *   base   = floor(floor(floor(2·L/5 + 2) · power · A/D) / 50) + 2
 *   damage = floor(base · crit · random · stab · type · burn)
 *
 * `random` is the caller's 0.85..1.00 band, passed in rather than rolled here so the draw
 * order stays visible in one place.
 */
export function damageOf(atk, def, m, { crit = 1, band = 1, burn = 1 } = {}) {
  const phys = m.c === PHYSICAL;
  const A = phys ? stat(atk, 'atk') : stat(atk, 'spa');
  const D = phys ? stat(def, 'def') : stat(def, 'spd');
  const type = effectiveness(m.t, def.types);
  if (type === 0) return { damage: 0, type };
  const stab = atk.types.includes(m.t) ? STAB : 1;
  const base = Math.floor(Math.floor(Math.floor((2 * atk.level) / 5 + 2) * m.p * (A / Math.max(1, D))) / 50) + 2;
  const damage = Math.max(1, Math.floor(base * crit * band * stab * type * burn));
  return { damage, type, stab: stab > 1, crit: crit > 1 };
}

/** Crit chance by ratio, Gen 6 table. Only ratios 1 and 2 are reachable from our move data. */
const critChance = (ratio) => (ratio >= 3 ? 0.5 : ratio === 2 ? 0.125 : 1 / 24);

/** Applies a stat-stage change, clamped, and says whether anything actually moved. */
function boost(target, boosts) {
  const moved = [];
  for (const [k, v] of Object.entries(boosts ?? {})) {
    if (!STAT_KEYS.includes(k)) continue;          // accuracy/evasion are not modelled
    const before = target.stages[k] ?? 0;
    const after = clamp(before + v, -6, 6);
    if (after !== before) { target.stages[k] = after; moved.push({ stat: k, by: after - before }); }
  }
  return moved;
}

/**
 * One side's action. Every roll it might need is drawn first, in the contractual order, and
 * the unused ones are thrown away — see the header for why that is not waste.
 */
function act(state, attacker, defender, slot, rng, events) {
  const atk = state[attacker];
  const def = state[defender];

  // --- the unconditional draws, in order -----------------------------------
  const rParalysis = rng.next();
  const rConfusion = rng.next();
  const rAccuracy = rng.next();
  const rCrit = rng.next();
  const rBand = rng.next();
  const rMulti = rng.next();
  const rSecondary = rng.next();
  const rFlinch = rng.next();

  const say = (kind, extra) => events.push({ turn: state.turn, actor: attacker, kind, ...extra });

  if (atk.volatile.flinch) {
    atk.volatile.flinch = false;
    say('flinch', { species: atk.species });
    return;
  }
  if (atk.status === 'frz') { say('frozen', { species: atk.species }); return; }
  if (atk.status === 'slp' && atk.sleepTurns > 0) { say('asleep', { species: atk.species }); return; }
  if (atk.status === 'par' && rParalysis < 0.25) { say('paralysed', { species: atk.species }); return; }

  if (atk.volatile.confusion > 0 && rConfusion < 1 / 3) {
    // A confusion hit is a 40-power typeless physical move against the user's own defence.
    const self = damageOf(atk, atk, { c: PHYSICAL, p: 40, t: '__typeless' }, { band: 0.85 + rBand * 0.15 });
    atk.hp = Math.max(0, atk.hp - self.damage);
    say('confused-hit', { species: atk.species, damage: self.damage, hp: atk.hp });
    return;
  }

  const m = resolveMove(slot.id);
  if (!m) return;
  if (slot.pp > 0) slot.pp--;
  say('move', { species: atk.species, move: slot.id, name: m.n, struggle: slot.id === STRUGGLE_ID });

  // Accuracy 0 means "cannot miss" (the build script's spelling of Showdown's `true`).
  if (m.a !== 0 && rAccuracy * 100 >= m.a) { say('miss', { species: def.species }); return; }

  if (m.c === STATUS) {
    const target = m.sb === 'self' ? atk : def;
    if (m.bo) {
      const moved = boost(target, m.bo);
      if (moved.length) say('boost', { species: target.species, target: m.sb ?? 'foe', moved });
    }
    if (m.st && !def.status) {
      def.status = m.st;
      if (m.st === 'slp') def.sleepTurns = 1 + Math.floor(rSecondary * 3);
      say('status', { species: def.species, status: m.st });
    }
    if (m.sv === 'confusion' && def.volatile.confusion <= 0) {
      def.volatile.confusion = 2 + Math.floor(rSecondary * 3);
      say('confused', { species: def.species });
    }
    return;
  }

  const crit = rCrit < critChance(m.hc ?? 1) ? 1.5 : 1;
  const band = 0.85 + rBand * 0.15;
  const burn = atk.status === 'brn' && m.c === PHYSICAL ? 0.5 : 1;
  const hits = m.mh ? m.mh[0] + Math.floor(rMulti * (m.mh[1] - m.mh[0] + 1)) : 1;

  let total = 0;
  let type = 1;
  for (let i = 0; i < hits && def.hp > 0; i++) {
    const hit = damageOf(atk, def, m, { crit, band, burn });
    type = hit.type;
    if (type === 0) break;
    def.hp = Math.max(0, def.hp - hit.damage);
    total += hit.damage;
  }
  if (type === 0) { say('immune', { species: def.species }); return; }
  say('damage', {
    species: def.species, move: slot.id, damage: total, hits,
    effectiveness: type, crit: crit > 1, hp: def.hp, maxHp: def.maxHp,
  });

  if (m.dr && total > 0) {
    const healed = Math.max(1, Math.floor((total * m.dr[0]) / m.dr[1]));
    atk.hp = Math.min(atk.maxHp, atk.hp + healed);
    say('drain', { species: atk.species, healed, hp: atk.hp });
  }
  if (m.rc && total > 0) {
    const hurt = Math.max(1, Math.floor((total * m.rc[0]) / m.rc[1]));
    atk.hp = Math.max(0, atk.hp - hurt);
    say('recoil', { species: atk.species, damage: hurt, hp: atk.hp });
  }

  // A secondary only fires on a target still standing — a fainted Pokemon cannot be burned.
  if (m.ss && def.hp > 0 && rSecondary * 100 < m.ss.c) {
    if (m.ss.st && !def.status && !isImmuneToStatus(def, m.ss.st)) {
      def.status = m.ss.st;
      if (m.ss.st === 'slp') def.sleepTurns = 1 + Math.floor(rFlinch * 3);
      say('status', { species: def.species, status: m.ss.st });
    }
    if (m.ss.sv === 'confusion' && def.volatile.confusion <= 0) {
      def.volatile.confusion = 2 + Math.floor(rFlinch * 3);
      say('confused', { species: def.species });
    }
    if (m.ss.sv === 'flinch') def.volatile.flinch = true;
    if (m.ss.bo) {
      const target = m.ss.sb === 'self' ? atk : def;
      const moved = boost(target, m.ss.bo);
      if (moved.length) say('boost', { species: target.species, target: m.ss.sb ?? 'foe', moved });
    }
  }
}

/**
 * Type immunities to status. Only the ones the games make load-bearing — a Fire-type that
 * could be burned, or a Steel-type that could be poisoned, reads as a bug to anybody who has
 * played a Pokemon game.
 */
function isImmuneToStatus(c, status) {
  if (status === 'brn') return c.types.includes('fire');
  if (status === 'frz') return c.types.includes('ice');
  if (status === 'psn' || status === 'tox') return c.types.includes('poison') || c.types.includes('steel');
  if (status === 'par') return c.types.includes('electric');
  return false;
}

/** Residual damage and counters. Runs for both sides, attacker first, always in that order. */
function endOfTurn(state, order, rng, events) {
  const rBurn = rng.next();
  const rSleep = rng.next();
  const rThaw = rng.next();
  const rConfusion = rng.next();

  for (const side of order) {
    const c = state[side];
    if (c.hp <= 0) continue;
    const say = (kind, extra) => events.push({ turn: state.turn, actor: side, kind, ...extra });

    if (c.status === 'brn' || c.status === 'psn') {
      const tick = Math.max(1, Math.floor(c.maxHp / 16));
      c.hp = Math.max(0, c.hp - tick);
      say('residual', { species: c.species, status: c.status, damage: tick, hp: c.hp });
    } else if (c.status === 'tox') {
      c.toxicTurns = Math.min(15, (c.toxicTurns || 0) + 1);
      const tick = Math.max(1, Math.floor((c.maxHp * c.toxicTurns) / 16));
      c.hp = Math.max(0, c.hp - tick);
      say('residual', { species: c.species, status: 'tox', damage: tick, hp: c.hp });
    }

    if (c.status === 'slp') {
      c.sleepTurns = Math.max(0, c.sleepTurns - 1);
      if (c.sleepTurns === 0) { c.status = null; say('woke', { species: c.species }); }
    }
    // A thaw is a coin the games flip at 20% a turn; drawn once above and shared, because two
    // frozen Pokemon in one turn is not a case this engine can produce.
    if (c.status === 'frz' && rThaw < 0.2) { c.status = null; say('thawed', { species: c.species }); }
    if (c.volatile.confusion > 0) {
      c.volatile.confusion--;
      if (c.volatile.confusion === 0) say('unconfused', { species: c.species });
    }
    // rBurn / rSleep / rConfusion are drawn to hold the position and deliberately unused here;
    // see the header. They are where a future residual effect goes.
    void rBurn; void rSleep; void rConfusion;
  }
}

/**
 * One turn. Returns a NEW state plus the events that happened, so a caller can render them and
 * keep the previous state to interpolate from.
 *
 * @param {object} state  from `begin()`
 * @param {number} seed   `config.seed`
 * @param {number} index  the global encounter index
 */
export function turn(state, seed, index) {
  if (state.over) return { state, events: [] };
  const next = { ...state, a: cloneSide(state.a), b: cloneSide(state.b), turn: state.turn + 1 };
  const rng = streamFor(seed, index, next.turn);
  const events = [];

  const slotA = choose(next.a, next.b);
  const slotB = choose(next.b, next.a);
  const mA = resolveMove(slotA.id);
  const mB = resolveMove(slotB.id);

  // Priority first, then speed, then a coin. The coin is drawn ALWAYS, before anything else in
  // the turn, so its position never depends on whether the speeds happened to tie.
  const rTie = rng.next();
  const prA = mA?.pr ?? 0;
  const prB = mB?.pr ?? 0;
  const spA = stat(next.a, 'spe') * (next.a.status === 'par' ? 0.5 : 1);
  const spB = stat(next.b, 'spe') * (next.b.status === 'par' ? 0.5 : 1);
  const aFirst = prA !== prB ? prA > prB : (spA !== spB ? spA > spB : rTie < 0.5);
  const order = aFirst ? ['a', 'b'] : ['b', 'a'];

  for (const side of order) {
    if (next.over) break;
    if (next.a.hp <= 0 || next.b.hp <= 0) break;
    act(next, side, side === 'a' ? 'b' : 'a', side === 'a' ? slotA : slotB, rng, events);
    if (next.a.hp <= 0 || next.b.hp <= 0) break;
  }

  if (next.a.hp > 0 && next.b.hp > 0) endOfTurn(next, order, rng, events);

  if (next.a.hp <= 0 || next.b.hp <= 0) {
    next.over = true;
    // Both down in one turn (recoil into a KO) is a loss: the wild is not caught and the lead
    // still fainted, which is the reading that cannot reward a mistake.
    next.winner = next.a.hp > 0 ? 'a' : 'b';
    // `actor` is the side that FELL, and it is not decoration: the meadow table can produce a
    // Caterpie against a Caterpie, and `species` alone cannot say which one went down. Purely
    // additive — no existing assertion reads it, and no draw moved (DECISIONS #72).
    const fell = next.winner === 'a' ? 'b' : 'a';
    events.push({ turn: next.turn, kind: 'faint', actor: fell, species: next[fell].species });
  }
  return { state: next, events };
}

/**
 * What `between` may ask for before a turn, and the only way anything outside this file
 * changes a combatant mid-fight.
 *
 * **No Action draws a random number.** An item's effect is arithmetic, so inserting one
 * between two turns cannot move the position of `root/battle/<index>/<turn>` — which is what
 * lets a potion drunk in a watched fight be drunk in the same place by a closed-tab replay
 * (DECISIONS #72).
 *
 * @typedef {Object} Action
 * @property {'heal'|'revive'|'pp'} kind
 * @property {string} item                 the item id the CALLER debits; this file never sees a bag
 * @property {number|'full'} [hp]          heal: how much
 * @property {boolean} [status]            heal: also clear the major status
 * @property {number} [fraction]           revive: 0.5 or 1 of maximum
 * @property {string} [moveId]             pp: which slot
 * @property {number|'full'} [amount]      pp: how much
 * @property {'a'|'b'} [side]              defaults to 'a' — the party's side
 */

/**
 * Applies one `Action` in place and answers the transcript event it produced, or `null` if it
 * did nothing.
 *
 * Two refusals are rules rather than tidiness. **A heal never raises a fainted Pokemon** — the
 * mainline is emphatic about it and `pokemon/instance.js heal()` was happy to do it, so a
 * Potion in an auto-heal list would quietly have been a free Revive. And **a revive only works
 * on a fainted one**, so the list cannot burn its scarcest item on a scratch.
 */
export function applyAction(state, act) {
  if (!act || typeof act !== 'object') return null;
  const side = act.side === 'b' ? 'b' : 'a';
  const c = state[side];
  if (!c) return null;
  const say = (kind, extra) => ({ turn: state.turn, actor: side, kind, item: act.item ?? null, species: c.species, ...extra });

  if (act.kind === 'heal') {
    if (c.hp <= 0) return null;                       // a potion is not a revive
    const before = c.hp;
    c.hp = act.hp === 'full' ? c.maxHp : Math.min(c.maxHp, c.hp + Math.max(0, Math.floor(act.hp || 0)));
    const cleared = !!act.status && !!c.status;
    if (act.status) { c.status = null; c.sleepTurns = 0; c.toxicTurns = 0; }
    if (c.hp === before && !cleared) return null;
    return say('item', { use: 'heal', healed: c.hp - before, hp: c.hp, maxHp: c.maxHp, cured: cleared });
  }

  if (act.kind === 'revive') {
    if (c.hp > 0) return null;                        // only a fainted one
    const frac = Number.isFinite(act.fraction) ? clamp(act.fraction, 0, 1) : 0.5;
    c.hp = Math.max(1, Math.round(c.maxHp * frac));
    c.status = null; c.sleepTurns = 0; c.toxicTurns = 0;
    c.volatile = { confusion: 0, flinch: false };
    return say('item', { use: 'revive', hp: c.hp, maxHp: c.maxHp });
  }

  if (act.kind === 'pp') {
    const slot = c.moves.find((m) => m.id === act.moveId) ?? c.moves.find((m) => m.pp <= 0);
    if (!slot) return null;
    const before = slot.pp;
    slot.pp = act.amount === 'full' ? slot.maxPp : Math.min(slot.maxPp, slot.pp + Math.max(0, Math.floor(act.amount || 0)));
    if (slot.pp === before) return null;
    return say('item', { use: 'pp', move: slot.id, restored: slot.pp - before, pp: slot.pp, maxPp: slot.maxPp });
  }

  return null;
}

/**
 * A fight, one turn at a time.
 *
 * This is the implementation now, and `resolve()` below is a drain of it — §5.17's "one
 * implementation of what a turn is" extended to cover what happens *between* two. The visible
 * fight steps it on a sim cadence so it can be watched and screenshotted; `idle` and `offline`
 * drain it in a loop. Anything else would let a potion drunk on screen not be drunk in the
 * replay, and the two would disagree about encounter N (DECISIONS #72).
 *
 * **An ally faint is not the end of the fight.** `turn()` calls it over the instant either
 * side hits zero, which is right for the *turn* and wrong for the *duel*: a revive puts the
 * same Pokemon back up, and a swap sends the next one out. Only when neither answers is it
 * over, and that is the party wipe. `winner: 'b'` therefore means **the party ran out**, not
 * "this Pokemon fell".
 *
 * `between` and `nextAlly` must be pure and must not draw randomness — see `applyAction`.
 *
 * @param {object} a  the party's combatant
 * @param {object} b  the wild
 * @param {{maxTurns?:number,
 *          between?:(state:object)=>Action[],
 *          nextAlly?:(state:object)=>object|null}} [opts]
 */
export function stepper(a, b, seed, index, { maxTurns = 60, between = null, nextAlly = null } = {}) {
  let state = begin(a, b);
  let done = false;
  /**
   * How many actions one `between` call may land before a turn.
   *
   * Four, because the deepest legal composition is revive -> swap -> heal -> ether and no
   * further. A hook that returns more is a bug in the hook, and a cap here turns it into a
   * dropped action rather than a frame that never ends.
   */
  let capped = false;
  /** How many party members have been sent out, so a caller can tell a swap from a revive. */
  let sent = 1;

  /** The ally is down and the wild is not: can anything keep the duel going? */
  function relieve(events) {
    // 1. the item list gets first refusal — a Revive raises the one that just fell.
    if (between) {
      const acts = between(state) ?? [];
      if (acts.length > MAX_BETWEEN) capped = true;
      for (const act of acts.slice(0, MAX_BETWEEN)) {
        const ev = applyAction(state, act);
        if (ev) events.push(ev);
      }
    }
    if (state.a.hp > 0) return true;
    // 2. otherwise the next conscious member steps out.
    const replacement = nextAlly ? nextAlly(state) : null;
    if (!replacement || (replacement.hp ?? 0) <= 0) return false;
    state.a = cloneSide(replacement);
    sent++;
    events.push({ turn: state.turn, actor: 'a', kind: 'swap', species: state.a.species, sent });
    return true;
  }

  const api = {
    get state() { return state; },
    get over() { return done || state.turn >= maxTurns; },
    get sent() { return sent; },
    get capped() { return capped; },
    /** One turn, plus whatever `between` decided to do before it. */
    step() {
      if (api.over) return { state, events: [], over: true };
      const events = [];

      if (between) {
        const acts = between(state) ?? [];
        if (acts.length > MAX_BETWEEN) capped = true;
        for (const act of acts.slice(0, MAX_BETWEEN)) {
          const ev = applyAction(state, act);
          if (ev) events.push(ev);
        }
      }

      const out = turn(state, seed, index);
      state = out.state;
      events.push(...out.events);

      if (state.over && state.a.hp <= 0 && state.b.hp > 0 && relieve(events)) {
        state.over = false;
        state.winner = null;
      }

      done = state.over;
      return { state, events, over: api.over };
    },
  };
  return api;
}

/**
 * Runs a fight to the end. A drain of `stepper()` — the SAME code the visible battle steps
 * through, which is what §5.17 has always claimed and what DECISIONS #72 finally made true.
 *
 * `maxTurns` is a stall guard, not a rule of the game: Struggle means a battle cannot deadlock
 * on PP, but two defensive Pokemon that keep missing still can. A draw is scored as a loss for
 * `a` for the same reason a double faint is.
 */
export function resolve(a, b, seed, index, { maxTurns = 60, between = null, nextAlly = null } = {}) {
  const run = stepper(a, b, seed, index, { maxTurns, between, nextAlly });
  const transcript = [];
  while (!run.over) transcript.push(...run.step().events);
  const state = run.state;
  const winner = state.over ? state.winner : (state.a.hp / state.a.maxHp >= state.b.hp / state.b.maxHp ? 'a' : 'b');
  return {
    winner, turns: state.turn, a: state.a, b: state.b,
    // What `economy.catchOdds` wants: the wild's remaining HP as a fraction. A won battle
    // leaves it at 0, which the formula clamps to 0.01 — the maximum HP bonus, and intended
    // (DECISIONS #61(i)).
    hpFraction: state.b.maxHp > 0 ? state.b.hp / state.b.maxHp : 1,
    stalled: !state.over,
    sent: run.sent,
    betweenCapped: run.capped,
    transcript,
  };
}

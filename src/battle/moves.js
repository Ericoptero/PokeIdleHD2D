/**
 * The move table, the learnsets, and which four moves a Pokemon actually has.
 *
 * Data comes from `public/generated/{moves,learnsets}.json`, built by
 * `src/pokemon/tools/build-battle-data.js` and committed (ARCHITECTURE §5.17). This file never
 * fetches: it is handed the parsed objects, so the browser can `fetch` them and the Node
 * selftest can read them off disk with the same code underneath.
 *
 * The short keys are the build script's, and this is the only reader of them:
 *
 *   n  name          t  type            c  category: 0 status, 1 physical, 2 special
 *   p  base power    a  accuracy (0 = cannot miss)     pp    pr priority
 *   hc high-crit ratio      dr drain [n,d]     rc recoil [n,d]     mh multihit [min,max]
 *   st status inflicted     sv volatile ('confusion')  bo boosts   sb 'self' | 'foe'
 *   ss secondary { c: chance, st?, sv?, bo?, sb? }
 *
 * Pure: no ctx, no clock, no DOM, no three, no RNG. It runs in Node.
 */

import { effectiveness, STAB, isType } from './types.js';

export const PHYSICAL = 1;
export const SPECIAL = 2;
export const STATUS = 0;

/** How many moves a Pokemon carries. Four, and it is not a tunable. */
export const MOVE_SLOTS = 4;

let MOVES = Object.create(null);
let LEARN = Object.create(null);
let loaded = false;

/**
 * Installs the two snapshots. Idempotent, and validated rather than trusted: a move with a
 * type outside the eighteen would silently become neutral against everything, which is the
 * kind of defect that looks like bad balance for weeks.
 */
export function load({ moves, learnsets }) {
  if (moves) {
    MOVES = Object.create(null);
    for (const [id, m] of Object.entries(moves)) {
      if (!isType(m.t)) continue;
      MOVES[id] = m;
    }
  }
  if (learnsets) LEARN = learnsets;
  loaded = Object.keys(MOVES).length > 0;
  return loaded;
}

export const ready = () => loaded;
export const move = (id) => MOVES[id] ?? null;
export const moveIds = () => Object.keys(MOVES);
export const moveCount = () => Object.keys(MOVES).length;

/**
 * A species' level-up list as `[{ level, move }]`, ascending.
 *
 * Rows are stored as `"24:agility"` — one string per row rather than a pair of arrays, because
 * the whole file is 266 KB and an array of two-element arrays costs a third again in brackets
 * for no gain at the one place that reads it.
 */
export function learnset(species) {
  const rows = LEARN[String(species ?? '').toLowerCase()];
  if (!rows) return [];
  const out = [];
  for (const row of rows) {
    const i = row.indexOf(':');
    if (i < 1) continue;
    const id = row.slice(i + 1);
    if (MOVES[id]) out.push({ level: Number(row.slice(0, i)) || 1, move: id });
  }
  return out;
}

/**
 * The four moves a species knows at `level`.
 *
 * **The last four learnable, not the first four**, which is how the games behave once a
 * Pokemon has been levelling for a while — a level-40 Pikachu that still knew Growl and
 * Tail Whip would lose to a Caterpie. `priority` is the player's per-Pokemon preference
 * list (§5.17): anything named there is kept ahead of the recency rule, so a favourite
 * never falls off the end.
 *
 * Deterministic and RNG-free: two builds of the same species at the same level always agree,
 * which is what lets `encounter/selftest.js`'s golden encounters survive this refactor
 * (DECISIONS #61(g)) — moves are *derived*, never rolled.
 *
 * @returns {{id:string, pp:number, maxPp:number}[]}
 */
export function movesFor(species, level, { priority = [] } = {}) {
  const known = [];
  const seen = new Set();
  for (const row of learnset(species)) {
    if (row.level > level) break;                // the list is level-ascending
    if (seen.has(row.move)) continue;
    seen.add(row.move);
    known.push(row.move);
  }
  if (!known.length) {
    // A species with an empty learnset would stand in the grass unable to act. Struggle is
    // the mainline answer to exactly this and it costs one row.
    return [{ id: STRUGGLE_ID, pp: 1, maxPp: 1 }];
  }

  const wanted = priority.filter((id) => seen.has(id));
  const rest = known.filter((id) => !wanted.includes(id));
  const picked = [...wanted, ...rest.slice(-Math.max(0, MOVE_SLOTS - wanted.length))]
    .slice(0, MOVE_SLOTS);

  return picked.map((id) => ({ id, pp: MOVES[id].pp, maxPp: MOVES[id].pp }));
}

/**
 * Struggle: what a Pokemon does with no PP left anywhere.
 *
 * Synthesised rather than read from the table, because Showdown's Struggle carries flags this
 * engine does not model and because a battle that can deadlock is worse than one that ends
 * badly — `resolve()` would otherwise spin to `maxTurns` every time two Pokemon ran dry.
 */
export const STRUGGLE_ID = '__struggle';
export const STRUGGLE = Object.freeze({
  n: 'Struggle', t: 'normal', c: PHYSICAL, p: 50, a: 0, pp: 1, pr: 0, rc: [1, 4],
});

/** Looks a move up, answering Struggle for the synthetic id. */
export const resolveMove = (id) => (id === STRUGGLE_ID ? STRUGGLE : MOVES[id] ?? null);

/**
 * What a move is worth against this defender, ignoring the dice.
 *
 * Used to pick a move (§5.17: "the highest expected damage the Pokemon can still pay the PP
 * for"). It is deliberately *not* the damage formula — it does not need the level term or the
 * random band to rank two moves, and keeping it separate means the ranking cannot drift when
 * the formula gains a term.
 */
export function expectedValue(m, self, foe) {
  if (!m) return -1;
  if (m.c === STATUS) {
    // A status move is worth something only if it would actually land something new. Ranked
    // below any damaging move on purpose: an idle battle that spends its turns buffing is an
    // idle battle the player watches for a very long time.
    const useful = (m.st && !foe.status) || (m.sv === 'confusion' && !foe.volatile?.confusion)
      || (m.bo && m.sb === 'self');
    return useful ? 12 : -1;
  }
  const mult = effectiveness(m.t, foe.types);
  if (mult === 0) return -1;
  const stab = self.types?.includes(m.t) ? STAB : 1;
  const atk = m.c === PHYSICAL ? self.stats.atk : self.stats.spa;
  const def = m.c === PHYSICAL ? foe.stats.def : foe.stats.spd;
  const hits = m.mh ? (m.mh[0] + m.mh[1]) / 2 : 1;
  const acc = (m.a === 0 ? 100 : m.a) / 100;
  return (m.p * hits * stab * mult * (atk / Math.max(1, def))) * acc;
}

/**
 * Picks the move to use this turn: the best `expectedValue` among the slots that still have
 * PP. Ties break on slot order, which is stable, so the choice is a pure function of the
 * battle state and never of call order.
 */
export function choose(self, foe) {
  let best = null;
  let bestScore = -Infinity;
  for (const slot of self.moves) {
    if (slot.pp <= 0) continue;
    const score = expectedValue(resolveMove(slot.id), self, foe);
    if (score > bestScore) { bestScore = score; best = slot; }
  }
  // Everything is out of PP, or everything scores -1 (immune / pointless status): Struggle.
  if (!best || bestScore < 0) return { id: STRUGGLE_ID, pp: 1, maxPp: 1, struggle: true };
  return best;
}

// @ts-check
/**
 * strike.js — one record per blow, folded out of a turn's transcript.
 *
 * The brief asks that every strike report its attacker, its target, the move, the damage, the
 * type effectiveness, whether it crit, whether it missed and whether anything fainted. **No
 * single transcript event carries that**, and the mismatch is not an accident of style:
 *
 *   - `move` and `damage` are two events, because a move can miss, be immune, or land eight
 *     times, and `engine.js` emits what happened rather than what was intended;
 *   - `species` is the **victim** on `damage`, `miss`, `immune` and `status`, and the **actor**
 *     on `move`, `recoil`, `drain` and `residual` — each event names the Pokemon it is about;
 *   - a multi-hit collapses into ONE `damage` with `hits > 1` and a summed total;
 *   - `faint` is a turn-level event, not a side's.
 *
 * So the transcript is left exactly as it is — `ui/panels/battle.js` renders thirteen of its
 * kinds directly and `encounter.transcript()` is a published API — and this file derives the
 * spec's shape on top of it. `encounter` emits one `battle:strike` per record as it steps,
 * because `battle` has no `ctx` and must keep none (src/battle/index.js).
 *
 * Pure, Node-runnable, no imports. A strike is a function of a turn's events and the two
 * combatants' names, and of nothing else.
 */

/** Events that begin a new strike all by themselves, and what they were caused by. */
const OPENERS = {
  move: null,                 // the ordinary case: an attack was attempted
  flinch: 'flinch',
  frozen: 'frozen',
  asleep: 'asleep',
  paralysed: 'paralysed',
  'confused-hit': 'confusion',
  item: 'item',
  swap: 'swap',
  residual: 'residual',
  woke: 'residual',
  thawed: 'residual',
  unconfused: 'residual',
};

/** Events that attach to whichever strike is open. */
const RIDERS = new Set(['damage', 'miss', 'immune', 'status', 'confused', 'boost', 'drain', 'recoil']);

const other = (side) => (side === 'a' ? 'b' : 'a');

/**
 * @typedef {Object} Strike
 * @property {number}  turn
 * @property {'a'|'b'|null} attacker        null for an end-of-turn residual
 * @property {string|null}  attackerSpecies
 * @property {'a'|'b'|null} target
 * @property {string|null}  targetSpecies
 * @property {string|null}  move            the move id, or null when nothing was thrown
 * @property {string|null}  name            its display name
 * @property {boolean} struggle
 * @property {number}  damage               summed across hits
 * @property {number}  hits
 * @property {number|null} effectiveness    0 | 0.25 | 0.5 | 1 | 2 | 4
 * @property {boolean} crit
 * @property {boolean} miss
 * @property {boolean} immune
 * @property {number|null} targetHp
 * @property {number|null} targetMaxHp
 * @property {number}  recoil
 * @property {number}  drain
 * @property {string|null} status           what was inflicted, if anything
 * @property {{stat:string, by:number}[]} boosts
 * @property {'a'|'b'|null} fainted
 * @property {string|null}  cause           'flinch' | 'confusion' | 'residual' | 'item' | …
 * @property {string|null}  item
 */

function blank(turn, actor, names, cause) {
  const target = actor ? other(actor) : null;
  return {
    turn,
    attacker: actor ?? null,
    attackerSpecies: actor ? names[actor] ?? null : null,
    target,
    targetSpecies: target ? names[target] ?? null : null,
    move: null, name: null, struggle: false,
    damage: 0, hits: 0, effectiveness: null,
    crit: false, miss: false, immune: false,
    targetHp: null, targetMaxHp: null,
    recoil: 0, drain: 0, status: null, boosts: [],
    fainted: null, cause: cause ?? null, item: null,
  };
}

/**
 * Folds one turn's events (or a whole transcript) into strike records, in order.
 *
 * @param {any[]} events  from `turn()` or `resolve().transcript` (the event records are
 *   plain objects with a `kind` and per-kind fields; see `turn()`)
 * @param {{a?:string, b?:string}} names  the two species, for the display half
 * @returns {Strike[]}
 */
export function strikesOf(events, names = {}) {
  const out = [];
  let open = null;
  const push = () => { if (open) out.push(open); open = null; };

  for (const ev of events ?? []) {
    if (!ev || typeof ev !== 'object') continue;
    const kind = ev.kind;

    if (kind === 'faint') {
      // Closes whatever was open — a faint is the consequence of the blow before it. With no
      // strike open (a turn that opened with a residual tick nobody survived) it stands alone.
      if (!open) open = blank(ev.turn, null, names, 'residual');
      open.fainted = ev.actor ?? null;
      push();
      continue;
    }

    if (kind in OPENERS) {
      push();
      open = blank(ev.turn, ev.actor ?? null, names, OPENERS[kind]);
      if (kind === 'move') {
        open.move = ev.move ?? null;
        open.name = ev.name ?? null;
        open.struggle = !!ev.struggle;
      } else if (kind === 'item') {
        open.item = ev.item ?? null;
        // An item is used ON the actor's own side, so the target is the actor.
        open.target = open.attacker;
        open.targetSpecies = open.attackerSpecies;
        open.use = ev.use ?? null;
      } else if (kind === 'residual') {
        // A residual hurts the side it is about; there is no attacker.
        open.target = ev.actor ?? null;
        open.targetSpecies = ev.actor ? names[ev.actor] ?? null : null;
        open.attacker = null;
        open.attackerSpecies = null;
        open.damage = ev.damage ?? 0;
        open.hits = ev.damage ? 1 : 0;
        open.status = ev.status ?? null;
        open.targetHp = ev.hp ?? null;
      }
      continue;
    }

    if (!RIDERS.has(kind)) continue;
    if (!open) open = blank(ev.turn, ev.actor ?? null, names, null);

    if (kind === 'damage') {
      open.damage += ev.damage ?? 0;
      open.hits += ev.hits ?? 1;
      open.effectiveness = ev.effectiveness ?? open.effectiveness;
      open.crit = open.crit || !!ev.crit;
      open.targetHp = ev.hp ?? open.targetHp;
      open.targetMaxHp = ev.maxHp ?? open.targetMaxHp;
    } else if (kind === 'miss') {
      open.miss = true;
    } else if (kind === 'immune') {
      open.immune = true;
      open.effectiveness = 0;
    } else if (kind === 'status') {
      open.status = ev.status ?? open.status;
    } else if (kind === 'confused') {
      open.status = open.status ?? 'confusion';
    } else if (kind === 'boost') {
      open.boosts.push(...(ev.moved ?? []));
    } else if (kind === 'drain') {
      open.drain += ev.healed ?? 0;
    } else if (kind === 'recoil') {
      open.recoil += ev.damage ?? 0;
    }
  }

  push();
  return out;
}

/** The one-line reading of a strike, for a callout or a log. Display names in, sentence out. */
export function describeStrike(s) {
  if (!s) return '';
  if (s.cause === 'item') return `${s.targetSpecies ?? '?'} used an item`;
  if (s.cause === 'swap') return `${s.attackerSpecies ?? '?'} stepped out`;
  if (s.cause === 'residual') return `${s.targetSpecies ?? '?'} was hurt by ${s.status ?? 'it'}`;
  if (!s.move) return `${s.attackerSpecies ?? '?'} could not move`;
  const head = `${s.attackerSpecies ?? '?'} used ${s.name ?? s.move}`;
  if (s.miss) return `${head} — it missed`;
  if (s.immune) return `${head} — it had no effect`;
  const bits = [];
  if (s.crit) bits.push('a critical hit');
  if (s.effectiveness > 1) bits.push('super effective');
  else if (s.effectiveness > 0 && s.effectiveness < 1) bits.push('not very effective');
  if (s.hits > 1) bits.push(`hit ${s.hits} times`);
  return bits.length ? `${head} — ${bits.join(', ')}` : head;
}

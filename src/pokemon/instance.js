/**
 * What a Pokemon *is*, once it can be hurt.
 *
 * Before this file an instance was `{ instanceId, species, level, shiny, hp: 1, exp: 0, ivs }`
 * and **nothing in the repo ever changed its level**: `idle/index.js:213` called a
 * `pokemon.grantExp` that did not exist, so every point of experience the game has ever
 * produced was thrown away (DECISIONS #61). This is the other half of that seam.
 *
 * Pure by construction: every dependency is a parameter. `battle` supplies the stat formula,
 * the growth curves and the move table; a species lookup supplies evolutions. Nothing here
 * imports another module (§5), reads a clock, or touches the DOM — so it runs in Node and the
 * selftest can level a Pokemon to 100 without a browser.
 *
 * **`battle` is reached through `ctx.get`, not `needs`.** A quarantined engine has to cost the
 * game its moves, not its sprites: `pokemon` failing would take the overworld down with it, and
 * ARCHITECTURE §2.1's whole point is that one broken module must not cascade.
 */

/** The registry's null object answers every property with a function — this is the tell. */
export const isLive = (api) => !!api && api.__missing === undefined;

/** The price list. Separate file because it is a table, and tables want room to be read. */
import * as EVO from './evolution.js';

/**
 * Fallbacks for when `battle` is not live.
 *
 * Deliberately not a second implementation of the stat formula — that is exactly the kind of
 * mirror that drifts (see `economy/pacing.js` against `idle/accrual.js`, and the seam rule
 * written to catch it). A Pokemon with no engine keeps a flat body and no moves, which reads
 * as "the engine is missing" rather than as bad balance.
 */
const FLAT = {
  stats: (base, ivs, level) => ({ hp: 10 + level, atk: 5, def: 5, spa: 5, spd: 5, spe: 5 }),
  expToLevel: (growth, level) => level ** 3,
  levelForExp: (growth, exp) => Math.max(1, Math.min(100, Math.floor(Math.cbrt(Math.max(0, exp))))),
  movesFor: () => [],
  expYield: (baseExp, level) => Math.max(1, Math.round((baseExp ?? 60) * level / 7)),
};

const bt = (api) => (isLive(api) ? api : FLAT);

/**
 * Mints an instance.
 *
 * **`instanceId` is minted once, here, and never recomputed.** It used to be built from the
 * level, so it changed the moment a Pokemon levelled — and `collection` keys its bus intake off
 * it, which would have meant a level-up quietly forking a Pokemon into two dex records.
 * `ordinal` is what makes it unique now: a monotone counter, not a property of the body.
 */
export function makeInstance({ species, level = 5, shiny = false, ordinal = 0, ivs, rng }, battle) {
  const b = bt(battle);
  const iv = ivs ?? {
    hp: rng.int(0, 31), atk: rng.int(0, 31), def: rng.int(0, 31),
    spa: rng.int(0, 31), spd: rng.int(0, 31), spe: rng.int(0, 31),
  };
  const stats = b.stats(species.baseStats, iv, level);
  return {
    instanceId: `${species.name}#${ordinal}`,
    species, level, shiny,
    exp: b.expToLevel(species.growthRate ?? 'medium', level),
    ivs: iv,
    stats,
    maxHp: stats.hp,
    hp: stats.hp,
    moves: b.movesFor(species.name, level),
    priority: [],
    status: null,
  };
}

/** Recomputes the body after a level change. Current HP keeps its *fraction*, not its value. */
export function refreshStats(inst, battle) {
  const b = bt(battle);
  const before = inst.maxHp > 0 ? inst.hp / inst.maxHp : 1;
  inst.stats = b.stats(inst.species.baseStats, inst.ivs, inst.level);
  inst.maxHp = inst.stats.hp;
  inst.hp = Math.max(1, Math.round(inst.maxHp * before));
  return inst;
}

/**
 * Re-derives the four slots after a level-up, **keeping the PP already spent**.
 *
 * A level-up that silently refilled PP would make levelling the cheapest heal in the game, and
 * an idle loop would find that within an hour.
 */
export function refreshMoves(inst, battle) {
  const b = bt(battle);
  const spent = new Map(inst.moves.map((m) => [m.id, m.pp]));
  const next = b.movesFor(inst.species.name, inst.level, { priority: inst.priority });
  const learned = [];
  for (const slot of next) {
    if (spent.has(slot.id)) slot.pp = Math.min(slot.pp, spent.get(slot.id));
    else learned.push(slot.id);
  }
  inst.moves = next;
  return learned;
}

/**
 * What this Pokemon would become, and what it is waiting for.
 *
 * `species.evo` is the requirement **inverted onto the parent** at build time (DECISIONS #61),
 * so this is a lookup rather than a search. Four methods reach a level:
 *
 *   - `levelUp`      the level on the row
 *   - `useItem`      the same level gate, plus the stone in the bag
 *   - everything else (`trade`, `levelFriendship`, `levelMove`, …) a **derived** level, so no
 *     line in the game is unreachable from a hunt — which is the point of the rule in §0.
 *
 * **Nothing here evolves anything.** `evolutionFor` prices the evolution and says whether the
 * bill can be paid; taking it is `pokemon.evolve()`, and that is only ever called because a
 * player pressed a button. Evolution used to fire the instant a level threshold went past,
 * which made it something that happened *to* the player.
 *
 * **A branching line is decided by the bag, not by the alphabet.** `evo` is sorted by name at
 * build time, so "the first row that qualifies" would have made Eevee always an Espeon and the
 * other seven unreachable — deterministic, and wrong. Three passes instead:
 *
 *   1. a stone route whose level is met AND whose stone is in the bag — the player *chose* it;
 *   2. otherwise the first non-stone route that qualifies;
 *   3. otherwise the first stone route that is only waiting on its stone, reported as
 *      `waitingOn` so the UI can say what to buy.
 *
 * So an Eevee with a Fire Stone becomes a Flareon and one with nothing becomes an Espeon, and
 * a Pikachu — which has no route that is not a stone — waits, and says so.
 */
export const derivedEvoLevel = EVO.derivedLevel;

export function evolutionFor(inst, lookup, { count = () => 0, isItem } = {}) {
  const priced = [];
  for (const row of inst.species.evo ?? []) {
    const to = lookup(row.to);
    if (!to) continue;
    const req = EVO.requirementFor(inst.species, to, row, { count, isItem });
    // \`to\` LAST: \`requirementFor\` reports \`to\` as the child's *name*, and spreading it over
    // the species object silently replaced the object with a string — every caller reading
    // \`row.to.name\` then got \`undefined\` with nothing throwing. Same shape of bug as the
    // blank type chart in phase 1, and caught the same way.
    priced.push({ ...row, ...req, to, ready: inst.level >= req.level && req.missing.length === 0 });
  }
  if (!priced.length) return null;
  // 1. anything the player can actually afford right now. That is the offer worth showing.
  const affordable = priced.find((r) => r.ready);
  if (affordable) return affordable;
  // 2. otherwise the CHEAPEST unmet route, measured in units still missing — the shortest
  //    grind, not the first alphabetically. A branching line therefore points the player at
  //    the one they are closest to instead of always naming the same child.
  const shortfall = (r) => (inst.level < r.level ? 1000 : 0)
    + r.missing.reduce((a, m) => a + (m.n - m.have), 0);
  return priced.slice().sort((a, b) => shortfall(a) - shortfall(b) || (a.to < b.to ? -1 : 1))[0];
}

/** Every route this species has, priced. The party panel lists them; `evolutionFor` picks one. */
export function evolutionOptions(inst, lookup, { count = () => 0, isItem } = {}) {
  const out = [];
  for (const row of inst.species.evo ?? []) {
    const to = lookup(row.to);
    if (!to) continue;
    const req = EVO.requirementFor(inst.species, to, row, { count, isItem });
    out.push({ ...row, ...req, to, ready: inst.level >= req.level && req.missing.length === 0 });
  }
  return out;
}

/**
 * Grants experience and applies every consequence in order: level, stats, moves, evolution.
 *
 * Returns a report rather than emitting — the caller owns the bus, so this stays pure and the
 * selftest can read the same answer the game does.
 *
 * @param {object} inst
 * @param {number} amount
 * @param {{battle:object, lookup:Function, hasItem?:Function, canEvolve?:boolean}} deps
 */
export function grantExp(inst, amount, { battle, lookup, count, isItem } = {}) {
  const b = bt(battle);
  const growth = inst.species.growthRate ?? 'medium';
  const gained = Math.max(0, Math.floor(amount || 0));
  const from = inst.level;
  inst.exp = Math.max(0, (inst.exp ?? 0) + gained);

  const to = Math.min(100, b.levelForExp(growth, inst.exp));
  const learned = [];
  if (to > from) {
    inst.level = to;
    refreshStats(inst, battle);
    learned.push(...refreshMoves(inst, battle));
  }

  // **Nothing evolves here.** Experience is reported, and the evolution it may have unlocked
  // is *offered*. Taking it is `pokemon.evolve()`, and that only ever runs because a player
  // pressed a button — an evolution that fires on its own is something that happens TO the
  // player, and the materials it now costs are theirs to decide to spend.
  const pending = evolutionFor(inst, lookup, { count, isItem });
  return {
    instanceId: inst.instanceId,
    gained, exp: inst.exp, from, to: inst.level, levelled: to > from, learned,
    pending: pending
      ? {
        to: pending.to.name, display: pending.display, level: pending.level,
        materials: pending.materials, missing: pending.missing, ready: pending.ready,
      }
      : null,
  };
}

/**
 * Swaps the species in place, keeping identity, IVs, experience and spent PP.
 *
 * In place, and keeping `instanceId`, because a Charmander that becomes a Charmeleon is the
 * same Pokemon — the box entry, the party slot and the dex record all point at that id.
 */
export function evolveTo(inst, species, battle) {
  const from = inst.species.name;
  inst.species = species;
  refreshStats(inst, battle);
  const learned = refreshMoves(inst, battle);
  return { instanceId: inst.instanceId, from, to: species.name, learned };
}

/**
 * Heals. `hp: 'full'` restores everything; a number restores that much.
 *
 * **It refuses a fainted Pokemon, and that is a rule rather than a guard.** Until DECISIONS #72
 * this function would happily take a 0 HP Oshawott to 20, which made a ₽200 Potion a working
 * Revive — and it made "fainted Pokemon cannot participate in battles" unenforceable, because
 * the first auto-heal rule would quietly resurrect whatever had just gone down. Raising a
 * fainted Pokemon is `revive()` below, and nothing else.
 *
 * `revive: true` is the one caller that is allowed through: the Pokemon Center, which restores
 * a wiped party in full.
 */
export function heal(inst, { hp = 'full', status = true, revive = false } = {}) {
  if (inst.hp <= 0 && !revive) return inst.hp;
  inst.hp = hp === 'full' ? inst.maxHp : Math.min(inst.maxHp, inst.hp + Math.max(0, hp));
  if (status) { inst.status = null; inst.sleepTurns = 0; inst.toxicTurns = 0; }
  return inst.hp;
}

/**
 * Raises a fainted Pokemon to a fraction of its maximum, and refuses a conscious one.
 *
 * The refusal is what stops an auto-revive list burning its scarcest item on a scratch: a
 * Revive is legal at 0 HP and illegal anywhere else, exactly as the games have it.
 */
export function revive(inst, { fraction = 0.5 } = {}) {
  if (inst.hp > 0) return inst.hp;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  inst.hp = Math.max(1, Math.round(inst.maxHp * f));
  inst.status = null;
  inst.sleepTurns = 0;
  inst.toxicTurns = 0;
  return inst.hp;
}

/**
 * Puts PP back into one move slot, or into the emptiest one when no move is named.
 *
 * The emptiest-slot fallback is what Auto-Ether wants: the brief watches "the PP percentage of
 * the highest-priority move", and the caller that knows which move that is passes its id — but
 * a player pressing ETHER with nothing selected means "the one that ran out".
 */
export function restorePp(inst, { moveId = null, amount = 10 } = {}) {
  const slots = inst.moves ?? [];
  const slot = (moveId ? slots.find((m) => m.id === moveId) : null)
    ?? [...slots].sort((x, y) => (x.pp / Math.max(1, x.maxPp)) - (y.pp / Math.max(1, y.maxPp)))[0];
  if (!slot) return 0;
  const before = slot.pp;
  slot.pp = amount === 'full' ? slot.maxPp : Math.min(slot.maxPp, slot.pp + Math.max(0, Math.floor(amount) || 0));
  return slot.pp - before;
}

/** Hurts. Never below zero; fainting is `hp === 0` and nothing else. */
export function damage(inst, n) {
  inst.hp = Math.max(0, inst.hp - Math.max(0, Math.floor(n || 0)));
  return inst.hp;
}

/** The save shape. Species is a name; everything derived is rebuilt on load (§5). */
export function serialize(inst) {
  return {
    instanceId: inst.instanceId,
    species: inst.species.name,
    level: inst.level, shiny: !!inst.shiny, exp: inst.exp ?? 0,
    ivs: { ...inst.ivs },
    hp: inst.hp,
    moves: inst.moves.map((m) => ({ id: m.id, pp: m.pp })),
    priority: [...(inst.priority ?? [])],
    status: inst.status ?? null,
  };
}

/**
 * Rebuilds an instance from a slice.
 *
 * **Derived state is rebuilt, never trusted from the file** (§5): stats and maxHp are
 * recomputed from base + IVs + level, and the move list is re-derived from the learnset with
 * only the *spent PP* carried over. A save that claimed a Snorlax had 4000 HP would be
 * corrected rather than obeyed.
 */
export function deserialize(slice, lookup, battle) {
  const species = lookup(slice?.species);
  if (!species) return null;
  const inst = {
    instanceId: typeof slice.instanceId === 'string' ? slice.instanceId : `${species.name}#0`,
    species,
    level: Math.max(1, Math.min(100, Math.floor(slice.level ?? 5))),
    shiny: !!slice.shiny,
    exp: Math.max(0, Math.floor(slice.exp ?? 0)),
    ivs: {
      hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(slice.ivs ?? {}),
    },
    priority: Array.isArray(slice.priority) ? slice.priority.filter((m) => typeof m === 'string') : [],
    status: typeof slice.status === 'string' ? slice.status : null,
    stats: null, maxHp: 1, hp: 1, moves: [],
  };
  refreshStats(inst, battle);
  inst.moves = bt(battle).movesFor(species.name, inst.level, { priority: inst.priority });
  const spent = new Map((slice.moves ?? []).map((m) => [m.id, m.pp]));
  for (const slot of inst.moves) if (spent.has(slot.id)) slot.pp = Math.max(0, Math.min(slot.maxPp, spent.get(slot.id)));
  inst.hp = Math.max(0, Math.min(inst.maxHp, Math.floor(slice.hp ?? inst.maxHp)));
  return inst;
}

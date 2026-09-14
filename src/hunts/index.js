/**
 * hunts — the biomes a party actually hunts in (src/hunts/index.js).
 *
 * A hunt map is composed, never sampled: every region in it exists because the place has a
 * reason for its shape. The authoring lives in `biomes/<id>.js`, one file per biome, and
 * everything they share — region algebra, palettes, the auto-tile guard rails — lives in
 * `compose.js` and `palette.js`.
 *
 * This file is the seam: it registers each map with `terrain`, drives `environment`'s biome
 * preset, hands the party to `simulation`, and owns the camera framings a critic shoots.
 */

import { makePalette, isLive } from './palette.js';
import { findLoop, slotsForLoop, stitchLoop } from './compose.js';
import { bfsPath, bfsCells } from '../core/path.js';

/** `core/dir.js`'s deltas, for walking a route string back over the draft in `audit()`. */
const LOOP_DX = [0, -1, 0, 1];
const LOOP_DZ = [1, 0, -1, 0];
const LOOP_LETTER = { s: 0, w: 1, n: 2, e: 3 };
/** The same expansion `simulation/route.js` does, kept here so `audit` needs no cross-import. */
const parseLoop = (spec) => {
  const out = [];
  for (const m of String(spec ?? '').toLowerCase().matchAll(/([nsew])\s*(\d*)/g)) {
    const n = m[2] ? parseInt(m[2], 10) : 1;
    for (let i = 0; i < n; i++) out.push(LOOP_LETTER[m[1]]);
  }
  return out;
};
import { FOREST, buildForest } from './biomes/forest.js';
import { MEADOW, buildMeadow } from './biomes/meadow.js';
import { CAVE, buildCave } from './biomes/cave.js';
import { COAST, buildCoast } from './biomes/coast.js';

/** @type {Array<object>} the biomes, in the order the showcase lists them. */
export const BIOMES = [
  { ...FOREST, build: buildForest },
  { ...MEADOW, build: buildMeadow },
  { ...CAVE, build: buildCave },
  { ...COAST, build: buildCoast },
];

const byId = (id) => BIOMES.find((b) => b.id === id) ?? BIOMES[0];

/**
 * How the party walks when nothing says otherwise: **east**, and only a few tiles in.
 *
 * `dir` is `core/dir.js`'s EAST. Every biome overrides `route` with a leg its own map can
 * actually walk (see each `biomes/*.js`), but the direction is not a per-biome taste call:
 * a party walking north files straight up the screen under a camera whose yaw never
 * changes, so each sprite stands in front of the one behind it and the only thing the
 * camera can see of the trainer is the back of the cap — a cream lozenge with no face on
 * it. That is the single defect all three blind A/B rounds named. Walking east strings the
 * queue out left-to-right across the frame: nobody occludes anybody, and the trainer shows
 * the side of the sheet that has a face, a brim and two arms on it.
 */
/**
 * How a hunt is played (`simulation.setFormation`).
 *
 * A hunt is watched, not steered. The **active Pokemon leads** — it is what walks into the
 * tall grass first, which is the whole reason `player:enteredTile` carries the head's cell —
 * the trainer follows it, and the keyboard does not move either of them: the wander does.
 *
 * `preferTags` is the part that is easy to get wrong. The autopilot this replaces preferred
 * `path`, which in a biome biases the party *away* from the grass it came here to hunt in.
 * A hunt prefers the grass and falls back to the path.
 *
 * A biome may override any of it with a `formation` field of its own; none needs to today.
 */
const HUNT_FORMATION = {
  head: 'pokemon', input: false, autopilot: 'route', strict: true,
  preferTags: ['tallgrass', 'encounter', 'path'],
};

/**
 * How much of the map a circuit may take, and how many creatures stand beside it.
 *
 * A biome may AUTHOR its own circuit: an ordered list of its own marker names in `loop.via`
 * (`authoredLoop`, below, and `stitchLoop` in `compose.js`) gets stitched into a ring through
 * exactly those markers, in the order asked, on the draft that was actually built — a route
 * string could not do this (a list of relative directions has no idea where it is, and one
 * authored against a map stays correct only until the composition changes; that is why the old
 * `walk.route` strings drifted, see `stageOnLoop`'s own comment below), but a marker NAME is
 * resolved fresh on every build.
 *
 * `findLoop` is the fallback, not the plan: it runs when a biome declares no `via`, or when the
 * authored circuit could not be stitched over the shipped map (a missing marker, a leg that
 * would not stitch, a rejected ring — `authoredLoop` warns and `audit()` below fails loudly on
 * any of those, so a degraded biome cannot ship quietly green).
 */
const LOOP = { min: 6, max: 22, margin: 11 };

/**
 * The shape knobs, resolved per biome — and read only by the `findLoop` FALLBACK.
 *
 * `corners`, `depth` and the rest of this bag shape the rectangle `findLoop` grows; a biome
 * with an authored `loop.via` is stitched straight through its own markers instead and never
 * consults them. Three layers, most specific first: whatever the biome's own `loop` field
 * says, then `config` (which `?loopCorners=` reaches without touching code), then the defaults
 * above. A biome that wants a plain rectangle fallback asks for `loop: { corners: 4 }` and
 * gets one.
 */
const loopOptions = (biome, config) => ({
  ...LOOP,
  corners: biome.loop?.corners ?? config.loopCorners ?? 12,
  depth: biome.loop?.depth ?? config.loopDepth ?? 3,
  preferTags: biome.loop?.preferTags ?? ['path', 'tallgrass'],
  // The queue is `gap` walkers long, so the ring has to open with at least that many steps in
  // one direction or the head is placed off its own path.
  straightLead: (config.followerGapTiles ?? 2) + 2,
  ...(biome.loop ?? {}),
});
/** Slots per lap. `WILD_CAP` is the ceiling; a lap wants encounters, not a wall of them. */
const SLOTS = 9;
/** Seconds an emptied slot stays empty before something new walks onto it. */
const RESPAWN_S = 26;

/** How many wild Pokemon a biome stands up, and how they are chosen. */
const WILD_CAP = 11;          // MAX_NPCS is 32 and `city` uses a dozen of them
const WILD_SPECIES_CAP = 6;   // one atlas sheet each; the rest are repeats

export default {
  id: 'hunts',
  needs: ['terrain', 'encounter', 'environment'],
  /**
   * Extra modules the showcase scene needs on top of `needs` (src/main.js).
   *
   * The party is the point of a hunt — the lead walks the grass and the trainer follows —
   * and every reference still we are scored against has characters in it. So `simulation`
   * and `pokemon` are staged for the showcase even though the *maps* do not need them.
   */
  showcaseNeeds: ['tiles', 'simulation', 'pokemon'],

  init(ctx) {
    const { log, bus, config } = ctx;
    const terrain = ctx.get('terrain');
    /**
     * What is standing on each slot right now, keyed by slot index.
     *
     * `encounter` engages a slot by index and this module hands the creature over **without**
     * taking its sprite off the map — the wild that fights is the one that was standing there,
     * the same body, and `encounter` retires it only once its own actor is in place (#87).
     *
     * `level` is rolled here, when the creature walks onto the slot, and not at engagement:
     * a plate over its head has to say the level it will actually fight at (#87).
     * @type {Map<number, {npcId:number, species:object, shiny:boolean, level:number, cx:number, cz:number, dir:number}>}
     */
    const occupancy = new Map();
    /** Slots waiting to be refilled: `{ k, at }` in `clock.simTime` seconds. */
    const refills = [];
    /**
     * Slots the party has already walked out to on this lap.
     *
     * Without it the head ping-pongs: it steps out to a slot, nothing takes the creature —
     * `encounter` is not armed in another module's showcase, or is quarantined, or the party is
     * wiped — it steps back onto the cell it left, `player:enteredTile` fires for that cell
     * again, and it commits the same detour forever. Measured in `?showcase=hunts&mode=meadow`
     * before this: **216 detours in 2000 ticks over twelve cells of map**.
     *
     * Cleared on a completed lap and on entry, so a slot the party could not take this time
     * round is tried again next time round — which is also the honest reading of "move toward
     * the next nearby living target".
     */
    const triedThisLap = new Set();

    /**
     * The NPC id `holdNpc(id, true)` currently has frozen for an in-progress approach, or
     * `null` when nothing is held.
     *
     * A wild is held from the instant the party commits to walking at it (so its own tether
     * drift cannot step it out from under a multi-step path) until one of two things closes
     * the story: a fight actually starts on it (`encounter:resolved` releases it once the duel
     * is over), or the approach ends with no fight at all — a blocked step abandoned it, the
     * lap moved on, `sim.detourHome()` cut it short. That second case has no event of its own
     * to hang a release on, so it is caught by watching `sim.detouring()` fall from `true` to
     * `false` (see `wasDetouring`, and `_refill`, below) — the one thing every ending of a
     * detour has in common. Without this a wild whose approach ended by any means other than a
     * fight would stay `held: true` forever: frozen, visible, and never fought again.
     */
    let heldNpcId = null;
    /** `sim.detouring()` as of the last tick, so `_refill` can catch its `true -> false` edge. */
    let wasDetouring = false;
    /**
     * Set by `resyncToLoop()` (below) the instant it queues a one-way detour back onto the
     * loop; consumed by the SAME `wasDetouring` edge `_refill` already watches, the tick that
     * detour ends (landed OR abandoned — see that handler's own comment), to hand the circuit
     * back with `setRoute` if the head actually made it onto a loop cell. Never a second
     * detector. Deliberately carries no target cell of its own: the edge handler looks up
     * wherever the head really is when it fires, rather than trusting where this queued the
     * detour toward — see `_refill`'s own comment for why that trust was the bug.
     */
    let resyncPending = false;

    /** How many times each slot has refilled — the index its respawn roll is addressed by. */
    const generations = new Map();
    /** Seconds of simulated time this module has seen, accumulated from its own `tick`. */
    let elapsed = 0;
    /** Landings since the party last completed a lap of the circuit. */
    let lapSteps = 0;
    /** Consecutive `player:enteredTile` landings off the current loop — `resyncToLoop`'s own
     * backstop counter, shares the `onLoopSet` lookup the lap counter above uses (point 4/5). */
    let offLoopStreak = 0;

    /** @type {Map<string, object>} what the last build of each map reported. */
    const built = new Map();
    /** Worlds drawn from a tileset that is not the draft's — see the note in `enter`. */
    let extraWorlds = [];
    let currentId = null;

    /** @type {number[]} the wild Pokemon standing in this map's grass, by NPC id. */
    let wildIds = [];

    /**
     * The level of the creature that walks onto slot `k` on its `gen`-th refill.
     *
     * **Rolled when it arrives, not when it is fought.** `encounter.engage` used to take the
     * species from the slot and the level from the encounter index, which was invisible while
     * the only thing a level did was decide a fight — but a plate over a wandering creature's
     * head advertises it, and a number that changed the moment you touched it would be a lie
     *.
     *
     * Its own sibling stream (`hunts/level/…`) rather than a draw appended to the slot's
     * respawn stream: sibling streams cannot perturb each other (src/core/rng.js), so every
     * species and shiny this module has ever rolled from a seed still rolls the same.
     * The band is `encounter`'s own (`levelBand` of the party's best member), so a hunt does
     * not suddenly stand up level-40 wildlife for a level-5 party.
     */
    function levelForSlot(biomeId, k, gen) {
      const encounter = ctx.get('encounter');
      const band = (isLive(encounter) && typeof encounter.band === 'function')
        ? encounter.band() : null;
      const min = Math.max(1, Math.round(Number(band?.min) || 3));
      const max = Math.max(min, Math.round(Number(band?.max) || min + 3));
      return ctx.rng.fork(`hunts/level/${biomeId}/${k}/${gen}`).int(min, max);
    }

    function disposeExtras() {
      for (const w of extraWorlds) w.dispose?.();
      extraWorlds = [];
    }
    bus.on('world:unloaded', disposeExtras);

    /** Takes the wild Pokemon off the map. Called before every re-entry, so they never stack. */
    function clearWild() {
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.removeNpc === 'function') {
        for (const id of wildIds) sim.removeNpc(id);
      }
      wildIds = [];
    }
    bus.on('world:unloaded', clearWild);

    /**
     * **A lap is a rest.** Without it one lost fight ends the session: the lead faints, the
     * next member steps up, and a wiped party walks its circuit forever meeting nothing.
     *
     * Per LAP and not per second, because that is what survives being chunked: `offline`
     * applies a gap in one call and `idle` drains it in slices, and a heal counted in whole
     * laps lands identically either way (src/idle/index.js). The full rule — a potion below a threshold,
     * and the Pokemon Center — is phase 6; this is the floor.
     */
    bus.on('player:enteredTile', ({ cx, cz }) => {
      const info = built.get(currentId);
      const loop = info?.loop;
      if (!loop) return;
      // Only a landing ON the loop advances the counter. Every tile of an off-loop detour —
      // chasing a wild, or `resyncToLoop`'s own backstop below — used to count too, so
      // `hunt:lap` and the `triedThisLap` clear fired early and drifted out of phase with the
      // circuit actually being walked. `onLoopSet` (built alongside the loop, below) is a
      // `Set` so this is a lookup rather than a scan of `loop.cells` on every tile.
      if (info.onLoopSet && !info.onLoopSet.has(`${cx},${cz}`)) return;
      if (++lapSteps < loop.cells.length) return;
      lapSteps = 0;
      triedThisLap.clear();
      const pokemon = ctx.get('pokemon');
      if (!isLive(pokemon) || typeof pokemon.party !== 'function') return;
      const frac = Math.max(0, Math.min(1, Number(ctx.config.lapHealFraction ?? 0.34)));
      for (const m of pokemon.party()) {
        if (!m || m.hp >= m.maxHp) continue;
        // `revive` because the header above is otherwise a promise this loop does not keep:
        // the guard at `pokemon/instance.js` heal() is `if (inst.hp <= 0 && !revive) return`, so
        // the one case the rest exists for — "a wiped party walks its circuit forever meeting
        // nothing" — was the one case it silently declined.
        //
        // `status` clears on the revive branch and only there. A faint does not cure anything:
        // `battle/engine.js` never nulls `status` on a KO and `encounter`'s writeBack copies the
        // combatant's back onto the instance, so a member that fainted poisoned would otherwise
        // come back at 34 % still poisoned and take residual chip on turn one of the next fight —
        // straight back towards the wipe this rest exists to prevent. Every other revive in the
        // game clears it (`INST.revive`, `pokemon.reviveAll`); a plain top-up still does not.
        const raise = m.hp <= 0;
        pokemon.heal?.(m.instanceId, {
          hp: Math.max(1, Math.round(m.maxHp * frac)), status: raise, revive: raise,
        });
      }
      bus.emit('hunt:lap', { biome: currentId, length: loop.cells.length });
    });

    /**
     * **The party leaves the circuit to reach what it is hunting — Tibia-style: whichever
     * living wild is nearest within `config.aggroTiles` pulls the trainer off the path, routed
     * around collision by a real search rather than a fixed cell pair, however many steps the
     * search actually takes to close the distance.**
     *
     * The brief asks that a battle begin when the trainer's Pokemon *physically reaches* a
     * living wild. What changed from the fixed-slot detour this replaced: that one fired only
     * when the head landed on the ONE cell the CURRENT lap's next slot happened to be authored
     * two cells off of. This fires from ANY tile entered while ANY occupied slot sits within
     * `aggroTiles`, picks the nearest one by its own LIVE position (a wild drifts a tile around
     * its tether — the same lookup `wanderingPlates()` already does), and paths to it with
     * `bfsPath` (`core/path.js`) — bounded to `aggroTiles`, so a plan is never accepted for a
     * target `bfsPath` had to notice was in range but the party would have to leave the loop
     * further than it was ever asked to go to reach.
     *
     * **This used to be a one-cell approach, and only a one-cell approach, on purpose — the
     * comment that stood here documented a real, measured corruption and a real workaround for
     * it. Both premises turned out to be wrong about WHERE the bug lived, not about whether it
     * existed.** `hunt-recovers.spec.js`'s "a lap of the circuit" case reliably turned a
     * multi-step round trip into a **permanent** stall of the circuit's own `strict` scripted
     * route, every run — that measurement was real. What it was blamed on — "the exact
     * mechanism inside `line.js`'s conga-line trail" — was not where it lived. Two real causes,
     * both in this module's own neighbourhood:
     *
     *  1. `simulation`'s `advance()` used to queue a detour as **both legs at once** —
     *     `[step, opposite(step)]` — and shift a step off that queue and hand it to `line.step`
     *     without checking the boolean `line.step` returns. `Line.step` returns `false` when
     *     the cell ahead fails `passable` and, in that case, only turns the head's facing — it
     *     does NOT move it. A blocked step was consumed from the queue anyway, so the return
     *     leg then ran one cell short and the head came home off the very cell its own `strict`
     *     route expected it to be standing on. `route.next()` then found the next scripted
     *     direction blocked, forever — a permanent stall caused by a silently dropped step, not
     *     by anything unresolved in the trail itself.
     *  2. This module planned the path with terrain passability alone, but the walker steps
     *     with terrain **and** the `solid` cell-occupancy map every wild NPC is spawned onto
     *     (`solid: true`, `spawnWild`/`_refill`, below). A multi-step BFS path can legitimately
     *     route through a cell another wild is currently standing on — invisible to a
     *     terrain-only plan — and that is exactly the kind of blocked step that triggers cause 1
     *     on a crowded lap. A one-cell approach almost never hits this, because `bfsPath` stops
     *     at Chebyshev distance 1 of the target and the one verified step is nearly always
     *     clear — which is why the workaround looked like it was addressing the trail and was
     *     actually just avoiding cause 2 by accident.
     *
     * Both are fixed at the source rather than avoided: `simulation.detour()` now takes the
     * out leg only and generates the return trip itself from the steps it actually walked (see
     * `simulation/index.js`'s own long comment on `detour`), so a blocked step can never leave a
     * return leg short again; and the path here is planned with `sim.passableFor(held.npcId)`
     * — the walker's own terrain-AND-solid check, minus the target's own claimed cell — so a
     * plan cannot route through a body the walker would actually refuse to step into. With both
     * fixed, the one-step guard was a bound on the SYMPTOM rather than the FIX, and lifting it
     * is what actually delivers the Tibia-style aggro the brief asked for: `range`, below, is
     * `aggroTiles` itself, not 1, and a wild anywhere inside that radius is walked to and walked
     * home from — cleanly, however long the approach turns out to be — rather than merely
     * noticed and left for ordinary progress round the loop to stumble into.
     */
    bus.on('player:enteredTile', ({ cx, cz }) => {
      const sim = ctx.get('simulation');
      const enc = ctx.get('encounter');
      if (!isLive(sim) || typeof sim.detour !== 'function') return;
      if (sim.detouring() || (isLive(enc) && enc.active?.())) return;
      // A party with nothing left standing walks past its wildlife rather than detouring
      // toward a fight it cannot take — `encounter/index.js`'s `slotNear()` already refuses
      // to engage one for the same reason; without this check here too, the walk toward it
      // still happened, wasting the lap's own rest (`hunt:lap`, below) on trips to wilds that
      // were never going to be fought.
      const pokemon = ctx.get('pokemon');
      const canFight = !isLive(pokemon) || typeof pokemon.firstConscious !== 'function'
        || !!pokemon.firstConscious();
      if (!canFight) return;
      const list = built.get(currentId)?.slots ?? [];
      if (!list.length) return;
      const npcs = typeof sim.npcs === 'function' ? sim.npcs() : [];
      const range = Math.max(1, Math.round(Number(config?.aggroTiles) || 5));

      // Every occupied slot's own LIVE position, in reach and not already given up on this
      // lap — nearest first, so a crowded stretch of the circuit always tries its closest
      // neighbour before a farther one.
      const candidates = [];
      for (let k = 0; k < list.length; k++) {
        if (triedThisLap.has(k)) continue;
        const held = occupancy.get(k);
        if (!held) continue; // defeated and not yet respawned
        const live = npcs.find((n) => n.id === held.npcId);
        if (!live) continue; // a slot can report occupied for one tick after its npc is gone
        const dist = Math.max(Math.abs(live.cx - cx), Math.abs(live.cz - cz));
        if (dist > range) continue;
        candidates.push({ k, held, live, dist });
      }
      if (!candidates.length) return;
      candidates.sort((a, b) => a.dist - b.dist || a.k - b.k);
      const { k, held, live } = candidates[0];

      // Plan against the SAME passability the walker steps with — terrain AND the `solid`
      // occupancy map, minus the target's own claimed cell — not terrain alone: see cause 2 in
      // this handler's own header comment. Falls back to a terrain-only predicate for a
      // quarantined or pre-slice `simulation` that has not shipped `passableFor` yet, so this
      // never throws on an older registry.
      const terrain = ctx.get('terrain');
      const passable = isLive(sim) && typeof sim.passableFor === 'function'
        ? sim.passableFor(held.npcId)
        : (isLive(terrain) && typeof terrain.passable === 'function' ? terrain.passable : () => true);
      const path = bfsPath({ cx, cz }, { cx: live.cx, cz: live.cz }, passable);
      if (!path || path.length > range) {
        // No path at all: either already in contact (the generic engage check on this same
        // event handles that, `encounter/index.js`'s `slotNear`) or genuinely unreachable.
        // Longer than `range`: `bfsPath` had to detour so far around collision that the real
        // walk would leave the loop further than `aggroTiles` was ever meant to reach for this
        // target — left for ordinary progress round the loop to close the rest of the way.
        // Either way, not worth re-trying every single tile for the rest of the lap.
        triedThisLap.add(k);
        return;
      }
      if (typeof sim.holdNpc === 'function') sim.holdNpc(held.npcId, true);
      heldNpcId = held.npcId;
      triedThisLap.add(k);
      // The out leg only — `simulation` generates and walks the return leg on its own now,
      // from whatever it actually walks, so it always comes home clean even if this plan turns
      // out to be stale by the time the party is partway along it.
      sim.detour(path);
    });

    /**
     * Cuts a mid-approach detour short the instant a fight actually starts.
     *
     * `config.slotEngageTiles` is 1: the party can engage as soon as it is one cell off a slot,
     * which can land well before a multi-step detour above finishes walking every queued step —
     * the target's own tether drift can also close the last cell of the gap on its own. Either
     * way, the moment a fight is on, the rest of the plan is chasing a creature that will not be
     * standing there once the duel resolves. `detourHome()` drops whatever `out` still has
     * queued and generates `back` from exactly what the party actually walked, so the return
     * trip is always correct even though the approach was cut off partway through — the same
     * safety net a blocked step gets inside `simulation` itself.
     */
    bus.on('encounter:started', () => {
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.detourHome === 'function') sim.detourHome();
    });

    /**
     * Releases whatever wild `holdNpc(id, true)` froze for the approach that just ended in a
     * fight. The other way an approach can end — no fight, the party comes home empty-handed —
     * has no event of its own; `_refill`, below, catches that by watching `sim.detouring()` fall
     * from `true` to `false` instead. Between the two, a wild is never left `held: true` forever
     * because its approach was interrupted or simply failed to land a fight.
     */
    bus.on('encounter:resolved', () => {
      if (heldNpcId == null) return;
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.holdNpc === 'function') sim.holdNpc(heldNpcId, false);
      heldNpcId = null;
    });

    /**
     * **Recovery backstop: walks the head back onto its own loop and resumes the circuit.**
     *
     * Stages 1-2 (`detourHome`, `stepOptions`, `src/simulation/index.js`) fix the two ways the
     * party used to end up off its own path for good, so this should essentially never fire —
     * it exists for whatever they do not fully cover. `bfsCells` (`core/path.js`) is asked for
     * an inclusive cell path from the head's current cell to the nearest `loop.cells` entry it
     * can actually reach, candidates tried nearest-first (Chebyshev) so the first one that
     * actually resolves wins and the search stays cheap. That path is walked as a ONE-WAY
     * detour (`{ returnHome: false }` — this is a move onto the loop, not an out-and-back), and
     * `_refill`'s own `wasDetouring` edge detector, below, picks up the arrival and hands the
     * circuit back with `setRoute`, rotated (`routeFrom`) so its first step is the one the cell
     * it landed on owes. `routeFrom`'s `i` is where the TRAINER stands, `gap` cells behind the
     * head (see `routeFrom`'s own doc below) — the head is what this walks, so the index fed in
     * is the landing cell's own index minus `gap`.
     *
     * Guarded exactly like the aggro handler above: never mid-detour, never mid-fight.
     */
    function resyncToLoop() {
      const loop = built.get(currentId)?.loop;
      if (!loop?.cells?.length) return;
      const sim = ctx.get('simulation');
      const enc = ctx.get('encounter');
      if (!isLive(sim) || typeof sim.detour !== 'function' || typeof sim.followerCell !== 'function') return;
      if (sim.detouring() || (isLive(enc) && enc.active?.())) return;

      // The SAME passability the party's own walker steps with (mover id `0`, `simulation`'s
      // own placeholder for the party) — not terrain alone — so this cannot plan a walk home
      // through a solid wild's claimed cell. Falls back to terrain-only for a quarantined or
      // pre-slice `simulation` with no `passableFor` yet.
      const terrain = ctx.get('terrain');
      const passable = typeof sim.passableFor === 'function'
        ? sim.passableFor(0)
        : (isLive(terrain) && typeof terrain.passable === 'function' ? terrain.passable : () => true);
      const head = sim.followerCell();

      const ranked = loop.cells
        .map((c) => ({ c, d: Math.max(Math.abs(c.cx - head.cx), Math.abs(c.cz - head.cz)) }))
        .sort((a, b) => a.d - b.d);
      for (const { c } of ranked) {
        if (c.cx === head.cx && c.cz === head.cz) continue; // already there — bfsCells refuses
        const cells = bfsCells(head, c, passable, { maxTiles: 512 });
        if (!cells) continue;
        // Cell path -> `core/dir.js`-style directions, via the same LOOP_DX/LOOP_DZ table
        // `audit()` already walks a route with, below — one lookup rather than a second
        // dx/dz-to-dir mapping.
        const dirs = [];
        for (let k = 1; k < cells.length; k++) {
          const dx = cells[k].cx - cells[k - 1].cx;
          const dz = cells[k].cz - cells[k - 1].cz;
          const dir = LOOP_DX.findIndex((x, d) => x === dx && LOOP_DZ[d] === dz);
          if (dir < 0) return; // a non-4-way step should never come back from bfsCells
          dirs.push(dir);
        }
        if (!dirs.length) return;
        resyncPending = true;
        sim.detour(dirs, { returnHome: false });
        return;
      }
      log.warn(`hunts/${currentId}: resyncToLoop found no reachable cell on its own loop`);
    }

    /** A scripted route stalled (`simulation/index.js`'s `walk:stalled`) — walk back to it. */
    bus.on('walk:stalled', () => resyncToLoop());

    /**
     * The cheap half of the backstop: if the head has landed off the loop for more than
     * `gap + 2` consecutive tiles, something left it off-circuit without ever stalling the
     * route (an aggro approach that never made it home, on a build where stages 1-2 have not
     * landed) — resync rather than wait for a stall that may never come. Reuses the same
     * `onLoopSet` lookup the lap counter above shares, so a cell is never tested against
     * `loop.cells` twice.
     */
    bus.on('player:enteredTile', ({ cx, cz }) => {
      const info = built.get(currentId);
      if (!info?.loop || !info.onLoopSet) return;
      if (info.onLoopSet.has(`${cx},${cz}`)) { offLoopStreak = 0; return; }
      const sim = ctx.get('simulation');
      const gap = isLive(sim) && typeof sim.gap === 'function' ? Math.max(0, sim.gap()) : 2;
      if (++offLoopStreak > gap + 2) {
        offLoopStreak = 0;
        resyncToLoop();
      }
    });

    /**
     * Stands wild Pokemon in the biome's own grass.
     *
     * The whole-game critic's headline: *"not one wild Pokemon appears in any of the sixteen
     * hunt frames across four biomes and four hours; the city plaza has more creatures in it
     * than the hunting grounds do."* A hunting ground with nothing to hunt is the brief's
     * headline feature missing from the one place it is supposed to be.
     *
     * Three seams, and no fourth:
     *
     *  - **which species** is `encounter.tablesFor(biome, tod)` — the same weighted table the
     *    idle loop rolls against, so what is standing in the grass at 21:00 is what you would
     *    actually meet there at 21:00. It comes back weight-expanded (`tables.js`), so a
     *    uniform pick from it is the weighted pick;
     *  - **where** is the biome's own build report: each `biomes/*.js` returns `wild`, a list
     *    of cells inside its encounter grass and clear of the route the party walks;
     *  - **how it is drawn** is `simulation.spawnNpc`, which stages through `pokemon`'s sprite
     *    field — one InstancedMesh for the whole cast, so eleven creatures cost zero extra
     *    draw calls and pick up contact shadows and the idle animation for free.
     *
     * They **stand** rather than wander, and that is a composition call with a measurement
     * behind it. A wandering NPC advances with the party — `advanceTo(3, 7)` is 22 sim ticks,
     * which is 4.4 tiles at `walkSecondsPerTile` 0.25 — so a creature placed two cells off the
     * lane can be anywhere within four of it by the time the shutter opens, and in
     * `coast-route-21` one walked onto the trainer's head. Standing keeps every one of them
     * exactly where `wildCells` put it, which is the placement this module can actually
     * reason about. They still animate: `poseWalker` gives a stationary Pokemon the idle
     * shuffle off simulated time.
     *
     * The atlas is built **before** the spawn loop rather than by it. `Cast.sync` awaits
     * `pokemon.sprites.prepare` internally, so spawning eleven NPCs one at a time would leave
     * real async work outstanding when `__READY__` flips, and a screenshot could catch the
     * field half-populated — a determinism hole that shows up as a shot that differs from
     * itself. Preparing every sheet first leaves `Cast.sync` with nothing but microtasks.
     */
    async function spawnWild(biome) {
      clearWild();
      occupancy.clear();
      refills.length = 0;
      generations.clear();
      const sim = ctx.get('simulation');
      const pokemon = ctx.get('pokemon');
      if (!isLive(sim) || typeof sim.spawnNpc !== 'function') return 0;
      if (!isLive(pokemon) || typeof pokemon.species !== 'function') return 0;
      // The SLOTS, not `wildCells`' scenery scatter. A slot is a fixed respawn point two
      // cells off the circuit (src/hunts/index.js) and the creature on it drifts one tile around it, so the
      // party meets the same wildlife in the same places on every lap — which is what makes a
      // hunt a route rather than a lucky dip. Falls back to the old scatter when a map could
      // not be given a loop, so a biome with no circuit still has animals in it.
      /**
       * **Slots only.** The old fallback spawned the biome's decorative `wildCells` scatter
       * when a map got no circuit — and those creatures are scenery: they sit at no slot, so
       * `takeSlot` has nothing to hand over and a player can walk past them forever. The brief
       * is explicit that every wild visible on a hunt map must be huntable, so a map with no
       * loop now stands empty and says so. A wood with no animals is a legible bug; a wood full
       * of animals that cannot be fought is not.
       */
      const cells = (built.get(biome.id)?.slots ?? []).map((c, i) => ({ ...c, k: i }));
      if (!cells.length) {
        log.warn(`hunts/${biome.id}: no spawn slots (no circuit was found) — the wood stands empty`);
        return 0;
      }

      const env = ctx.get('environment');
      const tod = (isLive(env) && typeof env.getTimeOfDay === 'function')
        ? env.getTimeOfDay() : (ctx.config.tod ?? 12);
      const encounter = ctx.get('encounter');
      const table = (isLive(encounter) && typeof encounter.tablesFor === 'function')
        ? (encounter.tablesFor(biome.id, tod) ?? []) : [];
      if (!table.length) {
        log.warn(`hunts/${biome.id}: encounter has no table at tod ${tod} — the grass stays empty`);
        return 0;
      }

      // Seeded off the biome *and the hour*, so the same URL gives the same creatures and a
      // different hour gives the nocturnal ones. Never `Math.random` (src/core/rng.js).
      const rng = ctx.rng.fork(`hunts/wild/${biome.id}/${Math.round(tod * 4)}`);
      /** A short cast, so a frame reads as a place with animals in it rather than a zoo. */
      const roster = [];
      for (let i = 0; i < WILD_SPECIES_CAP * 4 && roster.length < WILD_SPECIES_CAP; i++) {
        const s = pokemon.species(table[rng.int(0, table.length - 1)]);
        if (s && !roster.some((r) => r.name === s.name)) roster.push(s);
      }
      if (!roster.length) return 0;

      const n = Math.min(WILD_CAP, cells.length);
      // At most one shiny, and usually none. One is a reward for looking; two in a frame is a
      // bug report. Both rolls are seeded, so whether this map has one is a property of the
      // seed and the hour rather than of when the shutter opened.
      const shinyAt = rng.next() < 0.35 ? rng.int(0, n - 1) : -1;
      const picked = cells.slice(0, n).map((c, i) => ({
        ...c, k: c.k ?? i, species: roster[i % roster.length], shiny: i === shinyAt,
        level: levelForSlot(biome.id, c.k ?? i, 0),
      }));

      await pokemon.sprites?.prepare?.(picked.map((p) => ({ species: p.species, shiny: p.shiny })));

      for (const p of picked) {
        const npc = sim.spawnNpc({
          species: p.species, shiny: p.shiny, cx: p.cx, cz: p.cz, dir: p.dir ?? 0,
          // One tile of drift around the slot and no further: far enough that the wood is
          // alive, near enough that the slot is still where the player learned it was.
          tether: { cx: p.cx, cz: p.cz, radius: 1 },
          // Blocks the party's step (src/simulation/index.js). Safe because a slot is at Chebyshev exactly 2 from
          // the circuit and the tether radius is 1, so a wild can never stand on a loop cell.
          solid: true,
          // Named, because `simulation` forks its stream off the name: an unnamed NPC keys off
          // an incrementing id, so adding one more would reshuffle the walk of every creature
          // already on the map.
          name: `wild/${biome.id}/${p.cx},${p.cz}`,
        });
        if (npc) {
          wildIds.push(npc.id);
          // The slot remembers what is standing on it, so `encounter` can engage it by index
          // and this module can put something new there when the fight is over.
          occupancy.set(p.k ?? wildIds.length - 1, {
            npcId: npc.id, species: p.species, shiny: !!p.shiny, level: p.level,
            cx: p.cx, cz: p.cz, dir: p.dir ?? 0,
          });
        }
      }
      return wildIds.length;
    }

    /**
     * A biome's own predetermined circuit — `stitchLoop` (`compose.js`) run through the marker
     * names it names in `loop.via`, in order, closed last-to-first. Tried before `findLoop`'s
     * rectangle-grown fallback below; `null` (never throws) when the biome declares no `via`,
     * names fewer than three markers, names one this draft does not have, or `stitchLoop`
     * itself rejects the ring (a leg that would not stitch, a revisited or too-close-to-the-edge
     * cell, no opening straight run) — every one of those is a `log.warn`, because a caller
     * that falls back to a found circuit without saying so is exactly what `audit()`, below,
     * exists to catch when it happens.
     */
    function authoredLoop(draft, biome, c) {
      const via = biome.loop && biome.loop.via;
      if (!Array.isArray(via) || via.length < 3) return null;
      const points = [];
      for (const name of via) {
        const m = draft.marker(name);
        if (!m) {
          const known = [...draft.markers.keys()].join(', ') || 'none';
          log.warn(`hunts/${biome.id}: authored circuit names marker "${name}", `
            + `which this draft does not have (has: ${known}) -- falling back to a found circuit`);
          return null;
        }
        points.push({ cx: m.cx, cz: m.cz });
      }
      const opts = loopOptions(biome, c.config);
      return stitchLoop(draft, points, {
        straightLead: opts.straightLead, preferTags: opts.preferTags, margin: opts.margin,
        onLegFailed: ({ index, from, to }) => log.warn(
          `hunts/${biome.id}: authored circuit leg ${via[index]} (${from.cx},${from.cz}) `
          + `-> ${via[(index + 1) % via.length]} (${to.cx},${to.cz}) could not be stitched `
          + 'over the shipped map -- falling back to a found circuit'),
        onReject: (reason) => log.warn(
          `hunts/${biome.id}: authored circuit rejected (${reason}) -- falling back to a found circuit`),
      });
    }

    for (const biome of BIOMES) {
      terrain.register(`hunt-${biome.id}`, async (draft, c) => {
        const tiles = c.get('tiles');
        await tiles.load(draft.tileset);
        for (const extra of biome.alsoLoad ?? []) await tiles.load(extra);
        const palette = makePalette(tiles, draft.tileset, log);
        const rng = c.rng.fork(`hunts/${biome.id}/${draft.seed}`);
        const report = biome.build(draft, c, palette, rng, log) ?? {};

        // The circuit and its slots are computed HERE, against the finished draft, because
        // this is the only place that has one. `showcaseDefault`'s marker is the biome's own
        // idea of where the good ground is, so the loop is grown around that.
        // Every marker the biome placed, its own favourite first, then the spawn. A cave is a
        // system of galleries and searching only around the showcase marker found nothing.
        // Anchors for the FOUND fallback only — the authored path (above) resolves its own
        // markers by name and never touches this list.
        const preferred = biome.presets?.[biome.showcaseDefault]?.marker;
        const anchors = [...draft.markers.entries()]
          .sort(([a], [b]) => (a === preferred ? -1 : b === preferred ? 1 : 0))
          .map(([, m]) => m);
        anchors.push(draft.spawn);
        // Authored first, found as the fallback — see the `LOOP` header comment above.
        const loop = authoredLoop(draft, biome, c) ?? findLoop(draft, anchors, {
          ...loopOptions(biome, c.config),
          // Seeded off the biome and the map seed, so the bends are a property of the world
          // rather than of when the page happened to load.
          rng: c.rng.fork(`hunts/loop/${biome.id}/${draft.seed}`),
        });
        // `stitchLoop` always stamps `source: 'authored'`; `findLoop` knows nothing about
        // provenance at all, so a loop that comes back without one was found, not authored.
        if (loop && loop.source == null) loop.source = 'found';
        const slots = loop
          ? slotsForLoop(draft, loop.cells, c.rng.fork(`hunts/slots/${biome.id}/${draft.seed}`),
            { count: SLOTS })
          : [];
        if (!loop) {
          log.warn(`hunts/${biome.id}: no closed circuit fits this map between `
            + `${LOOP.min} and ${LOOP.max} cells — the party will stand still`);
        }
        // The "is this cell on the loop" lookup `lapSteps` and `resyncToLoop`'s off-loop streak
        // both share (points 4/5) — built once, here, rather than scanned per tile.
        const onLoopSet = loop ? new Set(loop.cells.map((cell) => `${cell.cx},${cell.cz}`)) : null;
        built.set(biome.id, { ...report, loop, slots, missing: palette.missing(), onLoopSet });
      });
    }

    /**
     * The circuit, rotated so the head's first step is the one it owes from where it stands.
     *
     * `cells[i]` is where the trainer is put; the head lands `gap` cells ahead on
     * `cells[i + gap]`, and `dirs[i + gap]` is the step that cell is due to take. `enter()` is
     * the `i = 0` case of this.
     */
    function routeFrom(loop, i, gap) {
      const dirs = parseLoop(loop.route);
      if (dirs.length <= gap) return { dirs, rotated: dirs };
      const at = ((i + gap) % dirs.length + dirs.length) % dirs.length;
      return { dirs, rotated: [...dirs.slice(at), ...dirs.slice(0, at)] };
    }

    /**
     * Stands the party **on its own circuit**, at the cell nearest the place a preset frames.
     *
     * This replaced `stageWalk`, which installed the biome's authored `walk.route` string —
     * `'e16 n2 e10 s2'` and three like it. Those predate the found loop and
     * survived it, so `/` walked the circuit and **every showcase and preset capture walked
     * something else**. Measured before the change: in `?showcase=hunts&mode=meadow` the party
     * visited 53 cells, **two of them on the loop**, and met **nothing at all** in two thousand
     * ticks — a lap that never gets near a wild Pokemon, in the one view a person is most
     * likely to look at. Every hunt frame this project had judged was staged that way
     *.
     *
     * The marker is a *framing* request, not a position: the party stands on the nearest loop
     * cell to it, so the picture is of the place asked for and the walker is on the path it
     * will actually walk. A biome with no circuit stands still at the marker, which is what
     * `enter()` does too — a hunt that cannot walk its loop should look broken rather than look
     * like a different game.
     */
    function stageOnLoop(sim, biome, marker, spec = {}) {
      const loop = built.get(biome.id)?.loop;
      const gap = typeof sim.gap === 'function' ? Math.max(0, sim.gap()) : 2;
      if (!loop?.cells?.length) {
        if (typeof sim.halt === 'function') sim.halt();
        return { dir: spec.dir ?? marker?.dir ?? 3, tiles: 0, subTicks: 0, on: null };
      }
      /**
       * The nearest cell that **starts a straight run at least as long as the queue**.
       *
       * `sim.teleport` places the *trainer* and `Line.place` lays the whole queue along one
       * direction, so the head lands `gap` cells ahead in a straight line — which is only on
       * the ring if the next `gap` steps all go the same way. `enter()` gets this for free
       * because `rotateToStraight` opens the ring on its longest straight; an arbitrary cell
       * near a marker does not, and a start one cell before a turn puts the head off the
       * circuit. Measured on the coast before this: 63 of 70 visited cells were off its own
       * loop.
       */
      const dirsAll = parseLoop(loop.route);
      // `gap + 1`, not `gap`: the run has to cover the cells the queue is laid across AND the
      // head's own first step, which is exactly what `straightLead` (`followerGapTiles + 2`)
      // guarantees for the ring's opening.
      const straightAt = (i) => {
        for (let k = 0; k <= gap; k++) {
          if (dirsAll[(i + k) % dirsAll.length] !== dirsAll[i % dirsAll.length]) return false;
        }
        return true;
      };
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < loop.cells.length; i++) {
        if (!straightAt(i)) continue;
        const c = loop.cells[i];
        const d = Math.abs(c.cx - (marker?.cx ?? 0)) + Math.abs(c.cz - (marker?.cz ?? 0));
        if (d < bestD) { bestD = d; best = i; }
      }
      // A ring bent past having any straight that long is the caller's problem, not something
      // to paper over with a start that puts the head in a hedge: fall back to the ring's own
      // opening, which `rotateToStraight` already chose for exactly this property.
      if (best < 0) best = 0;
      const { rotated } = routeFrom(loop, best, gap);
      // **`walk()` and not `setFormation()`**, and the reason is a guard three lines long:
      // `setFormation` refuses to start an autopilot under `config.showcase` (a showcase stages
      // its own frame and `?autowalk=0` pins one), so installing the route through it leaves a
      // showcase standing still. `enter()` has already set the formation — the head, the input
      // lock, `strict` — so all this has to do is hand over the route, which is exactly what
      // `stageWalk` did before it.
      if (typeof sim.walk === 'function') {
        sim.walk(rotated, {
          loop: true,
          strict: true,
          onStall: ({ cx, cz, dir }) => log.warn(
            `hunts/${biome.id}: the staged circuit stalled at (${cx},${cz}) facing ${dir}`),
        });
      }
      // Three tiles of walk so the queue is strung out along the path rather than stacked in
      // the pose `Line.place` laid it in — that is what it takes for the trainer and the lead
      // to be clear of each other at `followerGapTiles` 2.
      // **The trainer faces the direction of travel at ITS OWN cell**, not the head's next step.
      // `Line.place` lays the whole queue along this one heading, so handing it `dirs[best+gap]`
      // strung the party out along the wrong axis and put the head off the ring — measured on
      // the coast at 63 of 70 visited cells off its own loop.
      return { dir: dirsAll[best] ?? 3, tiles: 3, subTicks: 7, on: loop.cells[best] };
    }

    /** Where a preset stands the party, and how far back the camera sits for it. */
    function stage(marker, spec = {}) {
      const { ppu, offset = null } = spec;
      const draft = terrain.draft();
      const m = draft?.marker(marker);
      if (!m) {
        log.warn(`hunts: no marker "${marker}" on "${terrain.current()}" — it has ` +
          `${draft ? [...draft.markers.keys()].join(', ') : 'no map loaded'}`);
        return false;
      }
      // Zoom is `pixelsPerUnit` on the 16/32/64 ladder, not a camera distance: the camera is
      // orthographic, so standing it further back changes nothing about the size of anything
      //.
      if (ppu != null) ctx.config.set({ pixelsPerUnit: ppu });
      const sim = ctx.get('simulation');
      const biome = byId(currentId ?? 'forest');
      // The camera follows the trainer every frame, so a framing that only
      // moves the rig is undone before the shutter; the city has the same constraint. Move the
      // party, and the rig follows it.
      if (isLive(sim) && typeof sim.teleport === 'function') {
        const walk = stageOnLoop(sim, biome, m, spec);
        const at = walk.on ?? m;
        sim.teleport(at.cx, at.cz, walk.on ? walk.dir : (m.dir ?? spec.dir ?? 3));
        if (ctx.config.timeFrozen) {
          if (typeof sim.advanceTo === 'function') sim.advanceTo(walk.tiles, walk.subTicks);
          else if (typeof sim.advanceSteps === 'function') sim.advanceSteps(walk.tiles * 5);
          sim.freeze(true);
        }
        if (offset && typeof sim.frameOffset === 'function') sim.frameOffset(offset[0], offset[1]);
      } else {
        ctx.three.rig?.setFocus?.(m.cx + 0.5, terrain.height(m.cx, m.cz), m.cz + 0.5, true);
      }
      return true;
    }

    const api = {
      /** The biome menu the UI and the showcase both read. */
      list: () => BIOMES.map((b) => ({
        id: b.id, name: b.name, preset: b.preset, tileset: b.tileset,
        w: b.w, h: b.h, presets: Object.keys(b.presets ?? {}),
        formation: { ...HUNT_FORMATION, ...(b.formation ?? {}) },
        requiredLevel: b.requiredLevel ?? 0,
        // Only known once the map has been built — a biome that has never been entered
        // reports null rather than a guess.
        loop: built.get(b.id)?.loop
          ? {
            route: built.get(b.id).loop.route, w: built.get(b.id).loop.w, h: built.get(b.id).loop.h,
            corners: built.get(b.id).loop.corners, length: built.get(b.id).loop.cells.length,
          }
          : null,
        slots: built.get(b.id)?.slots?.length ?? 0,
      })),

      current: () => currentId,
      /**
       * The raw biome descriptor (`biomes/*.js`'s own export) — `presets` with its `{marker,
       * ppu}` shape intact, `loop.via`, `weather`, `showcaseDefault`. `biome()` below only
       * ever exposed a display-shaped subset; this is for tooling that has to freeze a biome
       * exactly, not present it — the Map Studio snapshot exporter (`studio/snapshot/main.js`).
       */
      descriptor: (id) => ({ ...byId(id) }),
      biome: (id) => {
        const b = byId(id);
        return {
          id: b.id, name: b.name, preset: b.preset, tileset: b.tileset, w: b.w, h: b.h,
          requiredLevel: b.requiredLevel ?? 0,
          formation: { ...HUNT_FORMATION, ...(b.formation ?? {}) },
        };
      },

      /**
       * Loads a biome and stands the party at its entrance.
       * @param {string} id
       * @returns {Promise<object|null>} the terrain handle
       */
      async enter(id = 'forest') {
        const biome = byId(id);
        const env = ctx.get('environment');
        // Liveness is tested on a *value*, never on `typeof`: the registry's null object
        // answers a typeof check with true even when the module is dead.
        if (isLive(env)) {
          env.setBiomePreset?.(biome.preset);
          env.setWeather?.(biome.weather?.[0] ?? 'clear', biome.weather?.[1] ?? 0);
        }
        const handle = await terrain.load(`hunt-${biome.id}`, {
          w: biome.w, h: biome.h, tileset: biome.tileset,
          biome: biome.id, seed: ctx.config.seed,
        });
        currentId = biome.id;
      // Reset with the scene: it used to carry across a biome change, so the first lap of a
      // new hunt healed early by however many steps the previous one had banked.
      lapSteps = 0;
      offLoopStreak = 0;
      resyncPending = false;

        // `terrain.load` builds one `InstancedWorld` from one tileset, and `InstancedWorld`
        // resolves every placement's id against that tileset alone. A model from `props` put
        // through an AdAstra draft therefore draws AdAstra's model of the same number, with
        // no warning anywhere, because both ids exist. Anything from another
        // set gets its own world here, disposed on `world:unloaded`.
        disposeExtras();
        for (const extra of built.get(biome.id)?.extras ?? []) {
          if (!extra.placements?.length) continue;
          extraWorlds.push(ctx.get('tiles').buildInstances(
            ctx.three.scene, extra.tileset, extra.placements, { name: `hunt:${biome.id}:${extra.tileset}` },
          ));
        }

        // Practical lights. A cave is "lit by its openings and by whatever glows down there"
        // (`environment`'s own preset note), and a point light is the only thing that can
        // make that fall off — a preset can raise the ambient but it cannot put the light in
        // one place. `lamps.clear()` first, so re-entering a biome does not stack them.
        if (isLive(env) && env.lamps) {
          env.lamps.clear();
          for (const light of built.get(biome.id)?.lights ?? []) env.lamps.add(light);
        }

        // The grass gets its animals before the party is stood in it, so the sprite atlas is
        // built once for the whole cast — party and wildlife together — rather than rebuilt
        // eleven more times behind a `__READY__` that has already flipped.
        const wild = await spawnWild(biome);

        const draft = terrain.draft();
        const spawn = draft?.spawn ?? { cx: biome.w >> 1, cz: biome.h >> 1, dir: 2 };
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.teleport === 'function') {
          // Before `teleport`, not after: `placePlayer` lays the queue out through
          // `formation.head`, and it installs this biome's own wander in place of whatever
          // the last scene was walking. `stage()` still wins, because it sets its scripted
          // route after `enter()` has returned.
          const loop = built.get(biome.id)?.loop ?? null;

          /**
           * **The route belongs to the HEAD, and `placePlayer` places the TRAINER.**
           *
           * `placePlayer(cx, cz, dir)` stands the trainer on that cell and lays the lead
           * Pokemon `gap` cells ahead of it — and in a hunt the Pokemon is the head (src/simulation/index.js), so
           * teleporting to `loop.start` puts the walker that follows the route two cells PAST
           * the corner, off the circuit entirely. It then walked the first leg from the wrong
           * place, ran into the rectangle's own side and stalled: measured as 22 of a 58-cell
           * loop covered in 84 tiles of walking, with `audit` reporting the loop clean the
           * whole time, because the loop WAS clean — nobody was standing on it.
           *
           * So the trainer starts on `cells[0]`, which puts the head on `cells[gap]`, and the
           * route is rotated by `gap` so its first step is the one that cell is due to take.
           * `parseRoute` accepts an array, so the rotation needs no new syntax.
           */
          const gap = typeof sim.gap === 'function' ? Math.max(0, sim.gap()) : 2;
          const { dirs, rotated } = loop ? routeFrom(loop, 0, gap) : { dirs: [], rotated: [] };

          sim.setFormation?.({
            ...HUNT_FORMATION, ...(biome.formation ?? {}),
            // No circuit means no route, and `setFormation` falls back to standing still
            // rather than to a wander — a hunt that cannot walk its loop should look broken,
            // not look like a different game.
            autopilot: loop ? 'route' : 'none',
            route: loop ? rotated : null,
            label: `simulation/wander/hunt-${biome.id}`,
          });
          const at = loop?.start ?? spawn;
          sim.teleport(at.cx, at.cz, loop ? dirs[0] : (spawn.dir ?? 2));
        } else {
          ctx.three.rig?.setFocus?.(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);
        }
        // The arrival toast belongs to `travel`, which announces every destination including
        // the city — one owner, so a hop does not toast twice.
        // The shipped-map assertion, run on every entry so it cannot go stale: a failure is a
        // console warning the screenshot harness records in the JSON beside every PNG.
        const audit = api.audit(biome.id);
        log.info(`hunts: ${biome.name} — ${wild} wild Pokemon in the grass, `
          + `${audit.checked} framings audited${audit.ok ? ' clean' : `, ${audit.fails.length} SHORT`}`);
        return handle;
      },

      /** The wild Pokemon standing in the current map, for the selftest and the debug probe. */
      wild() {
        const sim = ctx.get('simulation');
        if (!isLive(sim) || typeof sim.npcs !== 'function') return [];
        const mine = new Set(wildIds);
        return sim.npcs().filter((n) => mine.has(n.id));
      },

      /**
       * A named camera framing. Also accepts a bare `"cx,cz"` so a critic can point the
       * camera at anything without a marker existing for it.
       */
      preset(name) {
        if (!name) return false;
        const biome = byId(currentId ?? 'forest');
        const literal = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(String(name));
        if (literal) {
          // **Staged exactly like a named preset, and that is not tidiness.** A critic points
          // the camera at a cell with `--preset "26,34"` — it is how the cave's pale card was
          // found — and the old branch teleported facing `2` and walked nothing, so every
          // literal framing reproduced the one defect three blind rounds named: the queue
          // stacked on a north-facing column with the back of the cap toward the camera.
          const sim = ctx.get('simulation');
          const cx = +literal[1], cz = +literal[2];
          if (isLive(sim) && typeof sim.teleport === 'function') {
            const walk = stageOnLoop(sim, biome, { cx, cz });
            const at = walk.on ?? { cx, cz };
            sim.teleport(at.cx, at.cz, walk.dir ?? 3);
            if (ctx.config.timeFrozen) {
              if (typeof sim.advanceTo === 'function') sim.advanceTo(walk.tiles, walk.subTicks);
              else if (typeof sim.advanceSteps === 'function') sim.advanceSteps(walk.tiles * 5);
              sim.freeze(true);
            }
          } else {
            ctx.three.rig?.setFocus?.(cx + 0.5, terrain.height(cx, cz), cz + 0.5, true);
          }
          return true;
        }
        const spec = (biome.presets ?? {})[name];
        if (!spec) return false;
        return stage(spec.marker ?? name, spec);
      },

      /** What the last build of a map reported — trees planted, cells resolved, gaps found. */
      stats: (id = currentId) => built.get(id ?? '') ?? null,

      markers() {
        const draft = terrain.draft();
        return draft ? [...draft.markers.entries()].map(([k, v]) => ({ name: k, ...v })) : [];
      },

      /**
       * **Checks every framing of the loaded biome against the map that actually shipped.**
       *
       * `src/hunts/selftest.js` cannot do this and says so in its own output: it builds
       * against a stub tileset *and* off a different RNG stream, so its maps are not these
       * maps. It reported 279/279 green for a round in which three shipped framings still
       * filed north, which is worse than having no selftest, because a green one is trusted.
       *
       * This runs on the real `MapDraft`, after the real `tiles` pack has decided every
       * model's real footprint, and it asserts the two things a framing has to have:
       *
       *  - **the lane.** `Line.place` lays the queue from `cx − 5`, and `advanceTo(3, 7)`
       *    walks the lead to `cx + 6.4` — stepping into `cx + 7`. Every cell of
       *    `cx − 5 … cx + 8` must be passable eastward or `makeScriptedRoute` drops a step
       *    in silence and the whole queue turns north;
       *  - **one height across it**, because two walkers on either side of a terrace lip is
       *    the `cave --preset close` frame in which the trainer was cut off at the waist.
       *
       * A failure is a `log.warn`, and the screenshot harness records `consoleWarnings` in
       * every shot's JSON — so a clean shot log *is* the shipped-map assertion, and a dirty
       * one names the preset, the cell and the blocked offset.
       *
       * @returns {{ok:boolean, checked:number, fails:object[]}}
       */
      audit(id = currentId) {
        const biome = byId(id ?? 'forest');
        const draft = terrain.draft();
        const fails = [];
        if (!draft) return { ok: false, checked: 0, fails: [{ preset: '*', why: 'no map loaded' }] };
        let checked = 0;
        for (const [name, spec] of Object.entries(biome.presets ?? {})) {
          const m = draft.marker(spec.marker ?? name);
          if (!m) { fails.push({ preset: name, why: `no marker "${spec.marker ?? name}"` }); continue; }
          checked++;
          const y0 = draft.heightAt(m.cx, m.cz);
          const span = [];
          for (let dx = -5; dx <= 8; dx++) {
            const ok = draft.passable(m.cx + dx, m.cz, 3)
              && Math.abs(draft.heightAt(m.cx + dx, m.cz) - y0) <= 0.26;
            span.push(ok ? '.' : 'X');
          }
          if (span.includes('X')) {
            fails.push({ preset: name, at: `${m.cx},${m.cz}`, span: span.join(''), why: 'lane' });
          }
        }
        // --- the loop, walked ----------------------------------------------
        // This is the assertion the Node selftest cannot make: it builds a DIFFERENT map from
        // a different stream against a stub tileset, and once shipped 279/279 green over three
        // broken framings (see the head of `selftest.js`). The circuit has to be walked on the
        // draft the player is standing on, on every entry, so it cannot go stale.
        const loop = built.get(biome.id)?.loop ?? null;
        if (!loop) {
          fails.push({ preset: 'loop', why: 'no closed circuit was found for this map' });
        } else {
          checked++;
          // **Provenance.** A biome that authored a circuit and silently fell back to a found
          // one ships a shape nobody reviewed — `stitchLoop` always stamps `source: 'authored'`
          // on success, so anything else here means the authored attempt failed or was never
          // tried (`authoredLoop`, above, already warned which).
          if (biome.loop?.via && loop.source !== 'authored') {
            fails.push({ preset: 'loop', why: 'declares loop.via but is running a found circuit' });
          }

          let cx = loop.start.cx;
          let cz = loop.start.cz;
          let blocked = 0;
          const dirs = parseLoop(loop.route);
          let reversed = 0;
          for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[i];
            const nx = cx + LOOP_DX[dir];
            const nz = cz + LOOP_DZ[dir];
            if (!draft.passable(nx, nz, dir)) blocked++;
            // A 180-degree reversal walks the head straight into its own follower — `Line.step`
            // deliberately does not special-case one (`src/simulation/line.js`).
            if (dirs[(i + 1) % dirs.length] === ((dir + 2) & 3)) reversed++;
            cx = nx; cz = nz;
          }
          if (blocked) fails.push({ preset: 'loop', at: `${loop.start.cx},${loop.start.cz}`, why: `${blocked} blocked step(s)` });
          // **It has to come home.** A route that does not close is not a loop, and the party
          // would walk it once and then spend the rest of the session somewhere else.
          if (cx !== loop.start.cx || cz !== loop.start.cz) {
            fails.push({ preset: 'loop', why: `does not close — ends at ${cx},${cz} not ${loop.start.cx},${loop.start.cz}` });
          }
          if (reversed) {
            fails.push({ preset: 'loop', why: `${reversed} 180-degree reversal(s) back to back in the route` });
          }

          // **Every cell distinct.** A doubled-back stretch sterilises both its shoulders for
          // `slotsForLoop` and quietly yields fewer than the biome's `SLOTS` — see `stitchLoop`'s
          // own R9 check in `compose.js`, held here to the found loop as well.
          const seen = new Set();
          let revisited = 0;
          for (const c of loop.cells) {
            const k = `${c.cx},${c.cz}`;
            if (seen.has(k)) revisited++; else seen.add(k);
          }
          if (revisited) fails.push({ preset: 'loop', why: `${revisited} cell(s) on the ring visited more than once` });
        }

        // --- the slots, measured -------------------------------------------
        // Distance EXACTLY 2 is the arithmetic the encounter trigger rests on (src/hunts/index.js): a
        // tether of 1 plus a trigger of 1. A slot at 1 puts the party permanently in a battle
        // and a slot at 3 is never met.
        const slots = built.get(biome.id)?.slots ?? [];
        if (loop && slots.length) {
          checked++;
          const d = (s2) => Math.min(...loop.cells.map((c) => Math.max(Math.abs(c.cx - s2.cx), Math.abs(c.cz - s2.cz))));
          const wrong = slots.filter((s2) => d(s2) !== 2);
          if (wrong.length) {
            fails.push({ preset: 'slots', why: `${wrong.length} of ${slots.length} are not 2 cells off the path` });
          }
        }

        for (const f of fails) {
          log.warn(`hunts/${biome.id}: preset "${f.preset}" ${f.why} `
            + `${f.at ? `at ${f.at} — cx-5..cx+8 is ${f.span ?? '-'}` : ''}`);
        }
        return { ok: !fails.length, checked, fails };
      },

      /** The circuit this biome is played on: `{ start, route, cells, w, h }` or `null`. */
      loop: (id = currentId) => {
        const l = built.get(id ?? 'forest')?.loop ?? null;
        return l ? {
          start: { ...l.start }, route: l.route, w: l.w, h: l.h,
          corners: l.corners, length: l.cells.length, source: l.source ?? 'found',
          cells: l.cells.map((c) => ({ ...c })),
        } : null;
      },

      /** The fixed respawn points on it, with whatever is standing on each right now. */
      slots: (id = currentId) => {
        const list = built.get(id ?? 'forest')?.slots ?? [];
        return list.map((s2, k) => {
          const held = id == null || id === currentId ? occupancy.get(k) : null;
          return {
            k, cx: s2.cx, cz: s2.cz, dir: s2.dir ?? 0,
            // Where the party leaves the circuit for this slot, and which way it steps.
            from: s2.from ? { ...s2.from } : null,
            step: s2.step ?? null,
            approach: s2.approach ? { ...s2.approach } : null,
            occupied: !!held,
            species: held?.species?.name ?? null,
            display: held?.species?.display ?? held?.species?.name ?? null,
            shiny: !!held?.shiny,
            level: Number.isFinite(held?.level) ? held.level : null,
            npcId: held?.npcId ?? 0,
          };
        });
      },

      /**
       * Hands the creature on slot `k` over, **leaving its sprite standing where it is**.
       *
       * This is what makes a slot a *respawn point* rather than scenery: the wild that fights
       * is the one that was standing there. It used to be the *identity* that carried over and
       * not the body — this method deleted the NPC and `encounter` spawned a second sprite that
       * burst out of the grass over twenty sim steps. There is no burst any more, so deleting the body here would leave one or two frames of empty grass: the
       * caller retires `npcId` itself, the moment its own actor is in place.
       *
       * `cx,cz` is where the creature **is**, not the cell the slot was authored on: it drifts
       * one tile around its tether (src/hunts/index.js), and staging the fight on the authored cell would
       * teleport it up to a tile at the moment of contact. The slot is scheduled to refill on
       * this module's own tick, so the next lap meets something new in the same place.
       */
      takeSlot(k) {
        const held = occupancy.get(k);
        if (!held) return null;
        occupancy.delete(k);
        const sim = ctx.get('simulation');
        const live = (isLive(sim) && typeof sim.npcs === 'function')
          ? sim.npcs().find((n) => n.id === held.npcId) : null;
        const i = wildIds.indexOf(held.npcId);
        if (i >= 0) wildIds.splice(i, 1);
        refills.push({ k, at: elapsed + RESPAWN_S });
        return {
          species: held.species, shiny: held.shiny, level: held.level, k,
          npcId: held.npcId,
          cx: Number.isFinite(live?.cx) ? live.cx : held.cx,
          cz: Number.isFinite(live?.cz) ? live.cz : held.cz,
          dir: Number.isFinite(live?.dir) ? live.dir : (held.dir ?? 0),
        };
      },

      /** Seconds an emptied slot stays empty. `encounter` times its own beats against it. */
      respawnSeconds: RESPAWN_S,

      /** Driven by the descriptor's `tick`; not part of the src/hunts/index.js surface. */
      _refill(dt = 0) {
        // **This module's own accumulator, not `clock.simTime`.** The clock advances in
        // `clock.beginFrame`, and `registry.tick` — which is what drives this — does not touch
        // it. Timing a respawn off `simTime` meant a slot emptied under the screenshot
        // harness or a stepped sim never came back at all.
        elapsed += Math.max(0, dt);

        // Catches the ending of an approach that never became a fight (a blocked step that
        // abandoned the plan, `detourHome()` firing for someone else's fight, ordinary progress
        // round the loop rendering the target unreachable) — the `true -> false` edge of
        // `sim.detouring()` is the one thing every such ending has in common, unlike
        // `encounter:started`/`encounter:resolved`, which only fire for the ending that DOES
        // become a fight. Runs every tick, ahead of the respawn loop's own early return, because
        // the hold has to be released whether or not anything is waiting to refill.
        //
        // The SAME edge also closes out `resyncToLoop()`'s own one-way detour (above): once it
        // lands, `detouring()` falls back to `false` exactly like every other detour, so there
        // is nothing new to watch for — just something new to do on the edge already caught.
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.detouring === 'function') {
          const detouring = sim.detouring();
          if (wasDetouring && !detouring) {
            if (heldNpcId != null) {
              if (typeof sim.holdNpc === 'function') sim.holdNpc(heldNpcId, false);
              heldNpcId = null;
            }
            if (resyncPending) {
              resyncPending = false;
              const info = built.get(currentId);
              const loop = info?.loop;
              if (loop?.cells?.length && typeof sim.setRoute === 'function'
                && typeof sim.followerCell === 'function') {
                /**
                 * **`detouring()` going false does not mean the detour REACHED
                 * `resyncCellIndex`.** A one-way resync detour can be abandoned mid-approach
                 * exactly like any other (`simulation/index.js`'s "blocked mid-approach"
                 * branch in `advance()`) — a solid wild's tether drift claims a cell the plan
                 * assumed was open — and with `returnHome:false` that abandonment ALSO drops
                 * `out` to nothing and never populates `back`, so this same edge fires having
                 * gotten nowhere near the intended cell. Rotating from `resyncCellIndex`
                 * regardless is what produced a real, reproducible stall (measured: cave,
                 * seed 1337, tick 8750 — the head landed one cell short of the intended loop
                 * cell, the route was rotated for the cell it never reached, and its very next
                 * scripted step walked off the loop instead of along it). So find out where
                 * the head actually is, and rotate from THAT if it lands on the loop at all —
                 * a coincidence the streak-based backstop above should not have to clean up.
                 */
                const head = sim.followerCell();
                const at = loop.cells.findIndex((c) => c.cx === head.cx && c.cz === head.cz);
                if (at >= 0) {
                  const gap = typeof sim.gap === 'function' ? Math.max(0, sim.gap()) : 2;
                  // `at` is the HEAD's real landing index; `routeFrom`'s own `i` is the
                  // TRAINER's, `gap` cells behind — see `resyncToLoop`'s doc, above.
                  sim.setRoute(routeFrom(loop, at - gap, gap).rotated);
                }
                // Landed somewhere off the loop instead: leave the route alone. The head is
                // still off-circuit, so the `player:enteredTile` off-loop-streak counter
                // (below) picks it back up and tries `resyncToLoop()` again on its own —
                // exactly the path a resync that never got queued at all already takes.
              }
            }
          }
          wasDetouring = detouring;
        }

        if (!refills.length || !currentId) return;
        const now = elapsed;
        const biome = byId(currentId);
        const list = built.get(currentId)?.slots ?? [];
        const pokemon = ctx.get('pokemon');
        if (!isLive(sim) || !isLive(pokemon)) return;

        for (let i = refills.length - 1; i >= 0; i--) {
          if (refills[i].at > now) continue;
          const { k } = refills.splice(i, 1)[0];
          const cell = list[k];
          if (!cell || occupancy.has(k)) continue;

          // Rolled fresh, from a stream addressed by the slot and how many times it has
          // refilled — so a respawn is reproducible from the seed rather than from when the
          // player happened to walk past.
          const gen = (generations.get(k) ?? 0) + 1;
          generations.set(k, gen);
          const encounter = ctx.get('encounter');
          const env = ctx.get('environment');
          const tod = isLive(env) && typeof env.getTimeOfDay === 'function' ? env.getTimeOfDay() : (ctx.config.tod ?? 12);
          const table = isLive(encounter) && typeof encounter.tablesFor === 'function'
            ? (encounter.tablesFor(biome.id, tod) ?? []) : [];
          if (!table.length) continue;
          const rng = ctx.rng.fork(`hunts/slot/${biome.id}/${k}/${gen}`);
          const species = pokemon.species(table[rng.int(0, table.length - 1)]);
          if (!species) continue;
          const shiny = rng.next() < 1 / 512;
          const level = levelForSlot(biome.id, k, gen);

          // Fire and forget: the atlas may need the sheet and `spawnNpc` is synchronous, so
          // the sprite is prepared first and the NPC lands a microtask later.
          Promise.resolve(pokemon.sprites?.prepare?.([{ species, shiny }])).then(() => {
            if (occupancy.has(k) || currentId !== biome.id) return;
            const npc = sim.spawnNpc({
              species, shiny, cx: cell.cx, cz: cell.cz, dir: cell.dir ?? 0,
              tether: { cx: cell.cx, cz: cell.cz, radius: 1 },
              solid: true,
              name: `wild/${biome.id}/${cell.cx},${cell.cz}/${gen}`,
            });
            if (!npc) return;
            wildIds.push(npc.id);
            occupancy.set(k, {
              npcId: npc.id, species, shiny, level, cx: cell.cx, cz: cell.cz, dir: cell.dir ?? 0,
            });
            bus.emit('slot:respawned', { biome: biome.id, slot: k, species: species.name, shiny, level });
          }).catch(() => {});
        }
      },
    };
    return api;
  },

  /**
   * Refills emptied slots.
   *
   * On `tick` and not on a timer, because `clock.simTime` is the only clock gameplay may read
   * (src/core/clock.js) and a slot that refilled on wall time would repopulate a frozen screenshot.
   */
  tick(dt, ctx) {
    const api = ctx.get('hunts');
    if (typeof api?._refill === 'function') api._refill(dt);
  },

  async showcase(mode, ctx) {
    const { showcaseHunt } = await import('./showcase.js');
    return showcaseHunt(mode, ctx, BIOMES);
  },
};

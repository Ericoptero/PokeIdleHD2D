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
import { aStar, manhattan } from '../core/path.js';
import { makePatrol, chooseTarget, standTiles } from './patrol.js';

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
 * How a hunt is played (`simulation.setFormation` + `simulation.setPilot`).
 *
 * A hunt is watched, not steered. The **active Pokemon leads** — it is what walks into the
 * tall grass first, which is the whole reason `player:enteredTile` carries the head's cell —
 * the trainer follows it, and the keyboard does not move either of them.
 *
 * There is no scripted route and no wander bias any more. `enter()` installs one pilot
 * (`huntPilot`, below) through `sim.setPilot()`, and the pilot re-plans a fresh `aStar` path
 * toward the biome's own `patrol`'s current waypoint (`hunts/patrol.js`) every tick instead of
 * walking a fixed, pre-rotated route string — see `huntPilot`'s own header comment for why that
 * removes the alignment invariant the old `autopilot: 'route'` / `preferTags` bias existed to
 * protect.
 *
 * A biome may override any of it with a `formation` field of its own; none needs to today.
 */
const HUNT_FORMATION = { head: 'pokemon', input: false };

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

/**
 * How many `loop.cells` apart two consecutive patrol waypoints sit — the density
 * `patrolStep`'s `aStar` re-plans against, chosen so a stalled leg is never more than a
 * handful of tiles. Every `WAYPOINT_STRIDE`-th cell along the ring, wrapping (the final
 * segment back to `cells[0]` is whatever remainder is left, always shorter than a full
 * stride). This is a derived VIEW of `loop.cells`, not a second circuit: the ring itself
 * (`loop`, `audit()`'s own preconditions) is unchanged by it.
 */
const WAYPOINT_STRIDE = 7;
function waypointsForLoop(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i += WAYPOINT_STRIDE) out.push({ cx: cells[i].cx, cz: cells[i].cz });
  return out;
}

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
     * The hunt's own movement state, on top of the pilot (`huntPilot`, below):
     *
     *  - `'PATROL'` — the pilot drives toward `patrol.current()`; every tile landed on is
     *    checked for a nearby wild worth a detour to (`chooseTarget`, `hunts/patrol.js`).
     *  - `'APPROACH'` — a target is locked (`heldNpcId`/`heldSlotKey`) and the pilot instead
     *    drives toward its nearest reachable stand tile; no re-evaluation happens (target lock).
     *  - `'FIGHT'` — an encounter is running. `encounter` itself pauses the whole walker
     *    (`sim.pause(true)`/`(false)`, `encounter/index.js`), so nothing here has to stop the
     *    pilot; this is bookkeeping only, so a caller reading `huntState` mid-fight sees the
     *    truth.
     *  - `'RETURN'` — the fight is over and the party is walking back to `patrol.current()`
     *    (the SAME index it left, not advanced). `chooseTarget` is not consulted at all in this
     *    state — that is what replaces the old `triedThisLap` blacklist: a target cannot be
     *    re-picked until the party is back on its circuit, which is the fix for the measured
     *    216-detours-in-2000-ticks ping-pong. See `patrolStep`'s own comment for exactly where
     *    the transition back to `'PATROL'` happens.
     * @type {'PATROL'|'APPROACH'|'FIGHT'|'RETURN'}
     */
    let huntState = 'PATROL';
    /** The occupied slot key the party is currently approaching or fighting, or `null`. */
    let heldSlotKey = null;
    /**
     * The NPC id `holdNpc(id, true)` currently has frozen for an in-progress approach, or
     * `null` when nothing is held.
     *
     * A wild is held from the instant the party commits to walking at it (so its own tether
     * drift cannot step it out from under a multi-step approach) until one of two things closes
     * the story: a fight actually starts on it (`encounter:resolved` releases it once the duel
     * is over), or the approach ends with no fight at all — `approachStep` (below) notices the
     * target is no longer live/occupied and releases it itself, the tick it notices. Without
     * this a wild whose approach ended by any means other than a fight would stay `held: true`
     * forever: frozen, visible, and never fought again.
     */
    let heldNpcId = null;
    /** Warn-once guard for `patrolStep`'s own rule-6 stall (see its header comment). */
    let patrolStalled = false;
    /**
     * The slot `takeSlot(k)` most recently handed to a fight, awaiting `encounter:resolved` to
     * say the timer may start — or `null` when nothing is mid-resolution.
     *
     * **The respawn timer starts at resolution, not at `takeSlot()`.** A slot used to push its
     * own `{k, at: elapsed + RESPAWN_S}` the instant it was taken, which meant the clock ran
     * *during* the fight: a long duel (multi-turn, a catch attempt, a faint-and-swap) ate into
     * the same window a short one did not, so two fights of different length left their slots
     * refilling at different real distances from when the party actually walked away. Scheduling
     * the refill from `encounter:resolved` instead (below) means every fight, however long,
     * starts its slot's respawn clock at the same event: the moment the party is free to move
     * again.
     *
     * A scalar, not a queue, because only one encounter can be `active` at a time
     * (`encounter.engage` refuses a second while one is running) — `takeSlot` is never called
     * again before this is cleared.
     */
    let pendingResolve = null;

    /** How many times each slot has refilled — the index its respawn roll is addressed by. */
    const generations = new Map();
    /** Seconds of simulated time this module has seen, accumulated from its own `tick`. */
    let elapsed = 0;
    /**
     * Bumped by every `spawnWild()` call, and captured by `_refill`'s own deferred spawn
     * (`Promise.resolve(pokemon.sprites?.prepare?.(...)).then(...)`) at the moment it is
     * queued. `spawnWild()` itself `await`s a sprite-prepare before it ever writes `occupancy`
     * (its own comment on why), which leaves a window where a refill queued on the biome being
     * LEFT can still be in flight when the biome being ENTERED starts writing fresh occupancy —
     * `occupancy.has(k) || currentId !== biome.id` alone does not close it, because the new
     * `spawnWild()` clears `occupancy` before its own await too. The epoch is the one thing
     * that is guaranteed to differ across that boundary even when the slot key and the biome id
     * both happen to coincide.
     */
    let spawnEpoch = 0;

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

    /**
     * The species that walks onto slot `k` on its `gen`-th refill, when the slot carries its
     * own authored `pool` (`biome.spawns[].species`, resolved to species OBJECTS at build
     * time) rather than falling back to `encounter.tablesFor`. Its own sibling stream, for the
     * same reason `levelForSlot` has one: an authored roster and the shared table roster must
     * not perturb each other's rolls.
     */
    function speciesForSlot(biomeId, k, gen, pool) {
      return pool[ctx.rng.fork(`hunts/spawn-species/${biomeId}/${k}/${gen}`).int(0, pool.length - 1)];
    }

    /**
     * Seconds slot `k` on the CURRENT biome stays empty after being taken: the spawn's own
     * authored `respawn` (`biome.spawns`, resolved in `terrain.register`) when it has one, or
     * the shared `RESPAWN_S` default for everything `slotsForLoop` still derives.
     */
    function respawnSecondsFor(k) {
      const cell = (built.get(currentId)?.slots ?? [])[k];
      return Number.isFinite(cell?.respawn) ? cell.respawn : RESPAWN_S;
    }

    function disposeExtras() {
      for (const w of extraWorlds) w.dispose?.();
      extraWorlds = [];
    }
    bus.on('world:unloaded', disposeExtras);

    /**
     * Takes the wild Pokemon off the map. Called before every re-entry (`spawnWild`) and on
     * `world:unloaded`, so they never stack.
     *
     * Clears `occupancy`/`refills`/`generations`/`pendingResolve` too, not only `wildIds` —
     * this used to only remove the bodies, which meant `hunts.slots()` kept reporting every
     * slot occupied by a now-dead `npcId` for the whole gap between leaving a biome and the
     * next `spawnWild()` resolving it (an `await` away, see that function's own comment).
     * `slotNear`'s `npcs.find(...) ?? s2` fallback (`encounter/index.js`) would engage that
     * ghost occupancy against the slot's bare cell, and a stale `refills`/`generations` entry
     * from the map just left could fire against the next map's own slot indices.
     */
    function clearWild() {
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.removeNpc === 'function') {
        for (const id of wildIds) sim.removeNpc(id);
      }
      wildIds = [];
      occupancy.clear();
      refills.length = 0;
      generations.clear();
      pendingResolve = null;
      spawnEpoch++;
    }
    bus.on('world:unloaded', clearWild);

    /**
     * **A lap is a rest.** Without it one lost fight ends the session: the lead faints, the
     * next member steps up, and a wiped party walks its circuit forever meeting nothing.
     *
     * Fires from `patrolStep` (below) exactly when `patrol.advance()`/`.skip()` reports
     * `wrapped: true` — one full pass of the waypoint list, which is what a "lap" now means —
     * rather than from counting `player:enteredTile` landings against `loop.cells.length` the
     * way the old on-loop-only tally did. Per LAP and not per second, because that is what
     * survives being chunked: `offline` applies a gap in one call and `idle` drains it in
     * slices, and a heal counted in whole laps lands identically either way
     * (src/idle/index.js). The full rule — a potion below a threshold, and the Pokemon Center —
     * is phase 6; this is the floor.
     */
    function completeLap() {
      bus.emit('hunt:lap', { biome: currentId, length: built.get(currentId)?.loop?.cells?.length ?? 0 });
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
    }

    /**
     * The exact step-legality the party's own walker steps with — `sim.canStepFor(0)` (terrain
     * `canStep` AND the `solid` occupancy map, minus `ignoreNpcId`'s own claimed cell) — for
     * `aStar`, which needs the FROM-cell convention (`core/path.js`'s own header comment). Falls
     * back the same way the rest of this file already does when a capability is missing: terrain
     * `canStep` directly, then terrain `passable`, then "everything is open" for a quarantined or
     * pre-slice `terrain`.
     */
    function canStepFor(ignoreNpcId = 0) {
      const sim = ctx.get('simulation');
      if (isLive(sim) && typeof sim.canStepFor === 'function') return sim.canStepFor(ignoreNpcId);
      const terrain = ctx.get('terrain');
      if (isLive(terrain) && typeof terrain.canStep === 'function') {
        return (cx, cz, dir) => !!terrain.canStep(cx, cz, dir);
      }
      return isLive(terrain) && typeof terrain.passable === 'function'
        ? (cx, cz, dir) => !!terrain.passable(cx, cz, dir)
        : () => true;
    }

    /**
     * **PATROL and RETURN movement: one fresh `aStar` step toward `patrol.current()`, every
     * tick.** Recomputing the whole path every call (never caching one across ticks) is what
     * lets this react to the map changing under it — another wild's tether drift, an approach's
     * own hold releasing a cell — without a resync protocol of any kind: there is nothing to
     * resync, because nothing here is ever stale for more than one tick.
     *
     * **Rule 6** ("if the current waypoint is the walker's own current tile, or cannot be
     * reached, try the following waypoint instead"): `aStar` itself already returns `null` for
     * both of those cases — the same-cell case by its own documented contract, the unreachable
     * case by exhausting its search — so a single `!path` check covers the rule as written, no
     * separate equality test needed. `patrol.skip()` is `advance()` under another name
     * (`hunts/patrol.js`), so a skip mid-pass bumps the same index/lap bookkeeping an ordinary
     * arrival would. Bounded to one full pass of the waypoint list so a circuit that is somehow
     * entirely unreachable does not spin forever within one tick; a stall past that returns
     * `null` for this tick only (the next tick tries again from scratch) and warns once, not
     * every tick, via `patrolStalled`.
     *
     * **Where `'RETURN'` becomes `'PATROL'` again** — the exact point the test-rewrite phase
     * needs: the instant `patrol.arrived(head)` is true while `huntState === 'RETURN'`, BEFORE
     * `patrol.advance()` runs. That is "checks resume only after movement along the circuit
     * resumes" made structural rather than a matter of inspection — `chooseTarget` is gated on
     * `huntState === 'PATROL'` (see the `player:enteredTile` listener, below) and nothing sets
     * `huntState` back to `'PATROL'` except this one line, which cannot run until the party has
     * actually walked back within `patrol`'s own arrival radius of the waypoint it left.
     */
    function patrolStep(head, canStep) {
      const info = built.get(currentId);
      const patrol = info?.patrol;
      const count = info?.waypoints?.length ?? 0;
      if (!patrol || !count) return null;

      // Laps are counted once per CALL, not once per `advance()`/`skip()` inside it — a stalled
      // circuit (see below) can run this whole function, including its bounded retry loop,
      // every single tick with the party never actually moving, and `patrol.laps` incrementing
      // on every one of those retries would spam `hunt:lap` and the lap-rest heal at 20 Hz
      // instead of once per real lap walked.
      const lapsBefore = patrol.laps;

      if (patrol.arrived(head)) {
        if (huntState === 'RETURN') huntState = 'PATROL';
        patrol.advance();
      }

      let step = null;
      for (let tries = 0; tries < count && !step; tries++) {
        const path = aStar(head, patrol.current(), canStep);
        if (path) step = { dir: path[0].dir };
        else patrol.skip();
      }
      if (patrol.laps !== lapsBefore) completeLap();

      if (step) { patrolStalled = false; return step; }
      if (!patrolStalled) {
        patrolStalled = true;
        log.warn(`hunts/${currentId}: the patrol found no reachable waypoint in a full pass of its circuit`);
      }
      return null;
    }

    /**
     * **APPROACH movement: one fresh `aStar` step toward the locked target's nearest reachable
     * stand tile, every tick.** The target itself is frozen (`sim.holdNpc(id, true)`, set the
     * instant it was locked, below) so its `standTiles` never move once an approach starts —
     * only the WALKER's distance to them changes tick to tick, which is why re-ordering and
     * re-pathing fresh every call (rather than caching the one `chooseTarget` produced at lock
     * time) is still cheap and still correct.
     *
     * Already standing on one of the target's stand tiles returns `null` (stand still) rather
     * than pathing to a DIFFERENT one — `encounter`'s own `slotNear` (an independent trigger on
     * this same `player:enteredTile`) is what starts the fight from there; this function's only
     * job is to close the distance, never to shuffle around once it is closed.
     */
    function approachStep(head, canStep) {
      const sim = ctx.get('simulation');
      const npcs = isLive(sim) && typeof sim.npcs === 'function' ? sim.npcs() : [];
      const live = heldNpcId != null ? npcs.find((n) => n.id === heldNpcId) : null;
      if (!live || heldSlotKey == null || !occupancy.has(heldSlotKey)) {
        // Vanished before arrival — defeated by nothing here, despawned, or otherwise gone.
        // Release the hold and hand back to PATROL; `chooseTarget` re-arms on the next landing.
        releaseApproach();
        return patrolStep(head, canStep);
      }
      const stands = standTiles(live, canStep);
      if (stands.some((t) => t.cx === head.cx && t.cz === head.cz)) return null;
      const ordered = stands
        .map((t, i) => ({ t, i, d: manhattan(head, t) }))
        .sort((a, b) => (a.d !== b.d ? a.d - b.d : a.i - b.i));
      for (const { t } of ordered) {
        const path = aStar(head, t, canStep);
        if (path) return { dir: path[0].dir };
      }
      // Every stand tile temporarily blocked (another solid wild's own drift, most likely) —
      // the target is held and cannot itself move further away, so this simply retries next
      // tick rather than giving up.
      return null;
    }

    /** Drops whatever `holdNpc(id, true)` froze and hands the pilot back to PATROL. */
    function releaseApproach() {
      if (heldNpcId != null) {
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.holdNpc === 'function') sim.holdNpc(heldNpcId, false);
      }
      heldNpcId = null;
      heldSlotKey = null;
      huntState = 'PATROL';
    }

    /**
     * **The single pilot `enter()` installs via `sim.setPilot()` — the whole of a hunt's
     * movement.** Dispatches on `huntState`: `'APPROACH'` drives toward the locked target,
     * everything else (`'PATROL'`, `'RETURN'`, and `'FIGHT'`, which is never actually asked —
     * `encounter` pauses the whole walker for the duration of a fight, `encounter/index.js`, so
     * `route.next()` is simply not called) drives toward `patrol.current()`.
     *
     * There is no fixed step list and no rotation to keep aligned with where the head happens
     * to stand — the entire reason `enter()` can now teleport straight to `draft.spawn` instead
     * of `loop.start` with a `gap`-rotated route: the OLD scripted route was a fixed sequence of
     * directions indexed by position along the ring, so a head placed at the wrong index in that
     * sequence would walk a stale direction forever (the measured "22 of 58 cells" bug this
     * module's own history documents). A pilot has no index to misalign in the first place — it
     * asks "where am I, where do I want to go" fresh every tick, from wherever it actually is —
     * so it is correct from any starting cell on the map, not only from one the loop's own
     * construction happens to agree with.
     */
    function huntPilot(head) {
      // `ignoreNpcId` exists precisely for this: while `'APPROACH'` is closing on a locked
      // target (`heldNpcId`), that target's own claimed cell must not itself read as blocked —
      // its tether drift can put it on a stand tile the walker is trying to step onto, and
      // `0` (nothing) never excludes it. `patrolStep`, which never approaches anyone, keeps
      // the plain `canStepFor(0)`.
      const canStep = canStepFor(huntState === 'APPROACH' ? heldNpcId : 0);
      return huntState === 'APPROACH' ? approachStep(head, canStep) : patrolStep(head, canStep);
    }

    /**
     * **PATROL: after every tile reached, is a Pokemon close enough to pursue?**
     *
     * Replaces the old fixed-slot detour's aggro trigger with `chooseTarget`
     * (`hunts/patrol.js`) — same spawn data model (the SLOT system, `occupancy`/
     * `built.get(id).slots`, filtered to occupied slots at their LIVE npc cell), a different
     * selection algorithm: real walking distance via `aStar` to the nearest reachable STAND
     * TILE of a spawn, rather than a fixed two-step pair.
     *
     * Gated on `huntState === 'PATROL'` — `'APPROACH'` is a target lock (no re-evaluating
     * mid-approach) and `'RETURN'`/`'FIGHT'` do not evaluate targets at all, which is what
     * replaces the old `triedThisLap` blacklist: see `huntState`'s own doc, above.
     */
    bus.on('player:enteredTile', ({ cx, cz }) => {
      if (huntState !== 'PATROL') return;
      const sim = ctx.get('simulation');
      const enc = ctx.get('encounter');
      if (isLive(enc) && enc.active?.()) return;
      // A party with nothing left standing walks past its wildlife rather than detouring
      // toward a fight it cannot take — `encounter/index.js`'s `slotNear()` already refuses
      // to engage one for the same reason; without this check here too, the walk toward it
      // still happened, wasting the lap's own rest (`completeLap`, above) on trips to wilds
      // that were never going to be fought.
      const pokemon = ctx.get('pokemon');
      const canFight = !isLive(pokemon) || typeof pokemon.firstConscious !== 'function'
        || !!pokemon.firstConscious();
      if (!canFight) return;
      const list = built.get(currentId)?.slots ?? [];
      if (!list.length) return;
      const npcs = isLive(sim) && typeof sim.npcs === 'function' ? sim.npcs() : [];

      // Every occupied slot's own LIVE position — `chooseTarget` does the distance/reachability
      // work; this just builds the ACTIVE-only list its own contract asks for.
      const spawns = [];
      for (let k = 0; k < list.length; k++) {
        const held = occupancy.get(k);
        if (!held) continue; // defeated and not yet respawned
        const live = npcs.find((n) => n.id === held.npcId);
        if (!live) continue; // a slot can report occupied for one tick after its npc is gone
        spawns.push({ cx: live.cx, cz: live.cz, k, npcId: held.npcId });
      }
      if (!spawns.length) return;

      const canStep = canStepFor(0);
      const range = Math.max(1, Math.round(Number(config?.aggroTiles) || 5));
      const hit = chooseTarget({ cx, cz }, spawns, canStep, { maxManhattan: range });
      if (!hit) return;

      // Already standing beside it: combat begins without walking, via `encounter`'s own
      // `slotNear` on this same event — never locked into an approach for a walk that would
      // not go anywhere.
      if (standTiles(hit.spawn, canStep).some((t) => t.cx === cx && t.cz === cz)) return;

      if (typeof sim.holdNpc === 'function') sim.holdNpc(hit.spawn.npcId, true);
      heldNpcId = hit.spawn.npcId;
      heldSlotKey = hit.spawn.k;
      huntState = 'APPROACH';
    });

    /**
     * The fight is on. Bookkeeping only — `encounter` itself pauses the whole walker for the
     * duration (`sim.pause(true)`/`(false)`, `encounter/index.js`), so nothing here has to stop
     * anything; this just makes `huntState` tell the truth to a caller reading it mid-fight.
     */
    bus.on('encounter:started', () => { huntState = 'FIGHT'; });

    /**
     * Releases whatever wild `holdNpc(id, true)` froze for the approach that just ended in a
     * fight, and hands the pilot to `'RETURN'` if there was an approach to return from, or
     * straight back to `'PATROL'` if the party engaged without ever leaving it (already
     * standing beside the target when `chooseTarget` found it, above) — there is no walk home
     * to make in that case.
     *
     * **This is also where a taken slot's respawn clock actually starts.** `takeSlot()` only
     * records `pendingResolve`; the fight itself may run any number of turns, a catch attempt,
     * a faint-and-swap — none of which this module has to know the shape of — and the instant
     * it is over is exactly this event, on every path that ends one (`flee()` and
     * `resolveUnattended()` both route through `encounter/index.js`'s own `resolve()`, which is
     * the sole emitter of `encounter:resolved`, so there is no second way out of a fight that
     * would skip this).
     */
    bus.on('encounter:resolved', () => {
      const hadApproach = heldNpcId != null;
      if (hadApproach) releaseApproach(); // also sets huntState = 'PATROL'
      huntState = hadApproach ? 'RETURN' : 'PATROL';
      if (pendingResolve != null) {
        refills.push({ k: pendingResolve, at: elapsed + respawnSecondsFor(pendingResolve) });
        pendingResolve = null;
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
      clearWild(); // also resets occupancy/refills/generations/pendingResolve — see its own comment
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
      // An authored spawn (`biome.spawns[].species`, resolved to species OBJECTS already by
      // `authoredSpawns` in `terrain.register`) brings its own pool and never touches the
      // shared table — only a cell that OMITS one falls back to it, exactly as it always did
      // for every `slotsForLoop`-derived cell (which never has a `.species` of its own).
      const needsTable = cells.some((c) => !Array.isArray(c.species) || !c.species.length);
      const table = needsTable
        ? ((isLive(encounter) && typeof encounter.tablesFor === 'function')
          ? (encounter.tablesFor(biome.id, tod) ?? []) : [])
        : [];
      if (needsTable && !table.length) {
        log.warn(`hunts/${biome.id}: encounter has no table at tod ${tod} — the grass stays empty`);
        return 0;
      }

      // Seeded off the biome *and the hour*, so the same URL gives the same creatures and a
      // different hour gives the nocturnal ones. Never `Math.random` (src/core/rng.js).
      const rng = ctx.rng.fork(`hunts/wild/${biome.id}/${Math.round(tod * 4)}`);
      /** A short cast, so a frame reads as a place with animals in it rather than a zoo. */
      const roster = [];
      if (needsTable) {
        for (let i = 0; i < WILD_SPECIES_CAP * 4 && roster.length < WILD_SPECIES_CAP; i++) {
          const s = pokemon.species(table[rng.int(0, table.length - 1)]);
          if (s && !roster.some((r) => r.name === s.name)) roster.push(s);
        }
        if (!roster.length) return 0;
      }

      const n = Math.min(WILD_CAP, cells.length);
      // At most one shiny, and usually none. One is a reward for looking; two in a frame is a
      // bug report. Both rolls are seeded, so whether this map has one is a property of the
      // seed and the hour rather than of when the shutter opened.
      const shinyAt = rng.next() < 0.35 ? rng.int(0, n - 1) : -1;
      const picked = cells.slice(0, n).map((c, i) => {
        const k = c.k ?? i;
        const species = (Array.isArray(c.species) && c.species.length)
          ? speciesForSlot(biome.id, k, 0, c.species)
          : roster[i % roster.length];
        return { ...c, k, species, shiny: i === shinyAt, level: levelForSlot(biome.id, k, 0) };
      });

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

    /**
     * Whether `(cx,cz)` is fit to host a wild Pokemon that must actually be fought: inside the
     * map, standable ground, not already claimed by a multi-cell placement, and reachable — at
     * least one `standTiles()` result a walker could occupy to fight from
     * (`hunts/patrol.js` — exactly the seam it exists for). Shared between spawn resolution
     * (`authoredSpawns`, below) and `audit()`'s own spawn check, so the two can never quietly
     * drift apart on what "valid" means.
     *
     * `canStep` is FROM-cell (`core/path.js`'s convention, matching `standTiles`' own contract)
     * — at build time that is `draft.canStep`; nothing here needs a live `simulation`.
     */
    function validSpawnCell(draft, cx, cz, canStep) {
      if (!draft.inside(cx, cz)) return false;
      if (!draft.passable(cx, cz, 0)) return false;
      if (draft.occupied[draft.idx(cx, cz)]) return false;
      return standTiles({ cx, cz }, canStep).length > 0;
    }

    /**
     * A biome's own AUTHORED fixed spawns (`biome.spawns`), resolved against the finished
     * draft — the PRIMARY source of a hunt's slots from here on, ahead of `slotsForLoop`'s
     * derived geometry (which remains the fallback for a biome that declares no `spawns` array
     * at all: only a biome that opts in by declaring one pays for any of this, and no shipped
     * biome does yet — this task wires the mechanism, not the authoring).
     *
     * Marker-relative (`{at, dx, dz}`), never an absolute cell: the drafts are procedurally
     * seeded, so a hard-coded `{cx,cz}` can land on blocked ground after a seed change, but a
     * marker name is resolved fresh on every build — the same reasoning `authoredLoop`, above,
     * already documents for the circuit itself.
     *
     * Each entry is validated independently and a bad one is simply dropped, rather than
     * aborting the whole biome — a missing marker (the same failure-reporting `authoredLoop`
     * uses), an invalid cell (`validSpawnCell`, above), or an unknown species name
     * (`pokemon.species()`) is a `log.warn` and that one spawn entry is skipped, matching how a
     * missing loop marker is already handled.
     *
     * `species` names resolve to species OBJECTS here, once, rather than being re-looked-up on
     * every spawn/respawn — `spawnWild`/`_refill` (below) treat a resolved `species` array as
     * this spawn's own pool and only fall back to `encounter.tablesFor` when it is absent.
     */
    function authoredSpawns(draft, biome, c) {
      const list = Array.isArray(biome.spawns) ? biome.spawns : [];
      if (!list.length) return [];
      const pokemon = c.get('pokemon');
      const canStep = (x, z, dir) => draft.canStep(x, z, dir);
      const out = [];
      for (const entry of list) {
        const m = draft.marker(entry.at);
        if (!m) {
          const known = [...draft.markers.keys()].join(', ') || 'none';
          log.warn(`hunts/${biome.id}: authored spawn names marker "${entry.at}", `
            + `which this draft does not have (has: ${known}) -- skipping this spawn`);
          continue;
        }
        const cx = m.cx + (entry.dx ?? 0);
        const cz = m.cz + (entry.dz ?? 0);
        if (!validSpawnCell(draft, cx, cz, canStep)) {
          log.warn(`hunts/${biome.id}: authored spawn "${entry.at}"+(${entry.dx ?? 0},${entry.dz ?? 0}) `
            + `at ${cx},${cz} is not a usable spawn cell -- skipping this spawn`);
          continue;
        }
        let species = null;
        if (Array.isArray(entry.species) && entry.species.length) {
          species = [];
          let badName = null;
          for (const name of entry.species) {
            const s = isLive(pokemon) && typeof pokemon.species === 'function' ? pokemon.species(name) : null;
            if (!s) { badName = name; break; }
            species.push(s);
          }
          if (badName != null) {
            log.warn(`hunts/${biome.id}: authored spawn "${entry.at}" names unknown species `
              + `"${badName}" -- skipping this spawn`);
            continue;
          }
        }
        out.push({
          cx, cz, dir: 0, from: null, step: null, approach: null,
          species, respawn: Number.isFinite(entry.respawn) ? entry.respawn : RESPAWN_S,
        });
      }
      return out;
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
        // Authored spawns are the PRIMARY source (`authoredSpawns`, above); `slotsForLoop`'s
        // derived geometry is the fallback for a biome that declares no `spawns` array at all.
        const authored = authoredSpawns(draft, biome, c);
        const slots = authored.length ? authored
          : (loop
            ? slotsForLoop(draft, loop.cells, c.rng.fork(`hunts/slots/${biome.id}/${draft.seed}`),
              { count: SLOTS })
            : []);
        if (!loop) {
          log.warn(`hunts/${biome.id}: no closed circuit fits this map between `
            + `${LOOP.min} and ${LOOP.max} cells — the party will stand still`);
        }
        // The patrol's own waypoints, and its index/lap bookkeeping — built fresh alongside the
        // loop on every entry (never carried across a biome change, matching `huntState`'s own
        // reset in `enter()`, below), so a `waypoints` list always matches the `patrol` walking
        // it and neither can go stale relative to a rebuilt map.
        const waypoints = loop ? waypointsForLoop(loop.cells) : [];
        const patrol = waypoints.length ? makePatrol({ waypoints }) : null;
        built.set(biome.id, { ...report, loop, slots, waypoints, patrol, missing: palette.missing() });
      });
    }

    /**
     * Stands the party **on its own circuit**, at the cell nearest the place a preset frames.
     *
     * Much simpler than the scripted-route era: there is no rotation to get right, because
     * `huntPilot` (above) has no fixed step sequence whose index a teleport could misalign —
     * it re-plans a path to `patrol.current()` fresh from wherever the head actually stands.
     * So this only has to (1) find the nearest loop cell to the marker, no straight-run
     * precondition needed, and (2) let the ALREADY-INSTALLED pilot (`enter()` calls
     * `sim.setPilot(huntPilot)` once per biome entry, before any preset can run) walk a few
     * tiles from there — `stage()`'s own `advanceTo(walk.tiles, walk.subTicks)` below drives
     * that, exactly as it already did, just through the pilot instead of a throwaway scripted
     * route. That walk is also what strings the queue out of whatever stack `Line.place` laid
     * it in when the framing cell had no long straight run ahead of it.
     *
     * The marker is a *framing* request, not a position: the party stands on the nearest loop
     * cell to it, so the picture is of the place asked for and the walker is on the path it
     * will actually walk. A biome with no circuit stands still at the marker, which is what
     * `enter()` does too — a hunt that cannot walk its loop should look broken rather than look
     * like a different game.
     */
    function stageOnLoop(sim, biome, marker, spec = {}) {
      const loop = built.get(biome.id)?.loop;
      if (!loop?.cells?.length) {
        if (typeof sim.halt === 'function') sim.halt();
        return { dir: spec.dir ?? marker?.dir ?? 3, tiles: 0, subTicks: 0, on: null };
      }
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < loop.cells.length; i++) {
        const c = loop.cells[i];
        const d = Math.abs(c.cx - (marker?.cx ?? 0)) + Math.abs(c.cz - (marker?.cz ?? 0));
        if (d < bestD) { bestD = d; best = i; }
      }
      // A plausible initial facing for the teleport — the ring's own heading at this cell, from
      // the route string `audit()` already walks (`loop.route` describes the ring's shape
      // whether or not anything is currently walking it by that string). Cosmetic only: the
      // pilot decides the ACTUAL next step itself, from wherever it lands.
      const dir = parseLoop(loop.route)[best] ?? (spec.dir ?? marker?.dir ?? 3);
      return { dir, tiles: 3, subTicks: 7, on: loop.cells[best] };
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
      // new hunt healed early by however many steps the previous one had banked, and a target
      // held from the last biome would otherwise stay frozen (and untargetable) forever on a
      // map it no longer exists on.
      huntState = 'PATROL';
      if (heldNpcId != null) {
        const prevSim = ctx.get('simulation');
        if (isLive(prevSim) && typeof prevSim.holdNpc === 'function') prevSim.holdNpc(heldNpcId, false);
      }
      heldNpcId = null;
      heldSlotKey = null;
      patrolStalled = false;

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
          // `formation.head`, and it installs this biome's own formation in place of whatever
          // the last scene was walking. `stage()` still wins, because a preset runs after
          // `enter()` has returned.
          sim.setFormation?.({
            ...HUNT_FORMATION, ...(biome.formation ?? {}),
            label: `simulation/wander/hunt-${biome.id}`,
          });

          /**
           * **`enter()` teleports to the map's own entrance, not to `loop.start`.**
           *
           * The old scripted-route walker needed `loop.start` and a `gap`-rotated route
           * because a fixed sequence of directions is indexed by POSITION along the ring: the
           * trainer had to start on `cells[0]` (putting the head on `cells[gap]`) or the route
           * handed to `cells[gap]` would be the direction owed by some OTHER cell, and the head
           * would walk it forever — measured as 22 of a 58-cell loop covered in 84 tiles, with
           * `audit()` reporting the loop clean throughout, because the loop WAS clean; nobody
           * was standing on it.
           *
           * `huntPilot` (installed below) has no such index to misalign in the first place — it
           * asks `aStar` for a fresh path to `patrol.current()` every tick, from wherever the
           * head actually is, so it is correct starting from ANY cell on the map, not only one
           * the loop's own construction agrees with. That is what makes it safe to simplify
           * this to the one placement the spec actually asks for: the party starts at the map's
           * entrance (`draft.spawn`) and the pilot finds its own way onto the circuit from
           * there. The one cosmetic cost is `Line.place`'s own straight-run assumption: if
           * `draft.spawn` has no `gap` clear cells ahead of it, the queue starts stacked rather
           * than spread out (`Line.place`'s own documented fallback, `simulation/line.js`) —
           * harmless, and it resolves itself within the first few tiles the pilot walks, the
           * same way a staged preset's own `advanceTo` already untangles one on purpose
           * (`stageOnLoop`, above).
           */
          sim.teleport(spawn.cx, spawn.cz, spawn.dir ?? 2);
          if (typeof sim.setPilot === 'function') sim.setPilot(huntPilot);
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

        // --- the spawns, measured -------------------------------------------
        // Replaces the old "every slot is exactly 2 cells off the path" check: that distance
        // was the arithmetic of `slotsForLoop`'s own fixed-pair-detour geometry (a tether of 1
        // plus a trigger of 1), meaningless for an authored spawn, which has no "from"/"step"
        // pair of its own at all. What every RESOLVED spawn has to have instead, authored or
        // `slotsForLoop`-derived, whichever this biome actually has (`validSpawnCell`, above,
        // is the one place both this and spawn resolution ask the question): the cell is
        // inside the map, standable, unclaimed by static geometry, and has somewhere a walker
        // could stand to fight it from (`standTiles`) — and it sits within `chooseTarget`'s
        // own pathing/aggro range of at least one patrol waypoint, or a lap could walk past it
        // forever and never trigger the aggro check at all.
        const slots = built.get(biome.id)?.slots ?? [];
        const waypoints = built.get(biome.id)?.waypoints ?? [];
        if (slots.length) {
          checked++;
          const canStepAudit = (x, z, dir) => draft.canStep(x, z, dir);
          const invalid = slots.filter((s2) => !validSpawnCell(draft, s2.cx, s2.cz, canStepAudit));
          if (invalid.length) {
            fails.push({
              preset: 'slots',
              why: `${invalid.length} of ${slots.length} spawn cell(s) are not inside/passable/`
                + 'clear/standable',
            });
          }
          // The runtime aggro trigger's own `maxManhattan` (`config.aggroTiles`, the
          // `player:enteredTile` listener below) — not `chooseTarget`'s wider default of 6,
          // which used to let this audit pass a spawn the aggro check itself would already
          // reject as too far.
          const aggroRange = Math.max(1, Math.round(Number(config?.aggroTiles) || 5));
          const unreachable = slots.filter((s2) => !waypoints.some(
            (wp) => !!chooseTarget(wp, [s2], canStepAudit, { maxManhattan: aggroRange })));
          if (unreachable.length) {
            fails.push({
              preset: 'slots',
              why: `${unreachable.length} of ${slots.length} spawn cell(s) are unreachable from `
                + 'any patrol waypoint',
            });
          }
        }

        // **Authored species, re-checked independently of the resolution-time check.** `audit`'s
        // whole purpose (its own header comment, above) is to catch a regression that resolution
        // itself might one day stop catching, so this asks `pokemon.species()` again against the
        // RAW `biome.spawns` list rather than trusting that `built.slots` was already filtered.
        if ((biome.spawns ?? []).some((e) => Array.isArray(e.species) && e.species.length)) {
          checked++;
          const pokemon = ctx.get('pokemon');
          for (const entry of biome.spawns) {
            for (const name of entry.species ?? []) {
              const known = isLive(pokemon) && typeof pokemon.species === 'function'
                ? !!pokemon.species(name) : true;
              if (!known) {
                fails.push({
                  preset: 'spawns',
                  why: `authored spawn at "${entry.at}" names unknown species "${name}"`,
                });
              }
            }
          }
        }

        // **Live invariant: every `wild/<biome>/…` body on the map is a slot this module can
        // hand to a fight.** The build-time checks above ask whether the geometry is sound;
        // this asks whether the runtime bookkeeping actually agrees with it right now — the
        // user-facing shape of the bug the leaks above (a `takeSlot` whose fight never started,
        // a stale refill racing a biome switch, a wild sprite `showWild` lost track of) all
        // produce: a Pokemon standing in the grass with no slot behind it, which `slotNear`
        // (`encounter/index.js`) can never engage. Only meaningful for the LIVE biome — `audit`
        // can be asked about one that is not currently entered, and `sim.npcs()` only ever
        // reflects whatever the map actually has standing on it.
        if (id === currentId && currentId != null) {
          const sim = ctx.get('simulation');
          if (isLive(sim) && typeof sim.npcs === 'function') {
            checked++;
            const prefix = `wild/${currentId}/`;
            const liveWild = sim.npcs().filter((n) => typeof n.name === 'string' && n.name.startsWith(prefix));
            const occupied = [...occupancy.values()].map((o) => o.npcId);
            const orphaned = liveWild.filter((n) => !occupied.includes(n.id));
            if (orphaned.length) {
              fails.push({
                preset: 'wild',
                why: `${orphaned.length} live wild Pokemon on the map have no occupied slot `
                  + `behind them and cannot be engaged (ids: ${orphaned.map((n) => n.id).join(',')})`,
              });
            }
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
       * teleport it up to a tile at the moment of contact.
       *
       * **Does not itself schedule the refill.** It only marks `k` as `pendingResolve` (its own
       * doc comment, above, has the reasoning); the `encounter:resolved` listener is what pushes
       * `{k, at}` onto `refills` once the fight this slot was taken for has actually finished —
       * so the respawn clock starts at resolution, not here at the moment of contact.
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
        pendingResolve = k;
        return {
          species: held.species, shiny: held.shiny, level: held.level, k,
          npcId: held.npcId,
          cx: Number.isFinite(live?.cx) ? live.cx : held.cx,
          cz: Number.isFinite(live?.cz) ? live.cz : held.cz,
          dir: Number.isFinite(live?.dir) ? live.dir : (held.dir ?? 0),
        };
      },

      /**
       * Undoes exactly one `takeSlot(k)` — for a caller that took a slot's creature and then
       * failed to actually start a fight with it (`encounter`'s own `engage()`: an empty
       * encounter table, a party with nothing conscious). Without this the body `takeSlot`
       * handed over stays on the map with no occupancy entry and no scene ever tracking it —
       * visible, standing in the grass, and un-engageable forever, exactly the "Pokemon that
       * cannot be fought" defect this module exists to prevent.
       *
       * `taken` is `takeSlot`'s own return value, handed straight back — this only re-inserts
       * what that call removed, at the LIVE cell it reported (not a re-guess), and only if
       * nothing has already refilled `k` in the meantime (a caller that stalls past the next
       * tick loses the race to `_refill`, which is correct: the slot is not left double-booked).
       */
      releaseSlot(k, taken) {
        if (!taken || occupancy.has(k)) return false;
        occupancy.set(k, {
          npcId: taken.npcId, species: taken.species, shiny: !!taken.shiny, level: taken.level,
          cx: taken.cx, cz: taken.cz, dir: taken.dir ?? 0,
        });
        if (taken.npcId && !wildIds.includes(taken.npcId)) wildIds.push(taken.npcId);
        if (pendingResolve === k) pendingResolve = null;
        return true;
      },

      /** Seconds an emptied slot stays empty. `encounter` times its own beats against it. */
      respawnSeconds: RESPAWN_S,

      /**
       * Seconds slot `k` on the current biome specifically stays empty — an authored spawn's
       * own `respawn`, or `respawnSeconds` above. Read by the `encounter:resolved` listener and
       * the orphan guard (both below) rather than always the flat default, so a biome that
       * authors a faster- or slower-refilling spawn actually gets one.
       */
      respawnSecondsFor,

      /** Driven by the descriptor's `tick`; not part of the src/hunts/index.js surface. */
      _refill(dt = 0) {
        // **This module's own accumulator, not `clock.simTime`.** The clock advances in
        // `clock.beginFrame`, and `registry.tick` — which is what drives this — does not touch
        // it. Timing a respawn off `simTime` meant a slot emptied under the screenshot
        // harness or a stepped sim never came back at all.
        elapsed += Math.max(0, dt);

        // The old detour queue's `true -> false` edge is gone along with it: an approach ending
        // without a fight is now caught directly, the tick it happens, inside `approachStep`
        // (above) — it releases `heldNpcId` itself the moment the target it was chasing is no
        // longer live or occupied, rather than waiting for a detour-queue edge to notice.

        // **Orphan guard.** `takeSlot()` only marks `pendingResolve`; the refill itself is
        // scheduled from `encounter:resolved` (below), which might never fire for this slot —
        // a quarantined `encounter` module, or a biome switch that tears the scene down mid
        // fight. If nothing is actually `active()`, the fight this slot was taken for is not
        // coming back to resolve it, so schedule its refill from here instead rather than
        // leave the slot silently empty forever. This should not happen in ordinary play, so
        // it warns when it does.
        if (pendingResolve != null && currentId) {
          const encounter = ctx.get('encounter');
          const fighting = isLive(encounter) && typeof encounter.active === 'function' && !!encounter.active();
          if (!fighting) {
            log.warn(`hunts/${currentId}: slot ${pendingResolve} was taken but `
              + '"encounter:resolved" never fired for it — scheduling its refill anyway');
            refills.push({ k: pendingResolve, at: elapsed + respawnSecondsFor(pendingResolve) });
            pendingResolve = null;
          }
        }

        if (!refills.length || !currentId) return;
        const now = elapsed;
        const biome = byId(currentId);
        const list = built.get(currentId)?.slots ?? [];
        const sim = ctx.get('simulation');
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
          const rng = ctx.rng.fork(`hunts/slot/${biome.id}/${k}/${gen}`);
          // An authored spawn's own species pool (already resolved to objects, `terrain.
          // register`) wins; only a slot that never had one falls back to the shared table,
          // exactly as at initial spawn (`spawnWild`, above).
          let species;
          if (Array.isArray(cell.species) && cell.species.length) {
            species = speciesForSlot(biome.id, k, gen, cell.species);
          } else {
            const encounter = ctx.get('encounter');
            const env = ctx.get('environment');
            const tod = isLive(env) && typeof env.getTimeOfDay === 'function' ? env.getTimeOfDay() : (ctx.config.tod ?? 12);
            const table = isLive(encounter) && typeof encounter.tablesFor === 'function'
              ? (encounter.tablesFor(biome.id, tod) ?? []) : [];
            if (!table.length) continue;
            species = pokemon.species(table[rng.int(0, table.length - 1)]);
          }
          if (!species) continue;
          const shiny = rng.next() < 1 / 512;
          const level = levelForSlot(biome.id, k, gen);

          // Fire and forget: the atlas may need the sheet and `spawnNpc` is synchronous, so
          // the sprite is prepared first and the NPC lands a microtask later. `epoch` guards
          // against a `spawnWild()` on either this biome or the next one clearing the state
          // this refill was queued against while the prepare is still in flight — `spawnEpoch`'s
          // own comment has the exact window this closes that `occupancy`/`currentId` alone do
          // not.
          const epoch = spawnEpoch;
          Promise.resolve(pokemon.sprites?.prepare?.([{ species, shiny }])).then(() => {
            if (epoch !== spawnEpoch || occupancy.has(k) || currentId !== biome.id) return;
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

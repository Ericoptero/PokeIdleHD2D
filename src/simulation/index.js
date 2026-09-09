/**
 * simulation — the grid walker, and the thing the whole game is looked at through
 * (ARCHITECTURE §5.4).
 *
 * **The arrangement is a property of the scene, not of the game.** A scene hands one in
 * through `setFormation` and everything else falls out of it:
 *
 *   - `head: 'pokemon'` — a hunt. The active Pokemon is at the front of the queue and walks
 *     into the tall grass first, so `player:enteredTile` carries *its* cell. The player does
 *     not drive it (`input: false`); the autopilot does (`autopilot: 'wander'`);
 *   - `head: 'trainer'` — a walkable map like the city. The trainer leads and the Pokemon
 *     walks behind it, and the player drives with the keyboard (`input: true`,
 *     `autopilot: 'none'`).
 *
 * Two other things hold under both:
 *
 *   - the trainer is the player. `player()` and `teleport()` are about the trainer, which is
 *     the contract `offline` captures and restores through, and the **camera follows the
 *     trainer**, never the Pokemon;
 *   - **exactly one Pokemon is in the field.** The queue is the trainer and `party[0]`; the
 *     bench is on the bench.
 *
 * Movement is 4-way and tile-locked: a step starts on a cell and ends on a cell, at
 * `config.walkSecondsPerTile` (0.25). There is one cadence and it divides the 1/20 s sim
 * step exactly, so the same seed and the same input give the same path, cell for cell.
 * Rendering interpolates *between* fixed steps with the frame's `alpha` so 20 Hz gameplay
 * does not read as 20 fps motion — except when the sim is frozen for a screenshot, where
 * alpha is dropped so the same URL gives the same pixels (ARCHITECTURE §6.3).
 *
 * This module owns no art. Sprites, sheets, atlas and contact shadows all belong to
 * `pokemon` and are reached through `ctx.get('pokemon')` (see cast.js).
 */

import { SIM_DT } from '../core/clock.js';
import { SOUTH } from '../core/dir.js';
import { Line } from './line.js';
import { Cast } from './cast.js';
import { makeSurface } from './surface.js';
import { makeScriptedRoute, makeWander, STILL } from './route.js';

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * The party a brand-new save walks out of the door with. Only ever used when nothing else
 * has put a Pokemon in the party by the time a map is entered — a restored save, a scene
 * that hands one over, or `encounter` catching one all win, because this runs from
 * `placePlayer` and not from `init`.
 */
const STARTER_PARTY = [
  { species: 'oshawott', level: 5 },
  { species: 'snivy', level: 5 },
  { species: 'tepig', level: 5 },
];

/** Idle shuffle: mostly the standing frame, with a beat of the other one. Seconds. */
const IDLE_PERIOD = 1.7;
const IDLE_HOLD = 1.3;

/**
 * The closest two members of the queue may stand and still both be *visible*.
 *
 * A sprite is 16 texels per world unit and stretched by 1/cos(45°) (DECISIONS #18), so a
 * 32 px trainer frame is an upright quad 2.83 world units tall. Under a camera pitched 45°
 * below horizontal that quad covers `2.83 · sin(45°) = 2.0` tiles of *ground depth* on
 * screen. At `followerGapTiles = 1` the walker in front therefore covers the one behind it
 * completely: shot at `/` with the party walking north, the lead Pokemon — the entity the
 * whole brief is about — was entirely hidden behind the trainer
 * (docs/progress/simulation/r1/00-gap1-lead-hidden.png).
 *
 * The argument is symmetric and survives the formation flip: the occlusion is a property of
 * the *separation*, not of which walker is in front, so 2 is still the floor when the trainer
 * leads and the Pokemon walks behind it. `config.followerGapTiles` now ships at 2; this
 * module still raises it *unless the URL pinned a value*, so `?followerGapTiles=1` wins and
 * the config contract holds.
 */
const MIN_READABLE_GAP = 2;

const MAX_NPCS = 32;

export default {
  id: 'simulation',
  needs: ['terrain', 'pokemon'],
  /** The showcase authors its own map but reuses the city for `mode=city` (ARCHITECTURE §6). */
  showcaseNeeds: ['terrain', 'city'],

  init(ctx) {
    const { config, bus, log } = ctx;

    const line = new Line({ gap: config.followerGapTiles, members: 1 });
    const cast = new Cast(ctx);
    const surface = makeSurface(ctx);

    /** @type {{kind:'pokemon'|'trainer', species?:any, shiny?:boolean, trainer?:string, inst?:any}[]} */
    let members = [];
    let trainerIndex = 0;
    /** Slot of the active Pokemon, or -1 when the party is empty. */
    let pokemonIndex = -1;
    let trainerWho = 'hero';
    /** Where the NPC actors start inside the cast, which stages party and NPCs together. */
    let npcOffset = 0;

    /** @type {{id:number, line:Line, route:object, spec:object, who:string}[]} */
    const npcs = [];
    let nextNpcId = 1;

    let route = STILL;
    /**
     * How the scene currently in the world is played. `setFormation` is the only writer;
     * `city` and `hunts` call it from `enter()` *before* they place the player, because
     * `placePlayer` lays the queue out against `formation.head`.
     *
     * The default is `head: 'pokemon'` because the showcases that build their own map never
     * call `setFormation`, and their whole subject is the Pokemon meeting the world first.
     */
    let formation = { head: 'pokemon', input: true, autopilot: 'none', preferTags: ['path'], label: 'simulation/wander' };
    let intent = null;
    let frozen = false;
    let placed = false;
    /**
     * A whole-cell nudge added to the camera's focus, for a staged frame only.
     *
     * The camera follows the trainer (ARCHITECTURE §5.4) and nothing in the game moves this.
     * A showcase sometimes needs the subject off centre — the party in the empty half of a
     * crowded square, the corner sitting low in a wide frame — and moving the *focus* is the
     * only way to do that without moving the party off its own route. Whole cells, because a
     * fractional offset moves every sprite off the texel grid that `pixelExactDistance` just
     * put it on and the pixel art turns to mush.
     */
    let focusShift = { x: 0, z: 0 };

    // ---------------------------------------------------------------- world

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

    // See MIN_READABLE_GAP: at gap 1 a 45-degree camera hides one walker behind the other.
    if (!params.has('followerGapTiles') && config.followerGapTiles < MIN_READABLE_GAP) {
      config.set({ followerGapTiles: MIN_READABLE_GAP });
    }

    const terrainApi = () => ctx.get('terrain');

    /** Collision goes through terrain, always — this module never reads a tile itself. */
    function passable(cx, cz, dir) {
      const terrain = terrainApi();
      if (!isLive(terrain) || typeof terrain.passable !== 'function') return true;
      return !!terrain.passable(cx, cz, dir);
    }
    function tagsAt(cx, cz) {
      const terrain = terrainApi();
      if (!isLive(terrain) || typeof terrain.tagsAt !== 'function') return [];
      return terrain.tagsAt(cx, cz) ?? [];
    }
    const world = { passable, tagsAt };

    // ------------------------------------------------------------- the party

    /**
     * Rebuilds the queue from `pokemon.party()` and the current formation.
     *
     * **Two walkers, never more.** Only the active Pokemon — `party[0]` — is in the field;
     * the rest of the party exists in `pokemon.party()`, shows in the party bar and can be
     * swapped to the front with `setLead`, but it does not follow the trainer around. Which
     * of the two is at the head is the scene's call.
     */
    function rebuildMembers() {
      const pokemon = ctx.get('pokemon');
      const party = (isLive(pokemon) && typeof pokemon.party === 'function' ? pokemon.party() : []) ?? [];
      const lead = party[0] ?? null;
      const trainer = { kind: 'trainer', trainer: trainerWho };
      const mon = lead
        ? { kind: 'pokemon', species: lead.species, shiny: !!lead.shiny, inst: lead }
        : null;

      members = !mon ? [trainer]
        : formation.head === 'trainer' ? [trainer, mon]
          : [mon, trainer];
      trainerIndex = members.findIndex((m) => m.kind === 'trainer');
      pokemonIndex = members.findIndex((m) => m.kind === 'pokemon');
      // Set synchronously, not inside `restage`'s microtask: `renderPose` reads it every
      // frame, and a frame landing between here and the microtask would pose NPCs into the
      // party's own slots now that the party's size changes when a scene is entered.
      npcOffset = members.length;
      line.gap = Math.max(1, Math.round(config.followerGapTiles) || 1);
      line.setMembers(members.length);
    }

    /** Gives a brand-new save something to lead with. Uses only `pokemon`'s published API. */
    function seedPartyIfEmpty() {
      const pokemon = ctx.get('pokemon');
      if (!isLive(pokemon) || typeof pokemon.party !== 'function') return;
      if (pokemon.party().length) return;
      let seed = 0;
      for (const entry of STARTER_PARTY) {
        const inst = pokemon.createInstance({ ...entry, seed: seed++ });
        if (inst) pokemon.addToParty(inst);
      }
      log.info(`simulation: seeded the starting party — ${pokemon.party().map((p) => p.species.name).join(', ')}`);
    }

    /**
     * Stages party and NPC sprites in one atlas build, in line order then NPC order.
     *
     * Coalesced onto a microtask: `city` populates its lobby with a dozen `spawnNpc` calls in
     * a row, and restaging on each one would repack and re-upload the sprite atlas a dozen
     * times for a cast that is known in full by the end of the loop.
     */
    let staging = null;
    function restage() {
      if (staging) return staging;
      staging = Promise.resolve().then(() => {
        staging = null;
        const partySpecs = members.map((m) => (m.kind === 'trainer'
          ? { trainer: m.trainer }
          : { species: m.species, shiny: m.shiny }));
        npcOffset = partySpecs.length;   // already set synchronously by rebuildMembers/spawnNpc
        const npcSpecs = npcs.map((n) => (n.spec.trainer
          ? { trainer: n.spec.trainer }
          : { species: n.spec.species, shiny: !!n.spec.shiny }));
        return cast.sync([...partySpecs, ...npcSpecs]);
      }).catch((err) => log.warn('simulation: staging the cast failed', err));
      return staging;
    }

    // ------------------------------------------------------------ placement

    /**
     * Puts the **trainer** on `(cx, cz)` facing `dir`, with the lead Pokemon `gap` cells
     * ahead of it and the rest of the party queued behind, and snaps the camera.
     */
    function placePlayer(cx, cz, dir = SOUTH) {
      // A staged camera nudge belongs to one staged frame. `teleport` aliases this, so
      // leaving a showcase's offset on would follow the player into the next scene.
      focusShift = { x: 0, z: 0 };
      seedPartyIfEmpty();
      rebuildMembers();
      surface.rebuild();
      line.place(trainerIndex, cx, cz, dir & 3, passable);
      intent = null;
      route.reset?.();
      placed = true;
      restage();
      renderPose(0);
      const t = line.pose(trainerIndex, 0);
      ctx.three.rig?.setFocus?.(t.x + focusShift.x, surface.at(t.cx, t.cz), t.z + focusShift.z, true);
      announce();
      return api.player();
    }

    /**
     * One `player:moved` for the trainer, and one `player:enteredTile` for whoever is at the
     * head — the Pokemon in a hunt, the trainer in a walkable map. Either way it is the body
     * that meets the tile first, which is what an encounter must roll on.
     */
    function announce() {
      const t = line.cellOf(trainerIndex);
      const head = line.cellOf(0);
      bus.emit('player:moved', { cx: t.cx, cz: t.cz, dir: line.pose(trainerIndex, 0).dir });
      bus.emit('player:enteredTile', { cx: head.cx, cz: head.cz, tags: tagsAt(head.cx, head.cz) });
    }

    // ------------------------------------------------------------ the tick

    function stepOptions() {
      return { walkSeconds: config.walkSecondsPerTile, passable };
    }

    function advance(dt) {
      if (frozen || !placed) return;

      if (line.advance(dt)) announce();
      if (!line.moving) {
        const head = line.pose(0, 0);
        const cmd = intent ?? route.next(head, world);
        intent = null;
        if (cmd) line.step(cmd.dir, stepOptions());
      }

      for (const npc of npcs) {
        npc.line.advance(dt);
        if (!npc.line.moving) {
          const cmd = npc.route.next(npc.line.pose(0, 0), world);
          if (cmd) npc.line.step(cmd.dir, stepOptions());
        }
      }
    }

    // ----------------------------------------------------------- the render

    /** Walk phase from distance walked: two phases per tile keeps feet locked to the grid. */
    const walkPhase = (tiles) => Math.floor(tiles * 2);
    /** Standing shuffle, off simulated time so it freezes with everything else. */
    const idlePhase = (t) => ((t % IDLE_PERIOD) < IDLE_HOLD ? 0 : 1);

    function poseWalker(l, i, sub, spec) {
      const p = l.pose(i, sub);
      const y = surface.between(p.fromX, p.fromZ, p.cx, p.cz, p.t);
      // Actors are spawned hidden and revealed here, so a sprite whose async spawn lands
      // mid-frame never flashes at the world origin before its first pose arrives.
      const patch = { x: p.x, y, z: p.z, dir: p.dir, visible: true };
      if (p.moving) {
        patch.gait = 'walk';
        patch.phase = walkPhase(l.steps + p.t);
      } else if (spec.kind === 'trainer') {
        patch.gait = 'idle';
        patch.phase = 0;
      } else {
        // The Pokemon sheets have no separate idle pose, so the standing animation is the
        // walk cycle held on its contact frame with an occasional beat of the other one.
        patch.gait = 'walk';
        patch.phase = idlePhase(l.animTime);
      }
      return { p, patch };
    }

    function renderPose(alpha) {
      if (!placed) return;
      const sub = frozen ? 0 : Math.min(1, Math.max(0, alpha)) * SIM_DT / line.secondsPerTile;

      for (let i = 0; i < members.length; i++) {
        const { p, patch } = poseWalker(line, i, sub, members[i]);
        cast.set(i, patch);
        if (i === trainerIndex) {
          ctx.three.rig?.setFocus?.(p.x + focusShift.x, patch.y, p.z + focusShift.z, frozen);
        }
      }

      for (let n = 0; n < npcs.length; n++) {
        const npc = npcs[n];
        const npcSub = frozen ? 0 : Math.min(1, Math.max(0, alpha)) * SIM_DT / npc.line.secondsPerTile;
        const { patch } = poseWalker(npc.line, 0, npcSub, { kind: npc.spec.trainer ? 'trainer' : 'pokemon' });
        cast.set(npcOffset + n, patch);
      }
    }

    // ----------------------------------------------------------------- API

    const api = {
      // --- §5.4 ------------------------------------------------------------
      /** The trainer: the player's own avatar, the camera's focus and what `offline` saves. */
      player() {
        const c = line.cellOf(trainerIndex);
        const p = line.pose(trainerIndex, 0);
        return { cx: c.cx, cz: c.cz, dir: p.dir, moving: line.moving };
      },
      /**
       * Queues one step. Overrides the autopilot for that step; a blocked direction still
       * turns the head to face it, which is what Black & White does.
       *
       * Refused outright when the scene says the player does not drive the walker. "Not
       * allowed or existent" is a property of the world, not a preference of the UI, so the
       * refusal lives here as well as in `ui/input.js` — that closes the console and any
       * future input source at the same time.
       *
       * @returns {boolean} whether the step was queued
       */
      moveIntent(dir) {
        if (!formation.input) return false;
        intent = { dir: dir & 3 };
        return true;
      },
      stop() { intent = null; },

      /**
       * How the scene in the world is played: who leads, whether the player drives, and what
       * walks the queue when they do not. Called by `city.enter()` / `hunts.enter()` **before**
       * they place the player, because `placePlayer` lays the queue out against `head`.
       */
      setFormation(next = {}) {
        formation = {
          head: next.head === 'trainer' ? 'trainer' : 'pokemon',
          input: next.input !== false,
          autopilot: next.autopilot === 'wander' ? 'wander' : 'none',
          preferTags: Array.isArray(next.preferTags) ? [...next.preferTags] : ['path'],
          label: next.label ?? 'simulation/wander',
        };
        intent = null;
        // A showcase always starts still and stages its own walk, and `?autowalk=0` pins a
        // frame — both guards are the ones the boot-time wander used to carry.
        const asked = params.get('autowalk');
        const auto = !config.showcase && asked !== '0' && asked !== 'false' && formation.autopilot === 'wander';
        // Forked per scene, so the forest and the meadow are different strolls and each one
        // is reproducible from its own stream rather than from wherever the shared one got to.
        route = auto ? makeWander(ctx.rng.fork(formation.label), { preferTags: formation.preferTags }) : STILL;
        if (placed) { rebuildMembers(); restage(); renderPose(0); }
        return api;
      },
      formation: () => ({ ...formation, preferTags: [...formation.preferTags] }),

      /**
       * The active Pokemon, wherever it is standing — in front of the trainer in a hunt,
       * behind it in a walkable map. It is the §5.4 contract, so it follows the creature and
       * not the slot.
       */
      follower() {
        const lead = pokemonIndex >= 0 ? members[pokemonIndex] : null;
        if (!lead || lead.kind !== 'pokemon') return null;
        const c = line.cellOf(pokemonIndex);
        const p = line.pose(pokemonIndex, 0);
        return {
          cx: c.cx, cz: c.cz, dir: p.dir, x: p.x, z: p.z, y: surface.at(c.cx, c.cz),
          moving: line.moving,
          species: lead.species?.name ?? null,
          instanceId: lead.inst?.instanceId ?? null,
          shiny: !!lead.shiny,
        };
      },
      /**
       * The head's cell — where a tall-grass encounter is rolled. In a hunt the Pokemon leads
       * and this is its cell; in a walkable map the trainer leads and this is the trainer's.
       * Either way it is the body that walks into the grass first.
       */
      followerCell() { const c = line.cellOf(0); return { cx: c.cx, cz: c.cz, dir: line.pose(0, 0).dir }; },

      spawnNpc(spec = {}) {
        if (npcs.length >= MAX_NPCS) { log.warn(`simulation.spawnNpc: at the ${MAX_NPCS} NPC cap`); return null; }
        const dir = (spec.dir ?? SOUTH) & 3;
        const l = new Line({ gap: 1, members: 1 });
        l.place(0, spec.cx ?? 0, spec.cz ?? 0, dir, passable);
        // Every NPC gets its own stream, keyed by its own id, so spawning one more NPC does
        // not shift the walk of the ones already on the map.
        const rng = ctx.rng.fork(`simulation/npc/${spec.name ?? nextNpcId}`);
        const npc = {
          id: nextNpcId++,
          line: l,
          spec: { trainer: spec.trainer, species: spec.species, shiny: spec.shiny, name: spec.name },
          who: spec.trainer ?? null,
          route: spec.route === 'wander' || (!spec.route && spec.wander)
            ? makeWander(rng, { preferTags: spec.preferTags ?? ['path'] })
            : spec.route ? makeScriptedRoute(spec.route, { loop: spec.loop !== false })
              : STILL,
        };
        npcs.push(npc);
        npcOffset = members.length;
        restage();
        return { id: npc.id, cx: spec.cx ?? 0, cz: spec.cz ?? 0, dir };
      },
      npcs: () => npcs.map((n) => {
        const c = n.line.cellOf(0);
        return { id: n.id, cx: c.cx, cz: c.cz, dir: n.line.pose(0, 0).dir, moving: n.line.moving, name: n.spec.name ?? null };
      }),
      removeNpc(id) {
        const i = npcs.findIndex((n) => n.id === id);
        if (i < 0) return false;
        npcs.splice(i, 1);
        restage();
        return true;
      },

      placePlayer,
      teleport: placePlayer,

      // --- the walk --------------------------------------------------------
      /** Follows a fixed path forever: `walk('n8 w6 s8 e6')`. */
      walk(spec, opts = {}) { route = makeScriptedRoute(spec, opts); return api; },
      /** Strolls, seeded. Prefers the tags it is given, so a town walker keeps to the road. */
      wander(opts = {}) { route = makeWander(ctx.rng.fork(opts.label ?? 'simulation/wander'), opts); return api; },
      /** Stands still. */
      halt() { route = STILL; return api; },
      /** What the autopilot is doing: `'route' | 'wander' | 'still'`. */
      autopilot: () => route.kind,

      /**
       * Freezes the walk, the idle animation and every NPC, so a screenshot of a moving
       * scene is reproducible (ARCHITECTURE §6.3). The pose is kept exactly as it is.
       */
      freeze(on = true) { frozen = !!on; return api; },
      frozen: () => frozen,
      /**
       * Nudges the camera off the trainer by whole cells, for a staged screenshot. See
       * `focusShift`. Snaps immediately when the walk is frozen, so a showcase does not have
       * to spend frames letting the follow spring catch up to a scene it has already stopped.
       */
      frameOffset(dx = 0, dz = 0) {
        focusShift = { x: Math.round(dx), z: Math.round(dz) };
        renderPose(0);
        return api;
      },
      /** Advances the walk by `n` fixed sim ticks regardless of `frozen`; the showcase's tool. */
      advanceSteps(n = 1) {
        const was = frozen;
        frozen = false;
        for (let i = 0; i < n; i++) advance(SIM_DT);
        frozen = was;
        return line.distance;
      },
      /**
       * Walks to an exact point in the route and stops there: `tiles` completed steps plus
       * `subTicks` more sim ticks, so a showcase can freeze the queue mid-stride at a pose it
       * chose rather than at whatever the wall clock happened to reach.
       */
      advanceTo(tiles, subTicks = 0) {
        const was = frozen;
        frozen = false;
        let guard = 0;
        while (line.steps < tiles && guard++ < 40000) advance(SIM_DT);
        for (let i = 0; i < subTicks; i++) advance(SIM_DT);
        frozen = was;
        return { steps: line.steps, t: +line.t.toFixed(4), moving: line.moving };
      },

      // --- introspection ---------------------------------------------------
      /** The whole queue, head first, exactly as the renderer poses it. */
      lineup: () => members.map((m, i) => {
        const { p, patch } = poseWalker(line, i, 0, m);
        return {
          role: m.kind === 'trainer' ? 'trainer' : 'pokemon',
          who: m.kind === 'trainer' ? m.trainer : (m.species?.name ?? null),
          cx: p.cx, cz: p.cz, dir: p.dir, x: p.x, y: patch.y, z: p.z,
          gait: patch.gait, phase: patch.phase, moving: p.moving,
        };
      }),
      trail: () => line.trail.map((c) => ({ ...c })),
      /** Everything the debug overlay (and a probe) needs to see the walker's state. */
      debug: () => ({
        placed, frozen, autopilot: route.kind, gap: line.gap, members: members.length,
        head: formation.head, input: formation.input,
        steps: line.steps, t: +line.t.toFixed(4), moving: line.moving,
        distance: +line.distance.toFixed(3), animTime: +line.animTime.toFixed(3),
        surface: surface.ready, npcs: npcs.length, trailDepth: line.trail.length,
      }),
      gap: () => line.gap,
      surfaceAt: (cx, cz) => surface.at(cx, cz),
      /** Re-reads the map's surface heights; call after a map is rebuilt under our feet. */
      rebuildSurface: () => surface.rebuild(),

      dispose() { cast.clear(); npcs.length = 0; },

      // --- internals the descriptor drives --------------------------------
      _advance: advance,
      _render: renderPose,
    };

    // A lead swap re-cuts the head of the queue without moving anybody.
    bus.on('party:leadChanged', () => { if (!placed) return; rebuildMembers(); restage(); });

    /**
     * An evolved Pokemon has to change on screen, and until this listener existed it did not.
     *
     * `pokemon.evolve()` swaps the species **in place** on the instance, so `pokemon.party()`
     * reported the new one and the HUD updated — but `members` had captured the OLD species
     * object at its last `rebuildMembers`, and `Cast.keyOf` derives the sprite key from that.
     * The result was a Dewott in the party panel and an Oshawott still walking in front of the
     * trainer, indefinitely, with nothing anywhere throwing.
     *
     * The flash plays on the actor that is standing there *now*, before the restage: it
     * alternates between the two sheets, so it needs the actor that still holds the old one.
     * The restage then makes it permanent. Both halves are guarded — a quarantined `pokemon`
     * costs the moment its animation, never its correctness — and the restage runs even if the
     * animation could not, which is the half that is a bug fix rather than a flourish.
     */
    bus.on('pokemon:evolved', async ({ from, to } = {}) => {
      if (!placed) return;
      const pokemon = ctx.get('pokemon');
      const actorId = pokemonIndex >= 0 ? cast.actorId(pokemonIndex) : 0;
      const lead = isLive(pokemon) && typeof pokemon.lead === 'function' ? pokemon.lead() : null;

      // **The restage is the load-bearing half and it is unconditional.** The flourish moved
      // to `ui`'s full-screen cutscene (DECISIONS #64): animating a 32-pixel overworld sprite
      // behind the full-screen party panel that starts the evolution was a correct animation
      // in a place nobody was looking. What has to happen HERE is that the sprite walking in
      // front of the trainer stops being the old species.
      //
      // Deferred by most of one cutscene so the swap lands under the white-out rather than in
      // front of it. `ui` is asked how long that is rather than guessed at, and a quarantined
      // `ui` just means it happens immediately — which is correct, not degraded.
      const ui = ctx.get('ui');
      const wait = !config.showcase && isLive(ui) && ui.evolution ? ui.evolution.TOTAL * 620 : 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      void actorId; void lead;
      rebuildMembers();
      restage();
    });
    // A map rebuilt under the party invalidates every ground height we cached.
    bus.on('world:loaded', () => { surface.rebuild(); });

    // The autopilot is no longer installed here. A stroll belongs to a hunt, not to the
    // lobby: `setFormation` installs it when a scene that wants one is entered, which also
    // stops the city's own wander from following the player into a forest — `placePlayer`
    // resets the route but never replaced it.

    return api;
  },

  tick(dt, ctx) {
    ctx.get('simulation')._advance(dt);
  },

  /**
   * Poses and camera run at render rate, not at 20 Hz: writing sprite matrices only on a sim
   * step makes a 60 fps walk read as a 20 fps one, which is exactly the stutter the tile grid
   * is supposed to hide.
   */
  frame(dt, alpha, ctx) {
    ctx.get('simulation')._render(alpha);
  },

  async showcase(mode, ctx) {
    const { showcaseSimulation } = await import('./showcase.js');
    return showcaseSimulation(mode, ctx);
  },
};

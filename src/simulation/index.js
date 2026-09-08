/**
 * simulation — the grid walker, and the thing the whole game is looked at through
 * (ARCHITECTURE §5.4).
 *
 * The arrangement the brief asks for, which inverts the usual Pokemon follower:
 *
 *   - the **active Pokemon leads**. It is the head of the queue and the only entity input
 *     moves. It is also what walks into the tall grass first, so `player:enteredTile`
 *     carries *its* cell;
 *   - the **trainer follows**, standing where the lead stood `config.followerGapTiles` steps
 *     ago. The trainer is the player: `player()` and `teleport()` are about the trainer, which
 *     is the contract `offline` captures and restores through;
 *   - the **camera follows the trainer**, never the Pokemon. The lead turns corners a step
 *     early and a camera bolted to it would swing ahead of the frame every time;
 *   - the rest of the party trails behind the trainer in the same queue.
 *
 * Movement is 4-way and tile-locked: a step starts on a cell and ends on a cell, at
 * `config.walkSecondsPerTile` (0.25) or `runSecondsPerTile` (0.15). Both divide the 1/20 s
 * sim step exactly, so the same seed and the same input give the same path, cell for cell.
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
 * `config.followerGapTiles` ships at 1, which is the Black & White number for a camera that
 * is nearly top-down. Changing that default is a core change and is filed as a coreRequest;
 * until it lands this module raises it to 2 *unless the URL pinned a value*, so an explicit
 * `?followerGapTiles=1` still wins and the config contract holds.
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
    let trainerWho = 'hero';
    /** Where the NPC actors start inside the cast, which stages party and NPCs together. */
    let npcOffset = 0;

    /** @type {{id:number, line:Line, route:object, spec:object, who:string}[]} */
    const npcs = [];
    let nextNpcId = 1;

    let route = STILL;
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

    /** Rebuilds the queue from `pokemon.party()`: lead, trainer, then the rest. */
    function rebuildMembers() {
      const pokemon = ctx.get('pokemon');
      const party = (isLive(pokemon) && typeof pokemon.party === 'function' ? pokemon.party() : []) ?? [];
      const next = [];
      if (party.length) {
        next.push({ kind: 'pokemon', species: party[0].species, shiny: !!party[0].shiny, inst: party[0] });
      }
      next.push({ kind: 'trainer', trainer: trainerWho });
      for (const p of party.slice(1)) {
        next.push({ kind: 'pokemon', species: p.species, shiny: !!p.shiny, inst: p });
      }
      members = next;
      trainerIndex = party.length ? 1 : 0;
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
        npcOffset = partySpecs.length;
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

    /** One `player:moved` for the trainer and one `player:enteredTile` for the lead's cell. */
    function announce() {
      const t = line.cellOf(trainerIndex);
      const head = line.cellOf(0);
      bus.emit('player:moved', { cx: t.cx, cz: t.cz, dir: line.pose(trainerIndex, 0).dir, running: line.running });
      bus.emit('player:enteredTile', { cx: head.cx, cz: head.cz, tags: tagsAt(head.cx, head.cz) });
    }

    // ------------------------------------------------------------ the tick

    function stepOptions(running) {
      return {
        running,
        walkSeconds: config.walkSecondsPerTile,
        runSeconds: config.runSecondsPerTile,
        passable,
      };
    }

    function advance(dt) {
      if (frozen || !placed) return;

      if (line.advance(dt)) announce();
      if (!line.moving) {
        const head = line.pose(0, 0);
        const cmd = intent ?? route.next(head, world);
        intent = null;
        if (cmd) line.step(cmd.dir, stepOptions(!!cmd.running));
      }

      for (const npc of npcs) {
        npc.line.advance(dt);
        if (!npc.line.moving) {
          const cmd = npc.route.next(npc.line.pose(0, 0), world);
          if (cmd) npc.line.step(cmd.dir, stepOptions(!!cmd.running));
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
        patch.gait = l.running ? 'run' : 'walk';
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
        return { cx: c.cx, cz: c.cz, dir: p.dir, moving: line.moving, running: line.running };
      },
      /**
       * Queues one step. Overrides the autopilot for that step; a blocked direction still
       * turns the lead to face it, which is what Black & White does.
       */
      moveIntent(dir, running = false) { intent = { dir: dir & 3, running: !!running }; },
      stop() { intent = null; },

      /** The lead Pokemon — the head of the line, and the entity that meets the world first. */
      follower() {
        const lead = members[0];
        if (!lead || lead.kind !== 'pokemon') return null;
        const c = line.cellOf(0);
        const p = line.pose(0, 0);
        return {
          cx: c.cx, cz: c.cz, dir: p.dir, x: p.x, z: p.z, y: surface.at(c.cx, c.cz),
          moving: line.moving,
          species: lead.species?.name ?? null,
          instanceId: lead.inst?.instanceId ?? null,
          shiny: !!lead.shiny,
        };
      },
      /** The cell the lead Pokemon occupies — where a tall-grass encounter is rolled. */
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
            ? makeWander(rng, { preferTags: spec.preferTags ?? ['path'], running: !!spec.running })
            : spec.route ? makeScriptedRoute(spec.route, { loop: spec.loop !== false, running: !!spec.running })
              : STILL,
        };
        npcs.push(npc);
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
          role: i === trainerIndex ? 'trainer' : (i === 0 ? 'lead' : 'party'),
          who: m.kind === 'trainer' ? m.trainer : (m.species?.name ?? null),
          cx: p.cx, cz: p.cz, dir: p.dir, x: p.x, y: patch.y, z: p.z,
          gait: patch.gait, phase: patch.phase, moving: p.moving,
        };
      }),
      trail: () => line.trail.map((c) => ({ ...c })),
      /** Everything the debug overlay (and a probe) needs to see the walker's state. */
      debug: () => ({
        placed, frozen, autopilot: route.kind, gap: line.gap, members: members.length,
        steps: line.steps, t: +line.t.toFixed(4), moving: line.moving, running: line.running,
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
    // A map rebuilt under the party invalidates every ground height we cached.
    bus.on('world:loaded', () => { surface.rebuild(); });

    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

    // See MIN_READABLE_GAP: at gap 1 a 45-degree camera hides the lead behind the trainer.
    if (!params.has('followerGapTiles') && config.followerGapTiles < MIN_READABLE_GAP) {
      config.set({ followerGapTiles: MIN_READABLE_GAP });
    }

    // The default at `/` is a stroll — this is an idle game and a party standing to
    // attention in the plaza reads as a bug. `?autowalk=0` pins it for a stable screenshot;
    // a showcase always starts still and stages its own walk.
    const asked = params.get('autowalk');
    if (!config.showcase && asked !== '0' && asked !== 'false') {
      route = makeWander(ctx.rng.fork('simulation/wander'), { preferTags: ['path'] });
    }

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

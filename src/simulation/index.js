/**
 * simulation — the grid walker, and the thing the whole game is looked at through
 * (src/simulation/index.js).
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
 * alpha is dropped so the same URL gives the same pixels (tools/shots/shoot.js).
 *
 * This module owns no art. Sprites, sheets, atlas and contact shadows all belong to
 * `pokemon` and are reached through `ctx.get('pokemon')` (see cast.js).
 */

import { SIM_DT } from '../core/clock.js';
import { SOUTH, opposite, DIR_DX, DIR_DZ } from '../core/dir.js';
import { Line } from './line.js';
import { Cast } from './cast.js';
import { makeSurface } from './surface.js';
import { makeScriptedRoute, makeWander, makeTether, makePilotRoute, STILL } from './route.js';

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
 * A sprite is 16 texels per world unit and stretched by 1/cos(45°), so a
 * 32 px trainer frame is an upright quad 2.83 world units tall. Under a camera pitched 45°
 * below horizontal that quad covers `2.83 · sin(45°) = 2.0` tiles of *ground depth* on
 * screen. At `followerGapTiles = 1` the walker in front therefore covers the one behind it
 * completely: shot at `/` with the party walking north, the lead Pokemon — the entity the
 * whole brief is about — was entirely hidden behind the trainer
 *.
 *
 * The argument is symmetric and survives the formation flip: the occlusion is a property of
 * the *separation*, not of which walker is in front, so 2 is still the floor when the trainer
 * leads and the Pokemon walks behind it. `config.followerGapTiles` now ships at 2; this
 * module still raises it *unless the URL pinned a value*, so `?followerGapTiles=1` wins and
 * the config contract holds.
 */
const MIN_READABLE_GAP = 2;

const MAX_NPCS = 32;

/**
 * Fallback head height, in world units, for `lineup()`/`npcs()` entries when no live sprite
 * can report one — a cast slot that has not finished staging yet, or a quarantined `pokemon`.
 * Close to a trainer's own measured lift (`ui/plates.js`'s `TRAINER_LIFT`, ~2.26 — trimmed to
 * the art's own crown, not the sprite quad's empty top margin) so a plate that falls back
 * never lands somewhere obviously wrong.
 */
const DEFAULT_HEAD_LIFT = 2.3;

export default {
  id: 'simulation',
  needs: ['terrain', 'pokemon'],
  /** The showcase authors its own map but reuses the city for `mode=city` (src/main.js). */
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

    /**
     * The last frame's INTERPOLATED `{x,y,z}` per party member / NPC, cached by `renderPose()`
     * and read back by `lineup()`/`npcs()` (below) — `x`/`y`/`z` only; `cx`/`cz`/`dir`/`gait`/
     * `phase`/`moving` still come from a fresh `sub: 0` pose, unaffected.
     *
     * Sprites and the camera are posed every frame with `renderPose(alpha)`'s continuous
     * interpolation; `lineup()`/`npcs()` used to re-derive their own pose at `sub: 0` — the
     * tick-quantized position — which jumps once every sim tick (50 ms) while the sprite it
     * names glides. A nameplate anchored to `sub: 0` therefore trailed its sprite by up to one
     * full tick of motion, sawtoothing back into sync 20 times a second: the tremble
     * `ui/plates.js`'s callers reported. Indices stay valid across the one frame between
     * `renderPose()` (`registry.frame`) and `lineup()`/`npcs()` being read (`registry.
     * lateFrame`, `src/main.js`'s own ordering) — nothing mutates `members`/`npcs` in between.
     */
    let lastMemberPose = [];
    let lastNpcPose = [];

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
    /**
     * Steps the party owes before the autopilot is consulted again.
     *
     * `out` is queued by `detour()` — the APPROACH ONLY, one way. `advance()` drains it a step
     * at a time and, every time a step actually lands (`line.step` returns `true`), copies the
     * direction it just walked onto `taken` as it leaves `out`. So `taken` is never the plan —
     * it is the exact, verified record of how far the queue actually got. `back` is generated
     * from `taken`, never from `out`, the moment the approach ends: fully spent (the last queued
     * step landed and nothing is left to take), cut short on purpose (`detourHome()`, for a
     * fight that engaged mid-approach), or cut short by a blocked step (below). Either way `back`
     * is the reverse of `taken` with every direction inverted (`opposite`), so the return trip
     * always retraces cells the queue is KNOWN to have crossed rather than replaying a plan that
     * may have gone stale the instant one of its own steps met something solid.
     *
     * **This split is the fix for a stall that used to be permanent.** The old contract queued
     * both legs up front at commit time — `[step, opposite(step)]` — trusting a `line.step`
     * partway through never fails. When it did (another wild's own claimed cell, or a target's
     * tether drift closing a gap the plan assumed was open), the blocked step turned the head's
     * facing and did NOT move it (`Line.step`'s own contract) — but the old drain shifted it off
     * the queue regardless, so the return leg then ran one cell short and the head came home off
     * its own cell on the `strict` scripted circuit. `route.next()` then found the very next
     * scripted direction blocked, forever. A return leg is never queued now until the matching
     * outbound step has actually been walked, which removes the failure mode outright: `back` is
     * built from where the head demonstrably is, never from where a plan assumed it would be.
     */
    const detour = { out: [], taken: [], back: [], returnHome: true };
    /** Drops every queued detour step and everything recorded about the one in progress. */
    function resetDetour() {
      detour.out.length = 0;
      detour.taken.length = 0;
      detour.back.length = 0;
      detour.returnHome = true;
    }

    /**
     * Warns that a scripted route stalled, and emits `walk:stalled` with the same payload —
     * one shared helper so `setFormation`'s route construction and `setRoute`'s stay
     * identical rather than drifting into two slightly different messages. `hunts` listens for
     * the event to trigger a resync back onto the loop; the console line is what a human sees
     * without one.
     */
    function onRouteStall({ cx, cz, dir, index }) {
      log.warn(`simulation: the route stalled at (${cx},${cz}) facing ${dir}, step ${index} — `
        + 'the loop is blocked on the shipped map');
      bus.emit('walk:stalled', { cx, cz, dir, index });
    }
    let frozen = false;
    let paused = false;
    let placed = false;
    /**
     * A whole-cell nudge added to the camera's focus, for a staged frame only.
     *
     * The camera follows the trainer (src/simulation/index.js) and nothing in the game moves this.
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

    /**
     * Cells a **solid** NPC is standing on, `"cx,cz" -> npc id`.
     *
     * Wild Pokemon block the party now (the brief asks for it), and the geometry is why that is
     * safe rather than a way to wedge a `strict` route: a slot is at Chebyshev exactly 2 from
     * the circuit (`hunts.audit()` asserts it on every `enter()`) and its tether radius is 1, so
     * a wild's reachable set **never touches a loop cell**. The one blocked cell a walker can
     * meet is the approach cell of a detour, and the target is frozen before the step is taken.
     * Only `hunts` opts its wildlife in; the city's NPCs stay walk-through.
     */
    const solid = new Map();
    const cellKey = (cx, cz) => `${cx},${cz}`;

    /** Collision goes through terrain, always — this module never reads a tile itself. */
    function passable(cx, cz, dir) {
      const terrain = terrainApi();
      if (!isLive(terrain) || typeof terrain.passable !== 'function') return true;
      return !!terrain.passable(cx, cz, dir);
    }
    /** Terrain, plus whatever is standing there. `mover` is allowed to occupy its own cell. */
    function clear(cx, cz, dir, mover = 0) {
      if (!passable(cx, cz, dir)) return false;
      const who = solid.get(cellKey(cx, cz));
      return who === undefined || who === mover;
    }
    function tagsAt(cx, cz) {
      const terrain = terrainApi();
      if (!isLive(terrain) || typeof terrain.tagsAt !== 'function') return [];
      return terrain.tagsAt(cx, cz) ?? [];
    }
    /** What the PARTY walks against: terrain and every solid creature on it. */
    const world = { passable: (cx, cz, dir) => clear(cx, cz, dir, 0), tagsAt };
    /** What an NPC walks against: the same, minus its own claim. */
    const worldFor = (id) => ({ passable: (cx, cz, dir) => clear(cx, cz, dir, id), tagsAt });

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
      // A queued detour belongs to the cell it was queued from; an absolute move abandons it.
      resetDetour();
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

    /**
     * The options `line.step` walks a step with — terrain passability AND the `solid`
     * cell-occupancy map, for whichever `mover` is taking the step. Matches what `route.next()`
     * already picks a direction against (`world`/`worldFor(id)`, both built on `clear`): a step
     * chosen against terrain-plus-collision must also be WALKED against terrain-plus-collision,
     * or a direction can be picked correctly and then carry the walker through a solid body
     * anyway. The party is mover `0`, the same id `world.passable` uses, so its call sites take
     * the default; an NPC passes its own id (`worldFor`'s own id) so its own claimed cell does
     * not block its own step.
     */
    function stepOptions(mover = 0) {
      return { walkSeconds: config.walkSecondsPerTile, passable: (cx, cz, dir) => clear(cx, cz, dir, mover) };
    }

    function advance(dt) {
      if (frozen || !placed) return;

      if (line.advance(dt)) announce();
      if (!line.moving) {
        const head = line.pose(0, 0);
        // `paused` gates only the AUTOPILOT: a paused party finishes the tile it is on (the
        // `advance` above) and then stands, and a deliberate `moveIntent` still works, because
        // pausing is what a battle does and not what a cutscene does. The route keeps its
        // index, which is the whole difference between this and `halt()`.
        // **The detour is drained AHEAD of the autopilot**, which is what makes it invisible
        // to the route: `route.next` is never called on a detour step, so its index cannot
        // advance, and the head comes home to the cell it left with the route owing exactly
        // the step it owed before.
        // `paused` gates the detour too, and that is what makes `pause(true)` a clean freeze:
        // the party walks OUT, the fight starts, `pause(true)` stops the drain wherever `out`
        // and `back` happen to be, and `pause(false)` on `encounter:resolved` picks the drain
        // back up. Left ungated the head strolled back to the path while the duel was still
        // being fought, and the wild was left punching an empty cell.
        //
        // `out` and `back` are drained by separate branches below rather than one shared
        // "shift the next queued step" branch, because a step from each has to be handled
        // differently once `line.step` reports whether it actually landed — and the two are
        // mutually exclusive by construction: `back` is only ever populated at the instant
        // `out` empties (below, and in `detourHome()`), so at most one of them is ever
        // non-empty when this runs.
        if (intent) {
          const cmd = intent;
          intent = null;
          if (cmd) line.step(cmd.dir, stepOptions());
        } else if (paused) {
          // Frozen exactly where it stands — see the comment above.
        } else if (detour.out.length) {
          // Peek, don't shift: a blocked step must not be consumed as though it were taken.
          const dir = detour.out[0];
          if (line.step(dir, stepOptions())) {
            detour.out.shift();
            detour.taken.push(dir);
            if (!detour.out.length) {
              // The approach is fully spent — the return trip is exactly its mirror, unless
              // this approach was queued one-way (`detour(dirs, { returnHome: false })`), in
              // which case there is no trip home to build.
              if (detour.returnHome) detour.back = detour.taken.slice().reverse().map(opposite);
              detour.taken.length = 0;
            }
          } else {
            // Blocked mid-approach (Cause 2 of the old permanent stall: a multi-step path can
            // route through a cell another solid wild has since claimed). Abandon the rest of
            // the plan immediately rather than retry it — the cell that blocked it is not
            // going anywhere before the next tick either — and go home from exactly as far as
            // the queue actually got, not from where the plan assumed it would be. No step is
            // attempted this same tick; the next `advance()` call drains `back`.
            detour.out.length = 0;
            if (detour.returnHome) detour.back = detour.taken.slice().reverse().map(opposite);
            detour.taken.length = 0;
          }
        } else if (detour.back.length) {
          const dir = detour.back[0];
          if (line.step(dir, stepOptions())) {
            detour.back.shift();
          } else {
            // A step the queue itself just walked is now blocked — a genuine wedge, not
            // something to retry forever. Loud once, then let the route resume from wherever
            // the head actually is.
            log.warn('simulation: a detour could not retrace its own step home '
              + `(dir ${dir}) — abandoning the return leg where the party stands`);
            detour.back.length = 0;
          }
        } else {
          const cmd = route.next(head, world);
          if (cmd) line.step(cmd.dir, stepOptions());
        }
      }

      for (const npc of npcs) {
        const before = npc.line.pose(0, 0);
        npc.line.advance(dt);
        if (!npc.line.moving) {
          // Held creatures stand still: `hunts` freezes a wild the instant the party commits to
          // walking at it, so a tether step cannot move the target out from under the detour.
          const cmd = npc.held ? null : npc.route.next(npc.line.pose(0, 0), worldFor(npc.id));
          if (cmd) npc.line.step(cmd.dir, stepOptions(npc.id));
        }
        if (npc.solid) {
          const at = npc.line.pose(0, 0);
          if (at.cx !== before.cx || at.cz !== before.cz) {
            if (solid.get(cellKey(before.cx, before.cz)) === npc.id) solid.delete(cellKey(before.cx, before.cz));
            solid.set(cellKey(at.cx, at.cz), npc.id);
          }
        }
      }
    }

    // ----------------------------------------------------------- the render

    /**
     * How high above a staged actor's own feet its plate/balloon sits — the measured quad
     * height (`pokemon/sprites.js`'s `headLiftOf`, reached through `cast.sprites.get()`, which
     * is `pokemon.sprites.get()`'s published API), never a second guess at the same number.
     * `cast.sprites` already answers `null` for a quarantined or not-yet-live `pokemon`
     * (`Cast`'s own `isLive` guard), so this only has to cover *that* and a slot that has not
     * finished staging (`actorId` is 0 until `Cast.sync` spawns it).
     */
    function headLiftFor(actorId) {
      const sprites = cast.sprites;
      if (!sprites || !actorId) return DEFAULT_HEAD_LIFT;
      const a = sprites.get(actorId);
      return Number.isFinite(a?.headLift) ? a.headLift : DEFAULT_HEAD_LIFT;
    }

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
        lastMemberPose[i] = { x: p.x, y: patch.y, z: p.z };
        if (i === trainerIndex) {
          ctx.three.rig?.setFocus?.(p.x + focusShift.x, patch.y, p.z + focusShift.z, frozen);
        }
      }
      lastMemberPose.length = members.length;

      for (let n = 0; n < npcs.length; n++) {
        const npc = npcs[n];
        const npcSub = frozen ? 0 : Math.min(1, Math.max(0, alpha)) * SIM_DT / npc.line.secondsPerTile;
        const { p, patch } = poseWalker(npc.line, 0, npcSub, { kind: npc.spec.trainer ? 'trainer' : 'pokemon' });
        cast.set(npcOffset + n, patch);
        lastNpcPose[n] = { x: p.x, y: patch.y, z: p.z };
      }
      lastNpcPose.length = npcs.length;
    }

    // ----------------------------------------------------------------- API

    const api = {
      // --- src/simulation/index.js ------------------------------------------------------------
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
       * Turns the head of the walking queue on the spot, without moving it — `line.turn(dir)`
       * (`simulation/line.js`), written for exactly this and never called until a hunt battle
       * needed the party to visibly look at what it is fighting. "The head" is whichever member
       * `formation.head` put at the front of the queue (`setFormation`) — the party's Pokemon
       * in a hunt, the trainer on a walkable map — since that member is the only one whose
       * facing is a free value (`line.pose()`'s own `dir: k === 0 ? this.facing : to.dir`); a
       * follower's facing is fixed by the direction it last walked into its own cell and cannot
       * be turned without moving it.
       */
      face(dir) { line.turn(dir & 3); },

      /**
       * How the scene in the world is played: who leads, whether the player drives, and what
       * walks the queue when they do not. Called by `city.enter()` / `hunts.enter()` **before**
       * they place the player, because `placePlayer` lays the queue out against `head`.
       */
      setFormation(next = {}) {
        const kind = next.autopilot === 'wander' || next.autopilot === 'route' ? next.autopilot : 'none';
        formation = {
          head: next.head === 'trainer' ? 'trainer' : 'pokemon',
          input: next.input !== false,
          autopilot: kind,
          route: typeof next.route === 'string' || Array.isArray(next.route) ? next.route : null,
          strict: next.strict !== false,
          preferTags: Array.isArray(next.preferTags) ? [...next.preferTags] : ['path'],
          label: next.label ?? 'simulation/wander',
        };
        intent = null;
        resetDetour();
        paused = false;
        // A showcase always starts still and stages its own walk, and `?autowalk=0` pins a
        // frame — both guards are the ones the boot-time wander used to carry.
        const asked = params.get('autowalk');
        const auto = !config.showcase && asked !== '0' && asked !== 'false' && kind !== 'none';

        if (!auto) route = STILL;
        else if (kind === 'route' && formation.route) {
          // A hunt walks a CLOSED CIRCUIT (src/hunts/index.js), forever, and it is `strict` unless told
          // otherwise: a blocked step stalls where the player can see it rather than skipping
          // to the next heading and quietly walking the party off its own loop.
          route = makeScriptedRoute(formation.route, {
            loop: true,
            strict: formation.strict,
            onStall: onRouteStall,
          });
        } else if (kind === 'route') {
          log.warn("simulation: autopilot 'route' with no route spec — standing still");
          route = STILL;
        } else {
          // Forked per scene, so the forest and the meadow are different strolls and each one
          // is reproducible from its own stream rather than from wherever the shared one got to.
          route = makeWander(ctx.rng.fork(formation.label), { preferTags: formation.preferTags });
        }
        if (placed) { rebuildMembers(); restage(); renderPose(0); }
        return api;
      },
      formation: () => ({ ...formation, preferTags: [...formation.preferTags] }),

      /**
       * Replaces the scripted route object in place — the mid-session resync a hunt needs
       * once the head is back on its loop (`hunts.resyncToLoop()`), so the circuit picks up
       * from wherever it owes a step next, instead of restarting cold. `setFormation` is the
       * wrong tool for this: it also calls `resetDetour()`, `rebuildMembers()` and `restage()`,
       * throwing away exactly the in-flight state (a detour, the staged cast) a resync must
       * not disturb.
       *
       * Same shape as `setFormation`'s own scripted-route construction — `loop: true`,
       * `strict: formation.strict`, and the shared `onRouteStall` (above), so a fresh stall on
       * the new route still warns and emits `walk:stalled` exactly the way the original one
       * did. `formation.route` is updated too, so `sim.formation()` keeps reporting the loop
       * actually being walked.
       */
      setRoute(dirs) {
        formation = { ...formation, route: dirs };
        route = makeScriptedRoute(dirs, { loop: true, strict: formation.strict, onStall: onRouteStall });
        return api;
      },

      /**
       * Swaps the current route for a **pilot** — same slot `setRoute` writes, but there is no
       * fixed step list to record: `fn` is asked fresh every tick (`head`, `world`) and answers
       * `{ dir }` or `null`, the shape `hunts`'s waypoint-index A* re-planning needs instead of a
       * pre-computed circuit (see `makePilotRoute`, route.js). `formation.route` is cleared to
       * `null` rather than left holding a stale scripted-route spec, so `sim.formation()` never
       * reports a fixed path that is no longer what is actually being walked.
       */
      setPilot(fn) {
        formation = { ...formation, route: null };
        route = makePilotRoute(fn);
        return api;
      },

      /**
       * Stops the party where it stands, **keeping the route's place in its loop**.
       *
       * Three ways to stop and they are not interchangeable (src/simulation/index.js): `halt()` replaces the
       * route object and therefore loses a scripted route's index; `freeze()` is the
       * screenshot tool and also stops every NPC and the idle animation; this one is for a
       * battle, which has to hand the walk back exactly where it took it.
       */
      pause(on = true) { paused = !!on; return api; },
      paused: () => paused,

      /**
       * The active Pokemon, wherever it is standing — in front of the trainer in a hunt,
       * behind it in a walkable map. It is the src/simulation/index.js contract, so it follows the creature and
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
          spec: { trainer: spec.trainer, species: spec.species, shiny: spec.shiny, name: spec.name, display: spec.display ?? null },
          who: spec.trainer ?? null,
          /** Blocks the party's step. Wildlife opts in; the city's NPCs do not (src/simulation/index.js). */
          solid: !!spec.solid,
          /** Frozen where it stands, so a detour's target cannot walk out from under it. */
          held: false,
          route: spec.tether
            // A wild on a spawn slot drifts one tile and no further (src/hunts/index.js).
            ? makeTether(rng, spec.tether)
            : spec.route === 'wander' || (!spec.route && spec.wander)
              ? makeWander(rng, { preferTags: spec.preferTags ?? ['path'] })
              : spec.route ? makeScriptedRoute(spec.route, { loop: spec.loop !== false })
                : STILL,
        };
        npcs.push(npc);
        if (npc.solid) solid.set(cellKey(spec.cx ?? 0, spec.cz ?? 0), npc.id);
        npcOffset = members.length;
        restage();
        return { id: npc.id, cx: spec.cx ?? 0, cz: spec.cz ?? 0, dir };
      },
      /**
       * Every NPC, posed exactly as the renderer would — `x,y,z` are what `ui`'s nameplates
       * (src/ui/index.js) anchor to, and a plate a whole tile off its sprite because this read
       * used the discrete cell instead of the walker's own interpolated pose would be a
       * visible, silly bug. As with `lineup()`, above, `x`/`y`/`z` come from `renderPose()`'s
       * own cache (`lastNpcPose`) when it has run this frame — the interpolated position the
       * sprite is actually drawn at — falling back to the tick-quantized `sub: 0` pose only
       * when it has not (a Node test, or a read before the first `frame()`).
       *
       * `species`/`shiny`/`trainer`/`display` are the identity a caller needs to label the
       * NPC without reaching into its spec directly — `display` is the human label a spawner
       * chose (`spawnNpc`'s `display` option), for the NPCs a bare slug or a species id would
       * not read as (a city local, Nurse Joy); `null` when there is none to give.
       */
      npcs: () => npcs.map((n, i) => {
        const c = n.line.cellOf(0);
        const { p, patch } = poseWalker(n.line, 0, 0, { kind: n.spec.trainer ? 'trainer' : 'pokemon' });
        const rendered = lastNpcPose[i];
        return {
          id: n.id, cx: c.cx, cz: c.cz, dir: p.dir,
          x: rendered?.x ?? p.x, y: rendered?.y ?? patch.y, z: rendered?.z ?? p.z,
          moving: n.line.moving, name: n.spec.name ?? null,
          species: n.spec.species?.name ?? (typeof n.spec.species === 'string' ? n.spec.species : null),
          shiny: !!n.spec.shiny, trainer: n.spec.trainer ?? null, display: n.spec.display ?? null,
          headLift: headLiftFor(cast.actorId(npcOffset + i)),
        };
      }),
      removeNpc(id) {
        const i = npcs.findIndex((n) => n.id === id);
        if (i < 0) return false;
        const at = npcs[i].line.cellOf(0);
        if (solid.get(cellKey(at.cx, at.cz)) === id) solid.delete(cellKey(at.cx, at.cz));
        npcs.splice(i, 1);
        restage();
        return true;
      },

      /**
       * Freezes one NPC where it stands, or lets it go again.
       *
       * `hunts` holds a wild the instant the party commits to walking at it: the creature
       * drifts a tile around its slot, and a target that steps aside between the commit and the
       * arrival turns a detour — however many steps long — into a miss.
       */
      holdNpc(id, on = true) {
        const npc = npcs.find((n) => n.id === id);
        if (!npc) return false;
        npc.held = !!on;
        return true;
      },

      /**
       * Queues the party's APPROACH — **the out leg only**, one way. `route.next` is never
       * called on a queued step, so the scripted route's own index does not advance while the
       * party is off its own circuit, and the head comes home to the cell it left owing exactly
       * the step it owed before — that is still the whole mechanism by which a hunt can leave
       * its closed circuit to reach a creature and come home to the same lap (src/hunts/index.js).
       *
       * The return trip is no longer part of the call. `advance()` walks `out` a step at a
       * time, records every step that actually lands, and generates the way home itself from
       * that record the moment the approach ends — see the long comment on `detour`, above, for
       * why a replayed plan turned one blocked step into a permanent stall and a record of what
       * was actually walked cannot.
       *
       * `opts.returnHome` (default `true`) — pass `false` for a one-way walk: no `back` leg is
       * ever generated for this queued approach, however it ends (spent, blocked, or cut short
       * by `detourHome()`). That is what `hunts.resyncToLoop()` needs to walk the party back
       * onto its loop — a move that ends the trip, not one leg of an out-and-back.
       */
      detour(dirs, opts = {}) {
        const list = (Array.isArray(dirs) ? dirs : [dirs]).filter((d) => Number.isFinite(d));
        if (!list.length) return false;
        detour.out.push(...list.map((d) => d & 3));
        detour.returnHome = opts.returnHome !== false;
        return true;
      },
      detouring: () => detour.out.length > 0 || detour.back.length > 0,
      /**
       * Cuts a queued approach short and walks home from wherever the head actually got to,
       * right now — the same "reverse and invert what was actually taken" the approach's own
       * natural end uses (see `detour`, above), just triggered on demand instead of by `out`
       * running out on its own.
       *
       * `hunts` calls this the moment a fight starts: the party can engage as soon as it is
       * `config.slotEngageTiles` off a slot — as little as one cell — which can land mid-approach
       * on a multi-step detour, and the steps `out` still had queued would otherwise walk the
       * party on toward a creature that will not be there once the duel ends.
       *
       * **Never clobbers a `back` that is already built.** `bfsPath` stops one tile short of its
       * target on purpose, so no intermediate cell of an approach is usually within engage
       * range — the engage fires on the approach's own FINAL cell, by which point `advance()`'s
       * own out-drain branch (above) has already moved the whole trip into `back` and emptied
       * `taken`. That is the common case, not an edge case: rebuilding `back` from an empty
       * `taken` here would silently overwrite a fully-formed return trip with nothing, and the
       * party would never walk home. So `back` is only rebuilt when `taken` actually holds
       * something — the genuine mid-approach cut-short — and is left exactly as it is
       * otherwise. Either way `out` is cleared. A one-way approach (`detour(dirs, { returnHome:
       * false })`) never gets a `back` leg from this call either.
       */
      detourHome() {
        detour.out.length = 0;
        if (detour.taken.length) {
          if (detour.returnHome) detour.back = detour.taken.slice().reverse().map(opposite);
          detour.taken.length = 0;
        }
        return api;
      },
      /**
       * The exact passability the party's own walker steps with — terrain passability AND the
       * `solid` cell-occupancy map — for a caller (`hunts`) that wants to plan a path the walker
       * can actually complete, not just one that is clear of terrain alone. `ignoreNpcId`
       * excludes one creature's own claimed cell from the solid check, so a target's own tether
       * drift cannot make the very cell being walked TO read as blocked.
       *
       * `clear(cx, cz, dir, ignoreNpcId)` is exactly `world`'s own passability with the mover id
       * swapped from the party's placeholder (0) to the creature a caller wants to walk up to —
       * the same function, not a second guess at what it does.
       */
      passableFor(ignoreNpcId) {
        return (cx, cz, dir) => clear(cx, cz, dir, ignoreNpcId);
      },

      /**
       * Same contract as `passableFor`, above, but through `terrain.canStep(cx, cz, dir)`
       * instead of `terrain.passable` — a stricter step-legality check some terrains expose
       * (slopes, one-way ledges) that plain tile passability does not capture. `terrain` may not
       * carry `canStep` yet (a quarantined or pre-slice module), so this falls back to the exact
       * same `passable`-based check the existing `passable()` helper already falls back to,
       * rather than assuming the method exists and throwing against an older terrain.
       */
      canStepFor(ignoreNpcId) {
        return (cx, cz, dir) => {
          const terrain = terrainApi();
          const ok = isLive(terrain) && typeof terrain.canStep === 'function'
            ? !!terrain.canStep(cx, cz, dir)
            : passable(cx, cz, dir);
          if (!ok) return false;
          // `(cx, cz, dir)` is the FROM cell and the direction being stepped (`terrain.canStep`'s
          // own convention, matching `hunts/patrol.js`'s `standTiles` contract), so the solid
          // check has to land on the DESTINATION the step actually lands on — the same cell
          // `terrain.canStep` itself already resolved passability against — not on `(cx, cz)`
          // itself. Checking the source cell made every occupied cell unable to step OUT of
          // its own solid claim, which made `standTiles` return empty for a live wild standing
          // on its own slot and silently disabled the whole aggro detour (`hunts/index.js`'s
          // `chooseTarget` call) on every hunt map. `clear()`, above, already gets this right —
          // it is handed the destination cell directly by its own callers.
          const nx = cx + DIR_DX[dir], nz = cz + DIR_DZ[dir];
          const who = solid.get(cellKey(nx, nz));
          return who === undefined || who === ignoreNpcId;
        };
      },

      placePlayer,
      teleport: placePlayer,

      // --- the walk --------------------------------------------------------
      /** Follows a fixed path forever: `walk('n8 w6 s8 e6')`. */
      walk(spec, opts = {}) { resetDetour(); route = makeScriptedRoute(spec, opts); return api; },
      /** Strolls, seeded. Prefers the tags it is given, so a town walker keeps to the road. */
      wander(opts = {}) { route = makeWander(ctx.rng.fork(opts.label ?? 'simulation/wander'), opts); return api; },
      /** Stands still. */
      halt() { resetDetour(); route = STILL; return api; },
      /** What the autopilot is doing: `'route' | 'wander' | 'still'`. */
      autopilot: () => route.kind,

      /**
       * Freezes the walk, the idle animation and every NPC, so a screenshot of a moving
       * scene is reproducible (tools/shots/shoot.js). The pose is kept exactly as it is.
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
      /**
       * The whole queue, head first, exactly as the renderer poses it. `x`/`y`/`z` come from
       * `renderPose()`'s own cache (`lastMemberPose`, above) when it has run this frame — the
       * same interpolated position the sprite is drawn at, not the tick-quantized `sub: 0` this
       * still falls back to (a Node test, or a read before the first `frame()`). `cx`/`cz`/
       * `dir`/`gait`/`phase`/`moving` are cell-level facts a caller (`hunts`'s pilot,
       * `encounter`'s `slotNear`) plans against, so they always come from the fresh pose.
       */
      lineup: () => members.map((m, i) => {
        const { p, patch } = poseWalker(line, i, 0, m);
        const rendered = lastMemberPose[i];
        return {
          role: m.kind === 'trainer' ? 'trainer' : 'pokemon',
          who: m.kind === 'trainer' ? m.trainer : (m.species?.name ?? null),
          cx: p.cx, cz: p.cz, dir: p.dir,
          x: rendered?.x ?? p.x, y: rendered?.y ?? patch.y, z: rendered?.z ?? p.z,
          gait: patch.gait, phase: patch.phase, moving: p.moving,
          headLift: headLiftFor(cast.actorId(i)),
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
    bus.on('pokemon:evolved', async () => {
      if (!placed) return;
      const pokemon = ctx.get('pokemon');
      const actorId = pokemonIndex >= 0 ? cast.actorId(pokemonIndex) : 0;
      const lead = isLive(pokemon) && typeof pokemon.lead === 'function' ? pokemon.lead() : null;

      // **The restage is the load-bearing half and it is unconditional.** The flourish moved
      // to `ui`'s full-screen cutscene: animating a 32-pixel overworld sprite
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

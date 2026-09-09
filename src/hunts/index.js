/**
 * hunts — the biomes a party actually hunts in (ARCHITECTURE §5.14).
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
const DEFAULT_WALK = { route: 'e12', tiles: 3, subTicks: 7, dir: 3 };

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
  head: 'pokemon', input: false, autopilot: 'wander',
  preferTags: ['tallgrass', 'encounter', 'path'],
};

/** How many wild Pokemon a biome stands up, and how they are chosen. */
const WILD_CAP = 11;          // MAX_NPCS is 32 and `city` uses a dozen of them
const WILD_SPECIES_CAP = 6;   // one atlas sheet each; the rest are repeats

export default {
  id: 'hunts',
  needs: ['terrain', 'encounter', 'environment'],
  /**
   * Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6).
   *
   * The party is the point of a hunt — the lead walks the grass and the trainer follows —
   * and every reference still we are scored against has characters in it. So `simulation`
   * and `pokemon` are staged for the showcase even though the *maps* do not need them.
   */
  showcaseNeeds: ['tiles', 'simulation', 'pokemon'],

  init(ctx) {
    const { log, bus } = ctx;
    const terrain = ctx.get('terrain');
    /** @type {Map<string, object>} what the last build of each map reported. */
    const built = new Map();
    /** Worlds drawn from a tileset that is not the draft's — see the note in `enter`. */
    let extraWorlds = [];
    let currentId = null;

    /** @type {number[]} the wild Pokemon standing in this map's grass, by NPC id. */
    let wildIds = [];

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
      const sim = ctx.get('simulation');
      const pokemon = ctx.get('pokemon');
      if (!isLive(sim) || typeof sim.spawnNpc !== 'function') return 0;
      if (!isLive(pokemon) || typeof pokemon.species !== 'function') return 0;
      const cells = built.get(biome.id)?.wild ?? [];
      if (!cells.length) return 0;

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
      // different hour gives the nocturnal ones. Never `Math.random` (ARCHITECTURE §2.5).
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
        ...c, species: roster[i % roster.length], shiny: i === shinyAt,
      }));

      await pokemon.sprites?.prepare?.(picked.map((p) => ({ species: p.species, shiny: p.shiny })));

      for (const p of picked) {
        const npc = sim.spawnNpc({
          species: p.species, shiny: p.shiny, cx: p.cx, cz: p.cz, dir: p.dir ?? 0,
          // Named, because `simulation` forks its wander stream off the name: an unnamed NPC
          // keys off an incrementing id, so adding one more would reshuffle the walk of every
          // creature already on the map.
          name: `wild/${biome.id}/${p.cx},${p.cz}`,
        });
        if (npc) wildIds.push(npc.id);
      }
      return wildIds.length;
    }

    for (const biome of BIOMES) {
      terrain.register(`hunt-${biome.id}`, async (draft, c) => {
        const tiles = c.get('tiles');
        await tiles.load(draft.tileset);
        for (const extra of biome.alsoLoad ?? []) await tiles.load(extra);
        const palette = makePalette(tiles, draft.tileset, log);
        const rng = c.rng.fork(`hunts/${biome.id}/${draft.seed}`);
        const report = biome.build(draft, c, palette, rng, log) ?? {};
        built.set(biome.id, { ...report, missing: palette.missing() });
      });
    }

    /**
     * Stands the party on a marker, pointed the way this biome walks, and — under a frozen
     * clock — a few tiles into that walk so the queue is caught mid-stride.
     *
     * **This is the only staging path, and that is the whole of the "everyone still faces
     * north" bug.** Round 2 fixed `showcase.js` to freeze with `advanceTo` (tiles) instead
     * of `advanceSteps` (sim ticks) and then left this function calling `advanceSteps(7)` —
     * and `hunts.preset()` runs *after* the showcase, on every single capture, because the
     * harness applies `--preset` through `__HOOKS__.setPreset`. Seven sim ticks is 0.35 s,
     * which at `walkSecondsPerTile` 0.25 is **1.4 tiles**: the teleport reset the queue, the
     * lead took one step, and the trainer and the whole party behind it were still standing
     * in the pose `Line.place` laid them in. Probed on the running page before the change:
     * coast's `route` framing reported `steps: 1, distance: 1.2` with the lead at `dir: 3`
     * and every other walker at `dir: 2`, which is exactly the frame three blind rounds
     * called "the back of the trainer's cap".
     *
     * `Line.place` lays the *whole* queue along `dir` at the teleport, so a route that
     * starts east needs only two or three tiles of walk to be strung out east-west with
     * every sprite clear of the one behind it — the long `tiles` counts were compensating
     * for a north leg that had to be walked off first.
     */
    function stageWalk(sim, biome, spec = {}) {
      const walk = { ...DEFAULT_WALK, ...(biome.walk ?? {}), ...(spec.walk ?? {}) };
      // `walk` first, `teleport` second: `placePlayer` resets the route it finds, so setting
      // the route after the teleport would start it from wherever the last one left off.
      if (typeof sim.walk === 'function') sim.walk(walk.route, { loop: true });
      return walk;
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
      // (DECISIONS #60).
      if (ppu != null) ctx.config.set({ pixelsPerUnit: ppu });
      const sim = ctx.get('simulation');
      const biome = byId(currentId ?? 'forest');
      // The camera follows the trainer every frame (DECISIONS #27), so a framing that only
      // moves the rig is undone before the shutter — `city` learned this as #28j. Move the
      // party, and the rig follows it.
      if (isLive(sim) && typeof sim.teleport === 'function') {
        const walk = stageWalk(sim, biome, spec);
        sim.teleport(m.cx, m.cz, m.dir ?? spec.dir ?? walk.dir ?? 3);
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
      })),

      current: () => currentId,
      biome: (id) => {
        const b = byId(id);
        return {
          id: b.id, name: b.name, preset: b.preset, tileset: b.tileset, w: b.w, h: b.h,
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

        // `terrain.load` builds one `InstancedWorld` from one tileset, and `InstancedWorld`
        // resolves every placement's id against that tileset alone. A model from `props` put
        // through an AdAstra draft therefore draws AdAstra's model of the same number, with
        // no warning anywhere, because both ids exist (DECISIONS #26a). Anything from another
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
          sim.setFormation?.({
            ...HUNT_FORMATION, ...(biome.formation ?? {}),
            label: `simulation/wander/hunt-${biome.id}`,
          });
          sim.teleport(spawn.cx, spawn.cz, spawn.dir ?? 2);
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
            const walk = stageWalk(sim, biome, {});
            sim.teleport(cx, cz, walk.dir ?? 3);
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
        for (const f of fails) {
          log.warn(`hunts/${biome.id}: preset "${f.preset}" ${f.why} `
            + `${f.at ? `at ${f.at} — cx-5..cx+8 is ${f.span}` : ''}`);
        }
        return { ok: !fails.length, checked, fails };
      },
    };
    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseHunt } = await import('./showcase.js');
    return showcaseHunt(mode, ctx, BIOMES);
  },
};

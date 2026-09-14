/**
 * terrain — maps, heightfield and collision (src/terrain/index.js).
 *
 * Maps are *data*, produced by `city` and `hunts` through the authoring API and then
 * realised as instanced geometry. Nothing hand-places a mesh: if a scene cannot be
 * rebuilt from its seed and its author function, it cannot be re-screenshotted, and a
 * scene we cannot re-screenshot cannot be reviewed.
 */

import { MapDraft } from './draft.js';
import { parseMapFile } from './mapfile.js';
import { applyMapFile, builderFor } from './frommap.js';
import { populateFromMap } from './populate.js';

export default {
  id: 'terrain',
  needs: ['tiles'],
  /** Extra modules the showcase scene needs on top of `needs` (src/main.js). */
  showcaseNeeds: ['tiles'],

  init(ctx) {
    const { bus, log } = ctx;
    const builders = new Map();
    /** @type {{id:string, draft:MapDraft, world:object}|null} */
    let current = null;

    async function unload() {
      if (!current) return;
      const { id } = current;
      current.world?.dispose();
      current = null;
      bus.emit('world:unloaded', { mapId: id });
    }

    async function load(mapId, opts = {}) {
      const builder = builders.get(mapId);
      if (!builder) throw new Error(`terrain.load: no map registered as "${mapId}"`);
      await unload();

      const tiles = ctx.get('tiles');
      const draft = new MapDraft({ id: mapId, ...opts });
      // A hand-written builder returns nothing; a JSON-authored one (`registerMapFile`, via
      // `frommap.js`) returns the report the file carried on top of the draft — extras, loop,
      // wild slots, npcs, links. Kept as-is so a caller (a scene, or the Studio's own preview)
      // can build the extra `InstancedWorld`s and wire the rest without re-parsing the file.
      const report = (await builder(draft, ctx)) ?? null;
      draft.finalize();

      await tiles.load(draft.tileset);
      const world = tiles.buildInstances(ctx.three.scene, draft.tileset, draft.placements, { name: `map:${mapId}` });
      current = { id: mapId, draft, world, report };

      log.info(`map "${mapId}" ${draft.w}x${draft.h} — ${draft.placements.length} placements, ` +
        `${world.stats.meshes} meshes, ${Math.round(world.stats.triangles / 1000)}k tris`);
      bus.emit('world:loaded', {
        mapId, w: draft.w, h: draft.h, biome: draft.biome,
        placements: draft.placements.length, meshes: world.stats.meshes,
      });
      return api.handle();
    }

    const api = {
      /** Scenes register their author function once, at init. */
      register(mapId, builder) {
        if (builders.has(mapId)) log.warn(`terrain.register: replacing map "${mapId}"`);
        builders.set(mapId, builder);
      },
      /**
       * Registers a map from a parsed or raw `.map.json` document (`./mapfile.js`), replayed
       * through `./frommap.js` on every `load()` — the Map Studio's counterpart to a
       * hand-written biome builder. Throws if the document does not parse as a map file.
       * @param {string} mapId @param {object|string} json
       * @returns {object} the parsed map file, for a caller that wants its metadata up front
       */
      registerMapFile(mapId, json) {
        const map = parseMapFile(json);
        api.register(mapId, builderFor(map));
        return map;
      },
      registered: () => [...builders.keys()],

      load,
      unload,
      current: () => current?.id ?? null,
      draft: () => current?.draft ?? null,
      world: () => current?.world ?? null,
      /** The report a JSON-authored map's builder returned (`registerMapFile`), or null for a hand-written one. */
      report: () => current?.report ?? null,

      handle() {
        if (!current) return null;
        const d = current.draft;
        return {
          id: current.id, w: d.w, h: d.h, tileset: d.tileset, spawn: d.spawn,
          /**
           * The active map's gameplay-profile id — what `encounter/tables.js`, `idle/accrual.js`
           * and `encounter/drops.js` key their table/yield/loot lookups on (P5: these used to be
           * keyed off `d.biome`, a fixed 5-entry enum shared with the terrain-shape/environment
           * concern below; a map's *gameplay* profile and its *terrain shape* are different axes
           * and only coincided by convention for the four shipped hunts).
           *
           * Sourced from whatever the loaded map's own builder reported (`current.report`) —
           * `report.encounters.table` for a Studio-authored `.map.json` (`./frommap.js`) — and,
           * failing that, from `current.profileFallback` (`setDefaultProfile`, below), which a
           * scene with no map file loaded sets explicitly right after `load()` returns
           * (`src/hunts/index.js`'s `biome.id`, `src/city/index.js`'s/
           * `src/pokecenter/index.js`'s `'city'`). **Deliberately two separate sources**, not
           * one merged report: `city`/`pokecenter` test `terrain.report()`'s own truthiness to
           * decide whether a map file (and therefore its `npcs`/`lights`) was actually used —
           * folding a default INTO that report would make it truthy even on the pure proc-gen
           * path and silently stop every hand-authored NPC (Nurse Joy, the whole town) from
           * ever spawning again. `null` only when nothing has named a profile at all (a bare
           * test harness, e.g.); every reader already falls back the same way
           * `encounter/tables.js`'s own `TABLES[id] ?? TABLES.meadow` does for an id it does
           * not recognise, so this is safe to leave unresolved here.
           */
          encounterTable: current.report?.encounters?.table ?? current.profileFallback?.encounterTable ?? null,
          /**
           * Free-form category tags a map may declare (`map.tags`, `./mapfile.js`) — `'cave'`,
           * `'coastal'`, etc. Unlike `encounterTable` this is not a lookup key into one catalog:
           * a Dive/Dusk Ball wants to ask "is this place coastal/underground?", a question a
           * single id cannot answer once two differently-named maps might both be caves
           * (`economy/items.js`). Same two-source precedence as `encounterTable`, above.
           * Defaults to `[]`, never `null`, so a caller can always `.includes(...)` it without
           * a null-check.
           */
          tags: current.report?.tags ?? current.profileFallback?.tags ?? [],
        };
      },

      bounds: () => (current ? { w: current.draft.w, h: current.draft.h } : { w: 0, h: 0 }),
      inBounds: (cx, cz) => !!current && cx >= 0 && cz >= 0 && cx < current.draft.w && cz < current.draft.h,

      /** World Y of the walkable surface at a cell. */
      height(cx, cz) { return current ? current.draft.heightAt(cx, cz) : 0; },

      /**
       * @param {number} cx @param {number} cz
       * @param {number} [fromDir] the direction being moved in; ledges are one-way.
       */
      passable(cx, cz, fromDir) { return current ? current.draft.passable(cx, cz, fromDir) : false; },

      tagsAt(cx, cz) { return current ? current.draft.tagsAt(cx, cz) : []; },
      collisionAt(cx, cz) { return current ? current.draft.collisionAt(cx, cz) : 'block'; },

      /** Scenes compose maps through a draft; exposed for showcases and tools. */
      MapDraft,

      /**
       * Fetches and parses `/maps/<mapId>.map.json` when `ctx.config.mapFiles` is on
       * (`?mapFiles=1`) — a scene's registered builder calls this at the top of its own
       * closure and, on a hit, replays the file with `applyMapFile` instead of building from
       * code. Null on any miss (flag off, 404, a malformed file) so the caller's existing
       * hand-written builder is always the fallback, never a hard failure.
       */
      async tryLoadMapFile(mapId) {
        if (!ctx.config.mapFiles) return null;
        try {
          const res = await fetch(`/maps/${mapId}.map.json`);
          if (!res.ok) return null;
          return parseMapFile(await res.json());
        } catch (err) {
          log.warn(`terrain: could not load map file for "${mapId}" — ${err?.message ?? err}`);
          return null;
        }
      },
      /** Replays a parsed map file onto an in-progress draft — see `./frommap.js`. */
      applyMapFile: (draft, c, map) => applyMapFile(draft, c, map),
      /**
       * Spawns a loaded map's authored NPCs and registers its lights — see `./populate.js`.
       * Exposed here, rather than imported directly by `city`/`pokecenter`, because a deep
       * import into `terrain/populate.js` from a sibling module is exactly what
       * `tools/seams/run.js`'s "no deep imports" rule exists to catch; every other file under
       * this directory is reached the same indirect way (`tryLoadMapFile`, `applyMapFile`,
       * above).
       */
      populateFromMap: (c, data) => populateFromMap(c, data),
      /**
       * Names the gameplay-profile id/tags `handle()` should fall back to when the current
       * map's own report declares none (P5) — the proc-gen path of a scene that ALSO knows
       * how to load a `.map.json` (`city`, `pokecenter`, `hunts`). Called once, right after
       * `load()` resolves, by the same scene that just loaded — never by a sibling module.
       *
       * A no-op with nothing loaded; harmless for a call that races a `world:unloaded` (the
       * fallback is simply thrown away with `current` on the next `load()`/`unload()`).
       * @param {{encounterTable?:string|null, tags?:string[]}} profile
       */
      setDefaultProfile(profile = {}) {
        if (!current) return;
        current.profileFallback = { ...current.profileFallback, ...profile };
      },
    };
    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseTerrain } = await import('./showcase.js');
    return showcaseTerrain(mode, ctx);
  },
};

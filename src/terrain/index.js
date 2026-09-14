/**
 * terrain — maps, heightfield and collision (src/terrain/index.js).
 *
 * Maps are *data*: every one of them is a `.map.json` (`./mapfile.js`) authored in the Map
 * Studio and replayed onto a fresh `MapDraft` (`./draft.js`) through `./frommap.js`. Nothing
 * hand-places a mesh and nothing generates a map from code — a scene's registered builder
 * (`city`, `pokecenter`, `hunts`) does nothing but `loadMapFile` + `applyMapFile`.
 */

import { MapDraft } from './draft.js';
import { parseMapFile, DEFAULT_ECONOMY } from './mapfile.js';
import { applyMapFile, builderFor } from './frommap.js';
import { populateFromMap, buildExtras } from './populate.js';

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
      // Every registered builder is `(draft, ctx, opts) => applyMapFile(draft, ctx, map)` —
      // `builderFor` (`./frommap.js`) for a plain `.map.json` fetch, or one that closes over
      // an already-fetched `opts.map` so a caller who needed the file's own `w`/`h`/`tileset`
      // to size `opts` above (every real scene) does not fetch it twice. The report it
      // returns is what the file carried on top of the draft — extras, loop, spawn points,
      // npcs, links, economy — so a caller (a scene, or the Studio's own preview) can build
      // the extra `InstancedWorld`s and wire the rest without re-parsing the file.
      const report = (await builder(draft, ctx, opts)) ?? null;
      draft.finalize();

      await tiles.load(draft.tileset);
      const world = tiles.buildInstances(ctx.three.scene, draft.tileset, draft.placements, { name: `map:${mapId}` });
      current = { id: mapId, draft, world, report };

      log.info(`map "${mapId}" ${draft.w}x${draft.h} — ${draft.placements.length} placements, ` +
        `${world.stats.meshes} meshes, ${Math.round(world.stats.triangles / 1000)}k tris`);
      bus.emit('world:loaded', {
        mapId, w: draft.w, h: draft.h,
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
           * The active map's id, for anything that used to key off a fixed `biome` enum and
           * now just wants to know which map is loaded (`automation`'s "Hunt in" condition).
           */
          mapId: current.id,
          /**
           * Free-form category tags a map may declare (`map.tags`, `./mapfile.js`) — `'cave'`,
           * `'coastal'`, etc. A Dive/Dusk Ball wants to ask "is this place coastal/
           * underground?" (`economy/items.js`). Sourced from whatever the loaded map's own
           * builder reported (`current.report`, via `./frommap.js`) and, failing that, from
           * `current.profileFallback` (`setDefaultProfile`, below) — a scene with no map file
           * loaded sets this right after `load()` returns. **Deliberately two separate
           * sources**, not one merged report: `city`/`pokecenter` test `terrain.report()`'s
           * own truthiness to decide whether a map file (and therefore its `npcs`/`lights`)
           * was actually used — folding a default INTO that report would make it truthy
           * unconditionally. Defaults to `[]`, never `null`, so a caller can always
           * `.includes(...)` it without a null-check.
           */
          tags: current.report?.tags ?? current.profileFallback?.tags ?? [],
          /**
           * The map's own yield-multiplier profile — `idle/accrual.js` reads this instead of
           * the fixed 5-entry `biome` table it used to key off. Same two-source precedence as
           * `tags`, above; falls back to the neutral `DEFAULT_ECONOMY` profile
           * (`./mapfile.js`) when nothing has named one.
           */
          economy: current.report?.economy ?? current.profileFallback?.economy ?? DEFAULT_ECONOMY,
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
       * Fetches and parses `/maps/<mapId>.map.json` — every scene's registered builder calls
       * this at the top of its own closure and replays the file with `applyMapFile`. There is
       * no other way to build a map: nothing generates one from code any more. Throws (with
       * the fetch/parse error surfaced) on a 404 or a malformed file, rather than falling back
       * to anything — a missing map file is a real error, not a signal to build one from code.
       */
      async loadMapFile(mapId) {
        const res = await fetch(`/maps/${mapId}.map.json`);
        if (!res.ok) throw new Error(`terrain.loadMapFile: /maps/${mapId}.map.json ${res.status}`);
        return parseMapFile(await res.json());
      },
      /** Replays a parsed map file onto an in-progress draft — see `./frommap.js`. */
      applyMapFile: (draft, c, map) => applyMapFile(draft, c, map),
      /**
       * Builds every `role:"extra"` layer a loaded map's report carried (buildings, props,
       * dressing — anything composited from a second tileset) into its own `InstancedWorld`.
       * One shared helper so `city`/`pokecenter`/`hunts` don't each keep their own copy of
       * this loop — see `./populate.js`.
       */
      buildExtras: (c, report) => buildExtras(c, report),
      /**
       * Spawns a loaded map's authored NPCs and registers its lights — see `./populate.js`.
       * Exposed here, rather than imported directly by `city`/`pokecenter`, because a deep
       * import into `terrain/populate.js` from a sibling module is exactly what
       * `tools/seams/run.js`'s "no deep imports" rule exists to catch; every other file under
       * this directory is reached the same indirect way (`loadMapFile`, `applyMapFile`,
       * `buildExtras`, above).
       */
      populateFromMap: (c, data) => populateFromMap(c, data),
      /**
       * Names the tags/economy `handle()` should fall back to when the current map's own
       * report declares none. Called once, right after `load()` resolves, by the same scene
       * that just loaded — never by a sibling module.
       *
       * A no-op with nothing loaded; harmless for a call that races a `world:unloaded` (the
       * fallback is simply thrown away with `current` on the next `load()`/`unload()`).
       * @param {{tags?:string[], economy?:object}} profile
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

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
        return { id: current.id, w: d.w, h: d.h, biome: d.biome, tileset: d.tileset, spawn: d.spawn };
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
    };
    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseTerrain } = await import('./showcase.js');
    return showcaseTerrain(mode, ctx);
  },
};

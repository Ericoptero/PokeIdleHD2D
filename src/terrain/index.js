/**
 * terrain — maps, heightfield and collision (src/terrain/index.js).
 *
 * Maps are *data*, produced by `city` and `hunts` through the authoring API and then
 * realised as instanced geometry. Nothing hand-places a mesh: if a scene cannot be
 * rebuilt from its seed and its author function, it cannot be re-screenshotted, and a
 * scene we cannot re-screenshot cannot be reviewed.
 */

import { MapDraft } from './draft.js';

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
      await builder(draft, ctx);
      draft.finalize();

      await tiles.load(draft.tileset);
      const world = tiles.buildInstances(ctx.three.scene, draft.tileset, draft.placements, { name: `map:${mapId}` });
      current = { id: mapId, draft, world };

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
      registered: () => [...builders.keys()],

      load,
      unload,
      current: () => current?.id ?? null,
      draft: () => current?.draft ?? null,
      world: () => current?.world ?? null,

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

      /**
       * @param {number} cx @param {number} cz
       * @param {number} fromDir  the direction being stepped in, out of (cx,cz).
       * passable() plus an elevation rule: same-height ground connects, stairs bridge a
       * height change, and a ledge's own one-way check (in passable()) already covers itself.
       */
      canStep(cx, cz, fromDir) { return current ? current.draft.canStep(cx, cz, fromDir) : false; },

      tagsAt(cx, cz) { return current ? current.draft.tagsAt(cx, cz) : []; },
      collisionAt(cx, cz) { return current ? current.draft.collisionAt(cx, cz) : 'block'; },

      /** Scenes compose maps through a draft; exposed for showcases and tools. */
      MapDraft,
    };
    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseTerrain } = await import('./showcase.js');
    return showcaseTerrain(mode, ctx);
  },
};

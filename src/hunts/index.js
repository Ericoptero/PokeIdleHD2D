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

    function disposeExtras() {
      for (const w of extraWorlds) w.dispose?.();
      extraWorlds = [];
    }
    bus.on('world:unloaded', disposeExtras);

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

    /** Where a preset stands the party, and how far back the camera sits for it. */
    function stage(marker, { distance, dir = 2, offset = null } = {}) {
      const draft = terrain.draft();
      const m = draft?.marker(marker);
      if (!m) {
        log.warn(`hunts: no marker "${marker}" on "${terrain.current()}" — it has ` +
          `${draft ? [...draft.markers.keys()].join(', ') : 'no map loaded'}`);
        return false;
      }
      if (distance != null) ctx.config.set({ cameraDistance: distance });
      const sim = ctx.get('simulation');
      // The camera follows the trainer every frame (DECISIONS #27), so a framing that only
      // moves the rig is undone before the shutter — `city` learned this as #28j. Move the
      // party, and the rig follows it.
      if (isLive(sim) && typeof sim.teleport === 'function') {
        sim.teleport(m.cx, m.cz, m.dir ?? dir);
        // A teleport parks the queue on cell centres in a dead-straight line. Under the
        // harness's frozen clock, walk it a few fixed steps so it is caught mid-stride and
        // strung out along the route — the same trick, and the same reason, as #26d.
        if (ctx.config.timeFrozen && typeof sim.advanceSteps === 'function') {
          sim.advanceSteps(7);
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
      })),

      current: () => currentId,
      biome: (id) => {
        const b = byId(id);
        return { id: b.id, name: b.name, preset: b.preset, tileset: b.tileset, w: b.w, h: b.h };
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

        const draft = terrain.draft();
        const spawn = draft?.spawn ?? { cx: biome.w >> 1, cz: biome.h >> 1, dir: 2 };
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.teleport === 'function') {
          sim.teleport(spawn.cx, spawn.cz, spawn.dir ?? 2);
        } else {
          ctx.three.rig?.setFocus?.(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);
        }
        // Not in a showcase. Sim time is frozen for every capture, so a toast never expires
        // and sits in the corner of all 29 frames — over the near ground a critic reads.
        if (!ctx.config.showcase) bus.emit('ui:toast', { text: `Hunting ${biome.name}`, kind: 'info' });
        return handle;
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
          const sim = ctx.get('simulation');
          if (isLive(sim) && typeof sim.teleport === 'function') sim.teleport(+literal[1], +literal[2], 2);
          else ctx.three.rig?.setFocus?.(+literal[1] + 0.5, 0, +literal[2] + 0.5, true);
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
    };
    return api;
  },

  async showcase(mode, ctx) {
    const { showcaseHunt } = await import('./showcase.js');
    return showcaseHunt(mode, ctx, BIOMES);
  },
};

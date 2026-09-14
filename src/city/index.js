/**
 * city — the lobby (src/city/index.js).
 *
 * A composed town rather than a generated one: a paved square with the Pokemon Center and
 * the Mart facing it, a street running north between them, cottages up the road, lamp posts
 * that light at dusk, lit windows, and a cast of people and Pokemon on scripted routes.
 *
 * It is assembled from four files, split along the lines the engine forces:
 *
 *   `layout.js`      where everything is — one set of numbers, three consumers
 *   `map.js`         the AdAstra half: lawn, roads, paving, pond, trees, lamps, benches
 *   `structures.js`  the authored buildings and adapted props (their own tilesets, so their
 *                    own instanced worlds), plus every practical light
 *   `npcs.js`        the cast, spawned through `simulation`
 *
 * `simulation` and `pokemon` are reached through `ctx.get`, not declared in `needs`: a town
 * with nobody in it is still a town, and this way a broken walker costs the lobby its NPCs
 * instead of costing the game its lobby.
 */

import { buildCityMap, CITY_SIZE } from './map.js';
import { dressCity } from './structures.js';
import { populateCity, stageCityForShot } from './npcs.js';
import { FORMATION, PRESETS, SPAWN } from './layout.js';

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

export default {
  id: 'city',
  needs: ['terrain', 'environment'],
  /**
   * Extra modules the showcase scene needs on top of `needs` (src/main.js): the lobby is
   * judged on its cast, and the cast is `simulation` standing `pokemon`'s sprites on the map.
   */
  showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation'],

  init(ctx) {
    const { bus } = ctx;
    const terrain = ctx.get('terrain');
    // `?mapFiles=1`: replay a Studio-exported `.map.json` instead of `buildCityMap` — see the
    // identical seam in `src/hunts/index.js` for why this is safe to swap at just this one
    // call site. `structures.js`'s buildings/lamps/props are unaffected either way: they are
    // dressed from `layout.js` afterwards, in `enter()`, independent of the draft's own origin.
    terrain.register('demo-city', async (draft, c) => {
      const mapFile = await terrain.tryLoadMapFile('demo-city');
      return mapFile ? terrain.applyMapFile(draft, c, mapFile) : buildCityMap(draft, c);
    });

    /** @type {{dispose:() => void, stats:object}|null} */
    let dressing = null;
    /** @type {{dispose:() => void, ids:number[]}|null} */
    let cast = null;
    /** What the last `enter()`'s map file build reported (`applyMapFile`'s return, via
     *  `terrain.report()`), or `null` when `buildCityMap` ran instead — the same "was a map
     *  file used" signal `hunts/index.js`'s `built` map carries per biome, kept here as a
     *  single value because the city is a single map. Read by `preset()`/`formation()` so a
     *  Studio-authored camera preset or formation wins over `layout.js`'s constants exactly
     *  the way its `npcs`/`lights` already do in `enter()`, below. */
    let report = null;

    /**
     * The town takes itself down when its map is unloaded.
     *
     * `enter()` has always torn down first, which covers entering the city twice. It does not
     * cover *leaving*: travelling to a hunt calls `terrain.load('hunt-…')`, and without this
     * the Pokemon Center, the Mart, the cottages, the lamps and thirteen NPCs would still be
     * standing in the middle of the forest. `hunts` has had the same listener since it was
     * written; this is the half that was missing.
     */
    bus.on('world:unloaded', ({ mapId }) => {
      if (mapId !== 'demo-city') return;
      cast?.dispose();
      cast = null;
      dressing?.dispose();
      dressing = null;
      report = null;
    });

    /**
     * The nearest cell to `(cx, cz)` a walker can actually stand on, searched outward in
     * rings. A framing is authored as "look at the shopfront", and the cell that centres a
     * shopfront is quite often a bench or a flower bed — without this, `preset()` silently
     * degrades to a rig-only focus that `simulation` then overwrites on the very next frame,
     * which is exactly the bug that made `mode=pokecenter` render the default view.
     */
    function standableNear(cx, cz, radius = 4) {
      const t = ctx.get('terrain');
      if (typeof t.passable !== 'function') return { cx, cz };
      if (t.passable(cx, cz, SPAWN.dir)) return { cx, cz };
      for (let r = 1; r <= radius; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            // South first, then west/east, then north: the camera looks north, so stepping
            // back off a flower bed keeps what the framing was aimed at in the frame.
            if (t.passable(cx + dx, cz + dz, SPAWN.dir)) return { cx: cx + dx, cz: cz + dz };
          }
        }
      }
      return { cx, cz };
    }

    function focusOn(cx, cz) {
      const sim = ctx.get('simulation');
      const t = ctx.get('terrain');
      const at = standableNear(cx, cz);
      const y = typeof t.height === 'function' ? t.height(at.cx, at.cz) : 0;
      // The camera follows the trainer every frame, so framing a corner of the town means
      // standing the trainer in it. Falling back to the rig alone keeps presets working when
      // `simulation` is down.
      if (isLive(sim) && typeof sim.teleport === 'function') sim.teleport(at.cx, at.cz, SPAWN.dir);
      ctx.three.rig.setFocus(at.cx + 0.5, y, at.cz + 0.5, true);
    }

    const api = {
      /** How the lobby is played, so `travel` can show it without entering it. */
      formation: () => ({ ...(report?.formation ?? FORMATION) }),

      /** Builds the town and stands everybody in it. Safe to call again; it tears down first. */
      async enter() {
        cast?.dispose();
        cast = null;
        dressing?.dispose();
        dressing = null;

        const env = ctx.get('environment');
        env.setBiomePreset?.('city');
        // `hunts.enter()` sets the weather and this never did, so arriving from the coast
        // used to leave it raining in the lobby.
        env.setWeather?.('clear', 0);

        const handle = await terrain.load('demo-city', {
          w: CITY_SIZE, h: CITY_SIZE, tileset: 'bw2-adastra', biome: 'city', seed: ctx.config.seed,
        });
        // `terrain.report()` is `null` for the hand-written `buildCityMap` path (it returns
        // nothing) and the report `applyMapFile` produced for the Studio-exported path — the
        // same "was a map file used" signal `hunts/index.js` keeps per biome in `built`. Left
        // untouched (not defaulted here) on purpose: `cast`, below, tests its truthiness to
        // decide whether the map file's own `npcs`/`lights` are authoritative, and a default
        // folded into it would make that test true even on the proc-gen path.
        report = terrain.report();
        // The lobby has no wildlife by design (`encounter/tables.js`'s own empty `TABLES.city`)
        // — P5's `terrain.handle().encounterTable` needs a value regardless of which path
        // built this map, so it is named here explicitly rather than through `report`, above.
        terrain.setDefaultProfile?.({ encounterTable: 'city' });

        dressing = await dressCity(ctx);

        const spawn = handle?.spawn ?? SPAWN;
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.placePlayer === 'function') {
          // Before `placePlayer`, not after: it lays the queue out through `formation.head`,
          // so a formation applied afterwards would leave the line cut the wrong way round.
          sim.setFormation?.({ ...(report?.formation ?? FORMATION), label: 'simulation/wander/demo-city' });
          sim.placePlayer(spawn.cx, spawn.cz, spawn.dir ?? SPAWN.dir);
        }
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);

        // The map file is authoritative once one has been loaded: its own `npcs`/`lights`
        // replace `layout.js`'s hardcoded `NPCS` and `dressCity`'s own lamp registration —
        // `terrain.populateFromMap` (`src/terrain/populate.js`) is `city/npcs.js`'s
        // `populateCity` generalized to read a report instead of an import. `dressCity` still
        // ran just above for the buildings/props/paving `report.extras` has no consumer for
        // yet, and its own lamps are simply overwritten here when a map file won. No map file:
        // `populateCity` stays the only source, exactly as before this change.
        cast = report
          ? await terrain.populateFromMap(ctx, { npcs: report.npcs ?? [], lights: report.lights ?? [] })
          : await populateCity(ctx);
        return handle;
      },

      /**
       * Named camera framings the screenshot harness can request (src/main.js).
       *
       * A bare `"cx,cz"` is accepted as well, and that is a **workaround for a dead hook**.
       * `tools/shots/shoot.js --focus x,z` calls `window.__HOOKS__.focus()`, which sets the
       * camera rig and nothing else (`src/main.js`) — and `simulation` re-centres the rig on
       * the trainer on the very next frame, so every `--focus` capture of this scene silently
       * comes back as the default view, pixel-identical to the plaza preset. `preset()` teleports
       * first (`focusOn`), so `--preset 50,16` frames what `--focus 50,16` promised. The hook
       * itself is `main.js`'s.
       */
      preset(name) {
        const literal = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(String(name ?? ''));
        // The map file's own `cameras.presets` wins once one has been loaded, over
        // `layout.js`'s hand-authored `PRESETS` — see `report`'s own doc, above.
        const presets = report?.presets ?? PRESETS;
        const p = presets[name]
          ?? (literal ? { cx: Number(literal[1]), cz: Number(literal[2]) } : null)
          ?? (() => {
            const m = terrain.draft?.()?.marker(name);
            return m ? { cx: m.cx, cz: m.cz } : null;
          })();
        if (!p) return false;
        focusOn(p.cx, p.cz);
        return true;
      },
      presets: () => Object.keys(report?.presets ?? PRESETS),

      /** Every named point on the map — doors, lamps, framings. */
      markers: () => {
        const d = terrain.draft?.();
        return d ? [...d.markers.keys()] : [];
      },
      marker: (name) => terrain.draft?.()?.marker(name) ?? null,
      /** What the town is made of, for the debug overlay and the screenshot log. */
      stats: () => ({ ...(dressing?.stats ?? {}), npcs: cast?.ids.length ?? 0, extras: dressing?.extras ?? [] }),

      dispose() {
        cast?.dispose(); cast = null;
        dressing?.dispose(); dressing = null;
        report = null;
      },
    };
    return api;
  },

  async showcase(mode, ctx) {
    const city = ctx.get('city');
    await city.enter();
    if (mode && mode !== 'default') city.preset(mode);
    // Walk the cast to a fixed point and stop it there — a showcase must give the same pixels
    // for the same URL, and a scripted route is a pure function of how many sim steps ran.
    stageCityForShot(ctx);
  },
};

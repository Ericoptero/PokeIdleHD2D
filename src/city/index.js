/**
 * city — the lobby (src/city/index.js).
 *
 * A paved square with the Pokemon Center and the Mart facing it, a street running north
 * between them, cottages up the road, lamp posts that light at dusk, lit windows, and a cast
 * of people and Pokemon on scripted routes — entirely authored in the Map Studio and loaded
 * from `public/maps/demo-city.map.json` (`@/terrain/mapfile.js`). Nothing about the town is
 * generated or hardcoded here: `layout.js`/`map.js`/`structures.js`/`npcs.js` do not exist —
 * every building, lamp, prop, NPC and light the town has is in the map file.
 *
 * `simulation` and `pokemon` are reached through `ctx.get`, not declared in `needs`: a town
 * with nobody in it is still a town, and this way a broken walker costs the lobby its NPCs
 * instead of costing the game its lobby.
 */

const MAP_ID = 'demo-city';

/** A minimal fallback if a fresh install somehow loads before the file exists — a walkable
 *  cell for the trainer to stand on rather than a hard crash. */
const FALLBACK_SPAWN = { cx: 32, cz: 32, dir: 0 };
const FALLBACK_FORMATION = { head: 'trainer', input: true, autopilot: 'none' };

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
    terrain.register(MAP_ID, (draft, c, opts) => terrain.applyMapFile(draft, c, opts.map));

    /** @type {{dispose:() => void}|null} the buildings/lamps/props/paving worlds. */
    let extraWorlds = null;
    /** @type {{dispose:() => void, ids:number[]}|null} */
    let cast = null;
    /** What `enter()`'s `applyMapFile` reported (`terrain.report()`). */
    let report = null;

    /**
     * The town takes itself down when its map is unloaded.
     *
     * `enter()` has always torn down first, which covers entering the city twice. It does not
     * cover *leaving*: travelling to a hunt calls `terrain.load('hunt-…')`, and without this
     * the Pokemon Center, the Mart, the cottages, the lamps and every NPC would still be
     * standing in the middle of the forest.
     */
    bus.on('world:unloaded', ({ mapId }) => {
      if (mapId !== MAP_ID) return;
      cast?.dispose();
      cast = null;
      extraWorlds?.dispose();
      extraWorlds = null;
      report = null;
    });

    /**
     * The nearest cell to `(cx, cz)` a walker can actually stand on, searched outward in
     * rings. A framing is authored as "look at the shopfront", and the cell that centres a
     * shopfront is quite often a bench or a flower bed — without this, `preset()` silently
     * degrades to a rig-only focus that `simulation` then overwrites on the very next frame,
     * which is exactly the bug that made `mode=pokecenter` render the default view.
     */
    function standableNear(cx, cz, dir, radius = 4) {
      const t = ctx.get('terrain');
      if (typeof t.passable !== 'function') return { cx, cz };
      if (t.passable(cx, cz, dir)) return { cx, cz };
      for (let r = 1; r <= radius; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            // South first, then west/east, then north: the camera looks north, so stepping
            // back off a flower bed keeps what the framing was aimed at in the frame.
            if (t.passable(cx + dx, cz + dz, dir)) return { cx: cx + dx, cz: cz + dz };
          }
        }
      }
      return { cx, cz };
    }

    function focusOn(cx, cz) {
      const sim = ctx.get('simulation');
      const t = ctx.get('terrain');
      const dir = report?.formation?.head === 'trainer' ? 0 : FALLBACK_FORMATION.dir ?? 0;
      const at = standableNear(cx, cz, dir);
      const y = typeof t.height === 'function' ? t.height(at.cx, at.cz) : 0;
      // The camera follows the trainer every frame, so framing a corner of the town means
      // standing the trainer in it. Falling back to the rig alone keeps presets working when
      // `simulation` is down.
      if (isLive(sim) && typeof sim.teleport === 'function') sim.teleport(at.cx, at.cz, dir);
      ctx.three.rig.setFocus(at.cx + 0.5, y, at.cz + 0.5, true);
    }

    const api = {
      /** How the lobby is played, so `travel` can show it without entering it. */
      formation: () => ({ ...(report?.formation ?? FALLBACK_FORMATION) }),

      /** Builds the town and stands everybody in it. Safe to call again; it tears down first. */
      async enter() {
        cast?.dispose();
        cast = null;
        extraWorlds?.dispose();
        extraWorlds = null;

        const env = ctx.get('environment');
        const map = await terrain.loadMapFile(MAP_ID);
        env.setBiomePreset?.(map.environmentPreset);
        // `hunts.enter()` sets the weather and this never did, so arriving from the coast
        // used to leave it raining in the lobby.
        env.setWeather?.(map.weather?.[0] ?? 'clear', map.weather?.[1] ?? 0);

        const handle = await terrain.load(MAP_ID, {
          w: map.w, h: map.h, tileset: map.tileset, seed: map.seed, map,
        });
        report = terrain.report();
        terrain.setDefaultProfile?.({ economy: map.economy });

        extraWorlds = await terrain.buildExtras(ctx, report);

        const spawn = handle?.spawn ?? FALLBACK_SPAWN;
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.placePlayer === 'function') {
          // Before `placePlayer`, not after: it lays the queue out through `formation.head`,
          // so a formation applied afterwards would leave the line cut the wrong way round.
          sim.setFormation?.({ ...(report?.formation ?? FALLBACK_FORMATION), label: `simulation/wander/${MAP_ID}` });
          sim.placePlayer(spawn.cx, spawn.cz, spawn.dir ?? FALLBACK_SPAWN.dir);
        }
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);

        cast = await terrain.populateFromMap(ctx, { npcs: report?.npcs ?? [], lights: report?.lights ?? [] });
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
        const presets = report?.presets ?? {};
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
      presets: () => Object.keys(report?.presets ?? {}),

      /** Every named point on the map — doors, lamps, framings. */
      markers: () => {
        const d = terrain.draft?.();
        return d ? [...d.markers.keys()] : [];
      },
      marker: (name) => terrain.draft?.()?.marker(name) ?? null,
      /** What the town is made of, for the debug overlay and the screenshot log. */
      stats: () => ({ ...(extraWorlds?.stats ?? {}), npcs: cast?.ids.length ?? 0 }),

      dispose() {
        cast?.dispose(); cast = null;
        extraWorlds?.dispose(); extraWorlds = null;
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
    const { stageCityForShot } = await import('./stage.js');
    stageCityForShot(ctx);
  },
};

/**
 * pokecenter — the Pokemon Center's interior (ARCHITECTURE §5.18).
 *
 * One room, entered through the city's own `door:pokecenter` tile and left through this
 * room's own door tile, both driven off `simulation`'s `player:enteredTile` (ARCHITECTURE
 * §5.4) rather than a special-cased key: walking onto a tagged cell **is** the interaction,
 * the same way a hunt's tall grass is (`encounter/index.js`).
 *
 * It is assembled from three files, split the way `city` splits its four:
 *
 *   `layout.js`  where everything is — one set of numbers, two consumers
 *   `map.js`     the base tileset half (`pt-house-indoor`): floor, walls, the counter
 *   `dress.js`   the window and the benches (their own tilesets, so their own instanced
 *                worlds) plus the one practical light
 *
 * **No healing here.** `city.enter()` still cures the party on arrival, exactly as it does
 * today (DECISIONS #81) — this room adds nowhere for that logic to move to yet. A follow-up
 * slice gates the cure behind Nurse Joy and a cooldown and removes the free lobby heal; until
 * it lands, walking in and out of this room changes nothing about the party's HP.
 *
 * **Not on the travel panel.** `travel.destinations()` carries it with `hidden: true`
 * (§5.16) so `ui/panels/travel.js` never lists it — the door is the only way in, on purpose
 * (the user's own answer, recorded in the slice this module was written from).
 */

import { buildPokecenterMap } from './map.js';
import { dressPokecenter } from './dress.js';
import {
  ROOM_W, ROOM_H, TILESET, SPAWN, EXIT_TAG, RETURN_DIR, FORMATION, PRESETS,
} from './layout.js';

/** The registry hands out a null-object proxy for a dead module; `__missing` is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/** The terrain map id, and `travel`'s destination id — the two are the same string, the way
 *  `hunts` registers `hunt-<id>` under the id `hunts.list()` uses for it. */
const MAP_ID = 'pokecenter';

export default {
  id: 'pokecenter',
  needs: ['terrain', 'environment'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation'],

  init(ctx) {
    const { bus, log } = ctx;
    const terrain = ctx.get('terrain');
    terrain.register(MAP_ID, (draft, c) => buildPokecenterMap(draft, c));

    /** @type {{dispose:() => void, stats:object}|null} */
    let dressing = null;

    /** The room takes itself down when its map is unloaded — see `city/index.js`'s twin. */
    bus.on('world:unloaded', ({ mapId }) => {
      if (mapId !== MAP_ID) return;
      dressing?.dispose();
      dressing = null;
    });

    /**
     * The door, both ways. `simulation` emits `player:enteredTile` with the landing cell's
     * tags on every step (`src/simulation/index.js` `announce()`); this is the only listener
     * in the game that reads `door:pokecenter` or `EXIT_TAG`, so the transition lives here
     * rather than split across `city` and `travel`.
     *
     * `queueMicrotask`, the same way `travel`'s own `party:wiped` handler defers: this fires
     * from inside `simulation`'s tick, and `travel.go()` calls `sim.halt()` on its way in —
     * safe to call re-entrantly here (the step that produced this event has already finished),
     * but deferred anyway so a scene change is never observed mid-tick.
     */
    bus.on('player:enteredTile', ({ tags }) => {
      if (ctx.config.showcase) return;          // a showcase stages a frame; it never travels
      if (!Array.isArray(tags) || !tags.length) return;
      const nav = ctx.get('travel');
      if (!isLive(nav) || typeof nav.go !== 'function') return;
      const here = nav.current?.()?.id;

      if (tags.includes('door:pokecenter') && here === 'demo-city') {
        queueMicrotask(() => {
          nav.go(MAP_ID).catch((err) =>
            log.warn(`pokecenter: could not walk in through the door — ${err?.message ?? err}`));
        });
        return;
      }
      if (tags.includes(EXIT_TAG) && here === MAP_ID) {
        queueMicrotask(async () => {
          try {
            await nav.go('demo-city');
            // `city/map.js` mints this marker for every plot; the pokecenter's own is one
            // cell south of its door, which is exactly where a player leaving on foot should
            // land — the same marker `travel`'s wiped-party teleport already targets.
            const t = ctx.get('terrain');
            const marker = isLive(t) ? t.draft?.()?.markers?.get('pokecenter-door') : null;
            const sim = ctx.get('simulation');
            if (marker && isLive(sim) && typeof sim.teleport === 'function') {
              sim.teleport(marker.cx, marker.cz, RETURN_DIR);
            }
          } catch (err) {
            log.warn(`pokecenter: could not walk the player back outside — ${err?.message ?? err}`);
          }
        });
      }
    });

    /**
     * A named framing lands on a cell this room already guarantees is walkable — unlike
     * `city`'s arbitrary corners, nothing here needs `standableNear`'s ring search.
     */
    function focusOn(cx, cz) {
      const sim = ctx.get('simulation');
      const y = terrain.height(cx, cz);
      if (isLive(sim) && typeof sim.teleport === 'function') sim.teleport(cx, cz, SPAWN.dir);
      ctx.three.rig.setFocus(cx + 0.5, y, cz + 0.5, true);
    }

    const api = {
      /** How the room is played, so `travel` can show it without entering it. */
      formation: () => ({ ...FORMATION }),

      /** Builds the room and stands the trainer in it. Safe to call again; it tears down first. */
      async enter() {
        dressing?.dispose();
        dressing = null;

        const env = ctx.get('environment');
        // `enclosed:1` is the `interior` preset's own default (`environment/presets.js`), not
        // something this module sets explicitly — the same thing `hunts`' cave relies on
        // (`grep setEnclosure src/hunts` is empty). Verified on screen, not just read.
        env.setBiomePreset?.('interior');
        env.setWeather?.('clear', 0);

        const handle = await terrain.load(MAP_ID, {
          // `biome:'city'` on purpose, not `'interior'`: `encounter`'s `BIOMES` list does not
          // contain `'interior'`, and `tableFor()` falls back to **meadow** for anything it
          // does not recognise — this room would otherwise spawn wild meadow Pokemon on its
          // own carpet. `'city'` already resolves to an empty table (`TABLES.city = []`).
          w: ROOM_W, h: ROOM_H, tileset: TILESET, biome: 'city', seed: ctx.config.seed,
        });

        dressing = await dressPokecenter(ctx);

        const spawn = handle?.spawn ?? SPAWN;
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.placePlayer === 'function') {
          sim.setFormation?.({ ...FORMATION, label: 'simulation/wander/pokecenter' });
          sim.placePlayer(spawn.cx, spawn.cz, spawn.dir ?? SPAWN.dir);
        }
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);

        return handle;
      },

      /** Named camera framings the screenshot harness can request (ARCHITECTURE §8). */
      preset(name) {
        const literal = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(String(name ?? ''));
        const p = PRESETS[name]
          ?? (literal ? { cx: Number(literal[1]), cz: Number(literal[2]) } : null)
          ?? (() => {
            const m = terrain.draft?.()?.marker(name);
            return m ? { cx: m.cx, cz: m.cz } : null;
          })();
        if (!p) return false;
        focusOn(p.cx, p.cz);
        return true;
      },
      presets: () => Object.keys(PRESETS),

      /** Every named point on the map — the exit door, the framings. */
      markers: () => {
        const d = terrain.draft?.();
        return d ? [...d.markers.keys()] : [];
      },
      marker: (name) => terrain.draft?.()?.marker(name) ?? null,
      /** What the room is made of, for the debug overlay and the screenshot log. */
      stats: () => ({ ...(dressing?.stats ?? {}) }),

      dispose() {
        dressing?.dispose();
        dressing = null;
      },
    };
    return api;
  },

  async showcase(mode, ctx) {
    const pc = ctx.get('pokecenter');
    await pc.enter();
    if (mode && mode !== 'default') pc.preset(mode);
    // No cast to stage: the room has nobody in it yet (Nurse Joy is a follow-up slice), and
    // the trainer never moves on its own (`FORMATION.autopilot:'none'`), so the frame is
    // already the same for the same URL every time — nothing to freeze.
  },
};

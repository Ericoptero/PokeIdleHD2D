/**
 * pokecenter — the Pokemon Center's interior (src/pokecenter/index.js).
 *
 * One room, entered through the city's own `door:pokecenter` tile and left through this
 * room's own door tile, both driven off `simulation`'s `player:enteredTile` (ARCHITECTURE
 * src/simulation/index.js) rather than a special-cased key: walking onto a tagged cell **is** the interaction,
 * the same way a hunt's tall grass is (`encounter/index.js`).
 *
 * It is assembled from four files, split the way `city` splits its four:
 *
 *   `layout.js`  where everything is — one set of numbers, every other file here reads it
 *   `map.js`     the base tileset half (`pt-house-indoor`): floor, walls, the counter
 *   `dress.js`   the window and the benches (their own tilesets, so their own instanced
 *                worlds) plus the one practical light
 *   `heal.js`    the cure's cooldown arithmetic — pure, no `ctx`
 *
 * **Nurse Joy is the cure.** Facing the counter (its 3 cells carry the `counter` tag, added
 * by `map.js`) and pressing the generic `player:interact` key (`ui/input.js`, `Z`/`Space`)
 * opens a dialogue with her: off cooldown, the whole party is healed — HP, status **and PP**,
 * the actual difference from every other recovery in the game — once every `HEAL_COOLDOWN_MS`
 * real seconds (`heal.js`), free. `city.enter()` no longer heals anything; a party wipe still arrives already healed (`encounter.wipe()`'s
 * own `pokemon.reviveAll()`, unchanged), just in this room now instead of on the pavement, and
 * that path never touches the cooldown.
 *
 * **Not on the Routes screen.** `travel.destinations()` carries it with `hidden: true`
 * (src/travel/index.js) so `ui/screens/travel.js` never lists it — the door is the only way in.
 */

import { buildPokecenterMap } from './map.js';
import { dressPokecenter } from './dress.js';
import { remainingCooldownMs } from './heal.js';
import {
  ROOM_W, ROOM_H, TILESET, SPAWN, NURSE, EXIT_TAG, RETURN_DIR, FORMATION, PRESETS,
} from './layout.js';

/** The registry hands out a null-object proxy for a dead module; `__missing` is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/** The terrain map id, and `travel`'s destination id — the two are the same string, the way
 *  `hunts` registers `hunt-<id>` under the id `hunts.list()` uses for it. */
const MAP_ID = 'pokecenter';

/** Save slice version. `loadState` migrates forward and refuses a newer one (src/offline/slices.js). */
const SAVE_VERSION = 1;

export default {
  id: 'pokecenter',
  needs: ['terrain', 'environment'],
  /** Extra modules the showcase scene needs on top of `needs` (src/main.js). */
  showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation'],

  init(ctx) {
    const { bus, log } = ctx;
    const terrain = ctx.get('terrain');
    // `?mapFiles=1` — see the identical seam in `src/city/index.js` / `src/hunts/index.js`.
    terrain.register(MAP_ID, async (draft, c) => {
      const mapFile = await terrain.tryLoadMapFile(MAP_ID);
      return mapFile ? terrain.applyMapFile(draft, c, mapFile) : buildPokecenterMap(draft, c);
    });

    /** @type {{dispose:() => void, stats:object}|null} */
    let dressing = null;
    /** Nurse Joy's `simulation` npc id, when the hardcoded `NURSE` fallback spawned her —
     *  null on the map-file path, which tracks its own npc ids in `mapCast` instead. Kept
     *  separate rather than folded into `mapCast` so the legacy spawn below stays untouched. */
    let nurseId = null;
    /** @type {{dispose:() => void, ids:number[]}|null} what `populateFromMap` spawned when a
     *  map file was loaded — see `report`'s own doc, below, for when that is. */
    let mapCast = null;
    /** What the last `enter()`'s map file build reported (`applyMapFile`'s return, via
     *  `terrain.report()`), or `null` when `buildPokecenterMap` ran instead — the same signal
     *  `city/index.js` keeps for its own single map. Read by `preset()`/`formation()` so a
     *  Studio-authored camera preset or formation wins over `layout.js`'s constants. */
    let report = null;
    /** `ctx.clock.wallMs()` of the last successful cure, or `null` — "never healed" (see heal.js). */
    let lastHealMs = null;

    /** The room takes itself down when its map is unloaded — see `city/index.js`'s twin. */
    bus.on('world:unloaded', ({ mapId }) => {
      if (mapId !== MAP_ID) return;
      dressing?.dispose();
      dressing = null;
      mapCast?.dispose();
      mapCast = null;
      report = null;
      const sim = ctx.get('simulation');
      if (nurseId != null && isLive(sim) && typeof sim.removeNpc === 'function') sim.removeNpc(nurseId);
      nurseId = null;
    });

    /**
     * The cure. `player:interact` (`ui/input.js`) carries the faced cell's tags, read the same
     * way `simulation`'s own `announce()` builds `player:enteredTile`'s payload — so this only
     * has to check for `'counter'`, and any future NPC anywhere else in the game gets the same
     * key for free rather than a Center-specific one.
     *
     * **Unconditional once off cooldown** — no "is anyone even hurt" check, unlike the deleted
     * `city.enter()` heal (real Nurse Joy does not check first either). `pokemon.reviveAll()`
     * is the `revive: true` allowlist's caller #1 (`pokemon/instance.js:230-266`), reused here,
     * not duplicated; restoring every move slot's PP on top of it is the actual functional
     * difference between this cure and every other recovery path in the game (the wipe, the
     * hunt lap) — neither of those touches PP.
     */
    bus.on('player:interact', ({ tags }) => {
      if (ctx.config.showcase) return;          // a showcase stages a frame; it never heals
      if (!Array.isArray(tags) || !tags.includes('counter')) return;
      const nav = ctx.get('travel');
      if (!isLive(nav) || typeof nav.current !== 'function' || nav.current()?.id !== MAP_ID) return;

      const ui = ctx.get('ui');
      if (!isLive(ui) || typeof ui.say !== 'function') return;

      const remaining = remainingCooldownMs(lastHealMs, ctx.clock.wallMs());
      if (remaining > 0) {
        ui.say(['We need a moment to get your Pokémon ready — please come back shortly.'],
          { speaker: 'Nurse Joy' });
        return;
      }

      // Gated on `pokemon` actually being reachable: a stamp and a "you're all healed" line
      // with nothing behind either would be Nurse Joy lying to a player under `?break=pokemon`.
      const pokemon = ctx.get('pokemon');
      if (!isLive(pokemon) || typeof pokemon.reviveAll !== 'function') return;
      pokemon.reviveAll();
      const party = typeof pokemon.party === 'function' ? pokemon.party() : [];
      if (typeof pokemon.restorePp === 'function') {
        for (const m of party) {
          for (const slot of m?.moves ?? []) pokemon.restorePp(m.instanceId, { moveId: slot.id, amount: 'full' });
        }
      }
      lastHealMs = ctx.clock.wallMs();
      ui.say(['We\'ve restored your Pokémon to full health!', 'We hope to see you again!'],
        { speaker: 'Nurse Joy' });
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
      formation: () => ({ ...(report?.formation ?? FORMATION) }),

      /** Builds the room and stands the trainer in it. Safe to call again; it tears down first. */
      async enter() {
        dressing?.dispose();
        dressing = null;
        mapCast?.dispose();
        mapCast = null;

        const env = ctx.get('environment');
        // `enclosed:1` is the `interior` preset's own default (`environment/presets.js`), not
        // something this module sets explicitly — the same thing `hunts`' cave relies on
        // (`grep setEnclosure src/hunts` is empty). Verified on screen, not just read.
        env.setBiomePreset?.('interior');
        env.setWeather?.('clear', 0);

        const handle = await terrain.load(MAP_ID, {
          // `biome:'city'` here is the terrain-shape/tileset-palette field only (`MapDraft`'s
          // own `this.biome`, unrelated to gameplay since P5).
          w: ROOM_W, h: ROOM_H, tileset: TILESET, biome: 'city', seed: ctx.config.seed,
        });
        // `terrain.report()` is `null` for the hand-written `buildPokecenterMap` path (it
        // returns nothing) and the report `applyMapFile` produced for the Studio-exported path
        // — see `city/index.js`'s identical `report`. Left undefaulted for the same reason:
        // `mapCast`, below, tests its truthiness to decide whether the map file's own
        // `npcs`/`lights` win over the hardcoded `NURSE` fallback.
        report = terrain.report();
        // This room's actual encounter table (P5): explicit here rather than folded into
        // `report`, above, so a proc-gen build still reports the same empty `'city'` table a
        // Studio-authored `pokecenter.map.json` already does, without also making `report`
        // truthy on the path that has no `npcs`/`lights` to give `mapCast`.
        terrain.setDefaultProfile?.({ encounterTable: 'city' });

        dressing = await dressPokecenter(ctx);

        const spawn = handle?.spawn ?? SPAWN;
        const sim = ctx.get('simulation');
        if (isLive(sim) && typeof sim.placePlayer === 'function') {
          sim.setFormation?.({ ...(report?.formation ?? FORMATION), label: 'simulation/wander/pokecenter' });
          sim.placePlayer(spawn.cx, spawn.cz, spawn.dir ?? SPAWN.dir);
        }
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);

        if (report) {
          // The map file is authoritative once one has been loaded: its own `npcs` (one nurse
          // entry for the shipped room) and `lights` replace the hardcoded `NURSE` spawn and
          // `dressPokecenter`'s own window-light registration below —
          // `terrain.populateFromMap` (`src/terrain/populate.js`) is the same helper
          // `city/index.js` uses for its cast.
          mapCast = await terrain.populateFromMap(ctx, { npcs: report.npcs ?? [], lights: report.lights ?? [] });
        } else if (isLive(sim) && typeof sim.spawnNpc === 'function') {
          // Nurse Joy, after `dressPokecenter()` resolves — mirroring `city.enter()`'s own
          // `cast = await populateCity(ctx)` timing. `world:unloaded` above already reset
          // `nurseId` to null (it fired from inside `terrain.load()`, before this line), so this
          // never spawns a second copy of her on re-entry.
          const pokemonApi = ctx.get('pokemon');
          // One atlas build before the spawn, the way `city/npcs.js` batches its own cast —
          // a fresh atlas build mid-spawn is wasteful for a single NPC too.
          if (isLive(pokemonApi) && pokemonApi.sprites && typeof pokemonApi.sprites.prepare === 'function') {
            try {
              await pokemonApi.sprites.prepare([{ trainer: 'heroine' }]);
            } catch (err) {
              log.warn('pokecenter: preparing Nurse Joy’s sprite sheet failed', err);
            }
          }
          const npc = sim.spawnNpc({
            name: 'pokecenter/nurse', trainer: 'heroine', display: 'Nurse Joy',
            cx: NURSE.cx, cz: NURSE.cz, dir: NURSE.dir, solid: true,
          });
          nurseId = npc?.id ?? null;
        }

        return handle;
      },

      /** Named camera framings the screenshot harness can request (src/main.js). */
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

      /** Every named point on the map — the exit door, the framings. */
      markers: () => {
        const d = terrain.draft?.();
        return d ? [...d.markers.keys()] : [];
      },
      marker: (name) => terrain.draft?.()?.marker(name) ?? null,
      /** What the room is made of, for the debug overlay and the screenshot log. */
      stats: () => ({ ...(dressing?.stats ?? {}), extras: dressing?.extras ?? [] }),

      // --- the save seam (src/offline/slices.js) -------------------------------------------------
      // Discovered automatically by `offline.init()`'s `discoverProviders` — `pokecenter`
      // inits before `offline` in the registry's Kahn order, so a plain native
      // `saveState`/`loadState` pair needs no self-registration (unlike `travel`, which inits
      // after `offline`). Only the cooldown is saved: nothing else in the room has state of
      // its own (the map is rebuilt from its seed, and Nurse Joy is a fixed NPC).
      saveState: () => ({ v: SAVE_VERSION, lastHealMs }),
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        // Tolerates an older slice, refuses a newer one — the same seam every sibling at this
        // save order implements (`travel`, `battle`, `collection`, `encounter`); this module
        // is not one of the two named exceptions in src/offline/slices.js (`economy`, `idle`).
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`pokecenter: save slice v${value.v} is newer than v${SAVE_VERSION} — not loaded`);
          return false;
        }
        // A non-finite/missing `lastHealMs` (a fresh save, or a hand-edited one) reads as
        // "never healed" — matches `remainingCooldownMs(null, t) === 0` (`heal.js`).
        lastHealMs = Number.isFinite(value.lastHealMs) ? value.lastHealMs : null;
        return true;
      },

      dispose() {
        dressing?.dispose();
        dressing = null;
        mapCast?.dispose();
        mapCast = null;
        report = null;
      },
    };
    return api;
  },

  async showcase(mode, ctx) {
    const pc = ctx.get('pokecenter');
    await pc.enter();
    if (mode && mode !== 'default') pc.preset(mode);
    // No cast to stage: Nurse Joy has no route (`spawnNpc`'s default is `STILL`, `simulation/
    // index.js`), and the trainer never moves on its own (`FORMATION.autopilot:'none'`), so
    // the frame is already the same for the same URL every time — nothing to freeze.
  },
};

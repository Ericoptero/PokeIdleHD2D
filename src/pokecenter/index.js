/**
 * pokecenter — the Pokemon Center's interior (src/pokecenter/index.js).
 *
 * One room, entered through the city's own `door:pokecenter` tile and left through this
 * room's own door tile, both driven off `simulation`'s `player:enteredTile` (ARCHITECTURE
 * src/simulation/index.js) rather than a special-cased key: walking onto a tagged cell **is**
 * the interaction, the same way a hunt's tall grass is (`encounter/index.js`).
 *
 * The room, its window, its counter, its benches, Nurse Joy and the practical light are all
 * authored in the Map Studio and loaded from `public/maps/pokecenter.map.json`
 * (`@/terrain/mapfile.js`). `heal.js` is the only code left here — the cure's cooldown
 * arithmetic, pure, no `ctx`.
 *
 * **Nurse Joy is the cure.** Facing the counter (its cells carry the `counter` tag, authored
 * in the Studio) and pressing the generic `player:interact` key (`ui/input.js`, `Z`/`Space`)
 * opens a dialogue with her: off cooldown, the whole party is healed — HP, status **and PP**,
 * the actual difference from every other recovery in the game — once every `HEAL_COOLDOWN_MS`
 * real seconds (`heal.js`), free. `city.enter()` no longer heals anything; a party wipe still
 * arrives already healed (`encounter.wipe()`'s own `pokemon.reviveAll()`, unchanged), just in
 * this room now instead of on the pavement, and that path never touches the cooldown.
 *
 * **Not on the Routes screen.** `travel.destinations()` carries it with `hidden: true`
 * (src/travel/index.js) so `ui/screens/travel.js` never lists it — the door is the only way in.
 */

import { remainingCooldownMs } from './heal.js';

/** The registry hands out a null-object proxy for a dead module; `__missing` is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/** The terrain map id, and `travel`'s destination id. */
const MAP_ID = 'pokecenter';

/** Save slice version. `loadState` migrates forward and refuses a newer one (src/offline/slices.js). */
const SAVE_VERSION = 1;

/** A minimal fallback if a fresh install somehow loads before the file exists. */
const FALLBACK_SPAWN = { cx: 6, cz: 8, dir: 2 };
const FALLBACK_FORMATION = { head: 'trainer', input: true, autopilot: 'none' };
/** The door tag `map.js` used to author on the exit cell — still the contract every shipped
 *  room's own map file uses; kept as a fallback name only, never hardcoded room geometry. */
const EXIT_TAG = 'door:pokecenter-exit';
const RETURN_DIR = 0;

export default {
  id: 'pokecenter',
  needs: ['terrain', 'environment'],
  /** Extra modules the showcase scene needs on top of `needs` (src/main.js). */
  showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation'],

  init(ctx) {
    const { bus, log } = ctx;
    const terrain = ctx.get('terrain');
    terrain.register(MAP_ID, (draft, c, opts) => terrain.applyMapFile(draft, c, opts.map));

    /** @type {{dispose:() => void}|null} */
    let extraWorlds = null;
    /** @type {{dispose:() => void, ids:number[]}|null} */
    let cast = null;
    /** What `enter()`'s `applyMapFile` reported (`terrain.report()`). */
    let report = null;
    /** `ctx.clock.wallMs()` of the last successful cure, or `null` — "never healed" (see heal.js). */
    let lastHealMs = null;

    /** The room takes itself down when its map is unloaded — see `city/index.js`'s twin. */
    bus.on('world:unloaded', ({ mapId }) => {
      if (mapId !== MAP_ID) return;
      extraWorlds?.dispose();
      extraWorlds = null;
      cast?.dispose();
      cast = null;
      report = null;
    });

    /**
     * The cure. `player:interact` (`ui/input.js`) carries the faced cell's tags, read the same
     * way `simulation`'s own `announce()` builds `player:enteredTile`'s payload — so this only
     * has to check for `'counter'`, and any future NPC anywhere else in the game gets the same
     * key for free rather than a Center-specific one.
     *
     * **Unconditional once off cooldown** — no "is anyone even hurt" check (real Nurse Joy does
     * not check first either). `pokemon.reviveAll()` is the `revive: true` allowlist's caller,
     * reused here, not duplicated; restoring every move slot's PP on top of it is the actual
     * functional difference between this cure and every other recovery path in the game.
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
     * in the game that reads `door:pokecenter`/`EXIT_TAG`, so the transition lives here rather
     * than split across `city` and `travel`.
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
            // The city's own map mints this marker one cell south of the pokecenter's door —
            // exactly where a player leaving on foot should land, the same marker `travel`'s
            // wiped-party teleport already targets.
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

    function focusOn(cx, cz, dir) {
      const sim = ctx.get('simulation');
      const y = terrain.height(cx, cz);
      if (isLive(sim) && typeof sim.teleport === 'function') sim.teleport(cx, cz, dir ?? 0);
      ctx.three.rig.setFocus(cx + 0.5, y, cz + 0.5, true);
    }

    const api = {
      /** How the room is played, so `travel` can show it without entering it. */
      formation: () => ({ ...(report?.formation ?? FALLBACK_FORMATION) }),

      /** Builds the room and stands the trainer in it. Safe to call again; it tears down first. */
      async enter() {
        extraWorlds?.dispose();
        extraWorlds = null;
        cast?.dispose();
        cast = null;

        const env = ctx.get('environment');
        const map = await terrain.loadMapFile(MAP_ID);
        // `enclosed:1` is the `interior` preset's own default (`environment/presets.js`);
        // every shipped room's map declares `environmentPreset:"interior"` explicitly.
        env.setBiomePreset?.(map.environmentPreset);
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
          sim.setFormation?.({ ...(report?.formation ?? FALLBACK_FORMATION), label: `simulation/wander/${MAP_ID}` });
          sim.placePlayer(spawn.cx, spawn.cz, spawn.dir ?? FALLBACK_SPAWN.dir);
        }
        ctx.three.rig.setFocus(spawn.cx + 0.5, terrain.height(spawn.cx, spawn.cz), spawn.cz + 0.5, true);

        cast = await terrain.populateFromMap(ctx, { npcs: report?.npcs ?? [], lights: report?.lights ?? [] });
        return handle;
      },

      /** Named camera framings the screenshot harness can request (src/main.js). */
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

      /** Every named point on the map — the exit door, the framings. */
      markers: () => {
        const d = terrain.draft?.();
        return d ? [...d.markers.keys()] : [];
      },
      marker: (name) => terrain.draft?.()?.marker(name) ?? null,
      /** What the room is made of, for the debug overlay and the screenshot log. */
      stats: () => ({ ...(extraWorlds?.stats ?? {}) }),

      // --- the save seam (src/offline/slices.js) -------------------------------------------------
      saveState: () => ({ v: SAVE_VERSION, lastHealMs }),
      loadState(value) {
        if (!value || typeof value !== 'object') return false;
        if (Number(value.v) > SAVE_VERSION) {
          log.warn(`pokecenter: save slice v${value.v} is newer than v${SAVE_VERSION} — not loaded`);
          return false;
        }
        lastHealMs = Number.isFinite(value.lastHealMs) ? value.lastHealMs : null;
        return true;
      },

      dispose() {
        extraWorlds?.dispose(); extraWorlds = null;
        cast?.dispose(); cast = null;
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

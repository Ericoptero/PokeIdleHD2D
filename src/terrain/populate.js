/**
 * populate.js — builds a loaded map's authored NPCs, lights, and extra tilesets (src/terrain/
 * populate.js).
 *
 * `applyMapFile` (`./frommap.js`) hands every scene the same report shape — `npcs`, `lights`
 * and `extras` among it — and this is the one place that logic lives, shared by every module
 * that loads a `.map.json`: `city/index.js`, `pokecenter/index.js` and `hunts/index.js` all
 * call `populateFromMap` with `report.npcs`/`report.lights`, and `buildExtras` with the report
 * itself, instead of each keeping its own copy of "spawn NPCs" / "register lights" / "build the
 * buildings-and-props worlds" loops.
 */

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * Spawns `npcs` through `simulation.spawnNpc` and registers `lights` on `environment.lamps`.
 *
 * Idempotent per call, not per scene: this does not track what a *previous* call spawned, so
 * a caller re-entering its own map owns its own teardown — dispose the `ids` this returns
 * (via the returned `dispose()`) before calling this again.
 *
 * @param {object} ctx  core context
 * @param {{npcs?:object[], lights?:object[]}} data  `report.npcs`/`report.lights` from
 *   `terrain.applyMapFile`'s return value (`./frommap.js`)
 * @returns {Promise<{ids:number[], dispose:() => void}>}
 */
export async function populateFromMap(ctx, { npcs = [], lights = [] } = {}) {
  const { log } = ctx;
  const sim = ctx.get('simulation');
  const pokemon = ctx.get('pokemon');
  const ids = [];

  if (npcs.length) {
    if (!isLive(sim) || typeof sim.spawnNpc !== 'function') {
      log.warn('terrain/populate: simulation is unavailable — this map\'s authored NPCs were not spawned');
    } else {
      // One atlas build for the whole cast before the spawn loop, not one per NPC — modeled
      // directly on `city/npcs.js`'s `populateCity`, which measured this: `simulation`
      // restages on every spawn and each restage repacks whatever is not already resident, so
      // handing `pokemon` the full list first turns N atlas builds into one.
      if (isLive(pokemon) && pokemon.sprites && typeof pokemon.sprites.prepare === 'function') {
        try {
          await pokemon.sprites.prepare(npcs.map((n) => (n.trainer
            ? { trainer: n.trainer }
            : { species: n.species, shiny: !!n.shiny })));
        } catch (err) {
          log.warn('terrain/populate: preparing the NPC sprite sheets failed', err);
        }
      }

      for (const spec of npcs) {
        const npc = sim.spawnNpc({
          name: spec.name, cx: spec.cx, cz: spec.cz, dir: spec.dir ?? 0,
          trainer: spec.trainer, species: spec.species, shiny: spec.shiny, display: spec.display,
          route: spec.route, loop: true, solid: spec.solid,
        });
        if (npc?.id) ids.push(npc.id);
      }

      // Let the staging promises `spawnNpc` started drain before the first frame is presented,
      // so a screenshot never catches a half-spawned cast.
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Practical lights. `hunts/index.js`'s `enter()` has done exactly this — `clear()` then one
  // `add()` per entry — since it first read `report.lights`; lamps are not tracked by id for
  // individual removal anywhere in this project, they are cleared and rebuilt whole on every
  // scene load, so there is nothing else for this half to own.
  const env = ctx.get('environment');
  if (isLive(env) && env.lamps && typeof env.lamps.add === 'function') {
    env.lamps.clear();
    for (const light of lights) env.lamps.add(light);
  }

  return {
    ids,
    dispose() {
      const s = ctx.get('simulation');
      if (isLive(s) && typeof s.removeNpc === 'function') {
        for (const id of ids) s.removeNpc(id);
      }
      ids.length = 0;
    },
  };
}

/**
 * Builds every `role:"extra"` layer a loaded map's report carried — buildings, lamp posts,
 * props, paving, anything composited from a second tileset — into its own `InstancedWorld`.
 *
 * One shared helper: `city`, `pokecenter` and `hunts` used to each keep a near-identical loop
 * over their own module's extras (`city/structures.js`, `pokecenter/dress.js`,
 * `hunts/props.js`), rebuilding the same placements from hardcoded layout constants
 * regardless of whether a map file was actually loaded. Now every map's extras — and their
 * placement, their tileset, their `InstancedWorld` options (`castShadow`, `variety`) — live
 * only in the map file (`./mapfile.js`'s `layers[].options`, round-tripped by `./frommap.js`).
 *
 * @param {object} ctx core context
 * @param {{extras?:{tileset:string,placements:object[],options?:object}[]}|null} report
 *   `terrain.report()` — the value `./frommap.js`'s `applyMapFile` returned
 * @returns {Promise<{stats:object, dispose:() => void}>}
 */
export async function buildExtras(ctx, report) {
  const { log } = ctx;
  const tiles = ctx.get('tiles');
  const worlds = [];
  const undoFns = [];
  const stats = { meshes: 0, triangles: 0 };

  for (const extra of report?.extras ?? []) {
    if (!extra.placements?.length) continue;
    const tileset = await tiles.load(extra.tileset).catch((err) => {
      log.warn(`terrain/populate: extras tileset "${extra.tileset}" did not load`, err);
      return null;
    });
    if (!tileset) continue;
    const world = tiles.buildInstances(ctx.three.scene, extra.tileset, extra.placements, {
      name: `map:extra:${extra.tileset}`, ...(extra.options ?? {}),
    });
    worlds.push(world);
    stats.meshes += world.stats.meshes;
    stats.triangles += world.stats.triangles;

    // Per-tileset material touch-ups (a repaint, a shadow exclusion) — a fact about the
    // tileset's own pack, applied the same way regardless of which map is loading it.
    // `tiles.dressExtras` (not a deep import into `tiles/dressing.js`) is the seam
    // (`tools/seams/run.js` rule 2): cross-module access goes through `ctx.get('tiles')`.
    const undo = typeof tiles.dressExtras === 'function' ? tiles.dressExtras(extra.tileset, world) : null;
    if (undo) undoFns.push(undo);
  }

  return {
    stats,
    dispose() {
      for (const w of worlds) w.dispose();
      worlds.length = 0;
      for (const fn of undoFns) fn();
      undoFns.length = 0;
    },
  };
}

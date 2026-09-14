/**
 * populate.js — spawns a loaded map's authored NPCs and registers its lights (src/terrain/
 * populate.js).
 *
 * `applyMapFile` (`./frommap.js`) already hands every scene the same report shape — `npcs`
 * (from `map.npcs`) and `lights` (from `map.lights`) among it — but until this file existed
 * only `hunts/index.js` actually read any of the report at all, and even there only for
 * `lights`. `city` and `pokecenter` spawned from their own hardcoded `NPCS`/`NURSE` constants
 * (`city/layout.js`, `pokecenter/layout.js`) and dressed their own hardcoded `LAMPS`/window
 * glows regardless of whether a Studio-exported map file was actually loaded — so moving an
 * NPC or dragging a lamp in the Map Studio and saving changed a JSON file the game never
 * looked at for either one.
 *
 * This is the one place that spawning logic lives now, shared by every module that can load a
 * `.map.json`: `city/index.js` and `pokecenter/index.js` call it with `report.npcs`/
 * `report.lights` once a map file was used; `hunts/index.js` keeps its own inline handling
 * (its NPCs are wild Pokemon on respawn slots, not this shape) but registers its lights the
 * exact same way this file does — `env.lamps.clear()` then one `add()` per entry — which is
 * the reference this file's own light half is modeled on.
 */

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * Spawns `npcs` through `simulation.spawnNpc` and registers `lights` on `environment.lamps`.
 *
 * Idempotent per call, not per scene: this does not track what a *previous* call spawned, so
 * a caller re-entering its own map owns its own teardown — dispose the `ids` this returns
 * (via the returned `dispose()`) before calling this again, exactly the way `city/npcs.js`'s
 * `populateCity` already expects of its own caller.
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
      // so a screenshot never catches a half-spawned cast — the same wait `populateCity` uses.
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

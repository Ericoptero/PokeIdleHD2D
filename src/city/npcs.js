/**
 * The lobby's population.
 *
 * A city is a diorama until somebody is standing in it, so the plaza gets a cast: two people
 * outside the shops and a dozen Pokemon loitering, some still, some walking short loops.
 *
 * `simulation` owns walkers — the grid, the step timing, the collision, the sprite poses and
 * the route language (ARCHITECTURE §5.4) — so this file spawns through `spawnNpc()` and
 * never touches a sprite, a sheet or a frame index. That also means every route is checked
 * against `terrain.passable`, so an NPC cannot walk into the Pokemon Center's wall, and
 * every walk is seeded: `simulation` forks its own stream per NPC and `Math.random` is not
 * reachable from here (ARCHITECTURE §2.5).
 *
 * **Determinism.** A scripted route is a pure function of how many sim steps have run, and
 * the number of steps between page load and shutter is wall-clock luck. So when the clock is
 * frozen for a screenshot (DECISIONS #14) the cast is advanced by a fixed number of steps and
 * then frozen: the same URL gives the same pixels, and the still shows a mix of walkers
 * mid-stride and standers rather than a rank of statues on cell centres.
 */

import { NPCS } from './layout.js';

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * How far the cast has walked by the time a frozen screenshot is taken. 47 steps is 2.35 s
 * of simulated time — long enough that the walkers are strung out along their loops and off
 * the cell centres, and a prime so the two loops of different lengths do not sync up.
 */
const STAGE_STEPS = 47;

/**
 * Walks the whole cast to a fixed point and stops the clock there, so the city's *own*
 * showcase is reproducible (ARCHITECTURE §6.3). Called from `city.showcase()` and nowhere
 * else: `enter()` must leave `simulation`'s frame loop exactly as it found it, or entering
 * the lobby at `/` would freeze the player, and `simulation`'s own `mode=city` showcase —
 * which calls `city.enter()` and then stages its own walk — would inherit a pose it did not
 * ask for.
 */
export function stageCityForShot(ctx) {
  const sim = ctx.get('simulation');
  if (!isLive(sim) || typeof sim.advanceSteps !== 'function') return 0;
  sim.advanceSteps(STAGE_STEPS);
  sim.freeze?.(true);
  return STAGE_STEPS;
}

/**
 * @param {object} ctx  core context
 * @returns {Promise<{ids:number[], dispose:() => void}>}
 */
export async function populateCity(ctx) {
  const { log } = ctx;
  const sim = ctx.get('simulation');
  const pokemon = ctx.get('pokemon');
  const ids = [];

  if (!isLive(sim) || typeof sim.spawnNpc !== 'function') {
    log.warn('city: simulation is unavailable — the lobby has no NPCs');
    return { ids, dispose() {} };
  }

  // One atlas build for the whole cast. `simulation` restages on every spawn, and each
  // restage repacks whatever is not already resident, so handing `pokemon` the full list
  // first turns fourteen atlas builds into one.
  if (isLive(pokemon) && pokemon.sprites && typeof pokemon.sprites.prepare === 'function') {
    try {
      await pokemon.sprites.prepare(NPCS.map((n) => (n.trainer
        ? { trainer: n.trainer }
        : { species: n.species, shiny: !!n.shiny })));
    } catch (err) {
      log.warn('city: preparing the NPC sprite sheets failed', err);
    }
  }

  for (const spec of NPCS) {
    const npc = sim.spawnNpc({
      name: `city/${spec.name}`,
      cx: spec.cx, cz: spec.cz, dir: spec.dir ?? 0,
      trainer: spec.trainer, species: spec.species, shiny: spec.shiny,
      route: spec.route, loop: true,
    });
    if (npc?.id) ids.push(npc.id);
  }

  // Let the staging promises `spawnNpc` started drain before the first frame is presented,
  // so a screenshot never catches half a cast. Each spawn awaits the atlas and then one
  // `sprites.spawn` per slot; those are microtasks once the sheets are resident, so a
  // couple of macrotask turns is plenty.
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));

  log.info(`city: ${ids.length} NPCs on the plaza`);

  return {
    ids,
    dispose() {
      const s = ctx.get('simulation');
      if (!isLive(s) || typeof s.removeNpc !== 'function') return;
      for (const id of ids) s.removeNpc(id);
      ids.length = 0;
    },
  };
}

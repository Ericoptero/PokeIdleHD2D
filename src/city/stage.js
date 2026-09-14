/**
 * city/stage.js — deterministic screenshot staging for the lobby's cast.
 *
 * `simulation` owns walkers (src/simulation/index.js); this file only advances the clock a
 * fixed number of steps and freezes it, so the city's own showcase gives the same pixels for
 * the same URL every time — a scripted route is a pure function of how many sim steps have
 * run, and the number of steps between page load and shutter is otherwise wall-clock luck.
 */

/** The registry hands out a null-object proxy for a dead module, and it answers
 *  `typeof api.foo === 'function'` with true. `__missing` is the only honest tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * How far the cast has walked by the time a frozen screenshot is taken. 47 steps is 2.35 s
 * of simulated time — long enough that walkers are strung out along their loops and off the
 * cell centres, and a prime so loops of different lengths do not sync up.
 */
const STAGE_STEPS = 47;

/**
 * Walks the whole cast to a fixed point and stops the clock there, so the city's *own*
 * showcase is reproducible (tools/shots/shoot.js). Called from `city.showcase()` and nowhere
 * else: `enter()` must leave `simulation`'s frame loop exactly as it found it, or entering
 * the lobby at `/` would freeze the player.
 */
export function stageCityForShot(ctx) {
  const sim = ctx.get('simulation');
  if (!isLive(sim) || typeof sim.advanceSteps !== 'function') return 0;
  sim.advanceSteps(STAGE_STEPS);
  sim.freeze?.(true);
  return STAGE_STEPS;
}

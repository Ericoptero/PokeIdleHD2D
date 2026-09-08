/**
 * The hunts showcase: one mode per biome, so a critic can judge each place on its own.
 *
 *   /?showcase=hunts&mode=forest&tod=17.5
 *   node tools/shots/shoot.js --showcase hunts --mode cave --preset chamber --tod 21
 *
 * Two things it has to get right beyond "load the map":
 *
 *  - **The party is in frame.** A hunt is the lead Pokemon walking the grass with the
 *    trainer behind it; every reference still we are scored against has characters in it.
 *  - **The same URL gives the same pixels.** A scripted route is a pure function of how
 *    many sim steps have run, and the steps between page load and shutter are wall-clock
 *    luck. So under `config.timeFrozen` — which the screenshot harness sets for every
 *    capture (DECISIONS #14) — the cast is advanced a fixed number of steps and then
 *    frozen, which also catches it mid-stride instead of parked on a cell centre.
 */

import { isLive } from './palette.js';

/** How the party is walking when the shutter opens, per biome. */
/**
 * Every route tries to end walking **east**, and it does not yet succeed everywhere.
 *
 * Three rounds of blind A/B judging against the Gamma Emerald stills named the same tell in
 * our frames every time: "the protagonist's head is a blank cream oval with no face". The
 * art is not at fault — assets/trainer/hero.png is a 24-frame BW sheet with a face, a cap
 * brim, arms and a red-and-white outfit. Walking north points the camera at the back of the
 * cap, which under a 45-degree pitch is a featureless lozenge, and the party files up-screen
 * so each sprite hides the one behind it. `coast` is the one biome the critics said read
 * correctly, and it is the one whose route starts east.
 *
 * Asking for an east leg is not enough on its own, and this is worth knowing before anyone
 * tries it again: `makeScriptedRoute` skips any direction the world says is impassable and
 * moves on to the next in the list, silently. The forest, meadow and cave paths run
 * north-south, so an `e` leg is walked into trees, dropped, and the route wraps back to `n`.
 * Probed on the running page — every walker still reports `dir: 2` (north) with these
 * routes. The fix is a genuine east-west leg in the biome maps, which is map authoring, not
 * a route string.
 *
 * `tiles` is a count of *completed tiles*, and it has to be, which is the other half of the
 * bug. The old code froze with `advanceSteps`, which counts sim ticks — at 0.25 s per tile
 * that is fifteen ticks each, so `advanceSteps(23)` moved the party one and a half tiles and
 * left every route still on its first leg. `coast` read correctly for the one reason that it
 * *starts* east. `advanceTo` counts tiles, so these land where they say they do.
 */
const WALKS = {
  forest: { route: 'n12 e10', tiles: 18, subTicks: 7 },
  meadow: { route: 'n8 e12', tiles: 15, subTicks: 7 },
  cave: { route: 'n6 e10', tiles: 12, subTicks: 7 },
  coast: { route: 'e10 n4 e6', tiles: 8, subTicks: 7 },
};

export async function showcaseHunt(mode, ctx, biomes) {
  const { log, config } = ctx;
  const hunts = ctx.get('hunts');
  const wanted = mode && mode !== 'default' ? String(mode) : 'forest';
  const biome = biomes.find((b) => b.id === wanted) ?? biomes[0];
  if (biome.id !== wanted) {
    log.warn(`hunts: no biome "${wanted}" — showing ${biome.id}; the set is ${biomes.map((b) => b.id).join(', ')}`);
  }

  await hunts.enter(biome.id);
  stageParty(ctx, biome);

  // A default framing per biome, so a bare `?showcase=hunts&mode=cave` already shows the
  // thing the mode is about. `--preset` overrides it after `__READY__`.
  const first = biome.showcaseDefault ?? Object.keys(biome.presets ?? {})[0];
  if (first) hunts.preset(first);

  const stats = hunts.stats(biome.id);
  if (stats?.missing?.length) log.warn(`hunts/${biome.id}: unmatched tile queries — ${stats.missing.join(' ')}`);
  log.info(`hunts showcase: ${biome.name} (${biome.w}x${biome.h}, ${biome.tileset})`,
    stats?.stats ? JSON.stringify(stats.stats) : '');
  if (config.timeFrozen) log.info('hunts: cast staged and frozen for a reproducible frame');
}

/**
 * Walks the party a fixed distance into the map and freezes it there.
 *
 * Deliberately *not* in `enter()`: `/` and other modules' showcases call `enter`, and a
 * scene that stops another module's simulation as a side effect of being entered is the
 * kind of action at a distance that is impossible to find later (DECISIONS #26d).
 */
export function stageParty(ctx, biome) {
  const sim = ctx.get('simulation');
  if (!isLive(sim) || typeof sim.walk !== 'function') return false;
  const walk = WALKS[biome.id] ?? { route: 'e8', tiles: 6, subTicks: 7 };
  sim.walk(walk.route, { loop: true });
  if (!ctx.config.timeFrozen) return true;
  if (typeof sim.advanceTo === 'function') sim.advanceTo(walk.tiles, walk.subTicks);
  else sim.advanceSteps(walk.tiles * 15);
  sim.freeze(true);
  return true;
}

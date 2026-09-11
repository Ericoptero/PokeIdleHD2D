/**
 * The hunts showcase: one mode per biome, so a critic can judge each place on its own.
 *
 *   /?showcase=hunts&mode=forest&tod=17.5
 *   node tools/shots/shoot.js --showcase hunts --mode cave --preset chamber --tod 21
 *
 * Two things it has to get right beyond "load the map":
 *
 *  - **The party is in frame, walking east, with wildlife around it.** A hunt is the lead
 *    Pokemon walking the grass with the trainer behind it and something to hunt in it; every
 *    reference still we are scored against has characters in it.
 *  - **The same URL gives the same pixels.** A scripted route is a pure function of how many
 *    sim steps have run, and the steps between page load and shutter are wall-clock luck. So
 *    under `config.timeFrozen` — which the screenshot harness sets for every capture
 *    (DECISIONS #14) — the cast is advanced a fixed number of tiles and then frozen.
 *
 * **All of that staging now lives in one place: `stage()` in `index.js`.** It used to live in
 * two, and the second copy silently undid the first. This file froze the party with
 * `advanceTo` (which counts tiles); `hunts.preset()` then teleported the party again and
 * froze it with `advanceSteps(7)` (which counts 1/20 s sim ticks — 1.4 tiles), and the
 * harness applies `--preset` on *every* capture. So every shot in the module was taken 1.4
 * tiles into the route with the queue still in its teleport pose, which is why three blind
 * rounds in a row saw the back of the trainer's cap no matter what the route string said.
 * There is one staging path now and it is `stage()`.
 */

import { isLive } from './palette.js';

export async function showcaseHunt(mode, ctx, biomes) {
  const { log, config } = ctx;
  const hunts = ctx.get('hunts');
  const wanted = mode && mode !== 'default' ? String(mode) : 'forest';
  const biome = biomes.find((b) => b.id === wanted) ?? biomes[0];
  if (biome.id !== wanted) {
    log.warn(`hunts: no biome "${wanted}" — showing ${biome.id}; the set is ${biomes.map((b) => b.id).join(', ')}`);
  }

  await hunts.enter(biome.id);

  // A default framing per biome, so a bare `?showcase=hunts&mode=cave` already shows the
  // thing the mode is about. `--preset` re-runs the same path after `__READY__`.
  const first = biome.showcaseDefault ?? Object.keys(biome.presets ?? {})[0];
  if (first) hunts.preset(first);
  else stageAtSpawn(ctx, biome);

  const stats = hunts.stats(biome.id);
  if (stats?.missing?.length) log.warn(`hunts/${biome.id}: unmatched tile queries — ${stats.missing.join(' ')}`);
  log.info(`hunts showcase: ${biome.name} (${biome.w}x${biome.h}, ${biome.tileset})`,
    stats?.stats ? JSON.stringify(stats.stats) : '');
  const wild = hunts.wild?.() ?? [];
  log.info(`hunts showcase: ${wild.length} wild Pokemon staged`);
  if (config.timeFrozen) log.info('hunts: cast staged and frozen for a reproducible frame');
}

/**
 * The fallback for a biome with no presets at all: walk the party off its spawn so the queue
 * is strung out rather than parked in a line on cell centres.
 *
 * Deliberately *not* folded into `enter()`: `/` and other modules' showcases call `enter`,
 * and a scene that stops another module's simulation as a side effect of being entered is
 * the kind of action at a distance that is impossible to find later (DECISIONS #26d).
 */
export function stageAtSpawn(ctx, _biome) {
  const sim = ctx.get('simulation');
  if (!isLive(sim)) return false;
  // Walks a few tiles along **the circuit `enter()` already installed**. It used to install
  // `biome.walk.route` instead — an authored string that predates the found loop and survived
  // it — so every showcase photographed a walker on a path the game does not walk, and one
  // that passes no spawn slot at all (DECISIONS #74). There is one route now.
  if (!ctx.config.timeFrozen) return true;
  if (typeof sim.advanceTo === 'function') sim.advanceTo(3, 7);
  else if (typeof sim.advanceSteps === 'function') sim.advanceSteps(15);
  sim.freeze(true);
  return true;
}

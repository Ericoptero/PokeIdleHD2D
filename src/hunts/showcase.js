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
const WALKS = {
  forest: { route: 'n14 e2 n6', steps: 23 },
  meadow: { route: 'n10 e6 n8', steps: 17 },
  cave: { route: 'n8 e4 n6', steps: 15 },
  coast: { route: 'e10 n4 e6', steps: 21 },
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
  const walk = WALKS[biome.id] ?? { route: 'n8', steps: 13 };
  sim.walk(walk.route, { loop: true });
  if (!ctx.config.timeFrozen) return true;
  sim.advanceSteps(walk.steps);
  sim.freeze(true);
  return true;
}

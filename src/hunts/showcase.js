/**
 * The hunts showcase: one mode per hunt map, so a critic can judge each place on its own.
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
 * — the cast is advanced a fixed number of tiles and then frozen.
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

/** The registry hands out a null-object proxy for a dead module; `__missing` is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

export async function showcaseHunt(mode, ctx) {
  const { log, config } = ctx;
  const hunts = ctx.get('hunts');
  const list = hunts.list();
  const wanted = mode && mode !== 'default' ? String(mode) : list[0]?.id;
  const biome = list.find((b) => b.id === wanted) ?? list[0];
  if (!biome) { log.warn('hunts: no hunt maps to show'); return; }
  if (biome.id !== wanted) {
    log.warn(`hunts: no hunt map "${wanted}" — showing ${biome.id}; the set is ${list.map((b) => b.id).join(', ')}`);
  }

  await hunts.enter(biome.id);

  // The map's own first camera preset, so a bare `?showcase=hunts&mode=cave` already shows
  // the thing the mode is about. `--preset` re-runs the same path after `__READY__`.
  const first = biome.presets?.[0];
  if (first) hunts.preset(first);
  else stageAtSpawn(ctx, biome);

  const stats = hunts.stats(biome.id);
  log.info(`hunts showcase: ${biome.name} (${biome.w}x${biome.h}, ${biome.tileset})`,
    stats?.stats ? JSON.stringify(stats.stats) : '');
  const wild = hunts.wild?.() ?? [];
  log.info(`hunts showcase: ${wild.length} wild Pokemon staged`);
  if (config.timeFrozen) log.info('hunts: cast staged and frozen for a reproducible frame');
}

/**
 * The fallback for a hunt map with no presets at all: walk the party off its spawn so the
 * queue is strung out rather than parked in a line on cell centres.
 *
 * Deliberately *not* folded into `enter()`: `/` and other modules' showcases call `enter`,
 * and a scene that stops another module's simulation as a side effect of being entered is
 * the kind of action at a distance that is impossible to find later.
 */
export function stageAtSpawn(ctx, _biome) {
  const sim = ctx.get('simulation');
  if (!isLive(sim)) return false;
  // Walks a few tiles along **the circuit `enter()` already installed**.
  if (!ctx.config.timeFrozen) return true;
  if (typeof sim.advanceTo === 'function') sim.advanceTo(3, 7);
  else if (typeof sim.advanceSteps === 'function') sim.advanceSteps(15);
  sim.freeze(true);
  return true;
}

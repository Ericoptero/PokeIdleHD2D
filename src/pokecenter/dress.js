/**
 * The worlds the room's own draft cannot carry, plus the practical light.
 *
 * `map.js` reserves the window's and the benches' footprints (collision, tags) but cannot
 * place either: a `Placement` names a model id and `tiles.buildInstances()` resolves that id
 * against exactly **one** tileset, and the window lives in
 * `hgss-newbark-houses` while the benches live in `bw2-adastra` — neither is the room's own
 * `pt-house-indoor`. So each gets its own `InstancedWorld`, built from the same `layout.js`
 * numbers the draft reserved its cells from — exactly the split `city/structures.js` uses for
 * its authored buildings and adapted props.
 */

import { WINDOW, COUNTER, BENCHES } from './layout.js';

/** The registry hands out a null-object proxy for a dead module; `__missing` is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

/**
 * @param {object} ctx  core context
 * @returns {Promise<{dispose:() => void, stats:object}>}
 */
export async function dressPokecenter(ctx) {
  const tiles = ctx.get('tiles');
  const { log } = ctx;
  const scene = ctx.three.scene;
  const worlds = [];
  const stats = { window: 0, benches: 0, lamps: 0, filaments: 0, meshes: 0, triangles: 0 };

  // --- the window ------------------------------------------------------------
  // The only window geometry in the project — see layout.js. `subcategory`, not a name: the
  // catalog carries `subcategory:'window'` for exactly this one 3x1 piece.
  const winTiles = await tiles.load('hgss-newbark-houses').catch((err) => {
    log.warn('pokecenter: the `hgss-newbark-houses` tileset did not load — the room has no window', err);
    return null;
  });
  const winModel = winTiles
    ? tiles.find('hgss-newbark-houses', { category: 'building', subcategory: 'window' })[0]
    : null;
  if (winTiles && !winModel) log.warn('pokecenter: `hgss-newbark-houses` has no window model');
  if (winModel) {
    // `rot:2`, same reason as `map.js`'s north wall: the model's one face is `vn 0 0 -1`
    // (`hgss-newbark-houses/obj/building/window.obj`), which faces away from a camera that
    // sits at larger *z* looking toward `-z` (`core/render.js`). Turned 180 degrees the pane
    // faces the room instead of the wall behind it — and a 180-degree turn also carries the
    // glass from local z 0.9 to local z 0.1, i.e. from the *back* of its cell to the front of
    // it. `map.js`'s wall behind it goes through the identical turn and ends up at world z
    // 0.625 (its face is a flat plane there, not a slab — every vertex in the `.obj`'s main
    // group shares that one z). `cz` is nudged so the glass lands just in front of that
    // plane instead of at the cell's outer edge, where the two would read as two unrelated
    // panels rather than one wall with a window in it.
    const world = tiles.buildInstances(scene, 'hgss-newbark-houses',
      [{ modelId: winModel.id, cx: WINDOW.cx, cz: WINDOW.cz + 0.7, y: 0, rot: 2 }],
      { name: 'pokecenter:window', variety: 0, castShadow: false });
    worlds.push(world);
    stats.window = 1;
    stats.meshes += world.stats.meshes;
    stats.triangles += world.stats.triangles;
  }

  // --- the benches -------------------------------------------------------------
  // `bw2-adastra`'s `bench_e`/`bench_w`, each with its own `orientation` in the catalog
  // (unlike the wall sides `map.js` has to fall back to bounds for), so a plain category +
  // orientation query is enough.
  const benchTiles = await tiles.load('bw2-adastra').catch((err) => {
    log.warn('pokecenter: the `bw2-adastra` tileset did not load — the room has no seating', err);
    return null;
  });
  if (benchTiles) {
    const placements = [];
    for (const b of BENCHES) {
      const model = tiles.find('bw2-adastra', { category: 'prop', subcategory: 'bench', orientation: b.face })[0];
      if (!model) { log.warn(`pokecenter: no bench facing "${b.face}"`); continue; }
      placements.push({ modelId: model.id, cx: b.cx, cz: b.cz, y: 0, rot: 0 });
    }
    if (placements.length) {
      const world = tiles.buildInstances(scene, 'bw2-adastra', placements,
        { name: 'pokecenter:benches', variety: 0 });
      worlds.push(world);
      stats.benches = placements.length;
      stats.meshes += world.stats.meshes;
      stats.triangles += world.stats.triangles;
    }
  }

  // --- the practical light -----------------------------------------------------
  // `environment` owns the night ramp and the point-light pool (src/environment/index.js); the room
  // only says where the light comes from. The window is the room's one motivated source
  // (CLAUDE.md: "every scene needs a motivated light source") — daylight falling through it
  // and pooling on the floor in front of the counter, the same bulb+filament pairing
  // `city/structures.js` uses for its lamps: a coloured glow for the shaft, a small near-white
  // `point:false,pool:false` core stacked on it for the bright centre a flat glow cannot give.
  //
  // `groundY` is explicit and not left to `terrain.height()`: the indoor floor's visible
  // surface is baked 0.125 below the draft's own heightfield (`pt-house-indoor`'s floor
  // models render at y −0.125; the draft itself is never told, so `heightAt` still answers
  // 0). Left out, the ground pool decal would float a hair above the floor it is meant to
  // be lying on.
  const env = ctx.get('environment');
  if (isLive(env) && env.lamps && typeof env.lamps.add === 'function') {
    env.lamps.clear();
    const shaftX = WINDOW.cx + WINDOW.w / 2;
    // In front of the counter (`COUNTER.cz + 1.4`), matching the comment above — not behind it.
    // At `WINDOW.cz + 1.4` this sat almost exactly on Nurse Joy's own cell with
    // her there (`NURSE`, `layout.js`): the light's hot filament core landed on her face and
    // blew her out to a barely-visible smudge, confirmed by a cropped screenshot before this
    // fix (nothing wrong with her sprite or her spawn — `simulation.npcs()` and the sprite
    // field both showed a correctly placed, correctly framed actor sitting under a light this
    // bright). Moving the shaft one row south costs nothing compositionally — it was always
    // meant to fall in front of the counter, on the floor the player actually stands on to
    // talk to her — and clears the row she stands in entirely.
    const shaftZ = COUNTER.cz + 1.4;
    // `size` is kept modest on purpose: this room is a third the width of `city`'s plaza, and
    // the quad that read as a wide sodium halo out there (`city/structures.js`) bloomed clean
    // over the top of this room's 2.875-tall wall at the same setting — a light visibly
    // floating above the ceiling line rather than falling through the window beneath it.
    env.lamps.add({
      x: shaftX, y: 1.25, z: shaftZ,
      color: 0xdfe8ff, intensity: 1.1, radius: 6.5, size: 0.34, groundY: -0.125,
    });
    stats.lamps++;
    env.lamps.add({
      x: shaftX, y: 1.25, z: shaftZ,
      color: 0xf8f5ec, intensity: 1.2, size: 0.14, point: false, pool: false, groundY: -0.125,
    });
    stats.filaments++;
  }

  log.info(`pokecenter dressing: window ${stats.window}, ${stats.benches} benches, ` +
    `${stats.lamps} bulbs (+${stats.filaments} filaments), ${stats.meshes} meshes, ` +
    `${Math.round(stats.triangles / 1000)}k tris`);

  return {
    stats,
    dispose() {
      for (const w of worlds) w.dispose();
      worlds.length = 0;
      const e = ctx.get('environment');
      if (isLive(e) && e.lamps && typeof e.lamps.clear === 'function') e.lamps.clear();
    },
  };
}

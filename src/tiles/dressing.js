/**
 * dressing.js — per-tileset material touch-ups applied whenever an extra `InstancedWorld` is
 * built from that tileset (src/terrain/populate.js's `buildExtras`), regardless of which map
 * or scene is loading it.
 *
 * These are facts about the tileset's own pack, not hidden per-map customization: every
 * placement a map makes is already fully visible and editable in the Map Studio (the
 * `structures` tileset's buildings, lamps and props are ordinary extras layers in the map
 * file); what lives here is purely "this pack's red-roof sheet gets re-tinted for the Mart"
 * and "this pack's roof/awning faces don't receive shadows" — the same two touch-ups every
 * map using the `structures` pack gets, authored or not.
 */

import { repaint } from './recolor.js';

/** Material name -> `recolorTexture` options, per tileset slug. The Mart's roof/awning/sign
 *  turn blue and the cottage's roof turns ochre, so six buildings drawn from one red-roof
 *  sheet don't read as one terrace — see `./recolor.js`. */
const REPAINT_BY_TILESET = {
  structures: {
    'poke_mart:roof': { hue: 208, sat: 0.86, light: 1.0 },
    'poke_mart:awning': { hue: 208, sat: 0.80, light: 1.0 },
    'poke_mart:sign': { hue: 208, sat: 0.90, light: 1.0 },
    'house_a:roof': { hue: 22, sat: 0.72, light: 0.95 },
  },
};

/**
 * Material-name pattern, per tileset slug, whose faces should not receive shadows — a
 * workaround for a hard-edged shadow-mapping artifact on a 45-degree roof facet at this
 * shadow-map resolution (nothing in the game casts onto a roof, so refusing the shadow costs
 * nothing and removes the artifact).
 */
const UNSHADOW_PATTERN_BY_TILESET = {
  structures: /:(roof|awning)$/,
};

function unshadow(tileset, world, pattern) {
  const mats = tileset?.pack?.materials;
  if (!mats || !world?.meshes) return 0;
  let n = 0;
  for (const { mesh, model, groupIndex } of world.meshes) {
    const id = model?.groups?.[groupIndex]?.materialId;
    const name = id === undefined ? '' : (mats[id]?.name ?? '');
    if (!pattern.test(name)) continue;
    mesh.receiveShadow = false;
    n++;
  }
  return n;
}

/**
 * Applies this tileset's repaint/unshadow touch-ups to a just-built `InstancedWorld`.
 * @param {object} tileset what `tiles.get(slug)` returns
 * @param {object} world what `tiles.buildInstances` returned
 * @param {{warn:Function}} log
 * @returns {(() => void)|null} undoes the repaint (materials are shared across worlds built
 *   from the same tileset, so this must run before the tileset itself might repaint again
 *   under a different map); `null` when this tileset has no repaint spec to undo.
 */
export function dressExtraWorld(tileset, world, log) {
  if (!tileset) return null;
  const specs = REPAINT_BY_TILESET[tileset.slug];
  const undoRepaint = specs ? repaint(tileset, specs, log) : null;
  const pattern = UNSHADOW_PATTERN_BY_TILESET[tileset.slug];
  if (pattern) unshadow(tileset, world, pattern);
  return undoRepaint;
}

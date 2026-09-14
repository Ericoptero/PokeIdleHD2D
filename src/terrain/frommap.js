/**
 * frommap.js — replays a `.map.json` (`./mapfile.js`) onto a `MapDraft` (`./draft.js`).
 *
 * This is the other half of the round trip: `mapfile.draftToMapFile` freezes a finished
 * draft into JSON, this file turns JSON back into draft calls, so a map authored or edited
 * in the Studio loads through the exact same `terrain.register`/`terrain.load` path every
 * hand-written biome builder uses (`src/hunts/biomes/*.js`, `src/city/map.js`).
 *
 * Replay order matters:
 *
 *  1. Load every tileset the file names (the draft tileset plus each extra layer's).
 *  2. Stamp `grid.height` onto the draft FIRST. `MapDraft.place()` defaults an unset `y` to
 *     `heightAt(cx,cz)`, so a placement's height must see the authored terrain, not the
 *     zeroed array a fresh draft starts with.
 *  3. Replay `regions[]` (autotile masks), then the per-layer tile grids, then `objects[]` —
 *     all through `draft.place(model, cx, cz, { collision:'none', claim:false, ... })`, so
 *     none of `place()`'s side effects (collision, occupied, propagated tags) write anything;
 *     the file's own `grid.*` is what is authoritative.
 *  4. Stamp `grid.collision` / `grid.height` (again, now exact) / `grid.tags` / `grid.occupied`
 *     from the file, overwriting whatever step 3 touched. This is what makes replay order-
 *     independent and exact regardless of what any individual placement call did.
 *  5. Set `spawn` and replay `markers[]`.
 *
 * A placement whose layer has `role:"extra"` cannot go through `draft.place` — that layer's
 * models live in a different tileset's id namespace than `draft.tileset`, and
 * `InstancedWorld` resolves a `modelId` against exactly one tileset (`src/tiles/instanced.js`).
 * Those are collected into `extras`, grouped by tileset, for the caller to build as
 * additional `InstancedWorld`s the way `city/structures.js`/`hunts/props.js` do today.
 */

import { decodeRuns } from './mapfile.js';

function makeResolver(tiles, layer) {
  const names = layer.models ?? [];
  const ids = layer.modelIds ?? [];
  return (idx) => {
    if (idx < 0 || idx >= names.length) return null;
    const model = tiles.byName(layer.tileset, names[idx]);
    if (model) return model;
    const id = ids[idx];
    return id != null ? tiles.byId(layer.tileset, id) : null;
  };
}

function placeOne(draft, model, cx, cz, opts, isDraftRole, extrasByTileset, tileset) {
  if (isDraftRole) {
    draft.place(model, cx, cz, { ...opts, collision: 'none', claim: false });
    return;
  }
  let list = extrasByTileset.get(tileset);
  if (!list) { list = []; extrasByTileset.set(tileset, list); }
  list.push({
    modelId: model.id, cx, cz,
    y: opts.y ?? draft.heightAt(cx, cz),
    rot: opts.rot ?? 0,
    tint: opts.tint ?? 0xffffff,
    layer: opts.layer ?? 0,
  });
}

function applyTileGrid(draft, layer, t, resolve, isDraftRole, extrasByTileset, unresolved) {
  const n = draft.w * draft.h;
  const modelAt = decodeRuns(t.model, n);
  const rotAt = t.rot ? decodeRuns(t.rot, n) : null;
  const tintAt = t.tint ? decodeRuns(t.tint, n) : null;
  const yAt = t.y ? decodeRuns(t.y, n) : null;

  for (let i = 0; i < n; i++) {
    const idx = modelAt[i];
    if (idx < 0) continue;
    const cx = i % draft.w;
    const cz = Math.floor(i / draft.w);
    const model = resolve(idx);
    if (!model) {
      unresolved.push({ tileset: layer.tileset, name: layer.models?.[idx] ?? `#${idx}`, cx, cz, layer: t.layer });
      continue;
    }
    placeOne(draft, model, cx, cz, {
      rot: rotAt ? rotAt[i] : 0,
      tint: tintAt ? tintAt[i] : 0xffffff,
      y: yAt && yAt[i] != null ? yAt[i] : undefined,
      layer: t.layer,
    }, isDraftRole, extrasByTileset, layer.tileset);
  }
}

function applyObject(draft, layer, o, resolve, isDraftRole, extrasByTileset, unresolved) {
  const model = resolve(o.m);
  if (!model) {
    unresolved.push({ tileset: layer.tileset, name: layer.models?.[o.m] ?? `#${o.m}`, cx: o.cx, cz: o.cz, layer: o.layer });
    return;
  }
  placeOne(draft, model, o.cx, o.cz, { rot: o.rot ?? 0, tint: o.tint ?? 0xffffff, y: o.y, layer: o.layer ?? 0 },
    isDraftRole, extrasByTileset, layer.tileset);
}

function stampGrids(draft, grid) {
  const n = draft.w * draft.h;
  if (grid?.collision) {
    const v = decodeRuns(grid.collision, n);
    for (let i = 0; i < n; i++) draft.collision[i] = v[i];
  }
  if (grid?.height) {
    const v = decodeRuns(grid.height, n);
    for (let i = 0; i < n; i++) draft.height[i] = v[i];
  }
  if (grid?.tags) {
    const v = decodeRuns(grid.tags, n);
    for (let i = 0; i < n; i++) draft.tags[i] = v[i]?.length ? v[i].slice() : undefined;
  }
  if (grid?.occupied) {
    const v = decodeRuns(grid.occupied, n);
    for (let i = 0; i < n; i++) draft.occupied[i] = v[i];
  }
}

/**
 * Replays `map` onto `draft`. Call before `draft.finalize()`, exactly like a hand-written
 * builder — this is meant to be wrapped by `builderFor` and handed to `terrain.register`.
 *
 * @param {import('./draft.js').MapDraft} draft
 * @param {{get:(id:string)=>any}} ctx a module ctx — only `ctx.get('tiles')` is used
 * @param {object} map a parsed map file (`./mapfile.js` `parseMapFile`)
 * @returns {Promise<{extras:{tileset:string,placements:object[]}[], lights:object[],
 *   loop:object|null, wild:object|null, formation:object|null, presets:object,
 *   npcs:object[], links:object[], encounters:object|null, unresolved:object[]}>}
 *   a superset of the report `src/hunts/index.js` stores in `built` per biome — the caller
 *   builds `extras` into additional `InstancedWorld`s and wires the rest into the scene.
 */
export async function applyMapFile(draft, ctx, map) {
  const tiles = ctx.get('tiles');

  const tilesets = new Set([map.tileset, ...(map.layers ?? []).map((l) => l.tileset)]);
  for (const slug of tilesets) await tiles.load(slug);

  const unresolved = [];
  const extrasByTileset = new Map();

  // Height first — see the file header for why placement defaults depend on it.
  if (map.grid?.height) {
    const h = decodeRuns(map.grid.height, draft.w * draft.h);
    for (let i = 0; i < h.length; i++) draft.height[i] = h[i];
  }

  for (const region of map.regions ?? []) {
    if (region.kind !== 'autotile') continue;
    const mask = decodeRuns(region.mask, draft.w * draft.h);
    draft.autotile(tiles, region.set, (cx, cz) => !!mask[draft.idx(cx, cz)], {
      layer: region.layer ?? 0, collision: region.collision, tags: region.tags,
    });
  }

  for (const layer of map.layers ?? []) {
    const resolve = makeResolver(tiles, layer);
    const isDraftRole = layer.role !== 'extra';
    for (const t of layer.tiles ?? []) applyTileGrid(draft, layer, t, resolve, isDraftRole, extrasByTileset, unresolved);
    for (const o of layer.objects ?? []) applyObject(draft, layer, o, resolve, isDraftRole, extrasByTileset, unresolved);
  }

  stampGrids(draft, map.grid);

  if (map.spawn) draft.spawn = { ...map.spawn };
  for (const m of map.markers ?? []) {
    const { name, cx, cz, ...rest } = m;
    draft.mark(name, cx, cz, rest);
  }

  const extras = [...extrasByTileset.entries()].map(([tileset, placements]) => ({ tileset, placements }));
  return {
    extras,
    lights: map.lights ?? [],
    loop: map.loop ?? null,
    wild: map.wild ?? null,
    formation: map.formation ?? null,
    presets: map.cameras?.presets ?? {},
    npcs: map.npcs ?? [],
    links: map.links ?? [],
    encounters: map.encounters ?? null,
    unresolved,
  };
}

/** @param {object} map a parsed map file @returns {(draft, ctx) => Promise<object>} for `terrain.register` */
export function builderFor(map) {
  return (draft, ctx) => applyMapFile(draft, ctx, map);
}

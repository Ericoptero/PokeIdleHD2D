/**
 * tools.js — what each tool in the rail does to the document (`state.js`), expressed as
 * undo/redo commands pushed through `history.push()`. Pure logic, no DOM, no canvas — the
 * canvas (`canvas.js`) only turns pointer events into cell coordinates and calls these.
 */

import { cellKey, touch } from './state.js';
import { encodeRuns, decodeRuns } from '@/terrain/mapfile.js';

const idx = (doc, cx, cz) => cz * doc.w + cx;
const inside = (doc, cx, cz) => cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h;

/** Merges `patch` into `target`'s own keys, in place — `undefined` in `patch` DELETES the key
 *  entirely rather than leaving it present-but-`undefined`. Plain `Object.assign`/spread never
 *  removes a key, and `mapfile.js`'s own pretty-printer (unlike native `JSON.stringify`) does
 *  not silently drop an `undefined`-valued one either — it would emit invalid JSON. A few of
 *  this file's newer merge commands (`updateNpc`'s trainer/species switch, `updateLink`'s
 *  optional `label`/`to.marker`, `updateRegion`'s optional `collision`) need a field to
 *  genuinely disappear when a card clears it, so they route through this instead of a bare
 *  `Object.assign(target, patch)`. */
function applyPatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete target[k]; else target[k] = v; }
}

/**
 * Paints one cell of the active layer with `asset` (a catalog model), grid or object bucket
 * chosen the same way the exporter chooses it: 1x1 and alone at that cell -> grid.
 *
 * Two opt-ins the inspector's "Tile selecionado" toggles drive (both default to the previous,
 * paint-only behaviour): `claimFootprint` stamps `doc.occupied` at the cell, and passing
 * `collision` with `keepCollision:false` stamps that kind into `doc.collision` — until now
 * `paintCell` never touched either array, which is why "Preservar colisão existente" had
 * nothing real to preserve.
 */
export function paintCell(doc, history, {
  layer, cx, cz, asset, rot = 0, tint = 0xffffff, y = null,
  collision = null, claimFootprint = false, keepCollision = true,
}) {
  if (!inside(doc, cx, cz) || !asset) return;
  const grid = doc.tileLayers.get(layer) ?? new Map();
  const key = cellKey(cx, cz);
  const before = grid.get(key) ?? null;
  const after = { m: asset.name, rot, tint, y };
  const i = idx(doc, cx, cz);
  const beforeCollision = doc.collision[i];
  const beforeOccupied = doc.occupied[i];
  const stampCollision = !keepCollision && collision;
  history.push({
    label: 'pintar tile',
    redo() {
      doc.tileLayers.set(layer, grid);
      grid.set(key, after);
      if (stampCollision) doc.collision[i] = collision;
      if (claimFootprint) doc.occupied[i] = 1;
      touch(doc);
    },
    undo() {
      if (before) grid.set(key, before); else grid.delete(key);
      if (stampCollision) doc.collision[i] = beforeCollision;
      if (claimFootprint) doc.occupied[i] = beforeOccupied;
      touch(doc);
    },
  });
}

export function eraseCell(doc, history, { layer, cx, cz }) {
  if (!inside(doc, cx, cz)) return;
  const grid = doc.tileLayers.get(layer);
  const key = cellKey(cx, cz);
  const before = grid?.get(key) ?? null;
  if (!before) return;
  history.push({
    label: 'apagar tile',
    redo() { grid.delete(key); touch(doc); },
    undo() { grid.set(key, before); touch(doc); },
  });
}

/** Rectangle fill — `paintCell` repeated, batched into one undo step. */
export function paintRect(doc, history, { layer, x0, z0, x1, z1, asset, rot = 0, tint = 0xffffff }) {
  const grid = doc.tileLayers.get(layer) ?? new Map();
  const minX = Math.min(x0, x1); const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1); const maxZ = Math.max(z0, z1);
  const before = new Map();
  for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
    if (!inside(doc, cx, cz)) continue;
    const key = cellKey(cx, cz);
    before.set(key, grid.get(key) ?? null);
  }
  history.push({
    label: 'pintar retângulo',
    redo() {
      doc.tileLayers.set(layer, grid);
      for (const key of before.keys()) grid.set(key, { m: asset.name, rot, tint, y: null });
      touch(doc);
    },
    undo() {
      for (const [key, v] of before) { if (v) grid.set(key, v); else grid.delete(key); }
      touch(doc);
    },
  });
}

/** Clamps and normalizes an unnormalized two-corner rect to `[0,w)×[0,h)` — shared by
 *  `copyRect`/`moveRect`/`clearRect` below, the three `boxselect` commands that all start from
 *  the same `{x0,z0,x1,z1}` shape `session.getRectSelection()` hands them. Returns `null` when
 *  nothing of the rect survives clamping (e.g. a drag that started and ended entirely past one
 *  edge of the map) — every caller treats that as "nothing to do", the same tolerance
 *  `paintRect`'s own per-cell `inside()` check already gives an out-of-bounds cell. */
function clampRect(doc, x0, z0, x1, z1) {
  const minX = Math.max(0, Math.min(x0, x1));
  const maxX = Math.min(doc.w - 1, Math.max(x0, x1));
  const minZ = Math.max(0, Math.min(z0, z1));
  const maxZ = Math.min(doc.h - 1, Math.max(z0, z1));
  if (maxX < minX || maxZ < minZ) return null;
  return { minX, maxX, minZ, maxZ };
}

/**
 * A pure read of a rectangular region of the document, for `session.setClipboard` to hold and
 * `pasteClip` (below) to later re-anchor anywhere — no `history` entry, since copying does not
 * mutate anything. `cells[]`/`objects[]` store OFFSETS from the rect's own top-left corner
 * (`dx,dz`), not absolute coordinates, which is exactly what lets `pasteClip` drop the same
 * shape down at a different `(cx,cz)`.
 *
 * Scope cut, deliberate: only `doc.tileLayers` (every layer, not just the active one — a
 * box-select copies everything visibly stacked in the rect) and `doc.objects` travel with a
 * copy. `collision`/`height`/`tags`/`occupied` never do, in this slice — a box-select is an
 * authoring convenience for moving decorative content around, not a full terrain-clone tool.
 *
 * An object is only included when its OWN origin cell (`o.cx,o.cz`) falls inside the rect — a
 * multi-cell object whose origin sits outside but whose footprint overlaps the rect's edge is
 * NOT copied, and a copied multi-cell object's footprint may extend outside the copied bounds
 * once pasted elsewhere. Both are an accepted quirk of a plain rectangular copy, not something
 * this slice tries to solve.
 *
 * @param {object} doc
 * @param {{x0:number, z0:number, x1:number, z1:number}} rect unnormalized/out-of-bounds is fine
 * @returns {{w:number, h:number, cells:object[], objects:object[]}}
 */
export function copyRect(doc, { x0, z0, x1, z1 }) {
  const r = clampRect(doc, x0, z0, x1, z1);
  if (!r) return { w: 0, h: 0, cells: [], objects: [] };
  const { minX, maxX, minZ, maxZ } = r;
  const cells = [];
  for (const [layer, grid] of doc.tileLayers) {
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = grid.get(cellKey(cx, cz));
        if (cell) cells.push({ dx: cx - minX, dz: cz - minZ, layer, m: cell.m, rot: cell.rot, tint: cell.tint, y: cell.y });
      }
    }
  }
  const objects = doc.objects
    .filter((o) => o.cx >= minX && o.cx <= maxX && o.cz >= minZ && o.cz <= maxZ)
    .map((o) => ({ dx: o.cx - minX, dz: o.cz - minZ, layer: o.layer, m: o.m, rot: o.rot, tint: o.tint, y: o.y }));
  return { w: maxX - minX + 1, h: maxZ - minZ + 1, cells, objects };
}

/**
 * Pastes `clip` (from `copyRect`) anchored at `(cx,cz)` — one undo step for the WHOLE paste,
 * however many cells/objects it touches, not one per cell/object. A target cell outside
 * `[0,w)×[0,h)` is skipped rather than throwing — the same edge tolerance `paintRect`'s own
 * bounds check already has, so pasting near the map edge clips silently instead of crashing.
 *
 * Every touched tile layer's `Map` is resolved once (existing, or freshly minted the same way
 * `paintCell`'s own `doc.tileLayers.get(layer) ?? new Map()` does — never through `addLayer`,
 * which pushes its OWN undo step; a paste that happens to touch a brand-new layer number still
 * needs to stay one undo step, not two) and reused across every redo of this one command.
 */
export function pasteClip(doc, history, { clip, cx, cz }) {
  if (!clip || (!clip.cells.length && !clip.objects.length)) return;
  const grids = new Map(); // layer -> live Map reference, resolved once per touched layer
  const gridFor = (layer) => {
    if (!grids.has(layer)) grids.set(layer, doc.tileLayers.get(layer) ?? new Map());
    return grids.get(layer);
  };
  const cellWrites = []; // { layer, key, before, after }
  for (const c of clip.cells) {
    const tx = cx + c.dx; const tz = cz + c.dz;
    if (!inside(doc, tx, tz)) continue;
    const grid = gridFor(c.layer);
    const key = cellKey(tx, tz);
    cellWrites.push({ layer: c.layer, key, before: grid.get(key) ?? null, after: { m: c.m, rot: c.rot, tint: c.tint, y: c.y } });
  }
  // Every pasted object's `id` is minted up front, once (`doc.nextObjectId++`, the same counter
  // `placeObject` reuses — never a second, duplicate one) — so a redo after an undo re-creates
  // the SAME objects instead of minting a second, different set every time this command replays.
  const newObjects = [];
  for (const o of clip.objects) {
    const tx = cx + o.dx; const tz = cz + o.dz;
    if (!inside(doc, tx, tz)) continue;
    newObjects.push({ id: doc.nextObjectId++, m: o.m, cx: tx, cz: tz, layer: o.layer, rot: o.rot, tint: o.tint, y: o.y });
  }
  if (!cellWrites.length && !newObjects.length) return; // the whole clip clipped off the map — nothing to commit
  history.push({
    label: 'colar',
    redo() {
      for (const [layer, grid] of grids) doc.tileLayers.set(layer, grid);
      for (const w of cellWrites) grids.get(w.layer).set(w.key, w.after);
      for (const o of newObjects) doc.objects.push(o);
      touch(doc);
    },
    undo() {
      for (const w of cellWrites) {
        const grid = grids.get(w.layer);
        if (w.before) grid.set(w.key, w.before); else grid.delete(w.key);
      }
      const ids = new Set(newObjects.map((o) => o.id));
      doc.objects = doc.objects.filter((o) => !ids.has(o.id));
      touch(doc);
    },
  });
}

/**
 * Cut = copy + clear, as one command (one undo step) — for a FUTURE drag-move gesture
 * (`(x0,z0)-(x1,z1)` is the source rect, `(dx,dz)` the offset to the destination). NOT what
 * Ctrl+X calls: cut-to-clipboard and "move within the map" are different user actions, so
 * `main.js`'s Ctrl+X handler calls `copyRect` then `clearRect` instead — two separate steps for
 * a genuinely different gesture, not a missed reuse of this function.
 *
 * Reads every source cell/object BEFORE clearing or writing anything, exactly like `copyRect`
 * would, so a self-overlapping move (source and destination rects intersect) never reads back a
 * cell this same command already blanked. Spans every tile layer (matching `copyRect`'s own
 * cross-layer read) rather than one — unlike `clearRect` below, which is deliberately scoped to
 * one layer for the Delete key's own, more conservative default.
 */
export function moveRect(doc, history, { x0, z0, x1, z1, dx, dz }) {
  const r = clampRect(doc, x0, z0, x1, z1);
  if (!r) return;
  const { minX, maxX, minZ, maxZ } = r;

  const grids = new Map(); // layer -> live Map reference
  const gridFor = (layer) => {
    if (!grids.has(layer)) grids.set(layer, doc.tileLayers.get(layer) ?? new Map());
    return grids.get(layer);
  };
  const DELETE = Symbol('moveRect delete'); // a per-call sentinel — never leaks past this function
  const beforeByLayer = new Map(); // layer -> Map<key, valueOrNull> — every touched key's pre-move value, for undo
  const afterByLayer = new Map(); // layer -> Map<key, valueOrDELETE> — every touched key's post-move value, for redo
  // Two passes per layer, not one interleaved pass: an EARLIER-processed source cell's own
  // target write (`after.set(tkey, cell)`) must never be clobbered by a LATER-processed source
  // cell's own delete-marking (`after.set(key, DELETE)`) when that later cell's `key` happens to
  // equal the earlier one's `tkey` — exactly what an overlapping same-direction shift produces
  // (e.g. cells at cx=0,1,2,3 all moving +1: cx=0's write to cx=1 must survive cx=1's own
  // "I am now empty" marking, which runs right after it in cell order). Collecting every
  // `{key, tkey, cell}` first and applying every deletion before any target write — for the
  // whole layer, not per cell — makes the final target write for a given key always win,
  // regardless of processing order, the same way a plain doc.objects.push after a filter
  // already does not care what order its own two steps ran in for two different objects.
  for (const [layer, grid] of doc.tileLayers) {
    const moves = [];
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const key = cellKey(cx, cz);
        const cell = grid.get(key);
        if (cell) moves.push({ key, cell, tx: cx + dx, tz: cz + dz });
      }
    }
    if (!moves.length) continue;
    gridFor(layer);
    if (!beforeByLayer.has(layer)) beforeByLayer.set(layer, new Map());
    if (!afterByLayer.has(layer)) afterByLayer.set(layer, new Map());
    const before = beforeByLayer.get(layer);
    const after = afterByLayer.get(layer);
    // Pass 1: every source cell disappears.
    for (const mv of moves) {
      if (!before.has(mv.key)) before.set(mv.key, mv.cell);
      after.set(mv.key, DELETE);
    }
    // Pass 2: every target write lands, overwriting pass 1's DELETE wherever a target key
    // happens to equal some other cell's own source key (self-overlap).
    for (const mv of moves) {
      if (!inside(doc, mv.tx, mv.tz)) continue; // moved off the map — dropped, matching `pasteClip`'s own edge tolerance
      const tkey = cellKey(mv.tx, mv.tz);
      if (!before.has(tkey)) before.set(tkey, grid.get(tkey) ?? null);
      after.set(tkey, mv.cell);
    }
  }

  const sourceObjects = doc.objects.filter((o) => o.cx >= minX && o.cx <= maxX && o.cz >= minZ && o.cz <= maxZ);
  const newObjects = [];
  for (const o of sourceObjects) {
    const tx = o.cx + dx; const tz = o.cz + dz;
    if (!inside(doc, tx, tz)) continue; // moved off the map — dropped, same tolerance as above
    newObjects.push({ id: doc.nextObjectId++, m: o.m, cx: tx, cz: tz, layer: o.layer, rot: o.rot, tint: o.tint, y: o.y });
  }

  if (!afterByLayer.size && !sourceObjects.length) return; // an empty rect — nothing to move

  history.push({
    label: 'mover seleção',
    redo() {
      for (const [layer, grid] of grids) doc.tileLayers.set(layer, grid);
      for (const [layer, after] of afterByLayer) {
        const grid = grids.get(layer);
        for (const [key, val] of after) { if (val === DELETE) grid.delete(key); else grid.set(key, val); }
      }
      const removedIds = new Set(sourceObjects.map((o) => o.id));
      doc.objects = doc.objects.filter((o) => !removedIds.has(o.id));
      for (const o of newObjects) doc.objects.push(o);
      touch(doc);
    },
    undo() {
      for (const [layer, before] of beforeByLayer) {
        const grid = grids.get(layer);
        for (const [key, val] of before) { if (val) grid.set(key, val); else grid.delete(key); }
      }
      const newIds = new Set(newObjects.map((o) => o.id));
      doc.objects = doc.objects.filter((o) => !newIds.has(o.id));
      for (const o of sourceObjects) doc.objects.push(o);
      touch(doc);
    },
  });
}

/**
 * Clears every tile-grid entry and every origin-inside object in the rect, on `layer` ONLY —
 * the caller's active layer, threaded through the same way `paintRect`/`fillRegion` already
 * take `layer` rather than reaching for a module-level "current layer" of their own. Never every
 * layer at once: that would make a Delete-key press a far more destructive default than the
 * rest of this tool rail gives any other key, and nothing about a rectangular selection implies
 * "every layer" the way `copyRect`/`moveRect`'s own cross-layer read does for a copy/move.
 */
export function clearRect(doc, history, { x0, z0, x1, z1, layer }) {
  const r = clampRect(doc, x0, z0, x1, z1);
  if (!r) return;
  const { minX, maxX, minZ, maxZ } = r;
  const grid = doc.tileLayers.get(layer);
  const before = new Map();
  if (grid) {
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      const key = cellKey(cx, cz);
      const cell = grid.get(key);
      if (cell) before.set(key, cell);
    }
  }
  const objects = doc.objects.filter((o) => o.layer === layer && o.cx >= minX && o.cx <= maxX && o.cz >= minZ && o.cz <= maxZ);
  if (!before.size && !objects.length) return;
  history.push({
    label: 'limpar seleção',
    redo() {
      for (const key of before.keys()) grid.delete(key);
      if (objects.length) { const ids = new Set(objects.map((o) => o.id)); doc.objects = doc.objects.filter((o) => !ids.has(o.id)); }
      touch(doc);
    },
    undo() {
      for (const [key, val] of before) grid.set(key, val);
      for (const o of objects) doc.objects.push(o);
      touch(doc);
    },
  });
}

/** Flood-fills the 4-connected region sharing the clicked cell's current model. */
export function fillRegion(doc, history, { layer, cx, cz, asset, rot = 0, tint = 0xffffff }) {
  if (!inside(doc, cx, cz)) return;
  const grid = doc.tileLayers.get(layer) ?? new Map();
  const target = grid.get(cellKey(cx, cz))?.m ?? null;
  if (target === asset.name) return;
  const seen = new Set();
  const stack = [[cx, cz]];
  const before = new Map();
  while (stack.length) {
    const [x, z] = stack.pop();
    const key = cellKey(x, z);
    if (seen.has(key) || !inside(doc, x, z)) continue;
    seen.add(key);
    if ((grid.get(key)?.m ?? null) !== target) continue;
    before.set(key, grid.get(key) ?? null);
    stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]);
  }
  history.push({
    label: 'balde de tinta',
    redo() {
      doc.tileLayers.set(layer, grid);
      for (const key of before.keys()) grid.set(key, { m: asset.name, rot, tint, y: null });
      touch(doc);
    },
    undo() {
      for (const [key, v] of before) { if (v) grid.set(key, v); else grid.delete(key); }
      touch(doc);
    },
  });
}

export function setCollision(doc, history, { cx, cz, kind }) {
  if (!inside(doc, cx, cz)) return;
  const i = idx(doc, cx, cz);
  const before = doc.collision[i];
  if (before === kind) return;
  history.push({
    label: 'colisão',
    redo() { doc.collision[i] = kind; touch(doc); },
    undo() { doc.collision[i] = before; touch(doc); },
  });
}

export function adjustHeight(doc, history, { cx, cz, delta }) {
  if (!inside(doc, cx, cz)) return;
  const i = idx(doc, cx, cz);
  const before = doc.height[i];
  const after = Math.round((before + delta) * 20) / 20;
  history.push({
    label: 'altura',
    redo() { doc.height[i] = after; touch(doc); },
    undo() { doc.height[i] = before; touch(doc); },
  });
}

/** Snaps a height value to the nearest 0.05 — `adjustHeight`'s own precedent, matched exactly
 *  (not reinvented) so a sculpted terrace lands on the same grid `canStep`/`ELEVATION_EPS`
 *  (`src/terrain/draft.js`) reason about, rather than a near-miss like 0.2601 that reads
 *  identically on screen but silently changes walkability. */
const snapHeight = (v) => Math.round(v * 20) / 20;

/** The mean height of a cell's own 3×3 neighborhood (itself included), clipped to the map —
 *  `sculptTick`'s `smooth` mode target. A plain average, not distance-weighted: the tick's own
 *  radius falloff (below) already does the "softer at the edge" job; a second weighting here
 *  would just be two falloffs fighting each other for one visual effect. */
function neighborMeanHeight(doc, cx, cz) {
  let sum = 0;
  let count = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!inside(doc, nx, nz)) continue;
      sum += doc.height[idx(doc, nx, nz)];
      count++;
    }
  }
  return count ? sum / count : doc.height[idx(doc, cx, cz)];
}

/**
 * Opens a sculpt stroke — call once per `pointerdown` on the `sculpt` tool. `before` is a lazy
 * `idx -> original height` map, populated by `sculptTick` the first time each cell is actually
 * touched, and read back by `endSculptStroke` to close the WHOLE stroke into one undo step
 * (`paintRect`'s own before/after-map shape, generalized from a rectangle to a round brush).
 * `targetHeight` is `flatten`'s pin — the height under the pointer at the moment the stroke
 * started — captured lazily by the first `sculptTick` call instead of here, since that call
 * already knows the stroke's starting cell and this one does not need to.
 */
export function beginSculptStroke(_doc) {
  return { before: new Map() };
}

/**
 * Applies one tick of the brush at `(cx,cz)` — one call per `pointerdown`/`pointermove` while a
 * sculpt stroke is live. Round, not square (Euclidean distance, not Chebyshev/Manhattan), with a
 * linear falloff from full strength at the center to nothing at `radius`. Mutates `doc.height`
 * and bumps `doc._rev` (`touch`) directly — no history entry per tick, matching the doc's own
 * comment above `sculptTick`'s design: the undo grain is the whole STROKE, not the tick, so
 * `endSculptStroke` is what actually pushes to `history`.
 *
 * `stroke.before` only ever records a cell's PRE-STROKE value, the first time any tick in this
 * stroke actually changes it (`stroke.before.has(idx)` guards every write) — a cell revisited by
 * a later tick of the same stroke (a slow drag lingering over one spot, which is expected brush
 * behaviour, not a bug to de-duplicate) must not overwrite that original with an
 * already-modified value, or `endSculptStroke`'s undo would restore the wrong thing.
 */
export function sculptTick(doc, stroke, { cx, cz, mode, radius, strength }) {
  if (!inside(doc, cx, cz)) return;
  if (mode === 'flatten' && stroke.targetHeight === undefined) {
    stroke.targetHeight = doc.height[idx(doc, cx, cz)];
  }
  const r = Math.max(0, radius);
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(doc.w - 1, Math.ceil(cx + r));
  const minZ = Math.max(0, Math.floor(cz - r));
  const maxZ = Math.min(doc.h - 1, Math.ceil(cz + r));
  let changed = false;
  for (let nz = minZ; nz <= maxZ; nz++) {
    for (let nx = minX; nx <= maxX; nx++) {
      const dist = Math.hypot(nx - cx, nz - cz);
      if (dist > r) continue; // outside the round brush footprint, even though inside its bounding square
      const weight = r > 0 ? Math.max(0, Math.min(1, 1 - dist / r)) : 1;
      const i = idx(doc, nx, nz);
      const before = doc.height[i];
      let after;
      if (mode === 'raise' || mode === 'lower') {
        after = snapHeight(before + (mode === 'raise' ? 1 : -1) * strength * weight);
      } else if (mode === 'flatten') {
        after = snapHeight(before + (stroke.targetHeight - before) * strength * weight);
      } else if (mode === 'smooth') {
        after = snapHeight(before + (neighborMeanHeight(doc, nx, nz) - before) * strength * weight);
      } else {
        after = before;
      }
      if (after === before) continue; // a strength/radius-0 tick (or a fully-flat/leveled cell) is inert, not a spurious edit
      if (!stroke.before.has(i)) stroke.before.set(i, before);
      doc.height[i] = after;
      changed = true;
    }
  }
  if (changed) touch(doc);
}

/**
 * Closes a sculpt stroke into one undo entry covering every cell it touched — a no-op when the
 * stroke never actually changed anything (a click entirely off the map, or a down/up so quick no
 * tick ran, or every tick's delta rounded to zero). Mirrors `paintRect`'s own before/after-map
 * redo/undo shape: `after` is read back from the LIVE `doc.height` (already written by every
 * `sculptTick` call this stroke made) at push time, not recomputed, since the ticks already did
 * the real math — this command only needs to remember it as one atomic edit.
 */
export function endSculptStroke(doc, history, stroke) {
  if (!stroke.before.size) return;
  const after = new Map();
  for (const i of stroke.before.keys()) after.set(i, doc.height[i]);
  history.push({
    label: 'esculpir altura',
    redo() { for (const [i, v] of after) doc.height[i] = v; touch(doc); },
    undo() { for (const [i, v] of stroke.before) doc.height[i] = v; touch(doc); },
  });
}

export function toggleTag(doc, history, { cx, cz, tag }) {
  if (!inside(doc, cx, cz)) return;
  const i = idx(doc, cx, cz);
  const before = doc.tags[i].slice();
  const has = before.includes(tag);
  const after = has ? before.filter((t) => t !== tag) : [...before, tag];
  history.push({
    label: 'tag',
    redo() { doc.tags[i] = after; touch(doc); },
    undo() { doc.tags[i] = before; touch(doc); },
  });
}

/** A single top-level field write, undoable — the inspector's plain map-info fields
 *  (id/name/kind/seed/requiredLevel/biome/weather/environmentPreset) all funnel through this
 *  instead of writing `doc[key]` directly, so Ctrl+Z covers them like every other edit. */
export function setField(doc, history, { key, value }) {
  const before = doc[key];
  if (before === value) return;
  history.push({
    label: key,
    redo() { doc[key] = value; touch(doc); },
    undo() { doc[key] = before; touch(doc); },
  });
}

/** Replaces `doc.loop.via` wholesale — the Jogabilidade card's add/remove marker chips. */
export function setLoopVia(doc, history, { via }) {
  const before = doc.loop ? { ...doc.loop } : null;
  const after = { ...(doc.loop ?? {}), via };
  history.push({
    label: 'loop (via)',
    redo() { doc.loop = after; touch(doc); },
    undo() { doc.loop = before; touch(doc); },
  });
}

/**
 * Adds a spawn point at `(cx,cz)` — a wild Pokémon respawn point that owns its own
 * `respawnSeconds` and its own weighted `species[]` list (`@/terrain/mapfile.js`'s
 * `spawnPoints[]`). Placed directly by the author; nothing derives it from the loop any more.
 */
export function addSpawnPoint(doc, history, { cx, cz, dir = 0 }) {
  const point = {
    id: `spawn-${doc.spawnPoints.length}-${Date.now().toString(36)}`,
    cx, cz, dir, respawnSeconds: 26, species: [],
  };
  history.push({
    label: 'ponto de spawn',
    redo() { doc.spawnPoints.push(point); touch(doc); },
    undo() { doc.spawnPoints = doc.spawnPoints.filter((p) => p !== point); touch(doc); },
  });
  return point;
}

/** Removes one spawn point. Takes the point object itself (the same reference
 *  `doc.spawnPoints` holds), the same identity-based match `removeNpc`/`removeLight` use. */
export function removeSpawnPoint(doc, history, point) {
  history.push({
    label: 'remover ponto de spawn',
    redo() { doc.spawnPoints = doc.spawnPoints.filter((p) => p !== point); touch(doc); },
    undo() { doc.spawnPoints.push(point); touch(doc); },
  });
}

/** Merges `patch` into one spawn point — position, direction, `respawnSeconds`, or a whole
 *  new `species[]` list (the inspector's species-row editor replaces the array wholesale,
 *  the same coarse-grained undo grain every other row-editor command in this file uses). */
export function updateSpawnPoint(doc, history, { point, patch }) {
  const before = { ...point };
  const after = { ...point, ...patch };
  history.push({
    label: 'editar ponto de spawn',
    redo() { Object.assign(point, after); touch(doc); },
    undo() { Object.assign(point, before); touch(doc); },
  });
}

/** Replaces the map's own economy profile wholesale — the Economy card's number fields and
 *  its type -> multiplier `favours` list all funnel through this one command. */
export function setEconomy(doc, history, { economy }) {
  const before = doc.economy;
  const after = economy;
  history.push({
    label: 'economia',
    redo() { doc.economy = after; touch(doc); },
    undo() { doc.economy = before; touch(doc); },
  });
}

/** Picks which authored camera preset a scene boots into by default. */
export function setDefaultCamera(doc, history, { name }) {
  const before = doc.cameras;
  const after = { ...doc.cameras, default: name };
  history.push({
    label: 'câmera padrão',
    redo() { doc.cameras = after; touch(doc); },
    undo() { doc.cameras = before; touch(doc); },
  });
}

export function setSpawn(doc, history, { cx, cz, dir }) {
  const before = { ...doc.spawn };
  const after = { ...doc.spawn, cx, cz, ...(dir != null ? { dir } : {}) };
  history.push({
    label: 'spawn',
    redo() { doc.spawn = after; touch(doc); },
    undo() { doc.spawn = before; touch(doc); },
  });
}

export function placeMarker(doc, history, { name, cx, cz }) {
  const existing = doc.markers.find((m) => m.name === name);
  const before = existing ? { ...existing } : null;
  history.push({
    label: 'marcador',
    redo() {
      const m = doc.markers.find((x) => x.name === name);
      if (m) { m.cx = cx; m.cz = cz; } else doc.markers.push({ name, cx, cz });
      touch(doc);
    },
    undo() {
      if (before) { const m = doc.markers.find((x) => x.name === name); if (m) { m.cx = before.cx; m.cz = before.cz; } }
      else doc.markers = doc.markers.filter((x) => x.name !== name);
      touch(doc);
    },
  });
}

/** Takes the marker object itself (the same reference `doc.markers` holds) — the same
 *  identity-based match `removeNpc`/`removeLight`/`removeSpawnPoint` use, and required now that
 *  `updateMarker` can rename a marker in place: a name-keyed lookup would go stale the moment a
 *  rename and a remove land in the same edit session. */
export function removeMarker(doc, history, marker) {
  history.push({
    label: 'remover marcador',
    redo() { doc.markers = doc.markers.filter((m) => m !== marker); touch(doc); },
    undo() { doc.markers.push(marker); touch(doc); },
  });
}

/** Merges `patch` into one marker in place — today only `name` (the inspector's "Marcador"
 *  card), but written the same `{marker, patch}` shape as `updateLight`/`updateSpawnPoint` so it
 *  is not a special case. Position still moves through `placeMarker` (the gizmo-drag path). */
export function updateMarker(doc, history, { marker, patch }) {
  const before = { ...marker };
  const after = { ...marker, ...patch };
  history.push({
    label: 'editar marcador',
    redo() { Object.assign(marker, after); touch(doc); },
    undo() { Object.assign(marker, before); touch(doc); },
  });
}

export function placeObject(doc, history, { m, cx, cz, layer, rot = 0, tint = 0xffffff }) {
  const obj = { id: doc.nextObjectId++, m, cx, cz, layer, rot, tint, y: null };
  history.push({
    label: 'objeto',
    redo() { doc.objects.push(obj); touch(doc); },
    undo() { doc.objects = doc.objects.filter((o) => o.id !== obj.id); touch(doc); },
  });
  return obj;
}

/** Takes the object itself, not `{id}` — every call site already has the real `doc.objects`
 *  reference in hand (the bottom panel's row, the entity table's `ref`), so a redundant
 *  find-by-id only existed here before because nothing else in this file needed identity yet.
 *  Matches `removeNpc`/`removeLight`/`removeMarker`/`removeSpawnPoint`'s own convention. */
export function removeObject(doc, history, object) {
  history.push({
    label: 'remover objeto',
    redo() { doc.objects = doc.objects.filter((o) => o !== object); touch(doc); },
    undo() { doc.objects.push(object); touch(doc); },
  });
}

/** Merges `patch` into one object in place — rot/tint/layer/position, all in one place (the
 *  inspector's "Tile selecionado" card, when an object is selected, routes every one of its
 *  edits through this instead of the grid-cell-shaped `setCellRotation`/`setCellTint`, which
 *  cannot address an object by reference the way a `Map`-keyed grid cell can by `cx,cz`). */
export function updateObject(doc, history, { object, patch }) {
  const before = { ...object };
  const after = { ...object, ...patch };
  history.push({
    label: 'editar objeto',
    redo() { Object.assign(object, after); touch(doc); },
    undo() { Object.assign(object, before); touch(doc); },
  });
}

/** Repositions an existing object — new: objects could not be moved from the inspector before
 *  (only placed and removed). A thin `updateObject` wrapper, not its own history entry shape. */
export function moveObject(doc, history, { object, cx, cz }) {
  updateObject(doc, history, { object, patch: { cx, cz } });
}

export function addNpc(doc, history, npc) {
  history.push({
    label: 'npc',
    redo() { doc.npcs.push(npc); touch(doc); },
    undo() { doc.npcs = doc.npcs.filter((n) => n !== npc); touch(doc); },
  });
}

export function removeNpc(doc, history, npc) {
  history.push({
    label: 'remover npc',
    redo() { doc.npcs = doc.npcs.filter((n) => n !== npc); touch(doc); },
    undo() { doc.npcs.push(npc); touch(doc); },
  });
}

/** Merges `patch` into one NPC in place — the inspector's "NPC" card routes every field
 *  (name/display/dir/route/solid/shiny, and the trainer<->species kind switch) through this.
 *  Delete-aware (`applyPatch`): switching kind must actually remove the OTHER identity field
 *  (`trainer`/`species` are mutually exclusive in every shipped NPC — `openAddNpcDialog` never
 *  sets both), not merely null it, and clearing an optional text field (`display`/`route`)
 *  should drop the key rather than ship an empty string. */
export function updateNpc(doc, history, { npc, patch }) {
  const before = { ...npc };
  history.push({
    label: 'editar npc',
    redo() { applyPatch(npc, patch); touch(doc); },
    undo() {
      for (const k of Object.keys(npc)) delete npc[k];
      Object.assign(npc, before);
      touch(doc);
    },
  });
}

/**
 * Repositions an existing NPC in place — `addNpc`/`removeNpc` only ever add or remove a whole
 * entry, and until the 3D preview's draggable gizmos (`studio/viewport/index.js`) there was no "move it
 * to a new cell" command for anything to call. Takes the npc object itself (the same reference
 * `doc.npcs` holds), not an index — an index drifts under undo/redo of other add/remove
 * commands touching the array, object identity does not.
 */
export function moveNpc(doc, history, { npc, cx, cz }) {
  const before = { cx: npc.cx, cz: npc.cz };
  history.push({
    label: 'mover npc',
    redo() { npc.cx = cx; npc.cz = cz; touch(doc); },
    undo() { npc.cx = before.cx; npc.cz = before.cz; touch(doc); },
  });
}

export function addLight(doc, history, light) {
  history.push({
    label: 'luz',
    redo() { doc.lights.push(light); touch(doc); },
    undo() { doc.lights = doc.lights.filter((l) => l !== light); touch(doc); },
  });
}

export function removeLight(doc, history, light) {
  history.push({
    label: 'remover luz',
    redo() { doc.lights = doc.lights.filter((l) => l !== light); touch(doc); },
    undo() { doc.lights.push(light); touch(doc); },
  });
}

/** Merges `patch` into one light in place — identity-based (`{light, patch}`, matching
 *  `updateSpawnPoint`/`removeLight`), not the old `{index, patch}`. An index drifts under
 *  undo/redo of any OTHER add/remove touching `doc.lights` — the exact "selection shape" bug
 *  this slice's plan calls out (`studio/session.js`'s old `lightIndex` field, same problem). */
export function updateLight(doc, history, { light, patch }) {
  const before = { ...light };
  const after = { ...light, ...patch };
  history.push({
    label: 'editar luz',
    redo() { Object.assign(light, after); touch(doc); },
    undo() { Object.assign(light, before); touch(doc); },
  });
}

/** Rewrites one grid tile's rotation, in place. An object's rotation goes through the
 *  identity-based `updateObject` instead — a `Map`-keyed grid cell and an object reference are
 *  different enough storage shapes that folding both into one function meant an `objectId`
 *  branch nothing else in this file needed. */
export function setCellRotation(doc, history, { layer, cx, cz, rot }) {
  const grid = doc.tileLayers.get(layer);
  const key = cellKey(cx, cz);
  const cell = grid?.get(key);
  if (!cell) return;
  const before = { ...cell };
  history.push({
    label: 'rotação',
    redo() { grid.set(key, { ...cell, rot }); touch(doc); },
    undo() { grid.set(key, before); touch(doc); },
  });
}

/** Rewrites one grid tile's multiply tint, in place. See `setCellRotation`'s own note on why an
 *  object's tint goes through `updateObject` instead. */
export function setCellTint(doc, history, { layer, cx, cz, tint }) {
  const grid = doc.tileLayers.get(layer);
  const key = cellKey(cx, cz);
  const cell = grid?.get(key);
  if (!cell) return;
  const before = { ...cell };
  history.push({
    label: 'tint',
    redo() { grid.set(key, { ...cell, tint }); touch(doc); },
    undo() { grid.set(key, before); touch(doc); },
  });
}

/** Adds an empty tile layer at number `n` — undoable, and marks the doc dirty/bumps `_rev`
 *  via `touch()`, unlike the bottom panel's old direct `doc.tileLayers.set(...)`. */
export function addLayer(doc, history, n) {
  if (doc.tileLayers.has(n)) return;
  history.push({
    label: 'nova camada',
    redo() { doc.tileLayers.set(n, new Map()); touch(doc); },
    undo() { doc.tileLayers.delete(n); touch(doc); },
  });
}

// --- links: map-to-map doors/edges/stairs (`{id, kind, from:{cx,cz}, to:{...}, label?}`,
// `mapfile.js`'s header) ----------------------------------------------------------------------

/** Matches `addNpc`'s shape — nothing in this slice builds a "place a new link" tool/gizmo flow
 *  yet (a later slice's canvas/viewport work), but the command itself is not blocked on that. */
export function addLink(doc, history, link) {
  history.push({
    label: 'link',
    redo() { doc.links.push(link); touch(doc); },
    undo() { doc.links = doc.links.filter((l) => l !== link); touch(doc); },
  });
}

export function removeLink(doc, history, link) {
  history.push({
    label: 'remover link',
    redo() { doc.links = doc.links.filter((l) => l !== link); touch(doc); },
    undo() { doc.links.push(link); touch(doc); },
  });
}

/** Merges `patch` into one link in place. `patch.to`, when present, MERGES into `link.to`
 *  rather than replacing it wholesale — the link card edits one `to.*` subfield (map/marker/
 *  cx/cz/dir) at a time, the same reason `setEconomy`'s `favours` merge exists — and both the
 *  top-level and nested merges are delete-aware (`applyPatch`): clearing the optional `label` or
 *  switching `to.marker` for a bare `to.cx/cz` fallback must drop the stale key, not null it. */
export function updateLink(doc, history, { link, patch }) {
  const before = { ...link, to: { ...link.to } };
  const { to: toPatch, ...topPatch } = patch;
  history.push({
    label: 'editar link',
    redo() {
      applyPatch(link, topPatch);
      if (toPatch) { link.to = { ...link.to }; applyPatch(link.to, toPatch); }
      touch(doc);
    },
    undo() {
      for (const k of Object.keys(link)) delete link[k];
      Object.assign(link, before, { to: { ...before.to } });
      touch(doc);
    },
  });
}

// --- regions: authored autotile masks (`{id, kind:'autotile', set, layer?, collision?, tags?,
// mask:Runs<0|1>}`, `mapfile.js`'s header). Slice 9b adds the two commands below (`addRegion`,
// `paintRegionMask`) — the first real mask-painting tool; everything else in this section
// predates it and only let an already-authored region (none shipped before this slice) be
// selected/edited/removed. -----------------------------------------------------------------------

/**
 * Creates a new empty-mask region and pushes it, undoable — matches `addLink`'s own shape.
 * `set` is fixed here for good: `inspector.js`'s own `regionCard` only ever shows it as a
 * read-only field row (`fieldRow('Conjunto (set)', region.set)`), so the brush bar's "nova
 * região" picker (`panels.js`) is the only place an author ever chooses it. `layer`/`collision`/
 * `tags` stay editable afterward through `updateRegion`, unchanged by this slice. The mask starts
 * fully empty — `mapfile.js`'s own header is explicit that nothing here should ever pre-fill it
 * from anything else; painting membership is `paintRegionMask`'s job alone.
 */
export function addRegion(doc, history, { set, layer, collision, tags }) {
  const region = {
    // Same minting convention `entities.js`'s header points at for `spawnPoint`/`light`: an
    // index into the array plus a base-36 timestamp, unique for a Studio session and carried
    // through unchanged on every later save.
    id: `region-${doc.regions.length}-${Date.now().toString(36)}`,
    kind: 'autotile', set, layer, collision, tags: tags ?? [],
    mask: encodeRuns(new Array(doc.w * doc.h).fill(0)),
  };
  history.push({
    label: 'nova região',
    redo() { doc.regions.push(region); touch(doc); },
    undo() { doc.regions = doc.regions.filter((r) => r !== region); touch(doc); },
  });
  return region;
}

/**
 * Adds or removes `cells` (an array of `{cx,cz}` — whatever `main.js`'s own region drag gesture
 * naturally collects from its pointer-move `Set<string>` of `"cx,cz"` keys) from `region`'s mask.
 * ONE undo step per STROKE: call once on pointerup with every cell the drag touched, never once
 * per cell.
 *
 * This is where this slice's whole invariant actually lives (see the slice plan's own "read this
 * twice" section): **a region owns its masked cells on its own layer, exclusively.** `on: true`
 * adds membership and, for every NEWLY-masked cell, immediately —
 *  1. clears that layer's `doc.tileLayers` grid entry at the cell (if any), and
 *  2. removes any `doc.objects[]` entry whose origin cell matches (on that same layer), and
 *  3. steals the cell away from any OTHER region on the SAME layer that currently claims it
 *     (regions on one layer are mutually exclusive by mask, the same way a `tileLayers` Map slot
 *     holds only one entry — painting region B over a cell region A already owns makes B win,
 *     exactly like painting a normal tile over another one already does).
 * Doing this NOW, not deferred to `serializeDocument` time, is what keeps `validate.js`'s
 * `region-tile-overlap` check passing and keeps `frommap.js`'s replay from ever placing the same
 * cell twice (that file's own header: `regions[]` replays before `tiles[]`/`objects[]`, so a
 * masked cell that still had a real placement under it would draw both, doubled, on the very next
 * load — including the Studio's own live 3D pane, which reloads through the identical path).
 *
 * `on: false` (erasing membership) ONLY ever clears this region's own mask bit. It never restores
 * whatever the resolved autotile preview had been rendering there — that resolution is a LIVE
 * PREVIEW only (`mapfile.js`'s header: a snapshot of an existing map never fills `regions[]`; the
 * same "never bake a resolved placement back into a snapshot" rule applies symmetrically to
 * un-painting one here), so an erased cell simply becomes ordinary empty space again, exactly as
 * empty as a cell that was never masked at all.
 */
export function paintRegionMask(doc, history, { region, cells, on }) {
  const n = doc.w * doc.h;
  const layer = region.layer ?? 0;
  const beforeMask = decodeRuns(region.mask, n);
  const afterMask = beforeMask.slice();

  // Snapshot everything this stroke is about to touch, BEFORE anything is mutated, so `redo`/
  // `undo` below are plain data replays — the same shape every other command in this file uses
  // (`paintCell`'s own `before`/`after`, computed ahead of `history.push`). A partial undo (the
  // mask reverts but a cleared tile does not come back) would be worse than no undo at all here,
  // so every side effect below — the grid cell, the removed objects, the OTHER region's stolen
  // mask bits — gets its own "before" captured up front.
  const grid = doc.tileLayers.get(layer);
  const clearedTiles = []; // { key, before } — this region's own layer's grid cells cleared by painting ON
  const removedObjects = []; // real `doc.objects[]` references removed by painting ON
  const touchedIdx = [];
  const seen = new Set();

  for (const c of cells) {
    if (!inside(doc, c.cx, c.cz)) continue;
    const i = idx(doc, c.cx, c.cz);
    if (seen.has(i)) continue; // a drag can revisit a cell; act on it once
    seen.add(i);
    touchedIdx.push(i);
    afterMask[i] = on ? 1 : 0;
    if (!on) continue; // erasing touches nothing but this region's own mask bit — see the header above
    const key = cellKey(c.cx, c.cz);
    if (grid?.has(key)) clearedTiles.push({ key, before: grid.get(key) });
    for (const obj of doc.objects) {
      if (obj.cx === c.cx && obj.cz === c.cz && (obj.layer ?? 0) === layer) removedObjects.push(obj);
    }
  }
  if (!touchedIdx.length) return; // every cell was out of bounds or duplicate — nothing to paint

  // Steal newly-masked cells away from any other same-layer region that already claims them —
  // only relevant when ADDING membership; erasing never touches another region's mask.
  const stolenFrom = new Map(); // otherRegion -> { before: Runs, after: Runs }
  if (on) {
    for (const other of doc.regions) {
      if (other === region || (other.layer ?? 0) !== layer) continue;
      const otherMask = decodeRuns(other.mask, n);
      let changed = false;
      for (const i of touchedIdx) if (otherMask[i]) { otherMask[i] = 0; changed = true; }
      if (changed) stolenFrom.set(other, { before: other.mask, after: encodeRuns(otherMask) });
    }
  }

  const beforeMaskEncoded = region.mask;
  const afterMaskEncoded = encodeRuns(afterMask);

  history.push({
    label: on ? 'pintar região' : 'apagar região',
    redo() {
      region.mask = afterMaskEncoded;
      for (const { key } of clearedTiles) grid?.delete(key);
      if (removedObjects.length) {
        const removedSet = new Set(removedObjects);
        doc.objects = doc.objects.filter((o) => !removedSet.has(o));
      }
      for (const [other, { after }] of stolenFrom) other.mask = after;
      touch(doc);
    },
    undo() {
      region.mask = beforeMaskEncoded;
      for (const { key, before } of clearedTiles) grid?.set(key, before);
      if (removedObjects.length) doc.objects.push(...removedObjects);
      for (const [other, { before }] of stolenFrom) other.mask = before;
      touch(doc);
    },
  });
}

export function removeRegion(doc, history, region) {
  history.push({
    label: 'remover região',
    redo() { doc.regions = doc.regions.filter((r) => r !== region); touch(doc); },
    undo() { doc.regions.push(region); touch(doc); },
  });
}

/** Merges `patch` into one region in place (`layer`/`collision`/`tags` — never `mask`, which
 *  stays the paint tool's job). Delete-aware (`applyPatch`) so clearing the optional `collision`
 *  select drops the key instead of shipping an empty string. */
export function updateRegion(doc, history, { region, patch }) {
  const before = { ...region };
  history.push({
    label: 'editar região',
    redo() { applyPatch(region, patch); touch(doc); },
    undo() {
      for (const k of Object.keys(region)) delete region[k];
      Object.assign(region, before);
      touch(doc);
    },
  });
}

// --- loop waypoints: the INLINE (non-marker-name) entries of `doc.loop.via[]` ------------------

/** Repositions one inline waypoint — `index` is its real position in the full `via` array
 *  (marker-name strings included), matching `ENTITIES.loopWaypoint`'s own `{index, entry}` ref
 *  shape. A thin `setLoopVia` wrapper (one undo step), not a second copy of its merge logic. */
export function moveLoopWaypoint(doc, history, { index, cx, cz }) {
  const via = doc.loop?.via ?? [];
  if (typeof via[index] === 'string') return; // a marker-name entry moves by moving the marker itself
  setLoopVia(doc, history, { via: via.map((e, i) => (i === index ? { cx, cz } : e)) });
}

/** Removes one inline waypoint by its `via` index — also a thin `setLoopVia` wrapper. */
export function removeLoopWaypoint(doc, history, { index }) {
  const via = doc.loop?.via ?? [];
  setLoopVia(doc, history, { via: via.filter((_, i) => i !== index) });
}

// --- camera presets (`doc.cameras.presets`, a plain object keyed by name) ---------------------

/** Deletes one preset by name — undoable, and clears `doc.cameras.default` if it pointed at the
 *  removed preset (matching `setDefaultCamera`'s own whole-`doc.cameras`-replace pattern). */
export function removeCameraPreset(doc, history, { name }) {
  const before = doc.cameras;
  const presets = { ...doc.cameras.presets };
  delete presets[name];
  const after = { ...doc.cameras, presets, default: doc.cameras.default === name ? null : doc.cameras.default };
  history.push({
    label: 'remover câmera',
    redo() { doc.cameras = after; touch(doc); },
    undo() { doc.cameras = before; touch(doc); },
  });
}

/** Merges `patch` into one preset's own fields (position and `ppu`) — delete-aware
 *  (`applyPatch`), since switching a preset between its two shapes (marker-anchored vs. a bare
 *  `cx,cz`) must drop whichever fields the OTHER shape owns (`marker`+`ppu` vs `cx`+`cz`), not
 *  leave them dangling alongside the new ones. */
export function setCameraPreset(doc, history, { name, patch }) {
  const before = doc.cameras;
  const preset = { ...(doc.cameras.presets[name] ?? {}) };
  applyPatch(preset, patch);
  const after = { ...doc.cameras, presets: { ...doc.cameras.presets, [name]: preset } };
  history.push({
    label: 'editar câmera',
    redo() { doc.cameras = after; touch(doc); },
    undo() { doc.cameras = before; touch(doc); },
  });
}

// --- extras-layer objects (`doc.extras[extraIndex].objects[]`) — no stable id, array position
// within that one layer is the only handle, so every command here is identity-based (the object
// reference itself) scoped to its known `extraIndex`, matching `removeNpc`/`removeLight`'s own
// `.filter((x) => x !== ref)` identity pattern. --------------------------------------------------

export function removeExtraObject(doc, history, { extraIndex, object }) {
  const objects = doc.extras[extraIndex].objects;
  history.push({
    label: 'remover objeto extra',
    redo() { doc.extras[extraIndex].objects = objects.filter((o) => o !== object); touch(doc); },
    undo() { doc.extras[extraIndex].objects.push(object); touch(doc); },
  });
}

/** Merges `patch` into one extras-layer object in place — rot/tint today. */
export function updateExtraObject(doc, history, { object, patch }) {
  const before = { ...object };
  const after = { ...object, ...patch };
  history.push({
    label: 'editar objeto extra',
    redo() { Object.assign(object, after); touch(doc); },
    undo() { Object.assign(object, before); touch(doc); },
  });
}

/** Repositions an existing extras-layer object — new, matching `moveObject`'s own thin
 *  `update*` wrapper shape. `extraIndex` is only threaded through for signature symmetry with
 *  `updateExtraObject`/`removeExtraObject`; the object itself is what actually moves. */
export function moveExtraObject(doc, history, { extraIndex, object, cx, cz }) {
  updateExtraObject(doc, history, { extraIndex, object, patch: { cx, cz } });
}

/** What sits at a cell, topmost first — objects (any layer) before the active layer's grid tile. */
export function stackAt(doc, cx, cz) {
  const out = [];
  for (const obj of doc.objects) if (obj.cx === cx && obj.cz === cz) out.push({ kind: 'object', ...obj });
  for (const [layerNum, grid] of doc.tileLayers) {
    const cell = grid.get(cellKey(cx, cz));
    if (cell) out.push({ kind: 'tile', layer: layerNum, ...cell });
  }
  return out.sort((a, b) => b.layer - a.layer);
}

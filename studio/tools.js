/**
 * tools.js — what each tool in the rail does to the document (`state.js`), expressed as
 * undo/redo commands pushed through `history.push()`. Pure logic, no DOM, no canvas — the
 * canvas (`canvas.js`) only turns pointer events into cell coordinates and calls these.
 */

import { cellKey, touch } from './state.js';

const idx = (doc, cx, cz) => cz * doc.w + cx;
const inside = (doc, cx, cz) => cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h;

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
 * Replaces `doc.encounters.rows` wholesale — the per-map inline encounter table's add/remove/
 * edit-row controls (`bottom.js`'s Jogabilidade tab) all funnel through this one command,
 * keeping the undo log coarse-grained the same way `setLoopVia` already does for `loop.via`
 * rather than adding a separate command per field. `doc.encounters.table` (the shared
 * `TABLES[name]` lookup) is left untouched — a map can carry both, with `rows` taking
 * precedence at read time when present (checked first everywhere this reads the effective
 * table: `bottom.js`'s preview, and eventually the runtime).
 */
export function setEncounterRows(doc, history, { rows }) {
  const before = doc.encounters ? { ...doc.encounters } : null;
  const after = { ...(doc.encounters ?? {}), rows };
  history.push({
    label: 'tabela de encontro (linhas)',
    redo() { doc.encounters = after; touch(doc); },
    undo() { doc.encounters = before; touch(doc); },
  });
}

/**
 * Appends a hand-placed wild-spawn slot at `(cx,cz)` to `doc.wild.slots` — the authored
 * counterpart to `wild.resolved.slots`, which stays whatever `slotsForLoop` last computed and
 * cached (derived, not editable here), exactly parallel to how `loop.via` (authored) and
 * `loop.resolved` (derived cache) already coexist. Creates `doc.wild` if the map had none yet.
 */
export function addWildSlot(doc, history, { cx, cz }) {
  const before = doc.wild;
  const after = { ...(doc.wild ?? {}), slots: [...(doc.wild?.slots ?? []), { cx, cz }] };
  history.push({
    label: 'vaga selvagem',
    redo() { doc.wild = after; touch(doc); },
    undo() { doc.wild = before; touch(doc); },
  });
}

/**
 * Removes one authored wild-spawn slot. Takes the slot object itself (the same reference
 * `doc.wild.slots` holds) rather than an index or a name — a slot has no unique name field the
 * way a marker does, so this mirrors `removeNpc`/`removeLight`'s identity-based match instead
 * of `removeMarker`'s name-keyed one.
 */
export function removeWildSlot(doc, history, slot) {
  const before = doc.wild;
  const after = { ...doc.wild, slots: doc.wild.slots.filter((s) => s !== slot) };
  history.push({
    label: 'remover vaga selvagem',
    redo() { doc.wild = after; touch(doc); },
    undo() { doc.wild = before; touch(doc); },
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

export function removeMarker(doc, history, { name }) {
  const before = doc.markers.find((m) => m.name === name);
  if (!before) return;
  const snapshot = { ...before };
  history.push({
    label: 'remover marcador',
    redo() { doc.markers = doc.markers.filter((m) => m.name !== name); touch(doc); },
    undo() { doc.markers.push(snapshot); touch(doc); },
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

export function removeObject(doc, history, { id }) {
  const obj = doc.objects.find((o) => o.id === id);
  if (!obj) return;
  history.push({
    label: 'remover objeto',
    redo() { doc.objects = doc.objects.filter((o) => o.id !== id); touch(doc); },
    undo() { doc.objects.push(obj); touch(doc); },
  });
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

/**
 * Repositions an existing NPC in place — `addNpc`/`removeNpc` only ever add or remove a whole
 * entry, and until the 3D preview's draggable gizmos (`studio/preview.js`) there was no "move it
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

/** Merges `patch` into `doc.lights[index]` — undoable, unlike the inspector's old direct splice. */
export function updateLight(doc, history, { index, patch }) {
  const before = { ...doc.lights[index] };
  const after = { ...before, ...patch };
  history.push({
    label: 'editar luz',
    redo() { doc.lights[index] = after; touch(doc); },
    undo() { doc.lights[index] = before; touch(doc); },
  });
}

/** Rewrites one placed tile's rotation, in place (grid cell or object). */
export function setCellRotation(doc, history, { layer, cx, cz, rot, objectId = null }) {
  if (objectId != null) {
    const obj = doc.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const before = obj.rot;
    history.push({
      label: 'rotação',
      redo() { obj.rot = rot; touch(doc); },
      undo() { obj.rot = before; touch(doc); },
    });
    return;
  }
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

/** Rewrites one placed tile's multiply tint, in place (grid cell or object). */
export function setCellTint(doc, history, { layer, cx, cz, tint, objectId = null }) {
  if (objectId != null) {
    const obj = doc.objects.find((o) => o.id === objectId);
    if (!obj) return;
    const before = obj.tint;
    history.push({
      label: 'tint',
      redo() { obj.tint = tint; touch(doc); },
      undo() { obj.tint = before; touch(doc); },
    });
    return;
  }
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

/**
 * tools.js — what each tool in the rail does to the document (`state.js`), expressed as
 * undo/redo commands pushed through `history.push()`. Pure logic, no DOM, no canvas — the
 * canvas (`canvas.js`) only turns pointer events into cell coordinates and calls these.
 */

import { cellKey } from './state.js';

const idx = (doc, cx, cz) => cz * doc.w + cx;
const inside = (doc, cx, cz) => cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h;

/** Paints one cell of the active layer with `asset` (a catalog model), grid or object bucket
 *  chosen the same way the exporter chooses it: 1x1 and alone at that cell -> grid. */
export function paintCell(doc, history, { layer, cx, cz, asset, rot = 0, tint = 0xffffff }) {
  if (!inside(doc, cx, cz) || !asset) return;
  const grid = doc.tileLayers.get(layer) ?? new Map();
  const key = cellKey(cx, cz);
  const before = grid.get(key) ?? null;
  const after = { m: asset.name, rot, tint, y: null };
  history.push({
    label: 'pintar tile',
    redo() { doc.tileLayers.set(layer, grid); grid.set(key, after); doc.dirty = true; },
    undo() { if (before) grid.set(key, before); else grid.delete(key); doc.dirty = true; },
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
    redo() { grid.delete(key); doc.dirty = true; },
    undo() { grid.set(key, before); doc.dirty = true; },
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
      doc.dirty = true;
    },
    undo() {
      for (const [key, v] of before) { if (v) grid.set(key, v); else grid.delete(key); }
      doc.dirty = true;
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
      doc.dirty = true;
    },
    undo() {
      for (const [key, v] of before) { if (v) grid.set(key, v); else grid.delete(key); }
      doc.dirty = true;
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
    redo() { doc.collision[i] = kind; doc.dirty = true; },
    undo() { doc.collision[i] = before; doc.dirty = true; },
  });
}

export function adjustHeight(doc, history, { cx, cz, delta }) {
  if (!inside(doc, cx, cz)) return;
  const i = idx(doc, cx, cz);
  const before = doc.height[i];
  const after = Math.round((before + delta) * 20) / 20;
  history.push({
    label: 'altura',
    redo() { doc.height[i] = after; doc.dirty = true; },
    undo() { doc.height[i] = before; doc.dirty = true; },
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
    redo() { doc.tags[i] = after; doc.dirty = true; },
    undo() { doc.tags[i] = before; doc.dirty = true; },
  });
}

export function setSpawn(doc, history, { cx, cz }) {
  const before = { ...doc.spawn };
  history.push({
    label: 'spawn',
    redo() { doc.spawn = { ...doc.spawn, cx, cz }; doc.dirty = true; },
    undo() { doc.spawn = before; doc.dirty = true; },
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
      doc.dirty = true;
    },
    undo() {
      if (before) { const m = doc.markers.find((x) => x.name === name); if (m) { m.cx = before.cx; m.cz = before.cz; } }
      else doc.markers = doc.markers.filter((x) => x.name !== name);
      doc.dirty = true;
    },
  });
}

export function removeMarker(doc, history, { name }) {
  const before = doc.markers.find((m) => m.name === name);
  if (!before) return;
  const snapshot = { ...before };
  history.push({
    label: 'remover marcador',
    redo() { doc.markers = doc.markers.filter((m) => m.name !== name); doc.dirty = true; },
    undo() { doc.markers.push(snapshot); doc.dirty = true; },
  });
}

export function placeObject(doc, history, { m, cx, cz, layer, rot = 0, tint = 0xffffff }) {
  const obj = { id: doc.nextObjectId++, m, cx, cz, layer, rot, tint, y: null };
  history.push({
    label: 'objeto',
    redo() { doc.objects.push(obj); doc.dirty = true; },
    undo() { doc.objects = doc.objects.filter((o) => o.id !== obj.id); doc.dirty = true; },
  });
  return obj;
}

export function removeObject(doc, history, { id }) {
  const obj = doc.objects.find((o) => o.id === id);
  if (!obj) return;
  history.push({
    label: 'remover objeto',
    redo() { doc.objects = doc.objects.filter((o) => o.id !== id); doc.dirty = true; },
    undo() { doc.objects.push(obj); doc.dirty = true; },
  });
}

export function addNpc(doc, history, npc) {
  history.push({
    label: 'npc',
    redo() { doc.npcs.push(npc); doc.dirty = true; },
    undo() { doc.npcs = doc.npcs.filter((n) => n !== npc); doc.dirty = true; },
  });
}

export function removeNpc(doc, history, npc) {
  history.push({
    label: 'remover npc',
    redo() { doc.npcs = doc.npcs.filter((n) => n !== npc); doc.dirty = true; },
    undo() { doc.npcs.push(npc); doc.dirty = true; },
  });
}

export function addLight(doc, history, light) {
  history.push({
    label: 'luz',
    redo() { doc.lights.push(light); doc.dirty = true; },
    undo() { doc.lights = doc.lights.filter((l) => l !== light); doc.dirty = true; },
  });
}

export function removeLight(doc, history, light) {
  history.push({
    label: 'remover luz',
    redo() { doc.lights = doc.lights.filter((l) => l !== light); doc.dirty = true; },
    undo() { doc.lights.push(light); doc.dirty = true; },
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

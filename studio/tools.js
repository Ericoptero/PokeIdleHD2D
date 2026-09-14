/**
 * tools.js — what each tool in the rail does to the document (`state.js`), expressed as
 * undo/redo commands pushed through `history.push()`. Pure logic, no DOM, no canvas — the
 * canvas (`canvas.js`) only turns pointer events into cell coordinates and calls these.
 */

import { cellKey, touch } from './state.js';

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
// mask:Runs<0|1>}`, `mapfile.js`'s header) — mask PAINTING is a later slice's paint tool; this
// slice only lets an already-authored region (none ship yet) be selected/edited/removed. -------

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

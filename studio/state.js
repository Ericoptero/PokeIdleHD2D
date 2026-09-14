/**
 * state.js — the Studio's editable document: a `.map.json` (`@/terrain/mapfile.js`) decoded
 * into flat, dense, random-access arrays, plus an undo/redo command stack.
 *
 * The wire format is palette + run-length encoded for compact storage and diffable git
 * history (`mapfile.js`'s own header); neither property is what an editor wants while a
 * brush is live. `createDocument` decodes once on import; `serializeDocument` re-encodes once
 * on export. Everything in between — painting, undo, the canvas, the inspector — reads and
 * writes plain arrays and a plain object graph.
 *
 * Editing scope (documented, not a limitation of the format): the brush/fill/eraser tools
 * paint the active layer's **grid-eligible** placements — one model per cell, the same
 * bucket `mapfile.js`'s exporter fills automatically on save. A tree, a bridge, a building —
 * anything multi-cell or sharing a cell with something else — lives in `doc.objects[]`,
 * selectable and movable from the canvas but not brush-painted. This mirrors the format's own
 * tile-grid/object split, not an arbitrary restriction.
 */

import { encodeRuns, decodeRuns } from '@/terrain/mapfile.js';

const DEFAULT_TINT = 0xffffff;

function cellKey(cx, cz) { return `${cx},${cz}`; }

/** @param {object} map a parsed `.map.json` @returns {object} an editable document */
export function createDocument(map) {
  const w = map.w;
  const h = map.h;
  const n = w * h;

  const collision = map.grid?.collision ? decodeRuns(map.grid.collision, n) : new Array(n).fill('block');
  const height = map.grid?.height ? decodeRuns(map.grid.height, n) : new Array(n).fill(0);
  const tags = map.grid?.tags ? decodeRuns(map.grid.tags, n).map((t) => (t ? t.slice() : [])) : new Array(n).fill(null).map(() => []);
  const occupied = map.grid?.occupied ? decodeRuns(map.grid.occupied, n) : new Array(n).fill(0);

  // One draft-role layer group per distinct layer number: Map<layerNumber, Map<'cx,cz', {m,rot,tint,y}>>.
  const tileLayers = new Map();
  const objects = [];
  let extras = [];
  let draftTileset = map.tileset;

  for (const layer of map.layers ?? []) {
    if (layer.role === 'extra') {
      extras.push({ tileset: layer.tileset, models: layer.models ?? [], modelIds: layer.modelIds ?? [],
        objects: (layer.objects ?? []).map((o) => ({ ...o, m: layer.models?.[o.m] ?? `#${o.m}` })) });
      continue;
    }
    draftTileset = layer.tileset;
    for (const t of layer.tiles ?? []) {
      const modelAt = decodeRuns(t.model, n);
      const rotAt = t.rot ? decodeRuns(t.rot, n) : null;
      const tintAt = t.tint ? decodeRuns(t.tint, n) : null;
      const yAt = t.y ? decodeRuns(t.y, n) : null;
      const grid = tileLayers.get(t.layer) ?? new Map();
      tileLayers.set(t.layer, grid);
      for (let i = 0; i < n; i++) {
        if (modelAt[i] < 0) continue;
        grid.set(cellKey(i % w, Math.floor(i / w)), {
          m: layer.models?.[modelAt[i]] ?? `#${modelAt[i]}`,
          rot: rotAt ? rotAt[i] : 0,
          tint: tintAt ? tintAt[i] : DEFAULT_TINT,
          y: yAt && yAt[i] != null ? yAt[i] : null,
        });
      }
    }
    for (const o of layer.objects ?? []) {
      objects.push({ id: objects.length, m: layer.models?.[o.m] ?? `#${o.m}`, cx: o.cx, cz: o.cz,
        layer: o.layer ?? 0, rot: o.rot ?? 0, tint: o.tint ?? DEFAULT_TINT, y: o.y ?? null });
    }
  }

  return {
    w, h, tileset: draftTileset,
    id: map.id, name: map.name, kind: map.kind ?? 'hunt', module: map.module ?? null,
    biome: map.biome, seed: map.seed, requiredLevel: map.requiredLevel ?? 0,
    weather: map.weather ?? null, environmentPreset: map.environmentPreset ?? map.biome,
    source: map.source ?? {},
    // `map.tags` (`mapfile.js`) is a top-level, map-wide category list — `'cave'`,
    // `'coastal'` — that `economy/items.js`'s ball bonuses key off since P5. Named `mapTags`
    // here, not `tags`, because that name is already taken by the per-cell tag array
    // (`grid.tags`) three lines below — the two have coexisted in the file format since
    // before this field existed and are unrelated concepts.
    mapTags: map.tags ?? [],
    collision, height, tags, occupied,
    tileLayers, objects, nextObjectId: objects.length, extras,
    regions: map.regions ?? [],
    spawn: map.spawn ? { ...map.spawn } : { cx: w >> 1, cz: h >> 1, dir: 0 },
    markers: (map.markers ?? []).map((m) => ({ ...m })),
    loop: map.loop ? JSON.parse(JSON.stringify(map.loop)) : null,
    wild: map.wild ? JSON.parse(JSON.stringify(map.wild)) : null,
    encounters: map.encounters ? { ...map.encounters } : null,
    npcs: (map.npcs ?? []).map((x) => ({ ...x })),
    links: (map.links ?? []).map((x) => ({ ...x })),
    lights: (map.lights ?? []).map((x) => ({ ...x })),
    cameras: map.cameras ? JSON.parse(JSON.stringify(map.cameras)) : { default: null, presets: {} },
    formation: map.formation ? { ...map.formation } : null,
    dirty: false,
  };
}

/** @param {object} doc @returns {object} a `.map.json`-shaped, RLE-encoded map file */
export function serializeDocument(doc) {
  const n = doc.w * doc.h;
  const layers = [];

  // draft-role layer, grid tiles per layer number
  const modelNames = [];
  const modelIndex = new Map();
  const paletteFor = (name) => {
    let idx = modelIndex.get(name);
    if (idx === undefined) { idx = modelNames.length; modelNames.push(name); modelIndex.set(name, idx); }
    return idx;
  };
  const tiles = [];
  for (const [layerNum, grid] of [...doc.tileLayers.entries()].sort((a, b) => a[0] - b[0])) {
    const modelAt = new Array(n).fill(-1);
    const rotAt = new Array(n).fill(0);
    const tintAt = new Array(n).fill(DEFAULT_TINT);
    const yAt = new Array(n).fill(null);
    let anyRot = false; let anyTint = false; let anyY = false;
    for (const [key, cell] of grid) {
      const [cx, cz] = key.split(',').map(Number);
      const i = cz * doc.w + cx;
      modelAt[i] = paletteFor(cell.m);
      if (cell.rot) { rotAt[i] = cell.rot; anyRot = true; }
      if (cell.tint !== DEFAULT_TINT) { tintAt[i] = cell.tint; anyTint = true; }
      if (cell.y != null) { yAt[i] = cell.y; anyY = true; }
    }
    const entry = { layer: layerNum, model: encodeRuns(modelAt) };
    if (anyRot) entry.rot = encodeRuns(rotAt);
    if (anyTint) entry.tint = encodeRuns(tintAt);
    if (anyY) entry.y = encodeRuns(yAt);
    tiles.push(entry);
  }
  const objects = doc.objects.map((o) => {
    const obj = { m: paletteFor(o.m), cx: o.cx, cz: o.cz, layer: o.layer };
    if (o.rot) obj.rot = o.rot;
    if (o.tint !== DEFAULT_TINT) obj.tint = o.tint;
    if (o.y != null) obj.y = o.y;
    return obj;
  });
  layers.push({ tileset: doc.tileset, role: 'draft', models: modelNames, modelIds: [], tiles, objects });

  for (const ex of doc.extras) {
    const names = [];
    const idx = new Map();
    const pf = (name) => { let i = idx.get(name); if (i === undefined) { i = names.length; names.push(name); idx.set(name, i); } return i; };
    layers.push({
      tileset: ex.tileset, role: 'extra', models: names, modelIds: [],
      objects: ex.objects.map((o) => ({ m: pf(o.m), cx: o.cx, cz: o.cz, layer: o.layer ?? 0,
        ...(o.rot ? { rot: o.rot } : {}), ...(o.tint !== undefined && o.tint !== DEFAULT_TINT ? { tint: o.tint } : {}),
        ...(o.y !== undefined ? { y: o.y } : {}) })),
    });
  }

  return {
    format: 'pokeidle.map', version: 1,
    id: doc.id, name: doc.name, kind: doc.kind, module: doc.module,
    w: doc.w, h: doc.h, tileset: doc.tileset, biome: doc.biome, seed: doc.seed,
    requiredLevel: doc.requiredLevel, weather: doc.weather, environmentPreset: doc.environmentPreset,
    source: doc.source,
    tags: doc.mapTags ?? [],
    grid: {
      collision: encodeRuns(doc.collision),
      height: encodeRuns(doc.height.map((v) => Math.round(v * 1000) / 1000)),
      tags: encodeRuns(doc.tags),
      occupied: encodeRuns(doc.occupied),
    },
    layers,
    regions: doc.regions,
    spawn: { ...doc.spawn },
    markers: doc.markers.map((m) => ({ ...m })),
    loop: doc.loop, wild: doc.wild, encounters: doc.encounters,
    npcs: doc.npcs.map((x) => ({ ...x })), links: doc.links.map((x) => ({ ...x })),
    lights: doc.lights.map((x) => ({ ...x })), cameras: doc.cameras, formation: doc.formation,
  };
}

/** A blank document for "Novo mapa" — a flat, entirely walkable field. */
export function createBlankDocument({ id, name, w = 32, h = 32, tileset = 'bw2-adastra', biome = 'meadow', kind = 'hunt', groundModel = null }) {
  const n = w * h;
  return {
    w, h, tileset, id, name, kind, module: kind === 'hunt' ? 'hunts' : kind === 'city' ? 'city' : null,
    biome, seed: 1337, requiredLevel: 0, weather: null, environmentPreset: biome,
    source: { builder: 'studio (novo mapa)', snapshotAt: new Date().toISOString() },
    mapTags: [],
    collision: new Array(n).fill('walk'), height: new Array(n).fill(0),
    tags: new Array(n).fill(null).map(() => []), occupied: new Array(n).fill(0),
    tileLayers: groundModel
      ? new Map([[0, new Map(Array.from({ length: n }, (_, i) =>
        [cellKey(i % w, Math.floor(i / w)), { m: groundModel, rot: 0, tint: DEFAULT_TINT, y: null }]))]])
      : new Map(),
    objects: [], nextObjectId: 0, extras: [],
    regions: [],
    spawn: { cx: w >> 1, cz: h >> 1, dir: 0 },
    markers: [], loop: null, wild: null, encounters: null, npcs: [], links: [], lights: [],
    cameras: { default: null, presets: {} }, formation: null, dirty: true,
  };
}

// --- command stack ---------------------------------------------------------------------------

export function createHistory() {
  const undoStack = [];
  const redoStack = [];
  return {
    /** @param {{label:string, undo:() => void, redo:() => void}} cmd applied immediately */
    push(cmd) {
      cmd.redo();
      cmd.at = Date.now();
      undoStack.push(cmd);
      redoStack.length = 0;
    },
    undo() { const cmd = undoStack.pop(); if (!cmd) return false; cmd.undo(); redoStack.push(cmd); return true; },
    redo() { const cmd = redoStack.pop(); if (!cmd) return false; cmd.redo(); undoStack.push(cmd); return true; },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    clear() { undoStack.length = 0; redoStack.length = 0; },
    size: () => ({ undo: undoStack.length, redo: redoStack.length }),
    /** The log the bottom panel's Histórico tab renders — most recent first. */
    entries: () => ({
      undo: undoStack.map((c) => ({ label: c.label, at: c.at })).reverse(),
      redo: redoStack.map((c) => ({ label: c.label, at: c.at })).reverse(),
    }),
  };
}

/** Bumps `doc`'s revision counter and dirty flag — the one thing every mutating call site
 *  (`tools.js` commands, the inspector's direct field writes) calls instead of setting
 *  `doc.dirty = true` by hand, so `validation.js`'s `runValidation` can memoize correctly. */
export function touch(doc) {
  doc._rev = (doc._rev ?? 0) + 1;
  doc.dirty = true;
}

export { cellKey };

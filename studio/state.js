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
import { stitchLoop } from '@/hunts/compose.js';
import { peekCatalog } from './catalog.js';

const DEFAULT_TINT = 0xffffff;
const COLLISION_PASSABLE = new Set(['walk', 'stairs', 'shallow', 'door']);

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
      extras.push({ tileset: layer.tileset, models: layer.models ?? [],
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
    id: map.id, name: map.name, kind: map.kind ?? 'hunt',
    seed: map.seed, requiredLevel: map.requiredLevel ?? 0,
    weather: map.weather ?? null, environmentPreset: map.environmentPreset ?? 'meadow',
    // The map's own yield-multiplier profile (`idle/accrual.js` reads this off
    // `terrain.handle().economy` — no more fixed biome enum to pick one from).
    economy: map.economy ? JSON.parse(JSON.stringify(map.economy)) : { money: 1, exp: 1, research: 1, encounters: 1, favours: {} },
    // `map.tags` (`mapfile.js`) is a top-level, map-wide category list — `'cave'`,
    // `'coastal'` — that `economy/items.js`'s ball bonuses key off. Named `mapTags` here, not
    // `tags`, because that name is already taken by the per-cell tag array (`grid.tags`)
    // three lines below — the two are unrelated concepts.
    mapTags: map.tags ?? [],
    collision, height, tags, occupied,
    tileLayers, objects, nextObjectId: objects.length, extras,
    // Autotile masks the paint tool (Slice 9b, not this one) will populate. `id` is new in v3
    // (`mapfile.js`'s header) — minted here for any region a pre-v3 file might still carry
    // without one, the same way a light without one gets minted just below.
    regions: (map.regions ?? []).map((r, i) => (r.id ? { ...r } : { ...r, id: `region-${i}-${Date.now().toString(36)}` })),
    spawn: map.spawn ? { ...map.spawn } : { cx: w >> 1, cz: h >> 1, dir: 0 },
    markers: (map.markers ?? []).map((m) => ({ ...m })),
    loop: map.loop ? JSON.parse(JSON.stringify(map.loop)) : null,
    // Wild spawn points — each one owns its own respawn timer and its own weighted list of
    // species (`{id, cx, cz, dir, respawnSeconds, species:[{name, chance, when?, bump?}]}`).
    spawnPoints: (map.spawnPoints ?? []).map((p) => ({ ...p, species: (p.species ?? []).map((s) => ({ ...s })) })),
    npcs: (map.npcs ?? []).map((x) => ({ ...x })),
    // `{id, kind:'door'|'edge'|'stairs', from:{cx,cz}, to:{map, marker?, cx?, cz?, dir?}, label?}`
    // — see `mapfile.js`'s header. Plain data the document model round-trips untouched; nothing
    // here resolves a link at edit time (that is a later slice's canvas/inspector work).
    links: (map.links ?? []).map((x) => ({ ...x })),
    // `id` is new in v3, minted here on the same pattern as `regions[]` above, for any light a
    // pre-v3 file still carries without one.
    lights: (map.lights ?? []).map((x, i) => (x.id ? { ...x } : { ...x, id: `light-${i}-${Date.now().toString(36)}` })),
    cameras: map.cameras ? JSON.parse(JSON.stringify(map.cameras)) : { default: null, presets: {} },
    formation: map.formation ? { ...map.formation } : null,
    dirty: false,
  };
}

/** Rotated footprint extents — mirrors `src/tiles/instanced.js`'s exported `footprint()`
 *  exactly. Inlined rather than imported so this document model does not have to pull in
 *  `@/tiles` (and, through it, three.js) just for one pure arithmetic swap. */
function footprintOf(w, h, rot) {
  return (rot & 1) ? { w: h, h: w } : { w, h };
}

/**
 * `grid.occupied` looks, from `doc.objects[]` alone, like something fully re-derivable:
 * `MapDraft.place()` only ever marks a cell occupied for a placement whose ROTATED footprint
 * is wider than 1x1 (`src/terrain/draft.js`), so in principle the occupied set is a pure
 * function of each object's real model dimensions. It is measurably NOT, in this codebase's
 * actual shipped data: `demo-city.map.json`'s occupied grid carries ~267 cells that back
 * building-plot reservations with no placement behind them at all — stamped directly onto
 * `draft.occupied` by the pre-Studio hand-written city builder (`git show
 * 9876a49~1:src/city/map.js`, now retired) to keep a lot clear of scatter even where the
 * building itself renders from a separate extras layer — and `hunt-cave`/`hunt-forest`/
 * `hunt-meadow` show the opposite drift: recomputing from the CURRENT tileset catalog claims
 * hundreds more cells than they actually shipped with, because prop dimensions have moved
 * since these files were frozen. A "recompute from objects[] and overwrite" implementation
 * would therefore silently corrupt real, currently-shipped maps' walkability grids on the very
 * next Studio save — exactly the "broken map load" outcome this slice's own plan calls out as
 * the highest risk to avoid. (Verified by hand against all six shipped files before writing
 * this — see this slice's own final report for the numbers.)
 *
 * So `doc.occupied` is still the array actually written; this only VALIDATES it. Whenever the
 * draft tileset's catalog happens to already be loaded (`peekCatalog`, `./catalog.js` —
 * resolved only once the canvas/inspector have asked for it; never true inside a headless
 * decode-then-encode round trip such as `tools/mapstudio/studio-roundtrip.js`, which never
 * touches the canvas), this warns — once, summarized, never per-cell-spammy — when a
 * multi-cell object's footprint is NOT a subset of what is already marked, since that specific
 * direction of disagreement (a claim the file is missing, not an extra one it carries) is the
 * one a real bug looks like: a multi-cell placement added without going through the brush's
 * own stamping.
 */
function warnIfOccupiedIncomplete(doc) {
  const catalog = peekCatalog(doc.tileset);
  if (!catalog) return;
  const missing = [];
  for (const o of doc.objects) {
    const model = catalog.byName.get(o.m);
    if (!model) continue; // an unresolved name is `model-unresolved`'s (validate.js) problem, not this one's
    const { w, h } = footprintOf(model.w ?? 1, model.h ?? 1, o.rot ?? 0);
    if (w <= 1 && h <= 1) continue;
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = o.cx + dx;
        const cz = o.cz + dz;
        if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) continue;
        if (!doc.occupied[cz * doc.w + cx]) missing.push(`${cx},${cz}`);
      }
    }
  }
  if (missing.length) {
    console.warn(`state.js: grid.occupied is missing ${missing.length} cell(s) implied by `
      + `multi-cell object footprints (e.g. ${missing.slice(0, 5).join(' ')}) — a placement's `
      + "footprint may not have gone through the brush's own stamping");
  }
}

/** Mirrors `MapDraft.passable` (`src/terrain/draft.js`) and `validate.js`'s own `passableOf`,
 *  off `doc`'s plain decoded arrays — the minimal surface `stitchLoop` (`@/hunts/compose.js`)
 *  actually reads off a `MapDraft` (`.w`, `.h`, `.passable`, `.tagsAt` — confirmed by reading
 *  every `draft.` reference in `compose.js`), so a full `MapDraft` is not needed just to
 *  re-stitch a loop from plain arrays. */
function loopAdapter(doc) {
  const inside = (cx, cz) => cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h;
  const tagsAt = (cx, cz) => (inside(cx, cz) ? (doc.tags[cz * doc.w + cx] ?? []) : []);
  return {
    w: doc.w,
    h: doc.h,
    tagsAt,
    passable(cx, cz, fromDir) {
      if (!inside(cx, cz)) return false;
      const kind = doc.collision[cz * doc.w + cx];
      if (kind === 'ledge') {
        const dir = tagsAt(cx, cz).find((t) => t.startsWith('ledge:'));
        return dir ? Number(dir.slice(6)) === fromDir : false;
      }
      return COLLISION_PASSABLE.has(kind);
    },
  };
}

/** Resolves one `loop.via` entry to a concrete cell — a marker name looked up in `doc.markers`
 *  (`null` if the marker was deleted out from under it), or an inline `{cx,cz}` waypoint used
 *  as-is. Mirrors `studio/canvas.js`'s own `viaPoint` exactly (that file is out of this slice's
 *  scope to import from — the `loop` tool it belongs to is a later slice's canvas work — so the
 *  same small resolution rule is duplicated here rather than reached across the boundary). */
function viaPoint(doc, entry) {
  if (typeof entry === 'string') {
    const m = doc.markers.find((x) => x.name === entry);
    return m ? { cx: m.cx, cz: m.cz } : null;
  }
  return entry;
}

/**
 * `loop.resolved` used to be decoded from the input file and carried straight through to the
 * output, so an editor that moved a marker or repainted terrain under an authored loop shipped
 * a stale circuit — exactly the drift `validate.js`'s `loop-stale` check exists to catch. As of
 * v3 this re-stitches on every serialize instead: `stitchLoop` (`@/hunts/compose.js`, the pure,
 * generator-free half of `src/hunts/index.js` — see that file's own module-boundary note on why
 * only `compose.js` is imported here, never `hunts/index.js` itself) re-runs `doc.loop.via`
 * against the document's CURRENT terrain (`loopAdapter`, above) every time, so a saved file's
 * `resolved` always matches what the map actually stitches to right now — `null` when it no
 * longer closes, exactly like a fresh Studio map that has never been stitched.
 *
 * Only runs when the map authors its own `via` list; a map with none (or one already carrying
 * a `findLoop`-produced `resolved` with no `via` at all — `hunts/index.js`'s own fallback) has
 * nothing here to regenerate and round-trips its `loop` field unchanged.
 */
function freshLoop(doc) {
  const via = doc.loop?.via;
  if (!Array.isArray(via) || !via.length) return doc.loop;
  const points = [];
  for (const entry of via) {
    const p = viaPoint(doc, entry);
    if (!p) return { ...doc.loop, resolved: null }; // an authored marker vanished — `loop-stale` flags this for a human
    points.push(p);
  }
  const resolved = stitchLoop(loopAdapter(doc), points, {
    straightLead: doc.loop.straightLead, preferTags: doc.loop.preferTags, margin: doc.loop.margin,
  });
  return { ...doc.loop, resolved };
}

/** @param {object} doc @returns {object} a `.map.json`-shaped, RLE-encoded map file */
export function serializeDocument(doc) {
  warnIfOccupiedIncomplete(doc);
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
  layers.push({ tileset: doc.tileset, role: 'draft', models: modelNames, tiles, objects });

  for (const ex of doc.extras) {
    const names = [];
    const idx = new Map();
    const pf = (name) => { let i = idx.get(name); if (i === undefined) { i = names.length; names.push(name); idx.set(name, i); } return i; };
    layers.push({
      tileset: ex.tileset, role: 'extra', models: names,
      objects: ex.objects.map((o) => ({ m: pf(o.m), cx: o.cx, cz: o.cz, layer: o.layer ?? 0,
        ...(o.rot ? { rot: o.rot } : {}), ...(o.tint !== undefined && o.tint !== DEFAULT_TINT ? { tint: o.tint } : {}),
        ...(o.y !== undefined ? { y: o.y } : {}) })),
    });
  }

  return {
    format: 'pokeidle.map', version: 3,
    id: doc.id, name: doc.name, kind: doc.kind,
    w: doc.w, h: doc.h, tileset: doc.tileset, seed: doc.seed,
    requiredLevel: doc.requiredLevel, weather: doc.weather, environmentPreset: doc.environmentPreset,
    economy: doc.economy,
    tags: doc.mapTags ?? [],
    grid: {
      collision: encodeRuns(doc.collision),
      height: encodeRuns(doc.height.map((v) => Math.round(v * 1000) / 1000)),
      tags: encodeRuns(doc.tags),
      occupied: encodeRuns(doc.occupied),
    },
    layers,
    regions: doc.regions.map((r) => ({ ...r })),
    spawn: { ...doc.spawn },
    markers: doc.markers.map((m) => ({ ...m })),
    loop: freshLoop(doc),
    spawnPoints: doc.spawnPoints.map((p) => ({ ...p, species: (p.species ?? []).map((s) => ({ ...s })) })),
    npcs: doc.npcs.map((x) => ({ ...x })), links: doc.links.map((x) => ({ ...x })),
    lights: doc.lights.map((x) => ({ ...x })), cameras: doc.cameras, formation: doc.formation,
  };
}

/** A blank document for "Novo mapa" — a flat, entirely walkable field. */
export function createBlankDocument({ id, name, w = 32, h = 32, tileset = 'bw2-adastra', environmentPreset = 'meadow', kind = 'hunt', groundModel = null }) {
  const n = w * h;
  return {
    w, h, tileset, id, name, kind,
    seed: 1337, requiredLevel: 0, weather: null, environmentPreset,
    economy: { money: 1, exp: 1, research: 1, encounters: 1, favours: {} },
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
    markers: [], loop: null, spawnPoints: [], npcs: [], links: [], lights: [],
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

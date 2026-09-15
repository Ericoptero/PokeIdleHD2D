/**
 * session.js — the Map Studio's DOM-free editing state: which tool is active, the brush
 * settings, what is selected, which layers are hidden/locked, which overlays are toggled on,
 * the hover cell, the edit counter, and the single-cell tool dispatch (`applyToolAt`) that every
 * input surface funnels through so a click behaves identically no matter which one it came from
 * — the 3D pane's pick routing in `main.js` today, and, before Slice 7 deleted it, the 2D
 * canvas's own pointer handlers too, which is exactly why this file has no DOM in it despite
 * having grown up alongside one for most of its life. `subscribe`/`notify` is the one pub-sub
 * every panel and every renderer hangs off of.
 *
 * See `state.js`'s own header for why the *document* has no DOM in it; this file makes the same
 * argument one layer up. Editing STATE (as opposed to the document itself) has no more reason to
 * know about a `<canvas>`, a pointer event, or pan/zoom than the document does — a 3D viewport
 * (`viewport/`) is one DOM-bound renderer of this state, and does not own it.
 */

import {
  stackAt, paintCell, eraseCell, fillRegion, setCollision,
  setSpawn, placeObject, addNpc, addLight, addSpawnPoint, setLoopVia,
} from './tools.js';
import { openAddNpcDialog, openAddLightDialog } from './dialogs.js';
import { ENTITIES, regionContains } from './entities.js';
import { peekCatalog } from './catalog.js';

const COLLISION_PASSABLE = new Set(['walk', 'stairs', 'shallow', 'door']);
const DIR_DX = [0, -1, 0, 1];
const DIR_DZ = [1, 0, -1, 0];

function passableAt(doc, cx, cz, fromDir) {
  if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) return false;
  const kind = doc.collision[cz * doc.w + cx];
  if (kind === 'ledge') {
    const dir = doc.tags[cz * doc.w + cx].find((t) => t.startsWith('ledge:'));
    return dir ? Number(dir.slice(6)) === fromDir : false;
  }
  return COLLISION_PASSABLE.has(kind);
}

/** Flood-fills 4-connected reachability from `start` over passable cells — `getReachStats()`'s
 *  unreachable count and `viewport/overlay.js`'s own `reach` overlay share this one walk (the
 *  latter imports it back for its per-cell tinting) rather than keeping a second, drifting copy
 *  of the BFS. */
export function reachableFrom(doc, start) {
  const seen = new Uint8Array(doc.w * doc.h);
  if (!start || start.cx < 0 || start.cz < 0 || start.cx >= doc.w || start.cz >= doc.h) return seen;
  seen[start.cz * doc.w + start.cx] = 1;
  const queue = [[start.cx, start.cz]];
  while (queue.length) {
    const [cx, cz] = queue.shift();
    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DIR_DX[dir]; const nz = cz + DIR_DZ[dir];
      if (nx < 0 || nz < 0 || nx >= doc.w || nz >= doc.h) continue;
      const ni = nz * doc.w + nx;
      if (seen[ni] || !passableAt(doc, nx, nz, dir)) continue;
      seen[ni] = 1;
      queue.push([nx, nz]);
    }
  }
  return seen;
}

/** Tools `applyToolAt` refuses to run on a locked layer — every painting/placement tool.
 *  `select` and the read-only tools stay usable so a locked layer can still be inspected. */
export const LOCKED_TOOLS = new Set(['pencil', 'eraser', 'fill', 'rect', 'object']);

/** Tools that keep acting on every dragged cell while the pointer stays down, read by `main.js`'s
 *  3D pointer routing (and, before Slice 7 deleted it, the 2D canvas's own pointerdown
 *  drag-detection too — one Set, imported by both, instead of two hand-kept-in-sync copies).
 *  Everything else that paints (fill/spawn/npc/light/object) fires once per pointerdown. */
export const CONTINUOUS_PAINT_TOOLS = new Set(['pencil', 'eraser', 'coll']);

/** A light dot is hit-tested in cell space at ~half a cell radius — close enough for a click. */
function lightNear(doc, cx, cz) {
  let best = -1; let bestD = 1.2;
  doc.lights.forEach((l, i) => {
    const d = Math.hypot(l.x - (cx + 0.5), l.z - (cz + 0.5));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** A spawn point is on a cell, not a free-floating point — an exact-cell hit is enough. */
function spawnPointNear(doc, cx, cz) {
  return doc.spawnPoints.findIndex((p) => p.cx === cx && p.cz === cz);
}

export function makeSession({ history }) {
  let doc = null;
  let tool = 'select';
  let activeLayer = 0;
  // `y` (Slice: per-placement height) — `null` follows the cell's own terrain height
  // (`doc.height`, unchanged), a number pins the painted tile to that exact world Y regardless
  // of terrain — how two tiles land in the same column at different heights (paint one layer at
  // `y: null`, a second layer at `y: 5`). Read by `paintCell`/`paintRect`/`fillRegion`
  // (`tools.js`) at their `session.js` call sites below.
  const brush = { rot: 0, tint: 0xffffff, collision: 'walk', claimFootprint: false, y: null };
  let selectedAsset = null; // { name, tileset, w, h }
  // `{cell, kind, ref}` — `cell` keeps meaning what it always meant (drives `tileCard`/
  // `cellCard`, set alongside `kind`/`ref` for every cell-anchored entity so the cell inspector
  // still shows next to the entity's own card). `kind` is one of `ENTITIES`'s keys (`entities.
  // js`), or `null` for a bare cell with no entity — the ordinary `select`-tool click-on-empty-
  // ground case. `ref` is that kind's own reference shape (an array-element object for most
  // kinds, a small wrapper for `extraObject`/`loopWaypoint` — see `entities.js`'s header).
  //
  // Replaces the old fixed-field shape (`objectId`/`markerName`/`lightIndex`/`spawnPointIndex`)
  // — a fixed field per kind is exactly what made adding a 6th selectable kind "out of scope"
  // before, and an index (`lightIndex`/`spawnPointIndex`) drifts under undo/redo of any OTHER
  // add/remove touching that same array. A single `{kind, ref}` pair can only hold ONE entity at
  // a time (the old shape could set `objectId` AND `lightIndex` AND `spawnPointIndex`
  // independently on the same click) — `applyToolAt`'s `'select'` case below picks one by
  // priority when more than one entity occupies the clicked cell.
  let selection = { cell: null, kind: null, ref: null };
  // `boxselect`'s own committed rectangle (Slice 9a) — `{x0,z0,x1,z1}`, always normalized
  // (`x0<=x1`, `z0<=z1`) on write so every reader (the overlay's outline, `main.js`'s Ctrl+C/X/
  // V handlers, `copyRect`/`pasteClip`/`clearRect` themselves) can trust the corners without
  // re-normalizing a second time. Lives independently of `tool`/`selection` above on purpose —
  // picking `boxselect`, dragging a rect, then switching to `select` to inspect one cell inside
  // it (and switching back) must not lose the rect, so nothing here ever clears it on a tool
  // change; only a fresh document (`setDoc` below) does.
  let rectSelection = null;
  // The copy/cut buffer `copyRect` fills and `pasteClip` reads (`tools.js`) — a plain
  // `{w,h,cells,objects}` snapshot, never cleared by `setDoc`: a copy made on one map is still
  // meaningful to paste into another (nothing here is map-id-scoped).
  let clipboard = null;
  let editCount = 0;
  const hiddenLayers = new Set();
  const lockedLayers = new Set();
  const overlays = { grid: true, textures: true, collision: false, height: false, tags: false,
    footprints: true, markers: true, cameras: false, loop: true, encounters: true, lights: true, reach: false };
  let hoverCell = null;
  const listeners = new Set();

  function notify() { for (const fn of listeners) fn(); }

  /** True with no active box selection; inside it otherwise (see the public `canEditCell` this
   *  backs, above, for the multi-cell commands that need the raw rect instead). */
  function canEditCell(cx, cz) {
    if (!rectSelection) return true;
    return cx >= rectSelection.x0 && cx <= rectSelection.x1 && cz >= rectSelection.z0 && cz <= rectSelection.z1;
  }

  /** Single-cell tools an active box selection actually bounds — placement/marker/light/NPC
   *  tools, `select` and `eyedrop` are unaffected: a selection narrows where GROUND gets
   *  painted, it does not forbid standing an NPC or a light outside it. */
  const SELECTION_BOUND_TOOLS = new Set(['pencil', 'eraser', 'fill', 'coll', 'object']);

  function applyToolAt(cx, cz, kind) {
    if (kind === 'down') selection.cell = { cx, cz };
    if (LOCKED_TOOLS.has(tool) && lockedLayers.has(activeLayer)) {
      selection.cell = { cx, cz }; selection.kind = null; selection.ref = null; notify(); return;
    }
    if (SELECTION_BOUND_TOOLS.has(tool) && !canEditCell(cx, cz)) {
      selection.cell = { cx, cz }; selection.kind = null; selection.ref = null; notify(); return;
    }
    // Every tool but `select` starts this click with no entity selected — `select`'s own case
    // (below) computes `kind`/`ref` fresh, and `object`'s case re-sets them to the newly placed
    // object right after. Every other paint/placement tool leaves them null: a stale `kind`/
    // `ref` surviving a paint stroke on a DIFFERENT cell was already possible with the old
    // per-kind index fields (nothing but a fresh `select` click ever cleared `objectId`/
    // `lightIndex`/`spawnPointIndex`) — harmless in practice, but not worth preserving now that
    // a single `{kind,ref}` pair is the one thing the inspector trusts unconditionally.
    if (tool !== 'select') { selection.kind = null; selection.ref = null; }
    switch (tool) {
      case 'select': {
        selection.cell = { cx, cz };
        // Try every `ENTITIES` kind's own hit-test against this cell, keeping the highest-
        // `pickPriority` match — only one entity can occupy `{kind,ref}` at a time (unlike the
        // old `objectId`/`lightIndex`/`spawnPointIndex` fields, which could all be set
        // independently on the very same click). Priority, low to high: object < npc < link <
        // region < loopWaypoint < cameraPreset < spawnPoint < light. The three kinds that
        // already existed keep their relative order (object < spawnPoint < light) — a light
        // sitting exactly on a painted object's cell already rendered its own selection ring
        // last/on top in the old 2D canvas's draw order, before Slice 7 deleted it, so light
        // keeps winning here too. The five brand-new per-cell checks (npc/link/region/
        // loopWaypoint/cameraPreset) have no such precedent, so they are simply slotted in
        // between object and spawnPoint. `marker` and `spawn` are NOT hit-tested here, same as
        // before this slice — neither ever was: a marker/spawn is only selectable via its own
        // 3D gizmo or the bottom panel's Objetos/Jogabilidade rows.
        let kind = null;
        let ref = null;
        let best = -1;
        const take = (k, r) => {
          if (r == null) return;
          const p = ENTITIES[k].pickPriority;
          if (p > best) { kind = k; ref = r; best = p; }
        };
        const objHit = stackAt(doc, cx, cz).find((s) => s.kind === 'object');
        take('object', objHit ? doc.objects.find((o) => o.id === objHit.id) : null);
        take('npc', ENTITIES.npc.list(doc).find((n) => n.cx === cx && n.cz === cz));
        take('link', ENTITIES.link.list(doc).find((l) => l.from?.cx === cx && l.from?.cz === cz));
        take('region', ENTITIES.region.list(doc).find((r) => regionContains(doc, r, cx, cz)));
        take('loopWaypoint', ENTITIES.loopWaypoint.list(doc).find((w) => w.entry.cx === cx && w.entry.cz === cz));
        take('cameraPreset', ENTITIES.cameraPreset.list(doc).find((p) => {
          const at = ENTITIES.cameraPreset.positionOf(doc, p);
          return at && at.cx === cx && at.cz === cz;
        }));
        const spi = spawnPointNear(doc, cx, cz);
        take('spawnPoint', spi < 0 ? null : doc.spawnPoints[spi]);
        const li = overlays.lights ? lightNear(doc, cx, cz) : -1;
        take('light', li < 0 ? null : doc.lights[li]);
        selection.kind = kind;
        selection.ref = ref;
        break;
      }
      case 'pencil':
        if (selectedAsset) {
          paintCell(doc, history, { layer: activeLayer, cx, cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint,
            y: brush.y, claimFootprint: brush.claimFootprint });
          editCount++;
        }
        break;
      case 'eraser':
        eraseCell(doc, history, { layer: activeLayer, cx, cz });
        editCount++;
        break;
      case 'fill':
        if (selectedAsset) { fillRegion(doc, history, { layer: activeLayer, cx, cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint, y: brush.y, clip: rectSelection }); editCount++; }
        break;
      case 'coll':
        setCollision(doc, history, { cx, cz, kind: brush.collision });
        editCount++;
        break;
      case 'spawn':
        setSpawn(doc, history, { cx, cz });
        editCount++;
        break;
      case 'npc':
        openAddNpcDialog({ cx, cz, onCreate: (npc) => { addNpc(doc, history, npc); editCount++; notify(); } });
        break;
      case 'light':
        openAddLightDialog({ cx, cz, onCreate: (light) => { addLight(doc, history, light); editCount++; notify(); } });
        break;
      case 'wildslot':
        addSpawnPoint(doc, history, { cx, cz });
        editCount++;
        break;
      case 'loop': {
        // Always appends a fresh anonymous waypoint at the clicked cell. Repositioning an
        // existing inline one goes through its own inspector card (`entities.js`'s
        // `loopWaypoint` kind) instead of a click-and-drag here — the deleted 2D canvas used to
        // intercept that case earlier, in its own raw `pointerdown` handler, before it ever
        // reached this dispatch; no 3D-pane equivalent exists yet (`kinds.js`'s own note on the
        // `loop` tool has the rest of this story).
        const via = doc.loop?.via ?? [];
        setLoopVia(doc, history, { via: [...via, { cx, cz }] });
        editCount++;
        break;
      }
      case 'object':
        if (selectedAsset) {
          const obj = placeObject(doc, history, { m: selectedAsset.name, cx, cz, layer: activeLayer, rot: brush.rot, tint: brush.tint });
          selection.kind = 'object'; selection.ref = obj;
          editCount++;
        }
        break;
      // Picks the TOPMOST placement at the cell — every layer's grid tile, not just the active
      // one, plus any object — via `stackAt` (`tools.js`, already sorted highest layer first),
      // the same source `select`'s own object hit-test above reads. `selectedAsset` needs the
      // full shape `library.js`'s own `select(m)` builds (`{name, tileset, w, h, collision}`,
      // not just `{name, tileset}`) so a picked model paints back with its real footprint/
      // collision rather than silently defaulting to 1×1 walkable — `peekCatalog` is the
      // already-loaded catalog for `doc.tileset` (`library.js` loads it on document open; a miss
      // here — a picked model whose catalog has not been fetched yet — falls back to the bare
      // name/tileset pair, same as before this fix).
      case 'eyedrop': {
        const top = stackAt(doc, cx, cz)[0];
        if (top) {
          const model = peekCatalog(doc.tileset)?.byName?.get(top.m);
          selectedAsset = model
            ? { name: top.m, tileset: doc.tileset, w: model.w ?? 1, h: model.h ?? 1, collision: model.collision }
            : { name: top.m, tileset: doc.tileset };
        }
        break;
      }
      default: break;
    }
    selection.cell = { cx, cz };
    notify();
  }

  return {
    setDoc(d) {
      doc = d;
      selection = { cell: null, kind: null, ref: null };
      rectSelection = null; // a rect selected on the OLD map's grid means nothing on a new one
      editCount = 0;
      hiddenLayers.clear();
      lockedLayers.clear();
      notify();
    },
    getDoc: () => doc,
    setTool(t) {
      tool = t;
      // Broadcasts the change — previously silent, since nothing depended on it before this
      // slice (`panels.js`'s `toolRail` manages its own button highlight directly, without going
      // through `session.subscribe`). The status bar's "ferramenta: X" label (`panels.js`'s
      // `makeStatusBar`) was stale until the next unrelated notify before now.
      notify();
    },
    getTool: () => tool,
    // Notifies (matching `setLayerVisible`/`setLayerLocked` right below) — the inspector's own
    // tile card reads `session.getActiveLayer()` for the SAME selected cell (`tileCard`,
    // `inspector.js`), so switching the active layer without a notify left it showing the
    // previous layer's tile until some unrelated edit happened to refresh it. Confirmed while
    // verifying per-placement height: switching from "Camada 1" (`y:5`) back to the ground layer
    // kept showing "Camada 1"'s own tile in the inspector.
    setActiveLayer(n) { activeLayer = n; notify(); },
    getActiveLayer: () => activeLayer,
    setLayerVisible(n, on) { if (on) hiddenLayers.delete(n); else hiddenLayers.add(n); notify(); },
    isLayerVisible: (n) => !hiddenLayers.has(n),
    setLayerLocked(n, on) { if (on) lockedLayers.add(n); else lockedLayers.delete(n); notify(); },
    isLayerLocked: (n) => lockedLayers.has(n),
    // Notifies (unlike most plain setters here, which read back through a getter no renderer
    // polls) so a pick that did NOT come from the library's own card click — the eyedrop tool's
    // `applyToolAt` case already notifies on its own, but a future caller of this method
    // directly would not otherwise — still reaches `library.js`'s `syncSelection()`
    // (`main.js`'s own `session.subscribe`) and re-applies the `.ms-asset-card--sel` highlight.
    setSelectedAsset(a) { selectedAsset = a; notify(); },
    getSelectedAsset: () => selectedAsset,
    setBrush(patch) { Object.assign(brush, patch); },
    getBrush: () => ({ ...brush }),
    getEditCount: () => editCount,
    getReachStats() {
      if (!doc) return { unreachable: 0 };
      const seen = reachableFrom(doc, doc.spawn);
      let unreachable = 0;
      for (let cz = 0; cz < doc.h; cz++) for (let cx = 0; cx < doc.w; cx++) {
        const kind = doc.collision[cz * doc.w + cx];
        if (kind === 'block' || kind === 'water') continue;
        if (!seen[cz * doc.w + cx]) unreachable++;
      }
      return { unreachable };
    },
    getSelection: () => ({ ...selection }),
    setSelection(patch) { Object.assign(selection, patch); notify(); },
    getHover: () => hoverCell,
    setHover(cell) { hoverCell = cell; notify(); },
    getRectSelection: () => (rectSelection ? { ...rectSelection } : null),
    /** `rect` is normalized here (min/max swapped as needed) rather than trusting the caller —
     *  `main.js`'s `boxselect` drag hands this whichever corner order the pointer actually moved
     *  in, same as `paintRect`'s own `x0,z0,x1,z1` never assume `x0<=x1`. `null` clears the
     *  selection (nothing left to copy/cut/clear, the overlay hides its outline). */
    setRectSelection(rect) {
      rectSelection = rect ? {
        x0: Math.min(rect.x0, rect.x1), x1: Math.max(rect.x0, rect.x1),
        z0: Math.min(rect.z0, rect.z1), z1: Math.max(rect.z0, rect.z1),
      } : null;
      notify();
    },
    getClipboard: () => clipboard,
    setClipboard(clip) { clipboard = clip; notify(); },
    stackAtSelection: () => (selection.cell ? stackAt(doc, selection.cell.cx, selection.cell.cz) : []),
    /** True when `(cx,cz)` is paintable under the current box selection — always true with no
     *  selection, only inside it otherwise. `applyToolAt` checks this for the tools listed in
     *  `SELECTION_BOUND_TOOLS` above; `main.js`'s `rect`-drag commit and `fillRegion`'s own
     *  flood-walk (both outside `applyToolAt`'s single-cell dispatch) read the raw rect off
     *  `getRectSelection()` instead, to clip their own multi-cell regions rather than test one
     *  cell at a time. */
    canEditCell: (cx, cz) => canEditCell(cx, cz),
    /** Exposes the same tool dispatch a 2D pointer event drives, so `main.js` can route a
     *  3D-pane pick (`viewport/index.js`'s `pickCell`) through the identical brush/fill/coll/
     *  spawn/npc/light logic — including the `LOCKED_TOOLS`/selection guards and the `notify()`
     *  call at the end — with no second copy of this switch statement anywhere. */
    applyToolAt: (cx, cz, kind) => applyToolAt(cx, cz, kind),
    overlays: () => ({ ...overlays }),
    setOverlay(name, value) { overlays[name] = value; notify(); },
    toggleOverlay(name) { overlays[name] = !overlays[name]; notify(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The bare `notify()` — exposed (not just used internally) so a caller can announce a
     *  change it made through a `tools.js` command directly rather than through one of the
     *  methods above. `main.js`'s rect-drag commit (`paintRect`, called straight from its own
     *  3D-pane pointer handler — a two-corner drag has no single-cell meaning for `applyToolAt`
     *  to dispatch) is the one caller today; the deleted 2D canvas's own rect-fill and
     *  loop-waypoint drag commits used to be two more, the same asymmetry that existed then. */
    notify,
  };
}

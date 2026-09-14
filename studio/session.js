/**
 * session.js — the Map Studio's DOM-free editing state: which tool is active, the brush
 * settings, what is selected, which layers are hidden/locked, which overlays are toggled on,
 * the hover cell, the edit counter, and the single-cell tool dispatch (`applyToolAt`) that
 * every input surface — the 2D canvas's pointer handlers today, the 3D pane's pick routing in
 * `main.js` — funnels through so a click behaves identically no matter which surface it came
 * from. `subscribe`/`notify` is the one pub-sub every panel and every renderer hangs off of.
 *
 * See `state.js`'s own header for why the *document* has no DOM in it; this file makes the
 * same argument one layer up. Editing STATE (as opposed to the document itself) has no more
 * reason to know about a `<canvas>`, a pointer event, or pan/zoom than the document does —
 * `canvas.js` is one DOM-bound renderer of this state (a 3D viewport is effectively a second
 * one already, via `main.js`'s preview pointer routing), and neither owns it.
 */

import { cellKey } from './state.js';
import {
  stackAt, paintCell, eraseCell, fillRegion, setCollision, adjustHeight, toggleTag,
  setSpawn, placeMarker, placeObject, addNpc, addLight, addSpawnPoint, setLoopVia,
} from './tools.js';
import { openAddNpcDialog, openAddLightDialog } from './dialogs.js';

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
 *  unreachable count and the 2D canvas's own `reach` overlay share this one walk; `canvas.js`'s
 *  `render()` imports it back for the overlay's per-cell coloring rather than keeping a second,
 *  drifting copy of the BFS. */
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

/** Tools that keep acting on every dragged cell while the pointer stays down, in both the 2D
 *  canvas (`canvas.js`'s own pointerdown drag-detection) and the 3D pane (`main.js`'s preview
 *  pointer routing) — one Set, imported by both, instead of two hand-kept-in-sync copies.
 *  Everything else that paints (fill/spawn/marker/npc/light/object) fires once per pointerdown. */
export const CONTINUOUS_PAINT_TOOLS = new Set(['pencil', 'eraser', 'coll', 'height', 'tag']);

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
  const brush = { rot: 0, tint: 0xffffff, collision: 'walk', tag: 'tallgrass', heightStep: 0.25,
    claimFootprint: false, keepCollision: true };
  let selectedAsset = null; // { name, tileset, w, h }
  let selection = { cell: null, objectId: null, markerName: null, lightIndex: null, spawnPointIndex: null };
  let editCount = 0;
  const hiddenLayers = new Set();
  const lockedLayers = new Set();
  const overlays = { grid: true, textures: true, collision: false, height: false, tags: false,
    footprints: true, markers: true, cameras: false, loop: true, encounters: true, lights: true, reach: false };
  let hoverCell = null;
  const listeners = new Set();

  function notify() { for (const fn of listeners) fn(); }

  function applyToolAt(cx, cz, kind) {
    if (kind === 'down') selection.cell = { cx, cz };
    if (LOCKED_TOOLS.has(tool) && lockedLayers.has(activeLayer)) {
      selection.cell = { cx, cz }; notify(); return;
    }
    switch (tool) {
      case 'select': {
        const stack = stackAt(doc, cx, cz);
        selection.cell = { cx, cz };
        selection.objectId = stack.find((s) => s.kind === 'object')?.id ?? null;
        selection.lightIndex = overlays.lights ? lightNear(doc, cx, cz) : -1;
        if (selection.lightIndex < 0) selection.lightIndex = null;
        const spi = spawnPointNear(doc, cx, cz);
        selection.spawnPointIndex = spi < 0 ? null : spi;
        break;
      }
      case 'pencil':
        if (selectedAsset) {
          paintCell(doc, history, { layer: activeLayer, cx, cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint,
            collision: selectedAsset.collision, claimFootprint: brush.claimFootprint, keepCollision: brush.keepCollision });
          editCount++;
        }
        break;
      case 'eraser':
        eraseCell(doc, history, { layer: activeLayer, cx, cz });
        editCount++;
        break;
      case 'fill':
        if (selectedAsset) { fillRegion(doc, history, { layer: activeLayer, cx, cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint }); editCount++; }
        break;
      case 'coll':
        setCollision(doc, history, { cx, cz, kind: brush.collision });
        editCount++;
        break;
      case 'height':
        adjustHeight(doc, history, { cx, cz, delta: brush.heightStep });
        editCount++;
        break;
      case 'tag':
        toggleTag(doc, history, { cx, cz, tag: brush.tag });
        editCount++;
        break;
      case 'spawn':
        setSpawn(doc, history, { cx, cz });
        editCount++;
        break;
      case 'marker': {
        const name = prompt('Nome do marcador:');
        if (name) { placeMarker(doc, history, { name, cx, cz }); editCount++; }
        break;
      }
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
        // A drag-to-reposition of an existing inline waypoint is intercepted earlier, in the
        // raw `pointerdown` handler in `canvas.js`, and never reaches this dispatch — a plain
        // click here always appends a fresh anonymous waypoint at the clicked cell.
        const via = doc.loop?.via ?? [];
        setLoopVia(doc, history, { via: [...via, { cx, cz }] });
        editCount++;
        break;
      }
      case 'object':
        if (selectedAsset) {
          const obj = placeObject(doc, history, { m: selectedAsset.name, cx, cz, layer: activeLayer, rot: brush.rot, tint: brush.tint });
          selection.objectId = obj.id;
          editCount++;
        }
        break;
      case 'eyedrop': {
        const cell = doc.tileLayers.get(activeLayer)?.get(cellKey(cx, cz));
        if (cell) selectedAsset = { name: cell.m, tileset: doc.tileset };
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
      selection = { cell: null, objectId: null, markerName: null, lightIndex: null, spawnPointIndex: null };
      editCount = 0;
      hiddenLayers.clear();
      lockedLayers.clear();
      notify();
    },
    getDoc: () => doc,
    setTool(t) { tool = t; },
    getTool: () => tool,
    setActiveLayer(n) { activeLayer = n; },
    getActiveLayer: () => activeLayer,
    setLayerVisible(n, on) { if (on) hiddenLayers.delete(n); else hiddenLayers.add(n); notify(); },
    isLayerVisible: (n) => !hiddenLayers.has(n),
    setLayerLocked(n, on) { if (on) lockedLayers.add(n); else lockedLayers.delete(n); notify(); },
    isLayerLocked: (n) => lockedLayers.has(n),
    setSelectedAsset(a) { selectedAsset = a; },
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
    stackAtSelection: () => (selection.cell ? stackAt(doc, selection.cell.cx, selection.cell.cz) : []),
    /** Exposes the same tool dispatch a 2D pointer event drives, so `main.js` can route a
     *  3D-pane pick (`preview.js`'s `pickCell`) through the identical brush/fill/coll/height/
     *  tag/spawn/marker/npc/light logic — including the `LOCKED_TOOLS` guard and the `notify()`
     *  call at the end — with no second copy of this switch statement anywhere. */
    applyToolAt: (cx, cz, kind) => applyToolAt(cx, cz, kind),
    overlays: () => ({ ...overlays }),
    setOverlay(name, value) { overlays[name] = value; notify(); },
    toggleOverlay(name) { overlays[name] = !overlays[name]; notify(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The bare `notify()` — exposed (not just used internally) so `canvas.js` can announce a
     *  change it made through a `tools.js` command directly rather than through one of the
     *  methods above (its rect-fill and loop-waypoint drag commits, which call `paintRect`/
     *  `setLoopVia` straight from the pointer handler, the same asymmetry that exists today). */
    notify,
  };
}

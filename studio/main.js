/**
 * main.js — boots the Map Studio: assembles the layout, wires the canvas/panels to one
 * shared document reference, and owns the view switcher, the map picker, the new-map/
 * validation dialogs and the live 3D preview's navigation.
 */

import { h } from '@/ui/dom/el.js';
import tokens from '@/ui/css/tokens.css?inline';
import base from '@/ui/css/base.css?inline';
import studioCss from './css/studio.css?inline';

import { createDocument, createBlankDocument, serializeDocument, createHistory } from './state.js';
import { makeEditorCanvas } from './canvas.js';
import { makeSession, CONTINUOUS_PAINT_TOOLS } from './session.js';
import { makeLibraryPanel } from './library.js';
import { makePreview } from './preview.js';
import { setSpawn, placeMarker, updateLight, moveNpc, updateSpawnPoint } from './tools.js';
import { loadTextureBitmaps } from './catalog.js';
import { icon } from './icons.js';
import { OVERLAYS } from './kinds.js';
import { invalidateValidation } from './validation.js';
import { makeToolRail, makeToolbar, makeStatusBar, makeAssetBrushBar } from './panels.js';
import { makeInspector } from './inspector.js';
import { makeBottomPanel } from './bottom.js';
import { openNewMapDialog, makeMapPicker, makeValidationDrawer } from './dialogs.js';
import { listGameMaps, loadGameMap, importFile, exportFile, saveGameMap } from './io.js';

// A single synchronous <style>, the way `src/ui/dom/layer.js` injects the game's own theme —
// no flash of an unstyled panel while a stylesheet link resolves.
const style = document.createElement('style');
style.id = 'ms-style';
style.textContent = `${tokens}\n${base}\n${studioCss}`;
document.head.appendChild(style);

const root = h('div', { id: 'ui-dom', class: 'ms-root' });
document.body.appendChild(root);

let currentDoc = null;
const docRef = { get: () => currentDoc };
const history = createHistory();
let gameMapsCache = [];

const toolbarEl = h('div', {});
const libraryEl = h('div', { class: 'ms-panel ms-panel--library' });
const railEl = h('div', { class: 'ms-tool-rail' });
const overlayStripEl = h('div', { class: 'ms-overlay-strip' });
const brushBarEl = h('div', {});
const canvasWrap = h('div', { class: 'ms-canvas-wrap' });
const canvasEl = h('canvas', { class: 'ms-canvas' });
canvasWrap.appendChild(canvasEl);
const bottomEl = h('div', { class: 'ms-panel ms-panel--bottom' });
const inspectorEl = h('div', { class: 'ms-panel ms-panel--inspector' });
const statusEl = h('div', {});

const previewWrap = h('div', { class: 'ms-preview-wrap', hidden: true });
const previewHead = h('div', { class: 'ms-preview-head' }, 'Prévia HD-2D');
const previewContainer = h('div', { class: 'ms-preview-canvas' });
previewWrap.appendChild(previewHead);
previewWrap.appendChild(previewContainer);
const workspaceEl = h('div', { class: 'ms-workspace' }, [canvasWrap, previewWrap]);

const centerEl = h('div', { class: 'ms-center' }, [overlayStripEl, brushBarEl, workspaceEl, bottomEl]);
const bodyEl = h('div', { class: 'ms-body' }, [libraryEl, railEl, centerEl, inspectorEl]);
root.appendChild(h('div', { class: 'ms-app' }, [toolbarEl, bodyEl, statusEl]));

const session = makeSession({ history });
const editorCanvas = makeEditorCanvas({ canvas: canvasEl, history, session });

const toolRail = makeToolRail({ root: railEl, session });
const library = makeLibraryPanel({
  root: libraryEl, session, docRef, toolRail,
  onCatalogLoaded: (slug) => { loadTextureBitmaps(slug, { onProgress: () => editorCanvas.render() }); bottom.rebuild(); },
});
makeAssetBrushBar({ root: brushBarEl, session });

// --- overlay strip: the toggles `session` already implements but nothing called -----------
const INLINE_OVERLAY_COUNT = 7;
function buildOverlayStrip() {
  overlayStripEl.innerHTML = '';
  overlayStripEl.appendChild(icon('eye', { size: 15 }));
  const state = session.overlays();
  const chip = ([id, label, _iconName, dot]) => h('button', {
    class: `ms-ovl-chip${state[id] ? ' ms-ovl-chip--on' : ''}`,
    title: label,
    onClick: () => { session.toggleOverlay(id); buildOverlayStrip(); },
  }, [h('span', { class: 'ms-ovl-dot', style: { background: state[id] ? dot : 'rgba(255,255,255,0.18)' } }), h('span', {}, label)]);
  OVERLAYS.slice(0, INLINE_OVERLAY_COUNT).forEach((o) => overlayStripEl.appendChild(chip(o)));
  const rest = OVERLAYS.slice(INLINE_OVERLAY_COUNT);
  if (rest.length) {
    const menu = h('div', { class: 'ms-ovl-menu' }, rest.map(chip));
    const more = h('button', { class: 'ms-ovl-more', onClick: () => menu.classList.toggle('ms-hidden') }, [`+${rest.length}`, icon('chevron-down', { size: 12 })]);
    overlayStripEl.appendChild(h('div', { class: 'ms-ovl-more-wrap' }, [more, menu]));
  }
  const zoomWrap = h('div', { class: 'ms-ovl-zoom' }, [16, 32, 64].map((n) => h('button', {
    class: 'ms-zoom-btn', onClick: () => editorCanvas.setZoomPreset(n),
  }, String(n))));
  overlayStripEl.appendChild(h('div', { class: 'ms-spacer' }));
  overlayStripEl.appendChild(zoomWrap);
}
buildOverlayStrip();

// --- live HD-2D preview (studio/preview.js) — booted lazily, on first non-"edit" view, so
// opening the Studio does not pay for a second three.js renderer nobody asked to see. --------
let preview = null;
let previewRebuildTimer = null;
// `doc._rev` (`state.js`'s `touch()`) last scheduled a rebuild for — see `refreshAll()` below.
let lastRebuildRev = -1;
// The 3D pane's one pointer-drag state machine: `{ mode: 'pan' }` (camera drag, the pane's
// original and still-default behaviour), `{ mode: 'gizmo', gizmo, moved }` (dragging a spawn/
// marker/npc/light handle) or `{ mode: 'paint' }` (an active paint tool clicked/dragged a cell).
// Exactly one of these is live at a time — a gizmo hit always wins over painting, and painting
// always wins over panning, decided once on `pointerdown` (below).
let previewDrag = null;
let previewDownAt = null; // pointerdown client (x,y) — tells a click from a drag on pointerup

async function ensurePreview() {
  if (preview) return preview;
  preview = await makePreview({ container: previewContainer });
  previewHead.appendChild(h('span', { class: 'ms-eyebrow' }, 'Hora'));
  previewHead.appendChild(h('input', { type: 'range', min: '0', max: '23.5', step: '0.5', value: '11',
    class: 'ms-tod-slider', onInput: (e) => preview.setTod(e.target.value) }));
  previewHead.appendChild(h('span', { class: 'ms-eyebrow' }, 'Zoom'));
  const zoomOut = h('button', { class: 'ms-iconbtn', onClick: () => preview.zoomSteps(1) }, [icon('zoom-out', { size: 13 })]);
  const zoomIn = h('button', { class: 'ms-iconbtn', onClick: () => preview.zoomSteps(-1) }, [icon('zoom-in', { size: 13 })]);
  const fitBtn = h('button', { class: 'ms-iconbtn', title: 'Enquadrar mapa', onClick: () => currentDoc && preview.fitMap(currentDoc.w, currentDoc.h) }, [icon('scan', { size: 13 })]);
  previewHead.append(zoomOut, zoomIn, fitBtn);
  if (currentDoc) preview.load(serializeDocument(currentDoc));
  return preview;
}

// Tools with their own meaning in the 3D pane already — `select` and `pan` (click-to-select,
// drag-to-pan) and `eyedrop` (no 3D-specific behaviour yet) never dispatch through
// `session.applyToolAt`. Everything else does, which is also how an `npc`/`light`/`marker`
// click in 3D ends up popping the exact same modal/prompt the 2D canvas's tool rail does —
// `applyToolAt` is the one dispatch, not a second copy of it. `CONTINUOUS_PAINT_TOOLS` (which
// tools keep acting on every dragged cell) is `session.js`'s own single-source Set, imported
// above rather than kept as a second hand-synced copy here.
const NON_PAINT_TOOLS = new Set(['select', 'pan', 'eyedrop']);

/** Confines a dragged gizmo to the map — `setSpawn`/`placeMarker`/`moveNpc`/`updateLight` do not
 *  bounds-check the way `tools.js`'s cell-painting commands do (the 2D canvas never lets them:
 *  its own pointer handlers only ever call `applyToolAt` inside `[0,w)x[0,h)`), so a 3D drag that
 *  crosses the map edge clamps to the nearest valid cell instead of parking a spawn at cx:-4. */
function clampToMap(cx, cz) {
  if (!currentDoc) return { cx, cz };
  return { cx: Math.max(0, Math.min(currentDoc.w - 1, cx)), cz: Math.max(0, Math.min(currentDoc.h - 1, cz)) };
}

/** Commits a finished gizmo drag through the same undo-wired `tools.js` commands the inspector
 *  and the tool rail already use for spawn/marker/light — nothing here writes `doc` by hand
 *  (the P1 pass already went through and fixed the inspector fields that used to). */
function commitGizmoDrag(gizmo, e) {
  const cell = preview.pickCell(e.clientX, e.clientY);
  if (!cell || !currentDoc) return; // the pointer let go off the ground plane — nothing to commit
  const { cx, cz } = clampToMap(cell.cx, cell.cz);
  if (gizmo.kind === 'spawn') setSpawn(currentDoc, history, { cx, cz });
  else if (gizmo.kind === 'marker') {
    const m = currentDoc.markers[gizmo.index];
    if (m) placeMarker(currentDoc, history, { name: m.name, cx, cz });
  } else if (gizmo.kind === 'npc') {
    const npc = currentDoc.npcs[gizmo.index];
    if (npc) moveNpc(currentDoc, history, { npc, cx, cz });
  } else if (gizmo.kind === 'light') {
    // Lights are otherwise free-floating world coordinates (`state.js`'s header) — dragging one
    // in 3D still snaps it to a cell center like every other gizmo, and keeps its own `y`.
    updateLight(currentDoc, history, { index: gizmo.index, patch: { x: cx + 0.5, z: cz + 0.5 } });
  } else if (gizmo.kind === 'spawnPoint') {
    const point = currentDoc.spawnPoints[gizmo.index];
    if (point) updateSpawnPoint(currentDoc, history, { point, patch: { cx, cz } });
  }
  refreshAll(); // same pattern `inspector.js`'s onChange callback uses after its own tools.js calls
}

/** A click (no drag) on a gizmo selects the entity it represents, in the same shape the 2D
 *  canvas's own `select` tool writes to `session` — so the inspector and the bottom panel
 *  light up the same way regardless of which view was clicked. */
function selectGizmo(gizmo) {
  if (!currentDoc) return;
  if (gizmo.kind === 'spawn') {
    session.setSelection({ cell: { cx: currentDoc.spawn.cx, cz: currentDoc.spawn.cz }, markerName: null, lightIndex: null, spawnPointIndex: null });
  } else if (gizmo.kind === 'marker') {
    const m = currentDoc.markers[gizmo.index];
    if (m) session.setSelection({ cell: { cx: m.cx, cz: m.cz }, markerName: m.name, lightIndex: null, spawnPointIndex: null });
  } else if (gizmo.kind === 'npc') {
    // No dedicated NPC inspector card yet (out of scope for this phase) — cell selection at
    // least brings up the cell/"Objetos" inspector for where the NPC stands.
    const n = currentDoc.npcs[gizmo.index];
    if (n) session.setSelection({ cell: { cx: n.cx, cz: n.cz }, markerName: null, lightIndex: null, spawnPointIndex: null });
  } else if (gizmo.kind === 'light') {
    const l = currentDoc.lights[gizmo.index];
    if (l) session.setSelection({ cell: { cx: Math.floor(l.x), cz: Math.floor(l.z) }, markerName: null, lightIndex: gizmo.index, spawnPointIndex: null });
  } else if (gizmo.kind === 'spawnPoint') {
    const p = currentDoc.spawnPoints[gizmo.index];
    if (p) session.setSelection({ cell: { cx: p.cx, cz: p.cz }, markerName: null, lightIndex: null, spawnPointIndex: gizmo.index });
  }
}

previewContainer.addEventListener('pointerdown', (e) => {
  if (!preview) return;
  previewContainer.setPointerCapture(e.pointerId);
  previewDownAt = { x: e.clientX, y: e.clientY };

  // Gizmos win over everything else — a spawn/marker/npc/light handle sits in front of both
  // cell-selection and whatever paint tool is active, the same way a direct-manipulation handle
  // always takes priority over the canvas underneath it.
  const gizmo = preview.pickGizmo(e.clientX, e.clientY);
  if (gizmo) { previewDrag = { mode: 'gizmo', gizmo, moved: false }; return; }

  const tool = session.getTool();
  if (currentDoc && !NON_PAINT_TOOLS.has(tool)) {
    const cell = preview.pickCell(e.clientX, e.clientY);
    if (cell && cell.cx >= 0 && cell.cz >= 0 && cell.cx < currentDoc.w && cell.cz < currentDoc.h) {
      session.applyToolAt(cell.cx, cell.cz, 'down');
      previewDrag = { mode: 'paint' };
      return;
    }
  }

  // Default: the pane's original behaviour — drag pans the camera. A `select`/`pan`/`eyedrop`
  // click (or a paint click that missed the map) falls into this too; `pointerup` below turns a
  // *motionless* `select` one of those into a cell selection — the 3D pane's click-to-select.
  previewDrag = { mode: 'pan', x: e.clientX, y: e.clientY };
  previewContainer.classList.add('is-panning');
});
previewContainer.addEventListener('pointermove', (e) => {
  if (!preview || !previewDrag) return;
  if (previewDrag.mode === 'pan') {
    preview.panBy(e.clientX - previewDrag.x, e.clientY - previewDrag.y);
    previewDrag.x = e.clientX; previewDrag.y = e.clientY;
    return;
  }
  if (previewDrag.mode === 'gizmo') {
    previewDrag.moved = true;
    const cell = preview.pickCell(e.clientX, e.clientY);
    // Visual-only: the doc is untouched until `pointerup`, so dragging across the whole map is
    // one undo step, not one per animation frame.
    if (cell) { const c = clampToMap(cell.cx, cell.cz); preview.moveGizmoTo(previewDrag.gizmo.kind, previewDrag.gizmo.index, c.cx, c.cz); }
    return;
  }
  if (previewDrag.mode === 'paint' && currentDoc && CONTINUOUS_PAINT_TOOLS.has(session.getTool())) {
    const cell = preview.pickCell(e.clientX, e.clientY);
    if (cell && cell.cx >= 0 && cell.cz >= 0 && cell.cx < currentDoc.w && cell.cz < currentDoc.h) {
      session.applyToolAt(cell.cx, cell.cz, 'move');
    }
  }
});
function endPreviewDrag(e) {
  if (previewDrag?.mode === 'gizmo') {
    if (previewDrag.moved) commitGizmoDrag(previewDrag.gizmo, e);
    else selectGizmo(previewDrag.gizmo);
  } else if (previewDrag?.mode === 'pan' && previewDownAt && session.getTool() === 'select' && preview) {
    const movedPx = Math.hypot(e.clientX - previewDownAt.x, e.clientY - previewDownAt.y);
    if (movedPx < 4) {
      const cell = preview.pickCell(e.clientX, e.clientY);
      if (cell) session.setSelection({ cell });
    }
  }
  previewDrag = null;
  previewDownAt = null;
  previewContainer.classList.remove('is-panning');
}
previewContainer.addEventListener('pointerup', endPreviewDrag);
previewContainer.addEventListener('pointercancel', endPreviewDrag);
previewContainer.addEventListener('wheel', (e) => {
  if (!preview) return;
  e.preventDefault();
  preview.zoomSteps(Math.sign(e.deltaY));
}, { passive: false });

function schedulePreviewRebuild() {
  if (!preview) return;
  clearTimeout(previewRebuildTimer);
  // Debounced: `buildInstances` over a 20k-placement map is not a per-keystroke operation.
  previewRebuildTimer = setTimeout(() => { if (currentDoc) preview.load(serializeDocument(currentDoc)); }, 400);
}

// --- view switcher: Edição / Jogo / Dividida -------------------------------------------------
let viewMode = 'edit';
async function setViewMode(mode) {
  viewMode = mode;
  canvasWrap.hidden = mode === 'game';
  previewWrap.hidden = mode === 'edit';
  if (mode !== 'edit') { await ensurePreview(); if (currentDoc) preview.load(serializeDocument(currentDoc)); }
  if (mode !== 'game') editorCanvas.fitView();
}

// --- percorrer loop (the "Playtest" slot's real, honest stand-in — see the plan) -----------
let walking = false;
async function walkLoop() {
  const cells = currentDoc?.loop?.resolved?.cells;
  if (!cells?.length) return;
  if (walking) { walking = false; return; }
  if (viewMode === 'edit') { await setViewMode('split'); toolbar.setView('split'); }
  walking = true;
  const walkingDoc = currentDoc;
  let i = 0;
  const step = () => {
    if (!walking || currentDoc !== walkingDoc) { walking = false; return; }
    const c = cells[i % cells.length];
    preview.setFocus(c.cx, c.cz);
    i++;
    setTimeout(step, 220);
  };
  step();
}

// Every editing-state mutation/selection change re-renders the panels around it — a click
// that selects a cell, a paint stroke, an overlay toggle all funnel through here.
session.subscribe(() => refreshAll());

// --- selection -> 3D focus follow (a free win: `preview.setFocus` already existed, unused) --
let lastFocusKey = null;
session.subscribe(() => {
  const sel = session.getSelection();
  const key = sel.cell ? `${sel.cell.cx},${sel.cell.cz}` : null;
  if (key && key !== lastFocusKey && preview && viewMode !== 'edit') preview.setFocus(sel.cell.cx, sel.cell.cz);
  lastFocusKey = key;
});

const inspector = makeInspector({ root: inspectorEl, session, docRef, history, onChange: refreshAll });
const bottom = makeBottomPanel({ root: bottomEl, editorCanvas, session, docRef, history });
const status = makeStatusBar({ root: statusEl, session, docRef });

const validationDrawer = makeValidationDrawer({ docRef, session, onRevalidate: () => { invalidateValidation(); refreshAll(); } });

// `mapPicker` needs the toolbar's map-badge DOM node as its popover anchor, so it is built
// right after `makeToolbar` using the node that call just created — `onOpenPicker` below reads
// `mapPicker` at click time, by which point it is always assigned, not at construction time.
let mapPicker = null;
const toolbar = makeToolbar({
  root: toolbarEl, doc: docRef, history,
  onNew: () => openNewMapDialog({ onCreate: setDocument, hasUnsaved: !!currentDoc?.dirty }),
  onOpenPicker: () => mapPicker?.toggle(),
  onImport: async () => { const map = await importFile(); if (map) setDocument(createDocument(map)); },
  onExport: () => { if (currentDoc) { exportFile(serializeDocument(currentDoc)); currentDoc.dirty = false; } },
  onSave: async () => {
    if (!currentDoc) return;
    try {
      await saveGameMap(serializeDocument(currentDoc));
      currentDoc.dirty = false;
      gameMapsCache = await listGameMaps();
    } catch (err) {
      alert(`Não foi possível salvar "${currentDoc.id}": ${err.message}`);
    }
  },
  onValidate: () => validationDrawer.open(),
  onView: setViewMode,
  onWalkLoop: walkLoop,
});
mapPicker = makeMapPicker({
  anchor: toolbarEl.querySelector('.ms-map-badge'),
  getMaps: () => gameMapsCache,
  getCurrentId: () => currentDoc?.id ?? null,
  onPick: async (id) => setDocument(createDocument(await loadGameMap(id))),
  hasUnsaved: () => !!currentDoc?.dirty,
});

function refreshAll() {
  toolbar.refresh();
  inspector.rebuild();
  bottom.rebuild();
  status.refresh();
  editorCanvas.render();
  buildOverlayStrip();
  // Only reschedule the (expensive, debounced) 3D rebuild when the document actually changed —
  // `session.subscribe` also fires on bare hover/selection (`session.js`'s `setHover` calls
  // `notify()` unconditionally, not just on a drag), which used to snap the 3D camera back
  // to spawn on every mouse move over the 2D canvas. `state.js`'s `touch()` is the one thing
  // every real mutation calls, so its `_rev` counter is the signal that separates "something was
  // painted" from "the mouse moved" or "the selection changed".
  const rev = currentDoc?._rev ?? 0;
  if (viewMode !== 'edit' && currentDoc && rev !== lastRebuildRev) {
    lastRebuildRev = rev;
    schedulePreviewRebuild();
  }
}

function setDocument(doc) {
  currentDoc = doc;
  lastRebuildRev = doc._rev ?? 0; // a fresh/switched doc is handled by the explicit `preview.load()` below, not the rev-diff path
  invalidateValidation();
  editorCanvas.setDoc(doc);
  history.clear();
  library.setTileset(doc.tileset);
  loadTextureBitmaps(doc.tileset, { onProgress: () => editorCanvas.render() });
  refreshAll();
  if (viewMode !== 'edit' && preview) preview.load(serializeDocument(doc));
}

new ResizeObserver(() => editorCanvas.render()).observe(canvasWrap);

// Boot: open the game's first shipped map so the Studio starts on something real, not blank —
// falling back to a fresh blank map (still `bw2-adastra`) when none have been snapshotted yet.
(async function boot() {
  gameMapsCache = await listGameMaps();
  const doc = gameMapsCache.length
    ? createDocument(await loadGameMap(gameMapsCache[0].id))
    : createBlankDocument({ id: 'novo_mapa', name: 'Novo Mapa', w: 32, h: 32, tileset: 'bw2-adastra', environmentPreset: 'meadow', kind: 'hunt' });
  await library.init(doc.tileset);
  setDocument(doc);
})();

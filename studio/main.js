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
import { makeLibraryPanel } from './library.js';
import { makePreview } from './preview.js';
import { loadTextureBitmaps } from './catalog.js';
import { icon } from './icons.js';
import { OVERLAYS } from './kinds.js';
import { invalidateValidation } from './validation.js';
import { makeToolRail, makeToolbar, makeStatusBar, makeAssetBrushBar } from './panels.js';
import { makeInspector } from './inspector.js';
import { makeBottomPanel } from './bottom.js';
import { openNewMapDialog, makeMapPicker, makeValidationDrawer } from './dialogs.js';
import { listGameMaps, loadGameMap, importFile, exportFile } from './io.js';

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

const editorCanvas = makeEditorCanvas({ canvas: canvasEl, history });

makeToolRail({ root: railEl, editorCanvas });
const library = makeLibraryPanel({
  root: libraryEl, editorCanvas, docRef,
  onCatalogLoaded: (slug) => { loadTextureBitmaps(slug, { onProgress: () => editorCanvas.render() }); bottom.rebuild(); },
});
makeAssetBrushBar({ root: brushBarEl, editorCanvas });

// --- overlay strip: the toggles `editorCanvas` already implements but nothing called ------
const INLINE_OVERLAY_COUNT = 7;
function buildOverlayStrip() {
  overlayStripEl.innerHTML = '';
  overlayStripEl.appendChild(icon('eye', { size: 15 }));
  const state = editorCanvas.overlays();
  const chip = ([id, label, _iconName, dot]) => h('button', {
    class: `ms-ovl-chip${state[id] ? ' ms-ovl-chip--on' : ''}`,
    title: label,
    onClick: () => { editorCanvas.toggleOverlay(id); buildOverlayStrip(); },
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
let dragLast = null;

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

previewContainer.addEventListener('pointerdown', (e) => {
  if (!preview) return;
  dragLast = { x: e.clientX, y: e.clientY };
  previewContainer.setPointerCapture(e.pointerId);
  previewContainer.classList.add('is-panning');
});
previewContainer.addEventListener('pointermove', (e) => {
  if (!preview || !dragLast) return;
  preview.panBy(e.clientX - dragLast.x, e.clientY - dragLast.y);
  dragLast = { x: e.clientX, y: e.clientY };
});
function endPreviewDrag() { dragLast = null; previewContainer.classList.remove('is-panning'); }
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

// Every canvas mutation/selection change re-renders the panels around it — a click that
// selects a cell, a paint stroke, an overlay toggle all funnel through here.
editorCanvas.subscribe(() => refreshAll());

// --- selection -> 3D focus follow (a free win: `preview.setFocus` already existed, unused) --
let lastFocusKey = null;
editorCanvas.subscribe(() => {
  const sel = editorCanvas.getSelection();
  const key = sel.cell ? `${sel.cell.cx},${sel.cell.cz}` : null;
  if (key && key !== lastFocusKey && preview && viewMode !== 'edit') preview.setFocus(sel.cell.cx, sel.cell.cz);
  lastFocusKey = key;
});

const inspector = makeInspector({ root: inspectorEl, editorCanvas, docRef, history, onChange: refreshAll });
const bottom = makeBottomPanel({ root: bottomEl, editorCanvas, docRef, history });
const status = makeStatusBar({ root: statusEl, editorCanvas, docRef });

const validationDrawer = makeValidationDrawer({ docRef, editorCanvas, onRevalidate: () => { invalidateValidation(); refreshAll(); } });

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
  if (viewMode !== 'edit') schedulePreviewRebuild();
}

function setDocument(doc) {
  currentDoc = doc;
  invalidateValidation();
  editorCanvas.setDoc(doc);
  history.clear();
  library.setTileset(doc.tileset);
  loadTextureBitmaps(doc.tileset, { onProgress: () => editorCanvas.render() });
  refreshAll();
  if (viewMode !== 'edit' && preview) preview.load(serializeDocument(doc));
}

new ResizeObserver(() => editorCanvas.render()).observe(canvasWrap);

// A DEV-only hook, mirroring the game's own `window.__HOOKS__` — never relied on by the
// product itself, only by `tools/mapstudio/studio-ui.js`'s headless checks.
if (new URLSearchParams(location.search).get('hooks') === '1') {
  window.__MS__ = { get preview() { return preview; }, editorCanvas, docRef, toolbar, history };
}

// Boot: open the game's first shipped map so the Studio starts on something real, not blank —
// falling back to a fresh blank map (still `bw2-adastra`) when none have been snapshotted yet.
(async function boot() {
  gameMapsCache = await listGameMaps();
  const doc = gameMapsCache.length
    ? createDocument(await loadGameMap(gameMapsCache[0].id))
    : createBlankDocument({ id: 'novo_mapa', name: 'Novo Mapa', w: 32, h: 32, tileset: 'bw2-adastra', biome: 'meadow', kind: 'hunt' });
  await library.init(doc.tileset);
  setDocument(doc);
})();

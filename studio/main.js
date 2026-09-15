/**
 * main.js — boots the Map Studio: assembles the layout, wires the 3D viewport/panels to one
 * shared document reference, and owns the map picker, the new-map/validation dialogs and the
 * live 3D preview's navigation. Slice 7 deleted the 2D edit canvas and its view switcher — the
 * 3D viewport (`viewport/`) is the Studio's only workspace now, with a small read-only
 * `minimap.js` overlaid on it for orientation.
 */

import { h } from '@/ui/dom/el.js';
import tokens from '@/ui/css/tokens.css?inline';
import base from '@/ui/css/base.css?inline';
import studioCss from './css/studio.css?inline';

import { createDocument, createBlankDocument, serializeDocument, createHistory, cellKey } from './state.js';
import { paintRect, paintRegionMask } from './tools.js';
import { makeSession, CONTINUOUS_PAINT_TOOLS } from './session.js';
import { makeLibraryPanel } from './library.js';
import { makeViewport } from './viewport/index.js';
import { makeMinimap } from './minimap.js';
import { icon } from './icons.js';
import { OVERLAYS } from './kinds.js';
import { ENTITIES, regionContains } from './entities.js';
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
const bottomEl = h('div', { class: 'ms-panel ms-panel--bottom' });
const inspectorEl = h('div', { class: 'ms-panel ms-panel--inspector' });
const statusEl = h('div', {});

const previewWrap = h('div', { class: 'ms-preview-wrap' });
const previewHead = h('div', { class: 'ms-preview-head' }, 'Prévia HD-2D');
const previewContainer = h('div', { class: 'ms-preview-canvas' });
previewWrap.appendChild(previewHead);
previewWrap.appendChild(previewContainer);
const workspaceEl = h('div', { class: 'ms-workspace' }, [previewWrap]);

const centerEl = h('div', { class: 'ms-center' }, [overlayStripEl, brushBarEl, workspaceEl, bottomEl]);
const bodyEl = h('div', { class: 'ms-body' }, [libraryEl, railEl, centerEl, inspectorEl]);
root.appendChild(h('div', { class: 'ms-app' }, [toolbarEl, bodyEl, statusEl]));

const session = makeSession({ history });

const toolRail = makeToolRail({ root: railEl, session });
const library = makeLibraryPanel({
  root: libraryEl, session, docRef, toolRail,
  onCatalogLoaded: () => bottom.rebuild(),
});
makeAssetBrushBar({
  root: brushBarEl, session, docRef, history,
  // `preview` is assigned later, by `bootViewport()` below — but this callback is only ever
  // INVOKED once the brush bar's región section actually needs the list (the user has switched to
  // the `region` tool), well after `boot()`'s own `await bootViewport()` has resolved.
  getAutotileSets: () => (currentDoc ? preview?.autotileSets(currentDoc.tileset) ?? [] : []),
});

// --- overlay strip: the toggles `session` already implements but nothing called -----------
// (Slice 7: down to 4 entries — `kinds.js`'s own `OVERLAYS` header explains what left the table
// and why. `INLINE_OVERLAY_COUNT` still degrades gracefully at 4: every chip shows inline, no
// overflow menu, since 4 <= 7.)
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
  // The 2D canvas's own 16/32/64-px-per-cell zoom presets used to sit here — deleted along with
  // `canvas.js` itself (Slice 7), not merely lost track of: that was a pixels-per-cell concept
  // with no clean 1:1 mapping onto the 3D viewport's own `pixelsPerUnit` zoom ladder, which
  // already has its own dedicated zoom in/out buttons in the preview head (`preview.zoomSteps`,
  // wired in `bootViewport` below) — forcing a confusing unit mismatch onto three buttons here
  // would be worse than just not having them.
}
buildOverlayStrip();

// --- live HD-2D preview (studio/viewport/) — the Studio's only workspace since Slice 7, so
// there is nothing left to defer it past: booted eagerly, immediately, as part of the main boot
// sequence at the bottom of this file (`bootViewport` below, called from `boot()`). ------------
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

/** Boots the 3D viewport and appends its head controls (time-of-day, yaw, zoom) — called once,
 *  from the main boot sequence (`boot()` below), before any document loads. */
async function bootViewport() {
  preview = await makeViewport({ container: previewContainer, session });
  previewHead.appendChild(h('span', { class: 'ms-eyebrow' }, 'Hora'));
  previewHead.appendChild(h('input', { type: 'range', min: '0', max: '23.5', step: '0.5', value: '11',
    class: 'ms-tod-slider', onInput: (e) => preview.setTod(e.target.value) }));
  // Vista (Slice 6): 90°-step yaw — orientation and occlusion-checking (seeing behind a
  // building), not a second beauty angle. DS-era tile art is painted for one view, so yaw 90/
  // 180/270 shows gaps in single-sided walls and front-painted textures from behind — a known,
  // accepted limitation, not something either button below tries to hide.
  previewHead.appendChild(h('span', { class: 'ms-eyebrow' }, 'Vista'));
  const yawLeftIcon = icon('rotate-cw', { size: 13 });
  yawLeftIcon.style.transform = 'scaleX(-1)'; // mirrored `rotate-cw` — no separate `rotate-ccw` glyph vendored in icons.js
  const yawLeftBtn = h('button', { class: 'ms-iconbtn', title: 'Girar vista à esquerda (90°) · [', onClick: () => preview.setYaw(preview.getYaw() - 1) }, [yawLeftIcon]);
  const yawRightBtn = h('button', { class: 'ms-iconbtn', title: 'Girar vista à direita (90°) · ]', onClick: () => preview.setYaw(preview.getYaw() + 1) }, [icon('rotate-cw', { size: 13 })]);
  previewHead.append(yawLeftBtn, yawRightBtn);
  previewHead.appendChild(h('span', { class: 'ms-eyebrow' }, 'Zoom'));
  const zoomOut = h('button', { class: 'ms-iconbtn', onClick: () => preview.zoomSteps(1) }, [icon('zoom-out', { size: 13 })]);
  const zoomIn = h('button', { class: 'ms-iconbtn', onClick: () => preview.zoomSteps(-1) }, [icon('zoom-in', { size: 13 })]);
  const fitBtn = h('button', { class: 'ms-iconbtn', title: 'Enquadrar mapa', onClick: () => currentDoc && preview.fitMap(currentDoc.w, currentDoc.h) }, [icon('scan', { size: 13 })]);
  previewHead.append(zoomOut, zoomIn, fitBtn);
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

/** Resolves a `viewport/index.js` gizmo (`{kind, index}` — a position within
 *  `ENTITIES[kind].list(...)`, never a carried-over object) against the LIVE `currentDoc`.
 *  `viewport/index.js`'s own gizmos are built from `serializeDocument(currentDoc)`'s output — a
 *  snapshot whose `npcs`/`markers`/`lights`/`links`/`regions`/`spawnPoints` are all fresh
 *  `{...x}` clones (`state.js`'s `serializeDocument`), never the same references `currentDoc`'s
 *  own arrays hold. Handing a `tools.js` command or an inspector card one of those clones would
 *  let it mutate a throwaway object all the way through undo/redo while the real document
 *  silently never changes — this is the one required re-resolution step between "which gizmo
 *  did the raycaster hit" and "which live object does that gizmo represent", and every caller
 *  below goes through it rather than trusting a reference `viewport/index.js` might otherwise
 *  have carried. */
function resolveGizmoRef(gizmo) {
  return ENTITIES[gizmo.kind]?.list(currentDoc)[gizmo.index] ?? null;
}

/** Commits a finished gizmo drag through `ENTITIES[gizmo.kind].moveTo` — the same undo-wired
 *  `tools.js` commands the inspector already uses, looked up generically instead of a 5-branch
 *  `if/else if` chain (one per kind that happened to support dragging when this was written by
 *  hand). A kind with a gizmo but no `moveTo` (link/region/loopWaypoint/cameraPreset — no
 *  gizmo-drag flow yet) never reaches here at all: the `pointermove` handler below only flags a
 *  gizmo drag as "moved" when `moveTo` exists, so such a gizmo always resolves as a click
 *  (`selectGizmo`), never a drag commit. Nothing here writes `doc` by hand. */
function commitGizmoDrag(gizmo, e) {
  const cell = preview.pickCell(e.clientX, e.clientY);
  if (!cell || !currentDoc) return; // the pointer let go off the ground plane — nothing to commit
  const { cx, cz } = clampToMap(cell.cx, cell.cz);
  const ref = resolveGizmoRef(gizmo);
  if (ref == null) return; // the entity vanished (e.g. removed from another surface) mid-drag
  ENTITIES[gizmo.kind]?.moveTo?.(currentDoc, history, ref, { cx, cz });
  // `session.notify()`, not a direct `refreshAll()` call: `refreshAll` is already one of
  // `session`'s own subscribers (below, `session.subscribe(() => refreshAll())`), so notifying
  // still runs it — and also reaches every OTHER subscriber a direct call would skip entirely,
  // `viewport/overlay.js`'s rebuild-on-notify and `minimap.js`'s repaint-on-notify chief among
  // them. A `tools.js` command called straight from a pointer handler (as this one is) never
  // goes through `session.applyToolAt`'s own trailing `notify()`, so this call is the only thing
  // that tells either of those two the entity this gizmo represents just moved.
  session.notify();
}

/** A click (no drag) on a gizmo selects the entity it represents, in the same `{cell,kind,ref}`
 *  shape the 2D canvas's own `select` tool writes to `session` — so the inspector and the
 *  bottom panel light up the same way regardless of which view was clicked. Generic over every
 *  `ENTITIES` kind via `positionOf`/`space`, instead of a 5-branch chain. */
function selectGizmo(gizmo) {
  if (!currentDoc) return;
  const entity = ENTITIES[gizmo.kind];
  const ref = resolveGizmoRef(gizmo);
  const pos = ref != null ? entity?.positionOf(currentDoc, ref) : null;
  if (!pos) return;
  const cell = entity.space === 'world'
    ? { cx: Math.floor(pos.x), cz: Math.floor(pos.z) }
    : { cx: Math.floor(pos.cx), cz: Math.floor(pos.cz) };
  session.setSelection({ cell, kind: gizmo.kind, ref });
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
  // The rect tool never went through `session.applyToolAt` — even on the 2D canvas, before it
  // was deleted, it was its own drag-a-rectangle gesture with no single-cell meaning, committed
  // once on release (`paintRect`, `tools.js`) rather than per moved cell. Ported here verbatim
  // rather than folded into `applyToolAt`'s switch, which has no case for it and is not the
  // right shape for a two-corner command anyway.
  if (tool === 'rect' && currentDoc && session.getSelectedAsset()) {
    const cell = preview.pickCell(e.clientX, e.clientY);
    if (cell) { previewDrag = { mode: 'rect', x0: cell.cx, z0: cell.cz }; return; }
  }
  // Região (Slice 9b): also its own drag gesture, not a case in `session.applyToolAt`'s switch —
  // a mask paint-stroke has no single-cell meaning either, the same reasoning the `rect` branch
  // above already established. `on` is decided ONCE, from the FIRST cell's current membership,
  // and held fixed for the whole drag (a common paint-tool convention: painting starts by ADDING
  // membership if the first cell is not yet a member, or REMOVING it if it already is, so a user
  // never has to release and re-press to switch between add/remove mid-map). No active region
  // selected (`panels.js`'s brush bar is where one gets created/picked) falls through to the
  // generic dispatch below, which has no `'region'` case either — a harmless no-op, same as
  // `rect` with nothing selected just above.
  if (tool === 'region' && currentDoc) {
    const cell = preview.pickCell(e.clientX, e.clientY);
    const region = currentDoc.regions.find((r) => r.id === session.getActiveRegionId());
    if (cell && region && cell.cx >= 0 && cell.cz >= 0 && cell.cx < currentDoc.w && cell.cz < currentDoc.h) {
      const on = !regionContains(currentDoc, region, cell.cx, cell.cz);
      const cells = new Set([cellKey(cell.cx, cell.cz)]);
      previewDrag = { mode: 'region', region, on, cells };
      // Live-preview-only: does not touch `doc`/`doc._rev` (`state.js`'s `touch()` never runs
      // here) — `viewport/overlay.js` reads this straight off `session` to tint the in-progress
      // stroke, distinctly from the region's own already-committed mask, while the pointer is
      // still down. `paintRegionMask` (`tools.js`) is the only thing that ever writes `doc`,
      // called once on `pointerup` below with the whole stroke.
      session.setRegionStroke({ on, cells });
      return;
    }
  }
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
    // Only a kind whose `ENTITIES` entry has a `moveTo` actually drags — one without it (link/
    // region/loopWaypoint/cameraPreset this slice) never flags `moved`, so `endPreviewDrag`
    // always resolves it as a click (`selectGizmo`) instead of silently dragging the sprite
    // somewhere `commitGizmoDrag` would then have nothing to commit, leaving it visually
    // stranded until the next full gizmo rebuild.
    if (ENTITIES[previewDrag.gizmo.kind]?.moveTo) {
      previewDrag.moved = true;
      const cell = preview.pickCell(e.clientX, e.clientY);
      // Visual-only: the doc is untouched until `pointerup`, so dragging across the whole map is
      // one undo step, not one per animation frame.
      if (cell) { const c = clampToMap(cell.cx, cell.cz); preview.moveGizmoTo(previewDrag.gizmo.kind, previewDrag.gizmo.index, c.cx, c.cz); }
    }
    return;
  }
  if (previewDrag.mode === 'region' && currentDoc) {
    const cell = preview.pickCell(e.clientX, e.clientY);
    if (cell && cell.cx >= 0 && cell.cz >= 0 && cell.cx < currentDoc.w && cell.cz < currentDoc.h) {
      previewDrag.cells.add(cellKey(cell.cx, cell.cz));
      // Same `Set` reference `previewDrag.cells` already is — `setRegionStroke` still needs to
      // re-run so `viewport/overlay.js`'s own subscriber notices this stroke object is "new"
      // enough to warrant a rebuild (its own change-signature check reads `stroke.cells.size`).
      session.setRegionStroke({ on: previewDrag.on, cells: previewDrag.cells });
    }
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
  } else if (previewDrag?.mode === 'rect' && currentDoc) {
    // One `paintRect` call, one undo step, exactly like the deleted 2D canvas's own rect-drag
    // commit — no live preview during the drag either, matching what it never had.
    const cell = preview.pickCell(e.clientX, e.clientY);
    if (cell) {
      const brush = session.getBrush();
      paintRect(currentDoc, history, {
        layer: session.getActiveLayer(), x0: previewDrag.x0, z0: previewDrag.z0,
        x1: cell.cx, z1: cell.cz, asset: session.getSelectedAsset(), rot: brush.rot, tint: brush.tint,
      });
      // `session.notify()`, not `refreshAll()` — see `commitGizmoDrag`'s own comment on why:
      // `paintRect` is called directly, bypassing `session.applyToolAt`'s own trailing
      // `notify()`, so this is the only thing that tells `viewport/overlay.js`'s collision tint
      // and `minimap.js` a rectangle of cells just changed.
      session.notify();
    }
  } else if (previewDrag?.mode === 'region' && currentDoc) {
    // One `paintRegionMask` call, one undo step, for the WHOLE drag — matching `rect`'s own
    // single-commit-on-release convention right above.
    const cells = [...previewDrag.cells].map((key) => {
      const [cx, cz] = key.split(',').map(Number);
      return { cx, cz };
    });
    paintRegionMask(currentDoc, history, { region: previewDrag.region, cells, on: previewDrag.on });
    session.setRegionStroke(null); // the live-preview highlight; the committed mask now speaks for itself
    session.notify();
  } else if (previewDrag?.mode === 'pan' && previewDownAt && session.getTool() === 'select' && preview) {
    const movedPx = Math.hypot(e.clientX - previewDownAt.x, e.clientY - previewDownAt.y);
    if (movedPx < 4) {
      const cell = preview.pickCell(e.clientX, e.clientY);
      // A bare 3D-pane click (no gizmo hit) means "select just this cell" — explicit
      // `kind: null, ref: null` so a PREVIOUS entity selection cannot leak through, since
      // `setSelection`'s plain `Object.assign` merge does not clear fields a patch omits.
      if (cell) session.setSelection({ cell, kind: null, ref: null });
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

// --- yaw keybind (Slice 6): `[`/`]` rotate the 3D view 90° left/right ------------------------
//
// `Q`/`E` were the natural first pick, but `E` is already the `eraser` tool's keybind
// (`kinds.js`'s `TOOLS` table, 4th column) — `panels.js`'s own tool-rail keydown listener would
// swallow a plain `E` before this one ever saw it. Brackets are unclaimed anywhere in the
// Studio (`rg "addEventListener\('keydown'" studio/` turns up only `panels.js`'s two listeners)
// and read as "rotate/step" in enough editors to need no on-screen legend. Guarded the same way
// `panels.js`'s own listener is (never while typing in a field) and only live once the 3D pane
// has actually finished booting (`preview` is assigned by `bootViewport`, called from `boot()`
// at the bottom of this file) — Slice 7 deleted the view switcher this guard used to also check,
// since there is no other view left to gate a `[`/`]` press on.
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
  if (!preview) return;
  if (e.key === '[') { e.preventDefault(); preview.setYaw(preview.getYaw() - 1); }
  else if (e.key === ']') { e.preventDefault(); preview.setYaw(preview.getYaw() + 1); }
});

// --- percorrer loop (the "Playtest" slot's real, honest stand-in — see the plan) -----------
let walking = false;
async function walkLoop() {
  const cells = currentDoc?.loop?.resolved?.cells;
  if (!cells?.length) return;
  if (walking) { walking = false; return; }
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
  if (key && key !== lastFocusKey && preview) preview.setFocus(sel.cell.cx, sel.cell.cz);
  lastFocusKey = key;
});

const inspector = makeInspector({ root: inspectorEl, session, docRef, history, onChange: refreshAll, getGameMaps: () => gameMapsCache });
const bottom = makeBottomPanel({ root: bottomEl, session, docRef, history });
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
  buildOverlayStrip();
  // Only reschedule the (expensive, debounced) 3D rebuild when the document actually changed —
  // `session.subscribe` also fires on bare hover/selection (`session.js`'s `setHover` calls
  // `notify()` unconditionally, not just on a drag), which used to snap the 3D camera back
  // to spawn on every mouse move over the 2D canvas. `state.js`'s `touch()` is the one thing
  // every real mutation calls, so its `_rev` counter is the signal that separates "something was
  // painted" from "the mouse moved" or "the selection changed".
  const rev = currentDoc?._rev ?? 0;
  if (currentDoc && rev !== lastRebuildRev) {
    lastRebuildRev = rev;
    schedulePreviewRebuild();
  }
}

function setDocument(doc) {
  currentDoc = doc;
  lastRebuildRev = doc._rev ?? 0; // a fresh/switched doc is handled by the explicit `preview.load()` below, not the rev-diff path
  invalidateValidation();
  session.setDoc(doc);
  history.clear();
  library.setTileset(doc.tileset);
  refreshAll();
  preview.load(serializeDocument(doc));
}

// Boot: eagerly boot the 3D viewport (Slice 7 — it is the Studio's only workspace now, nothing
// left to defer it past), mount the minimap over it, then open the game's first shipped map so
// the Studio starts on something real, not blank — falling back to a fresh blank map (still
// `bw2-adastra`) when none have been snapshotted yet.
(async function boot() {
  await bootViewport();
  makeMinimap({ root: previewContainer, session, docRef, viewport: preview });
  gameMapsCache = await listGameMaps();
  const doc = gameMapsCache.length
    ? createDocument(await loadGameMap(gameMapsCache[0].id))
    : createBlankDocument({ id: 'novo_mapa', name: 'Novo Mapa', w: 32, h: 32, tileset: 'bw2-adastra', environmentPreset: 'meadow', kind: 'hunt' });
  await library.init(doc.tileset);
  setDocument(doc);
})();

/**
 * canvas.js — the top-down 2D edit surface: one `<canvas>`, pan/zoom, a repaint per change,
 * and eleven toggleable overlays drawn straight from the document's own arrays (no fake
 * geometry — `reachableFrom`-style BFS, the real `loop.resolved`/`wild.resolved`, real
 * collision/tag data). See `state.js`'s header for why a DOM grid was never on the table at
 * this cell count with this many overlays.
 *
 * Tile art has no thumbnails in this pipeline (a documented scope cut — see the plan), so
 * cells are drawn as deterministic swatches: `catalog.js`'s `colorFor()` once the tileset's
 * catalog has loaded, a stable per-name hash colour before then, so a map is legible the
 * instant it opens instead of flashing grey until a fetch resolves.
 *
 * All non-visual editing state — which tool is active, the brush, the selection, hidden/locked
 * layers, overlay toggles, the hover cell, the single-cell tool dispatch — lives in
 * `session.js`, not here; this file only reads it (`session.getDoc()`, `session.overlays()`,
 * `session.getSelection()`, ...) and turns DOM pointer events into `session.applyToolAt(...)`
 * calls. It subscribes to `session`'s own `notify()` so any editing-state change re-renders
 * the canvas, regardless of which input surface — this one, or the 3D pane in `main.js` —
 * caused it. The 2D-gesture-specific `drag` state machine (pan/rect/loop-via-drag/paint) stays
 * local to this file: it is presentation logic for this one input surface, not session state.
 */

import { colorFor, peekCatalog, dominantImage, peekBitmap } from './catalog.js';
import { COLLISION_COLOR } from './kinds.js';
import { paintRect, setLoopVia } from './tools.js';
import { reachableFrom, CONTINUOUS_PAINT_TOOLS } from './session.js';

/** Below this cell size a 32² texture is noise, and drawImage-per-cell over a 64×64 map is
 *  the slow path — fall back to the flat swatch. */
const TEXTURE_MIN_PX = 6;

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 24% 26%)`;
}

/** Resolves one `loop.via` entry to a concrete cell — a marker name looked up in `doc.markers`
 *  (`null` if the marker was deleted out from under it, which `marker-missing` already flags),
 *  or an inline `{cx,cz}` waypoint used as-is. */
function viaPoint(doc, entry) {
  if (typeof entry === 'string') {
    const m = doc.markers.find((x) => x.name === entry);
    return m ? { cx: m.cx, cz: m.cz } : null;
  }
  return entry;
}

/** Index of the inline (non-marker-name) `loop.via` entry sitting exactly at `(cx,cz)`, or -1.
 *  Named-marker entries are moved by moving the marker itself (the existing `marker` tool), so
 *  only inline waypoints are ever drag targets for the `loop` tool. */
function inlineViaNear(doc, cx, cz) {
  const via = doc.loop?.via ?? [];
  return via.findIndex((entry) => typeof entry !== 'string' && entry.cx === cx && entry.cz === cz);
}

export function makeEditorCanvas({ canvas, history, session }) {
  const ctx2d = canvas.getContext('2d');
  const view = { ox: 8, oy: 8, cell: 14 };
  let drag = null;

  function toScreen(cx, cz) { return [view.ox + cx * view.cell, view.oy + cz * view.cell]; }
  function toCell(px, py) { return [Math.floor((px - view.ox) / view.cell), Math.floor((py - view.oy) / view.cell)]; }

  function fitView() {
    const doc = session.getDoc();
    if (!doc) return;
    const pad = 24;
    const availW = canvas.clientWidth - pad;
    const availH = canvas.clientHeight - pad;
    view.cell = Math.max(3, Math.min(40, Math.floor(Math.min(availW / doc.w, availH / doc.h))));
    view.ox = Math.max(8, (canvas.clientWidth - doc.w * view.cell) / 2);
    view.oy = Math.max(8, (canvas.clientHeight - doc.h * view.cell) / 2);
  }

  function resizeBackingStore() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function modelInfo(doc, name) {
    const cat = peekCatalog(doc.tileset);
    return cat?.byName?.get(name) ?? null;
  }

  /** Draws one cell/footprint's art: the real texture when loaded and large enough on screen,
   *  else the instant-paint flat swatch (`catalog.js`'s `colorFor`/local `hashColor`). */
  function drawArt(c, doc, overlays, name, info, x, y, w, h) {
    const image = overlays.textures && info ? dominantImage(info, peekCatalog(doc.tileset)) : null;
    const bitmap = view.cell >= TEXTURE_MIN_PX ? peekBitmap(doc.tileset, image) : null;
    if (bitmap) { c.drawImage(bitmap, x, y, w, h); return; }
    c.fillStyle = info ? colorFor(info) : hashColor(name);
    c.fillRect(x, y, w, h);
  }

  function render() {
    const doc = session.getDoc();
    if (!doc) return;
    const overlays = session.overlays();
    const selection = session.getSelection();
    resizeBackingStore();
    const c = ctx2d;
    c.imageSmoothingEnabled = false;
    c.fillStyle = '#0a0806';
    c.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    c.save();

    // --- base: tile layers, ascending order ---
    for (const [layerNum, grid] of [...doc.tileLayers.entries()].sort((a, b) => a[0] - b[0])) {
      if (!session.isLayerVisible(layerNum)) continue;
      for (const [key, cell] of grid) {
        const [cx, cz] = key.split(',').map(Number);
        const [x, y] = toScreen(cx, cz);
        drawArt(c, doc, overlays, cell.m, modelInfo(doc, cell.m), x, y, view.cell, view.cell);
      }
    }

    // --- overlay: collision tint ---
    if (overlays.collision) {
      for (let cz = 0; cz < doc.h; cz++) for (let cx = 0; cx < doc.w; cx++) {
        const kind = doc.collision[cz * doc.w + cx];
        const col = COLLISION_COLOR[kind];
        if (!col) continue;
        const [x, y] = toScreen(cx, cz);
        c.fillStyle = col;
        c.fillRect(x, y, view.cell, view.cell);
      }
    }

    // --- overlay: height shading ---
    if (overlays.height) {
      for (let cz = 0; cz < doc.h; cz++) for (let cx = 0; cx < doc.w; cx++) {
        const hgt = doc.height[cz * doc.w + cx];
        if (!hgt) continue;
        const [x, y] = toScreen(cx, cz);
        c.fillStyle = hgt > 0 ? `rgba(224,166,75,${Math.min(0.5, Math.abs(hgt) * 0.35 + 0.12)})` : `rgba(158,203,230,${Math.min(0.5, Math.abs(hgt) * 0.35 + 0.12)})`;
        c.fillRect(x, y, view.cell, view.cell);
      }
    }

    // --- overlay: tags ---
    if (overlays.tags) {
      c.fillStyle = 'rgba(158,203,230,0.85)';
      for (let cz = 0; cz < doc.h; cz++) for (let cx = 0; cx < doc.w; cx++) {
        if (!doc.tags[cz * doc.w + cx]?.length) continue;
        const [x, y] = toScreen(cx, cz);
        c.fillRect(x + view.cell - 4, y + 2, 2, 2);
      }
    }

    // --- overlay: reachability ---
    if (overlays.reach) {
      const seen = reachableFrom(doc, doc.spawn);
      for (let cz = 0; cz < doc.h; cz++) for (let cx = 0; cx < doc.w; cx++) {
        const kind = doc.collision[cz * doc.w + cx];
        if (kind === 'block' || kind === 'water') continue;
        const [x, y] = toScreen(cx, cz);
        c.fillStyle = seen[cz * doc.w + cx] ? 'rgba(127,201,140,0.14)' : 'rgba(214,104,91,0.30)';
        c.fillRect(x, y, view.cell, view.cell);
      }
    }

    // --- objects ---
    for (const obj of doc.objects) {
      if (!session.isLayerVisible(obj.layer)) continue;
      const info = modelInfo(doc, obj.m);
      const rot = (obj.rot ?? 0) & 3;
      const fw = rot & 1 ? (info?.h ?? 1) : (info?.w ?? 1);
      const fh = rot & 1 ? (info?.w ?? 1) : (info?.h ?? 1);
      const [x, y] = toScreen(obj.cx, obj.cz);
      drawArt(c, doc, overlays, obj.m, info, x, y, fw * view.cell, fh * view.cell);
      if (overlays.footprints) {
        c.strokeStyle = 'rgba(224,166,75,0.6)';
        c.setLineDash([3, 2]);
        c.strokeRect(x + 0.5, y + 0.5, fw * view.cell - 1, fh * view.cell - 1);
        c.setLineDash([]);
      }
      if (selection.kind === 'object' && selection.ref === obj) {
        c.strokeStyle = '#E0A64B';
        c.lineWidth = 2;
        c.strokeRect(x + 1, y + 1, fw * view.cell - 2, fh * view.cell - 2);
        c.lineWidth = 1;
      }
    }

    // --- grid lines ---
    if (overlays.grid) {
      c.strokeStyle = 'rgba(255,255,255,0.07)';
      c.lineWidth = 1;
      c.beginPath();
      for (let cx = 0; cx <= doc.w; cx++) {
        const x = view.ox + cx * view.cell;
        c.moveTo(x + 0.5, view.oy); c.lineTo(x + 0.5, view.oy + doc.h * view.cell);
      }
      for (let cz = 0; cz <= doc.h; cz++) {
        const y = view.oy + cz * view.cell;
        c.moveTo(view.ox, y + 0.5); c.lineTo(view.ox + doc.w * view.cell, y + 0.5);
      }
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.03)';
      c.strokeRect(view.ox + 0.5, view.oy + 0.5, doc.w * view.cell - 1, doc.h * view.cell - 1);
    }

    // --- loop ---
    if (overlays.loop && doc.loop?.resolved?.cells?.length) {
      c.strokeStyle = 'rgba(247,241,231,0.85)';
      c.lineWidth = 2;
      c.beginPath();
      const cells = doc.loop.resolved.cells;
      for (let i = 0; i < cells.length; i++) {
        const [x, y] = toScreen(cells[i].cx + 0.5, cells[i].cz + 0.5);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
      c.stroke();
      c.lineWidth = 1;
    }

    // --- loop (authored via) — the hand-edited waypoint sequence that produces `loop.resolved`
    // once (re-)stitched. Drawn dashed, in a different colour, so it never reads as the same
    // line as the (possibly stale) resolved cache above it — see `loop-stale`'s own note on why
    // the Studio never re-stitches live.
    if (overlays.loop && doc.loop?.via?.length) {
      const pts = doc.loop.via
        .map((entry, i) => (drag?.loopVia && drag.index === i ? { cx: drag.cx, cz: drag.cz } : viaPoint(doc, entry)))
        .filter(Boolean);
      if (pts.length > 1) {
        c.strokeStyle = 'rgba(224,166,75,0.85)';
        c.lineWidth = 1.5;
        c.setLineDash([5, 4]);
        c.beginPath();
        pts.forEach((p, i) => {
          const [x, y] = toScreen(p.cx + 0.5, p.cz + 0.5);
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        });
        c.closePath();
        c.stroke();
        c.setLineDash([]);
        c.lineWidth = 1;
      }
      // Inline waypoints get their own small square marker — named-marker entries already
      // render via the `markers` overlay below, so only anonymous ones need a mark here.
      c.fillStyle = 'rgba(224,166,75,0.9)';
      doc.loop.via.forEach((entry, i) => {
        if (typeof entry === 'string') return;
        const p = drag?.loopVia && drag.index === i ? { cx: drag.cx, cz: drag.cz } : entry;
        const [x, y] = toScreen(p.cx + 0.5, p.cz + 0.5);
        c.fillRect(x - 3, y - 3, 6, 6);
      });
    }

    // --- spawn points ---
    // Authored spawn points (`doc.spawnPoints`, placed by the `wildslot` tool) — each one is
    // a real respawn point with its own species list, not a derived cache any more.
    if (overlays.encounters && doc.spawnPoints?.length) {
      c.fillStyle = 'rgba(227,143,176,0.9)';
      for (const s of doc.spawnPoints) {
        const [x, y] = toScreen(s.cx + 0.5, s.cz + 0.5);
        c.beginPath(); c.arc(x, y, Math.max(2, view.cell * 0.28), 0, Math.PI * 2); c.fill();
      }
    }

    // --- lights ---
    if (overlays.lights) {
      doc.lights.forEach((l) => {
        const [x, y] = toScreen(l.x, l.z);
        const r = (l.radius ?? 6) * view.cell;
        const grad = c.createRadialGradient(x, y, 0, x, y, r);
        const hex = `#${(l.color ?? 0xffffff).toString(16).padStart(6, '0')}`;
        grad.addColorStop(0, `${hex}33`); grad.addColorStop(1, `${hex}00`);
        c.fillStyle = grad;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        c.fillStyle = hex;
        c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill();
        if (selection.kind === 'light' && selection.ref === l) {
          c.strokeStyle = '#E0A64B'; c.lineWidth = 2;
          c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.stroke();
          c.lineWidth = 1;
        }
      });
    }

    // --- camera presets ---
    if (overlays.cameras && doc.cameras?.presets) {
      c.font = '9px monospace';
      for (const [name, p] of Object.entries(doc.cameras.presets)) {
        // A preset frames either a named marker (hunts/interior style) or a bare cell
        // (city style) — `mapfile.js`'s two shapes for `cameras.presets[name]`.
        const at = p.marker ? doc.markers.find((m) => m.name === p.marker) : p;
        if (!at || at.cx == null || at.cz == null) continue;
        const [x, y] = toScreen(at.cx + 0.5, at.cz + 0.5);
        const isDefault = doc.cameras.default === name;
        c.strokeStyle = isDefault ? '#E0A64B' : 'rgba(224,166,75,0.55)';
        c.lineWidth = isDefault ? 2 : 1;
        const r = 6;
        c.strokeRect(x - r, y - r * 0.7, r * 2, r * 1.4);
        c.fillStyle = 'rgba(255,255,255,0.75)';
        c.fillText(name, x + r + 2, y + 3);
      }
      c.lineWidth = 1;
    }

    // --- markers ---
    if (overlays.markers) {
      for (const m of doc.markers) {
        const [x, y] = toScreen(m.cx + 0.5, m.cz + 0.5);
        c.fillStyle = selection.kind === 'marker' && selection.ref === m ? '#E0A64B' : '#7FC98C';
        c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.8)';
        c.font = '10px monospace';
        c.fillText(m.name, x + 6, y + 3);
      }
    }

    // --- spawn ---
    {
      const [x, y] = toScreen(doc.spawn.cx + 0.5, doc.spawn.cz + 0.5);
      c.fillStyle = '#E0A64B';
      c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 5, y + 4); c.lineTo(x - 5, y + 4); c.closePath(); c.fill();
    }

    // --- npcs ---
    for (const n of doc.npcs) {
      const [x, y] = toScreen(n.cx + 0.5, n.cz + 0.5);
      c.fillStyle = '#9ECBE6';
      c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill();
    }

    // --- selection ring ---
    if (selection.cell) {
      const [x, y] = toScreen(selection.cell.cx, selection.cell.cz);
      c.strokeStyle = '#E0A64B';
      c.lineWidth = 2;
      c.strokeRect(x + 1, y + 1, view.cell - 2, view.cell - 2);
      c.lineWidth = 1;
    }

    c.restore();
  }

  canvas.addEventListener('pointerdown', (e) => {
    const doc = session.getDoc();
    if (!doc) return;
    const rect = canvas.getBoundingClientRect();
    const [cx, cz] = toCell(e.clientX - rect.left, e.clientY - rect.top);
    const tool = session.getTool();
    if (tool === 'pan' || e.button === 1) { drag = { pan: true, x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }; return; }
    if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) return;
    if (tool === 'rect' && session.getSelectedAsset()) { drag = { rect: true, x0: cx, z0: cz }; return; }
    if (tool === 'loop') {
      const viaIndex = inlineViaNear(doc, cx, cz);
      // Clicking on top of an existing inline waypoint starts a reposition drag instead of
      // adding a new one — the drag stays visual-only (see `pointermove` below) until
      // `pointerup` commits it as a single `setLoopVia` call, one undo step per drag.
      if (viaIndex >= 0) { drag = { loopVia: true, index: viaIndex, cx, cz }; render(); return; }
    }
    session.applyToolAt(cx, cz, 'down');
    if (CONTINUOUS_PAINT_TOOLS.has(tool)) drag = { paint: true };
  });
  canvas.addEventListener('pointermove', (e) => {
    const doc = session.getDoc();
    if (!doc) return;
    const rect = canvas.getBoundingClientRect();
    if (drag?.pan) {
      view.ox = drag.ox + (e.clientX - drag.x);
      view.oy = drag.oy + (e.clientY - drag.y);
      render();
      return;
    }
    const [cx, cz] = toCell(e.clientX - rect.left, e.clientY - rect.top);
    if (drag?.loopVia) {
      // Visual-only while live — the doc is untouched until `pointerup`, so dragging across
      // the whole map is one undo step, matching the 3D gizmo drag pattern in `main.js`.
      if (cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h) { drag.cx = cx; drag.cz = cz; render(); }
      return;
    }
    if (drag?.paint && cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h) session.applyToolAt(cx, cz, 'move');
    // `setHover` notifies on its own (a bare hover triggers a notify, not just a drag — see
    // `main.js`'s own comment at its `session.subscribe` call site) — no second notify here.
    session.setHover(cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h ? { cx, cz } : null);
  });
  window.addEventListener('pointerup', (e) => {
    const doc = session.getDoc();
    if (!doc) { drag = null; return; }
    if (drag?.rect) {
      const rect = canvas.getBoundingClientRect();
      const [cx, cz] = toCell(e.clientX - rect.left, e.clientY - rect.top);
      const brush = session.getBrush();
      paintRect(doc, history, { layer: session.getActiveLayer(), x0: drag.x0, z0: drag.z0, x1: cx, z1: cz, asset: session.getSelectedAsset(), rot: brush.rot, tint: brush.tint });
      render();
    } else if (drag?.loopVia) {
      const via = doc.loop?.via ?? [];
      const next = via.map((entry, i) => (i === drag.index ? { cx: drag.cx, cz: drag.cz } : entry));
      setLoopVia(doc, history, { via: next });
      session.notify(); render();
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    if (!session.getDoc()) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    const [cx, cz] = toCell(mx, my);
    const next = Math.max(3, Math.min(48, view.cell - Math.sign(e.deltaY) * 2));
    view.ox = mx - cx * next; view.oy = my - cz * next;
    view.cell = next;
    render();
  }, { passive: false });

  // Any editing-state change — a paint stroke, an overlay toggle, a layer visibility flip, a
  // selection made from the 3D pane — re-renders this canvas, not just the surface that caused
  // it. This is what lets every non-visual mutator in `session.js` drop the `render()` call it
  // used to make directly (back when this state lived here) in favour of a plain `notify()`.
  session.subscribe(() => render());

  return {
    setDoc(d) {
      // `session.setDoc` resets and notifies on its own (see its own header comment) — no
      // separate notify needed here, only the visual follow-up: fit the view to the new doc's
      // size, then paint it.
      session.setDoc(d);
      fitView();
      render();
    },
    render,
    fitView() { fitView(); render(); },
    zoomBy(mult) { if (!session.getDoc()) return; view.cell = Math.max(3, Math.min(48, Math.round(view.cell * mult))); render(); },
    /** The 2D canvas's own cell-pixel-size presets (16/32/64 px per cell) — distinct from the
     *  3D preview's `pixelsPerUnit` ladder, but the same three round numbers for consistency. */
    setZoomPreset(px) { if (!session.getDoc()) return; view.cell = Math.max(3, Math.min(48, px)); render(); },
  };
}

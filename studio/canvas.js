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
 */

import { cellKey } from './state.js';
import { colorFor, peekCatalog } from './catalog.js';
import {
  paintCell, eraseCell, paintRect, fillRegion, setCollision, adjustHeight, toggleTag,
  setSpawn, placeMarker, placeObject, stackAt,
} from './tools.js';

const COLLISION_COLOR = {
  walk: 'rgba(127,201,140,0.0)', block: 'rgba(214,104,91,0.38)', water: 'rgba(95,168,220,0.40)',
  shallow: 'rgba(158,203,230,0.30)', door: 'rgba(224,166,75,0.42)', stairs: 'rgba(178,142,220,0.42)',
  ledge: 'rgba(226,150,80,0.46)', none: 'rgba(255,255,255,0.05)',
};
const COLLISION_PASSABLE = new Set(['walk', 'stairs', 'shallow', 'door']);
const DIR_DX = [0, -1, 0, 1];
const DIR_DZ = [1, 0, -1, 0];

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 24% 26%)`;
}

function passableAt(doc, cx, cz, fromDir) {
  if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) return false;
  const kind = doc.collision[cz * doc.w + cx];
  if (kind === 'ledge') {
    const dir = doc.tags[cz * doc.w + cx].find((t) => t.startsWith('ledge:'));
    return dir ? Number(dir.slice(6)) === fromDir : false;
  }
  return COLLISION_PASSABLE.has(kind);
}

function reachableFrom(doc, start) {
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

export function makeEditorCanvas({ canvas, history }) {
  const ctx2d = canvas.getContext('2d');
  let doc = null;
  const view = { ox: 8, oy: 8, cell: 14 };
  const overlays = { grid: true, collision: false, height: false, tags: false, footprints: true,
    markers: true, cameras: false, loop: true, encounters: true, lights: true, reach: false };
  let tool = 'select';
  let activeLayer = 0;
  let brush = { rot: 0, tint: 0xffffff, collision: 'walk', tag: 'tallgrass', heightStep: 0.25 };
  let selectedAsset = null; // { name, tileset, w, h }
  let selection = { cell: null, objectId: null, markerName: null };
  let drag = null;
  const listeners = new Set();

  function notify() { for (const fn of listeners) fn(); }

  function modelInfo(name) {
    const cat = peekCatalog(doc.tileset);
    return cat?.byName?.get(name) ?? null;
  }

  function toScreen(cx, cz) { return [view.ox + cx * view.cell, view.oy + cz * view.cell]; }
  function toCell(px, py) { return [Math.floor((px - view.ox) / view.cell), Math.floor((py - view.oy) / view.cell)]; }

  function fitView() {
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

  function render() {
    if (!doc) return;
    resizeBackingStore();
    const c = ctx2d;
    c.imageSmoothingEnabled = false;
    c.fillStyle = '#0a0806';
    c.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    c.save();

    // --- base: tile layers, ascending order ---
    for (const [, grid] of [...doc.tileLayers.entries()].sort((a, b) => a[0] - b[0])) {
      for (const [key, cell] of grid) {
        const [cx, cz] = key.split(',').map(Number);
        const [x, y] = toScreen(cx, cz);
        const info = modelInfo(cell.m);
        c.fillStyle = info ? colorFor(info) : hashColor(cell.m);
        c.fillRect(x, y, view.cell, view.cell);
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
      const info = modelInfo(obj.m);
      const rot = (obj.rot ?? 0) & 3;
      const fw = rot & 1 ? (info?.h ?? 1) : (info?.w ?? 1);
      const fh = rot & 1 ? (info?.w ?? 1) : (info?.h ?? 1);
      const [x, y] = toScreen(obj.cx, obj.cz);
      c.fillStyle = info ? colorFor(info) : hashColor(obj.m);
      c.fillRect(x, y, fw * view.cell, fh * view.cell);
      if (overlays.footprints) {
        c.strokeStyle = 'rgba(224,166,75,0.6)';
        c.setLineDash([3, 2]);
        c.strokeRect(x + 0.5, y + 0.5, fw * view.cell - 1, fh * view.cell - 1);
        c.setLineDash([]);
      }
      if (selection.objectId === obj.id) {
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

    // --- wild / encounter slots ---
    if (overlays.encounters && doc.wild?.resolved?.slots?.length) {
      c.fillStyle = 'rgba(227,143,176,0.9)';
      for (const s of doc.wild.resolved.slots) {
        const [x, y] = toScreen(s.cx + 0.5, s.cz + 0.5);
        c.beginPath(); c.arc(x, y, Math.max(2, view.cell * 0.28), 0, Math.PI * 2); c.fill();
      }
    }

    // --- lights ---
    if (overlays.lights) {
      for (const l of doc.lights) {
        const [x, y] = toScreen(l.x, l.z);
        const r = (l.radius ?? 6) * view.cell;
        const grad = c.createRadialGradient(x, y, 0, x, y, r);
        const hex = `#${(l.color ?? 0xffffff).toString(16).padStart(6, '0')}`;
        grad.addColorStop(0, `${hex}33`); grad.addColorStop(1, `${hex}00`);
        c.fillStyle = grad;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
        c.fillStyle = hex;
        c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill();
      }
    }

    // --- markers ---
    if (overlays.markers) {
      for (const m of doc.markers) {
        const [x, y] = toScreen(m.cx + 0.5, m.cz + 0.5);
        c.fillStyle = selection.markerName === m.name ? '#E0A64B' : '#7FC98C';
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

  function applyToolAt(cx, cz, kind) {
    if (kind === 'down') selection.cell = { cx, cz };
    switch (tool) {
      case 'select': {
        const stack = stackAt(doc, cx, cz);
        selection.cell = { cx, cz };
        selection.objectId = stack.find((s) => s.kind === 'object')?.id ?? null;
        break;
      }
      case 'pencil':
        if (selectedAsset) paintCell(doc, history, { layer: activeLayer, cx, cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint });
        break;
      case 'eraser':
        eraseCell(doc, history, { layer: activeLayer, cx, cz });
        break;
      case 'fill':
        if (selectedAsset) fillRegion(doc, history, { layer: activeLayer, cx, cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint });
        break;
      case 'coll':
        setCollision(doc, history, { cx, cz, kind: brush.collision });
        break;
      case 'height':
        adjustHeight(doc, history, { cx, cz, delta: brush.heightStep });
        break;
      case 'tag':
        toggleTag(doc, history, { cx, cz, tag: brush.tag });
        break;
      case 'spawn':
        setSpawn(doc, history, { cx, cz });
        break;
      case 'marker': {
        const name = prompt('Nome do marcador:');
        if (name) placeMarker(doc, history, { name, cx, cz });
        break;
      }
      case 'object':
        if (selectedAsset) {
          const obj = placeObject(doc, history, { m: selectedAsset.name, cx, cz, layer: activeLayer, rot: brush.rot, tint: brush.tint });
          selection.objectId = obj.id;
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
    render();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    const rect = canvas.getBoundingClientRect();
    const [cx, cz] = toCell(e.clientX - rect.left, e.clientY - rect.top);
    if (tool === 'pan' || e.button === 1) { drag = { pan: true, x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }; return; }
    if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) return;
    if (tool === 'rect' && selectedAsset) { drag = { rect: true, x0: cx, z0: cz }; return; }
    applyToolAt(cx, cz, 'down');
    if (tool === 'pencil' || tool === 'eraser' || tool === 'coll' || tool === 'height' || tool === 'tag') drag = { paint: true };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!doc) return;
    const rect = canvas.getBoundingClientRect();
    if (drag?.pan) {
      view.ox = drag.ox + (e.clientX - drag.x);
      view.oy = drag.oy + (e.clientY - drag.y);
      render();
      return;
    }
    const [cx, cz] = toCell(e.clientX - rect.left, e.clientY - rect.top);
    if (drag?.paint && cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h) applyToolAt(cx, cz, 'move');
    hoverCell = cx >= 0 && cz >= 0 && cx < doc.w && cz < doc.h ? { cx, cz } : null;
    notify();
  });
  window.addEventListener('pointerup', (e) => {
    if (!doc) { drag = null; return; }
    if (drag?.rect) {
      const rect = canvas.getBoundingClientRect();
      const [cx, cz] = toCell(e.clientX - rect.left, e.clientY - rect.top);
      paintRect(doc, history, { layer: activeLayer, x0: drag.x0, z0: drag.z0, x1: cx, z1: cz, asset: selectedAsset, rot: brush.rot, tint: brush.tint });
      render();
    }
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    if (!doc) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    const [cx, cz] = toCell(mx, my);
    const next = Math.max(3, Math.min(48, view.cell - Math.sign(e.deltaY) * 2));
    view.ox = mx - cx * next; view.oy = my - cz * next;
    view.cell = next;
    render();
  }, { passive: false });

  let hoverCell = null;

  return {
    setDoc(d) { doc = d; selection = { cell: null, objectId: null, markerName: null }; fitView(); render(); notify(); },
    render,
    fitView() { fitView(); render(); },
    zoomBy(mult) { if (!doc) return; view.cell = Math.max(3, Math.min(48, Math.round(view.cell * mult))); render(); },
    setOverlay(name, value) { overlays[name] = value; render(); },
    toggleOverlay(name) { overlays[name] = !overlays[name]; render(); notify(); },
    overlays: () => ({ ...overlays }),
    setTool(t) { tool = t; },
    getTool: () => tool,
    setActiveLayer(n) { activeLayer = n; },
    getActiveLayer: () => activeLayer,
    setSelectedAsset(a) { selectedAsset = a; },
    getSelectedAsset: () => selectedAsset,
    setBrush(patch) { Object.assign(brush, patch); },
    getBrush: () => ({ ...brush }),
    getSelection: () => ({ ...selection }),
    setSelection(patch) { Object.assign(selection, patch); render(); notify(); },
    getHover: () => hoverCell,
    stackAtSelection: () => (selection.cell ? stackAt(doc, selection.cell.cx, selection.cell.cz) : []),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/**
 * minimap.js — a small read-only overview canvas, pinned as a corner overlay on top of the 3D
 * viewport (Slice 7: the Studio's only workspace now that `canvas.js`'s 2D edit surface is
 * gone). Shows, at a glance: collision shading, every gizmo-bearing `ENTITIES` kind's own dot,
 * roughly where the 3D camera is currently focused, and validation issue pins — all read live
 * from `session`/`docRef`/`runValidation`, never a cached snapshot.
 *
 * Click-to-jump (`viewport.setFocus`) is its ONLY interaction. No painting, no tool dispatch, no
 * selection changes — this is deliberately NOT a second editor, just an orientation aid over the
 * one real one (`viewport/`). Repaints on every `session` notify (the same pattern `canvas.js`
 * used to follow, and `viewport/overlay.js` still does) — a full redraw is cheap at this scale
 * (one small canvas, a handful of rects and dots), so unlike `overlay.js` there is no
 * rev-diffing here.
 */

import { h } from '@/ui/dom/el.js';
import { COLLISION_COLOR } from './kinds.js';
import { ENTITIES } from './entities.js';
import { runValidation } from './validation.js';

// A square minimap, matched 1:1 to the canvas backing store (`studio.css`'s `.ms-minimap` pins
// it to the same size) — no devicePixelRatio scaling needed at a size this small.
const SIZE = 168;

/** @param {{root: HTMLElement, session: object, docRef: {get: () => object|null}, viewport: object}} opts
 *  `viewport` is `viewport/index.js`'s own returned API — only `getFocusCell` (read) and
 *  `setFocus` (the one write this file is allowed) are ever called on it. */
export function makeMinimap({ root, session, docRef, viewport }) {
  const canvas = h('canvas', { class: 'ms-minimap', width: SIZE, height: SIZE });
  const ctx = canvas.getContext('2d');
  root.appendChild(canvas);

  // Recomputed by every `render()` below, reused as-is by `pointerdown` — one fit/cell mapping,
  // not two copies that could drift apart.
  let cell = 1;
  let offX = 0;
  let offY = 0;

  function fit(doc) {
    cell = Math.max(1, Math.min(SIZE / doc.w, SIZE / doc.h));
    offX = (SIZE - doc.w * cell) / 2;
    offY = (SIZE - doc.h * cell) / 2;
  }

  function render() {
    const doc = docRef.get();
    ctx.fillStyle = '#0a0806';
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (!doc) return;
    fit(doc);

    // 1. collision shading — one flat rect per cell, `kinds.js`'s own palette (skip `walk`,
    // fully transparent there, same convention `viewport/overlay.js`'s collision quads use).
    for (let cz = 0; cz < doc.h; cz++) {
      for (let cx = 0; cx < doc.w; cx++) {
        const kind = doc.collision[cz * doc.w + cx];
        if (kind === 'walk') continue;
        ctx.fillStyle = COLLISION_COLOR[kind] ?? 'rgba(255,255,255,0.05)';
        ctx.fillRect(offX + cx * cell, offY + cz * cell, cell, cell);
      }
    }

    // 2. entity dots — every `ENTITIES` kind with a gizmo, in that kind's own gizmo color
    // (`entities.js` is the single source of truth for both; no second palette here).
    for (const entity of Object.values(ENTITIES)) {
      if (!entity.gizmo) continue;
      const color = `#${entity.color.toString(16).padStart(6, '0')}`;
      for (const ref of entity.list(doc)) {
        const pos = entity.positionOf(doc, ref);
        if (!pos) continue; // e.g. a camera preset whose marker was deleted out from under it
        const px = offX + (entity.space === 'world' ? pos.x : pos.cx + 0.5) * cell;
        const py = offY + (entity.space === 'world' ? pos.z : pos.cz + 0.5) * cell;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1.5, cell * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 3. camera focus indicator — roughly where the 3D rig is looking right now
    // (`viewport/index.js`'s `getFocusCell`, added this slice specifically for this minimap).
    const focus = viewport?.getFocusCell?.();
    if (focus) {
      const px = offX + (focus.cx + 0.5) * cell;
      const py = offY + (focus.cz + 0.5) * cell;
      const r = Math.max(4, cell * 0.8);
      ctx.strokeStyle = '#F2EBE0';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px - r / 2, py - r / 2, r, r);
    }

    // 4. validation issue pins — reuses `runValidation`'s own memoized result, never a second
    // pass over the document just for the minimap.
    const v = runValidation(doc);
    const pin = (issue, color) => {
      if (issue.at?.cx == null) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(offX + (issue.at.cx + 0.5) * cell, offY + (issue.at.cz + 0.5) * cell, Math.max(1.5, cell * 0.18), 0, Math.PI * 2);
      ctx.fill();
    };
    v.errors.forEach((i) => pin(i, '#D6685B'));
    v.warnings.forEach((i) => pin(i, '#E0A64B'));
  }

  // 5. click-to-jump — the ONLY interaction this file has. Resolves the click against the exact
  // `cell`/`offX`/`offY` the last `render()` computed, then hands off to the viewport — never a
  // `session.applyToolAt`/`setSelection` call, which would make this a second editor.
  canvas.addEventListener('pointerdown', (e) => {
    const doc = docRef.get();
    if (!doc) return;
    const rect = canvas.getBoundingClientRect();
    const cx = Math.floor((e.clientX - rect.left - offX) / cell);
    const cz = Math.floor((e.clientY - rect.top - offY) / cell);
    if (cx < 0 || cz < 0 || cx >= doc.w || cz >= doc.h) return;
    viewport?.setFocus?.(cx, cz);
  });

  session.subscribe(render);
  render();

  return { el: canvas };
}

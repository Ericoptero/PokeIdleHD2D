// @ts-check
/**
 * A window's pure geometry — the clamp math, the default (first-open) size, and the minimum a
 * panel may be resized to. Pulled out of `panels/common.js` for the same reason `gesture.js`
 * was in slice 015: it touches no DOM, so `ui/selftest.js` and `window.test.js` can both run it
 * under plain Node, and a browser-only bug (an accidental `document.` reference) fails there
 * too rather than only in a screenshot.
 *
 * What is *not* here: the actual per-panel Map of remembered geometry, and the live-drag
 * reconciliation against `screen.js`'s held gesture. Those are stateful — a real window has to
 * survive many repaints — and they live in `panels/common.js` next to `scrollMemory`, which
 * already does the identical job (a per-tag `Map` reconciling a caller's own value against a
 * live pointer gesture) for the mouse wheel. This file is the reducer half; that Map is the
 * `screen.js`/`gesture.js` split applied a second time.
 */

/** Every panel's window may shrink to this before it stops, unless `MIN_SIZES` overrides it.
 *  Small enough that the smallest authored window (`travel.js`'s 212x128) is well above it,
 *  large enough that the header, the close cross and one line of footer all still fit. */
export const MIN_SIZE = { w: 140, h: 90 };

/** Per-panel overrides, keyed by the same `windowId` `windowFrame` takes. Empty today — no
 *  panel has asked for a size floor different from `MIN_SIZE` — but the table exists so one
 *  can be added without changing every call site's shape. */
export const MIN_SIZES = {};

/** The minimum size a window carrying `id` may be resized to. */
export function minSizeFor(id) {
  return MIN_SIZES[id] ?? MIN_SIZE;
}

/**
 * The box a panel opens at the first time it is ever shown in a save — centred, at its own
 * authored (`fit()`-clamped) size. Identical to what `windowFrame` always did before this
 * slice, so a fresh save's first `KeyP` looks exactly as it did.
 * @param {number} w
 * @param {number} h
 * @param {{width:number, height:number}} buffer
 * @param {number} margin
 */
export function defaultBox(w, h, buffer, margin) {
  void margin; // kept for a symmetrical signature with clampMove/clampResize; centring ignores it
  return {
    x: Math.round((buffer.width - w) / 2),
    y: Math.round((buffer.height - h) / 2) - 1,
    w, h,
  };
}

/**
 * Clamps a window's **position**, keeping `w`/`h` fixed — what a title-bar drag needs. The
 * window's top-left corner never sits left of or above `margin`, and its bottom-right corner
 * never sits past the buffer's own margin on the far side (the `- 2` on the vertical axis
 * matches `fit()`'s existing footer-line allowance, so a dragged window clamps to exactly the
 * same floor a freshly opened one already respects).
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {{width:number, height:number}} buffer
 * @param {number} margin
 */
export function clampMove(box, buffer, margin) {
  const maxX = Math.max(margin, buffer.width - margin - box.w);
  const maxY = Math.max(margin, buffer.height - margin - 2 - box.h);
  return {
    ...box,
    x: Math.max(margin, Math.min(box.x, maxX)),
    y: Math.max(margin, Math.min(box.y, maxY)),
  };
}

/**
 * Clamps a window's **size**, keeping its top-left corner (`x`/`y`) fixed — what dragging the
 * bottom-right grip needs. Never below `min`, never so large that the bottom-right corner
 * passes the buffer's own margin from wherever the window currently sits.
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {{width:number, height:number}} buffer
 * @param {number} margin
 * @param {{w:number,h:number}} min
 */
export function clampResize(box, buffer, margin, min) {
  const maxW = Math.max(min.w, buffer.width - margin - box.x);
  const maxH = Math.max(min.h, buffer.height - margin - 2 - box.y);
  return {
    ...box,
    w: Math.max(min.w, Math.min(box.w, maxW)),
    h: Math.max(min.h, Math.min(box.h, maxH)),
  };
}

/** Applies a live pointer delta to a window being moved: only `x`/`y` change. */
export function applyMove(originBox, dx, dy) {
  return { ...originBox, x: originBox.x + dx, y: originBox.y + dy };
}

/** Applies a live pointer delta to a window being resized: only `w`/`h` change. */
export function applyResize(originBox, dx, dy) {
  return { ...originBox, w: originBox.w + dx, h: originBox.h + dy };
}

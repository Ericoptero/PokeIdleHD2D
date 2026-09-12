/**
 * The shell every full-screen panel is drawn in, and the small widgets they share.
 *
 * A panel is a window over a dimmed scene, never a page: the city stays visible behind it,
 * because in this game the shop *is* a building you are standing in front of.
 */

import { C, panel, header, well, row, button } from '../theme.js';
import { clampScroll } from '../gesture.js';
import {
  minSizeFor, defaultBox, clampMove, clampResize, applyMove, applyResize,
} from '../window.js';

export const MARGIN = 10;

/**
 * A wheel-driven scroll offset survives here, keyed by the widget's own `tag` — not by
 * `list()`'s or `scrollArea()`'s caller-owned `top`/`ruleTop`/etc. closure variable, which
 * `screen.js`'s wheel handler has no way to reach. Four of the six panels that call `list()`
 * never read its returned `top` back into their own state (`shop.js`, `boxes.js`,
 * `travel.js`, and `dex.js` does not call `list()` at all — see the correction in slice 015's
 * Inspected section), so this is the only place a wheel delta can live.
 *
 * A tag's memory is discarded, not applied, the moment the caller's own `top` changes from
 * what it was when the memory was recorded — a keyboard nav, a fresh selection or a fresh
 * `open()` always wins over a stale wheel position, which is what keeps this from fighting the
 * existing keyboard-driven scrolling every one of these panels already has.
 */
const scrollMemory = new Map();

/**
 * The effective top for `tag`, reconciling the caller's own `top` with any wheel memory.
 *
 * Exported (beyond `list()`/`scrollArea()`'s own use) for a caller with its own paging math —
 * `dex.js`'s multi-column national list is the first one — that wants the identical
 * wheel/keyboard reconciliation without adopting `list()`'s single-column row layout.
 */
export function reconciledTop(tag, callerTop, contentSize, viewSize) {
  const mem = scrollMemory.get(tag);
  const delta = mem && mem.callerTop === callerTop ? mem.delta : 0;
  return clampScroll(callerTop + delta, contentSize, viewSize);
}

/** Registers the wheel target for `tag` over `box`, moving by `step` units per wheel notch. */
export function registerScroll(g, box, tag, callerTop, contentSize, viewSize, step) {
  g.hit(box, {
    scroll: (deltaY) => {
      const mem = scrollMemory.get(tag);
      const delta = mem && mem.callerTop === callerTop ? mem.delta : 0;
      const dir = deltaY > 0 ? 1 : -1;
      const nextTop = clampScroll(callerTop + delta + dir * step, contentSize, viewSize);
      scrollMemory.set(tag, { callerTop, delta: nextTop - callerTop });
    },
  }, `${tag}-scroll`);
}

/**
 * A window's remembered position and size, keyed by its own `windowId` — the same shape as
 * `scrollMemory` above, and for the same reason: `windowFrame` is called fresh from inside
 * each panel's own closure every frame, so the one thing that has to survive a repaint is a
 * module-scope `Map`, not a caller-owned variable. Populated lazily, only once a window is
 * actually dragged or resized (slice 016) — a panel nobody has touched keeps recomputing
 * `defaultBox()` centred at its own authored size against whatever the buffer currently is,
 * which is what lets a browser resized between sessions still open a sane first window.
 * @type {Map<string, {x:number,y:number,w:number,h:number}>}
 */
const windowGeometry = new Map();

/**
 * The live gesture `windowFrame`'s drag/resize regions are reconciled against, keyed by
 * `${windowId}:move` or `${windowId}:resize`. Ephemeral — never persisted, never read outside
 * a live drag — the anchor (the window's own box and the pointer's position, both the instant
 * the gesture was first observed *in a paint*) it stores here is exactly what `reconciledTop`
 * stores for a wheel notch, one type up: a live delta reconciled against a stable base until
 * the gesture ends, at which point the result is written into `windowGeometry` and this entry
 * is dropped.
 *
 * "First observed in a paint" rather than "at the `pointerdown`" is a small, deliberate gap:
 * this module only ever runs inside `draw()`, called from a paint, and a paint only happens
 * when something is dirty — so any pointer travel between the actual `pointerdown` and the
 * next paint is not measured (`screen.js`'s pointerdown handler does mark the screen dirty
 * synchronously, so on a live, running game this is at most one `requestAnimationFrame` tick,
 * imperceptible against real mouse movement). A test with the frame loop paused
 * (`tests/flows/hud-windows.spec.js`'s `boot()`) has to force that first paint itself before
 * moving further, or it measures zero.
 * @type {Map<string, {px:number, py:number, base:object, live:object}>}
 */
const windowDrag = new Map();

/**
 * `screen.js`'s held gesture (`gesture.js`'s `DragState`), or `null` — set once per frame by
 * `index.js`'s own `draw()`, *before* the current panel's `draw()` runs, because `windowFrame`
 * is called from deep inside that panel's own closure and has no other way to reach it without
 * every one of its six call sites threading `screen.drag()` through `opts` by hand.
 * @type {import('../gesture.js').DragState|null}
 */
let activeDrag = null;
/** Called once per frame by `index.js`. Not exported for a panel to call — nothing outside
 *  `index.js`'s own `draw()` knows what the live gesture actually is. */
export function setActiveDrag(drag) { activeDrag = drag; }

/**
 * Reconciles one window's `kind` ('move' or 'resize') against the live gesture, exactly the
 * way `registerScroll`'s callback reconciles a wheel notch against `reconciledTop`'s memory:
 * while the matching drag is held, the return value tracks the pointer continuously off a
 * fixed anchor (never off the previous frame's own output, which would drift); the instant it
 * is no longer held, whatever was last computed is written back into `windowGeometry` as the
 * new persisted geometry and the anchor is forgotten.
 */
function reconcileDrag(id, kind, base, buffer, m, min) {
  const key = `${id}:${kind}`;
  // `activeDrag.tag` is the region's own diagnostic tag (`'window-drag'`/`'window-resize'`,
  // read by `screen.regions()` and by `tests/flows/hud-windows.spec.js`) — the *payload*'s own
  // `kind` is what says which gesture this is, exactly the shape `windowFrame` registers below.
  const payloadKind = kind === 'move' ? 'window' : 'resize';
  const active = !!activeDrag && activeDrag.payload?.kind === payloadKind && activeDrag.payload?.id === id;
  let mem = windowDrag.get(key);
  if (active) {
    if (!mem) mem = { px: activeDrag.x, py: activeDrag.y, base, live: base };
    const dx = activeDrag.x - mem.px;
    const dy = activeDrag.y - mem.py;
    const live = kind === 'move'
      ? clampMove(applyMove(mem.base, dx, dy), buffer, m)
      : clampResize(applyResize(mem.base, dx, dy), buffer, m, min);
    mem.live = live;
    windowDrag.set(key, mem);
    return live;
  }
  if (mem) {
    windowDrag.delete(key);
    windowGeometry.set(id, mem.live);
    return mem.live;
  }
  return base;
}

/**
 * Every window's geometry, JSON-safe — the `ui` save slice's own payload
 * (`index.js`'s `saveState`). Only ids a player has actually dragged or resized appear; a
 * panel never touched keeps opening at its authored default (`defaultBox`), which is exactly
 * what a save with no `ui` slice at all already did before this slice.
 */
export function serializeWindows() {
  return Object.fromEntries(windowGeometry);
}

/** The inverse of `serializeWindows()` — `index.js`'s `loadState`. Malformed entries (not the
 *  four numeric fields) are skipped rather than crashing the restore of every other window. */
export function restoreWindows(value) {
  windowGeometry.clear();
  if (!value || typeof value !== 'object') return;
  for (const [id, box] of Object.entries(value)) {
    if (!box || typeof box !== 'object') continue;
    const { x, y, w, h } = box;
    if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    windowGeometry.set(id, { x, y, w, h });
  }
}

/**
 * The gutter between a window and the edge of the buffer. It is a *fraction* of the buffer
 * rather than a constant, because the buffer is not one size: 640x360 at 1080p, 533x299 at
 * 1600x900 and 426x239 at 720p (`screen.js` takes the renderer's own internal size). A
 * constant 10 that looks generous at 640 is 2.3 % of a 426-wide screen.
 */
export const margin = (g) => Math.max(5, Math.min(10, Math.round(g.width / 64)));

/**
 * Clamps an *authored* window size to the buffer actually being drawn into.
 *
 * This is the fix for the round-1 fault that mattered most: every panel hard-coded the size
 * that happened to fit the 640x360 buffer of a 1920x1080 window, so at 1600x900 (533x299)
 * two of them started at a negative x and the first character of nine labels was off the
 * left edge, and at 1280x720 (426x239) every panel was destroyed. Nothing may pass a raw
 * number to `windowFrame` any more; it passes `fit(g, w, h)`.
 */
export function fit(g, w, h) {
  const m = margin(g);
  return {
    w: Math.min(w, g.width - m * 2),
    h: Math.min(h, g.height - m * 2 - 2),
  };
}

/** The resize grip's own side, in UI buffer pixels — the bottom-right corner of every window. */
const GRIP = 8;

/**
 * Three short diagonal dashes stepping into the corner — the standard resize affordance, drawn
 * in the same stone the scrollbar thumb already uses (`list()`, above) rather than a plain box:
 * a magenta placeholder is a bug and a blank square reads as an unfinished corner, not as a
 * control.
 */
function drawGrip(g, box) {
  const cx = box.x + box.w - 2;
  const cy = box.y + box.h - 2;
  for (let i = 0; i < 3; i++) {
    const o = i * 3;
    g.fill(cx - o, cy - o, 1, 1, C.stoneLight);
    g.fill(cx - o - 1, cy - o - 1, 1, 1, C.stoneShadow);
  }
}

/**
 * The window. Returns the content rect inside the header and above the footer.
 *
 * `windowId` is required (slice 016): it is the key `windowGeometry`/`serializeWindows`
 * remembers this window's position and size under, so two panels must never pass the same
 * one. Every existing call site passes its own panel `id` (`'party'`, `'shop'`, …).
 * @param {object} g painter
 * @param {{windowId:string, title:string, bar?:string, edge?:string, light?:string, footer?:string, footerRight?:string, onClose?:Function, w?:number, h?:number}} opts
 */
export function windowFrame(g, opts) {
  const m = margin(g);
  const id = opts.windowId;
  const buffer = { width: g.width, height: g.height };
  const min = minSizeFor(id);

  // Clamped here as well as by the caller: a panel that forgets `fit()` still cannot draw
  // itself off the screen, which is the whole of issue 1. This is now only the *authored*
  // default's clamp — the window's actual, remembered geometry is clamped again below,
  // against whatever the buffer is *this* frame, which is what lets a save opened on a
  // smaller screen than it was last dragged/resized on still land inside it.
  const fitW = Math.min(opts.w ?? g.width - m * 2, g.width - m * 2);
  const fitH = Math.min(opts.h ?? g.height - m * 2 - 2, g.height - m * 2 - 2);

  let base = windowGeometry.get(id) ?? defaultBox(fitW, fitH, buffer, m);
  base = clampResize(base, buffer, m, min);
  base = clampMove(base, buffer, m);

  let box = reconcileDrag(id, 'move', base, buffer, m, min);
  box = reconcileDrag(id, 'resize', box, buffer, m, min);

  g.scrim(0, 0, g.width, g.height, 0.5);
  if (opts.onClose) g.hit({ x: 0, y: 0, w: g.width, h: g.height }, opts.onClose, 'scrim');

  panel(g, box, { paper: C.wallBase });
  // The window's own paper swallows a pointerdown so it stops here instead of falling through
  // to the full-buffer scrim registered above: every widget the caller draws inside `box`
  // afterward (a row, a button, the close cross below) registers its own hit region strictly
  // later and so wins over this one, by the same "last one wins" rule the scrim itself relies
  // on — but the plain paper in between them had nothing registered on it at all, which was
  // the bug (DECISIONS #84).
  g.hit(box, { swallow: true }, 'window-body');
  const inner = header(g, box, opts.title, {
    bar: opts.bar ?? C.roofBase, edge: opts.edge ?? C.roofDeep, light: opts.light ?? C.roofLight,
  });

  // The title bar itself, a drag region (slice 016): picked up on `pointerdown` instead of
  // calling anything (`screen.js`'s `r.drag` branch), so a plain click that never moves does
  // nothing — which is the point, a window does not open or close from its own title bar.
  // Registered *before* the close cross below, so "last one wins" still gives the cross the
  // few pixels of overlap in the top-right corner.
  g.hit({ x: box.x + 1, y: box.y + 1, w: box.w - 2, h: 13 }, {
    drag: { payload: { kind: 'window', id } },
  }, 'window-drag');

  // close cross, top right of the header
  const x0 = box.x + box.w - 14;
  g.text(x0, box.y + 3, '✗', C.wallHi, { shadow: opts.edge ?? C.roofDeep });
  if (opts.onClose) g.hit({ x: x0 - 3, y: box.y + 1, w: 14, h: 13 }, opts.onClose, 'close');

  let footH = 0;
  if (opts.footer) {
    footH = 11;
    const fy = box.y + box.h - footH - 1;
    g.fill(box.x + 1, fy, box.w - 2, footH, C.wallShadow);
    g.fill(box.x + 1, fy, box.w - 2, 1, C.wallDeep);
    // The footer is a hint, not a headline: when the window is narrow the right-hand
    // summary is dropped before the key legend is allowed to overprint it.
    const rw = opts.footerRight ? g.measure(opts.footerRight) : 0;
    const room = box.w - 10 - (rw ? rw + 8 : 0) - GRIP - 2;
    if (g.measure(opts.footer) <= room || !rw) {
      g.text(box.x + 5, fy + 2, opts.footer, C.shadowInk, { max: box.w - 10 - GRIP - 2 });
      if (rw) g.textRight(box.x + box.w - 5 - GRIP - 2, fy + 2, opts.footerRight, C.shadowInk);
    } else {
      g.text(box.x + 5, fy + 2, opts.footer, C.shadowInk, { max: box.w - 10 - GRIP - 2 });
    }
  }

  // The resize grip, bottom-right — drawn and registered last so it wins the corner over the
  // footer strip it sits inside (every one of this module's six windows passes a `footer`, so
  // that strip is always reserved and a panel's own content, laid out against the rect this
  // function returns, never reaches into it).
  drawGrip(g, box);
  g.hit({ x: box.x + box.w - GRIP, y: box.y + box.h - GRIP, w: GRIP, h: GRIP }, {
    drag: { payload: { kind: 'resize', id } },
  }, 'window-resize');

  return { x: inner.x + 3, y: inner.y + 3, w: inner.w - 6, h: inner.h - 6 - footH, box };
}

/**
 * A titled sub-box inside a window. Returns the rect inside it.
 *
 * The header-colour rule, written down because round 1 had three of them in one window with
 * nothing explaining which was which: **the window's own title bar carries the module's
 * colour** (red for the dex and the party, blue for the shop and storage) and **every
 * section bar inside it is stone**. A section bar is never coloured to mean something.
 */
export function section(g, box, title, opts = {}) {
  g.fill(box.x, box.y, box.w, 9, opts.bar ?? C.stoneShadow);
  g.fill(box.x, box.y, box.w, 1, opts.light ?? C.stoneBase);
  g.text(box.x + 3, box.y + 1, title, opts.ink ?? C.wallHi);
  const rest = { x: box.x, y: box.y + 9, w: box.w, h: box.h - 9 };
  return well(g, rest, opts);
}

/**
 * A scrolling list. Draws only the visible window of `items`, registers a hit region per
 * row, and paints a scrollbar when there is more than fits.
 *
 * The mouse wheel, over this list's own box, moves that window by whole rows — registered as
 * a `scroll` region over the whole box, *before* the per-row regions below so an ordinary
 * click still finds whichever row is on top of it (`screen.js`'s `pick()` is "last one wins";
 * this region carries no `on`, so it never wins a click, only a wheel event, which `screen.js`
 * looks for by the `scroll` field itself, not by z-order).
 *
 * @param {object} g
 * @param {{x,y,w,h}} box
 * @param {object} opts `{ items, rowH, top, selected, onPick, draw(g, item, rect, state), tag, dark }`
 * @returns {{rows:number, top:number}}
 */
export function list(g, box, opts) {
  const rowH = opts.rowH ?? 12;
  const rows = Math.max(1, Math.floor(box.h / rowH));
  const total = opts.items.length;
  const tag = opts.tag ?? 'row';
  const callerTop = opts.top ?? 0;
  const top = reconciledTop(tag, callerTop, total, rows);
  const maxTop = Math.max(0, total - rows);
  const hasBar = total > rows;
  const listW = hasBar ? box.w - 4 : box.w;

  registerScroll(g, box, tag, callerTop, total, rows, 3);

  for (let i = 0; i < rows && top + i < total; i++) {
    const item = opts.items[top + i];
    const rect = { x: box.x, y: box.y + i * rowH, w: listW, h: rowH };
    const selected = opts.selected === top + i;
    const ink = row(g, rect, { selected, disabled: item.disabled, dark: !!opts.dark });
    opts.draw(g, item, rect, { selected, ink, index: top + i });
    if (opts.onPick && !item.disabled) {
      g.hit(rect, () => opts.onPick(top + i, item), `${tag}-${top + i}`);
    }
  }

  if (hasBar) {
    const bx = box.x + box.w - 3;
    g.fill(bx, box.y, 3, box.h, opts.dark ? C.deepDeep : C.wallDeep);
    const thumbH = Math.max(6, Math.round(box.h * rows / total));
    const ty = box.y + Math.round((box.h - thumbH) * (maxTop ? top / maxTop : 0));
    g.fill(bx, ty, 3, thumbH, opts.dark ? C.deepLight : C.stoneBase);
    g.fill(bx, ty, 3, 1, opts.dark ? C.deepDim : C.stoneLight);
  }
  return { rows, top };
}

/**
 * A scrolling window over content that is not a uniform row list — a wrapped paragraph, a
 * detail pane, anything currently truncated at a hard `y` budget rather than reachable
 * (`boxes.js`, `shop.js`'s multiplier column and `automation.js`'s settings column all still
 * do this; wiring them onto this widget is out of this slice's scope, per its own "Out of
 * scope" section — this builds the primitive, unused as yet).
 *
 * Unlike `list()`, the caller draws whatever it wants at whatever `y` it wants (`opts.draw`
 * receives the scrolled `top`, in pixels, to subtract from its own layout), clipped to `box`
 * with `g.clip` so content that overflows is cut at the edge instead of bleeding into
 * whatever is drawn after it — never simply left off the bottom the way a hard budget does.
 *
 * @param {object} g
 * @param {{x,y,w,h}} box
 * @param {object} opts `{ contentH, top, draw(g, box, top), tag }`
 * @returns {{top:number}}
 */
export function scrollArea(g, box, opts) {
  const contentH = Math.max(0, opts.contentH ?? 0);
  const tag = opts.tag ?? 'scrollArea';
  const callerTop = opts.top ?? 0;
  const top = reconciledTop(tag, callerTop, contentH, box.h);
  const hasBar = contentH > box.h;
  const barW = hasBar ? 4 : 0;

  registerScroll(g, box, tag, callerTop, contentH, box.h, 24);
  g.clip(box.x, box.y, box.w - barW, box.h, () => opts.draw(g, { ...box, w: box.w - barW }, top));

  if (hasBar) {
    const bx = box.x + box.w - 3;
    const thumbH = Math.max(6, Math.round(box.h * box.h / contentH));
    const maxTop = Math.max(0, contentH - box.h);
    const ty = box.y + Math.round((box.h - thumbH) * (maxTop ? top / maxTop : 0));
    g.fill(bx, box.y, 3, box.h, C.wallDeep);
    g.fill(bx, ty, 3, thumbH, C.stoneBase);
    g.fill(bx, ty, 3, 1, C.stoneLight);
  }
  return { top };
}

/** A labelled key/value line — the workhorse of every detail pane. */
export function stat(g, x, y, label, value, opts = {}) {
  g.text(x, y, label, opts.labelInk ?? C.shadowInk);
  g.textRight(x + (opts.w ?? 120), y, String(value), opts.ink ?? C.ink);
}

/** A row of small buttons. Returns the total width drawn. */
export function tabs(g, x, y, items, { active, onPick, h = 13, gap = 2, tag = 'tab' } = {}) {
  let cx = x;
  items.forEach((item, i) => {
    const w = g.measure(item.label) + 10;
    const box = { x: cx, y, w, h };
    const ink = button(g, box, { active: active === item.id, disabled: item.disabled });
    g.textCentre(box.x + w / 2, y + 3, item.label, ink);
    if (onPick && !item.disabled) g.hit(box, () => onPick(item.id, i), `${tag}-${item.id}`);
    cx += w + gap;
  });
  return cx - x - gap;
}

/** A wide push button with its own label. */
export function action(g, box, label, { disabled = false, active = false, danger = false, onPick, tag = 'action' } = {}) {
  const ink = button(g, box, { disabled, active, danger });
  g.textCentre(box.x + box.w / 2, box.y + Math.round((box.h - 7) / 2), label, ink);
  if (onPick && !disabled) g.hit(box, onPick, tag);
  return box;
}

export { C, panel, header, well, row, button };

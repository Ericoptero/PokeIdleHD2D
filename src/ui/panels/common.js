/**
 * The shell every full-screen panel is drawn in, and the small widgets they share.
 *
 * A panel is a window over a dimmed scene, never a page: the city stays visible behind it,
 * because in this game the shop *is* a building you are standing in front of.
 */

import { C, panel, header, well, row, button } from '../theme.js';

export const MARGIN = 10;

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

/**
 * The window. Returns the content rect inside the header and above the footer.
 * @param {object} g painter
 * @param {{title:string, bar?:string, edge?:string, light?:string, footer?:string, onClose?:Function, w?:number, h?:number}} opts
 */
export function windowFrame(g, opts) {
  const m = margin(g);
  // Clamped here as well as by the caller: a panel that forgets `fit()` still cannot draw
  // itself off the screen, which is the whole of issue 1.
  const w = Math.min(opts.w ?? g.width - m * 2, g.width - m * 2);
  const h = Math.min(opts.h ?? g.height - m * 2 - 2, g.height - m * 2 - 2);
  const box = { x: Math.round((g.width - w) / 2), y: Math.round((g.height - h) / 2) - 1, w, h };

  g.scrim(0, 0, g.width, g.height, 0.5);
  if (opts.onClose) g.hit({ x: 0, y: 0, w: g.width, h: g.height }, opts.onClose, 'scrim');

  panel(g, box, { paper: C.wallBase });
  const inner = header(g, box, opts.title, {
    bar: opts.bar ?? C.roofBase, edge: opts.edge ?? C.roofDeep, light: opts.light ?? C.roofLight,
  });

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
    const room = box.w - 10 - (rw ? rw + 8 : 0);
    if (g.measure(opts.footer) <= room || !rw) {
      g.text(box.x + 5, fy + 2, opts.footer, C.shadowInk, { max: box.w - 10 });
      if (rw) g.textRight(box.x + box.w - 5, fy + 2, opts.footerRight, C.shadowInk);
    } else {
      g.text(box.x + 5, fy + 2, opts.footer, C.shadowInk, { max: box.w - 10 });
    }
  }
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
 * @param {object} g
 * @param {{x,y,w,h}} box
 * @param {object} opts `{ items, rowH, top, selected, onPick, draw(g, item, rect, state) }`
 * @returns {{rows:number, top:number}}
 */
export function list(g, box, opts) {
  const rowH = opts.rowH ?? 12;
  const rows = Math.max(1, Math.floor(box.h / rowH));
  const total = opts.items.length;
  const maxTop = Math.max(0, total - rows);
  const top = Math.max(0, Math.min(maxTop, opts.top ?? 0));
  const hasBar = total > rows;
  const listW = hasBar ? box.w - 4 : box.w;

  for (let i = 0; i < rows && top + i < total; i++) {
    const item = opts.items[top + i];
    const rect = { x: box.x, y: box.y + i * rowH, w: listW, h: rowH };
    const selected = opts.selected === top + i;
    const ink = row(g, rect, { selected, disabled: item.disabled, dark: !!opts.dark });
    opts.draw(g, item, rect, { selected, ink, index: top + i });
    if (opts.onPick && !item.disabled) {
      g.hit(rect, () => opts.onPick(top + i, item), `${opts.tag ?? 'row'}-${top + i}`);
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

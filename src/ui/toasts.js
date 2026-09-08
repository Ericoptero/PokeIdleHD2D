/**
 * Toasts. Several modules already emit `ui:toast` (§4) — `collection` on a new dex entry or
 * a shiny, `automation` when a rule fires, `economy` on a Wonder Trade voucher, `offline` on
 * a welcome-back — and until now nothing drew them.
 *
 * They stack from the bottom of the screen upward, newest at the bottom, and each carries a
 * coloured spine keyed to `kind` so a warning reads as one before the sentence does. Ageing
 * is driven by the frame delta, and **stops entirely in showcase mode**: a screenshot of the
 * same URL has to give the same pixels (ARCHITECTURE §6.3), and a toast that is 400 ms old
 * in one capture and 900 ms old in the next is a diff.
 */

import { C, TOAST_COLOUR, panel } from './theme.js';
import { wrap } from './font.js';

const LIFETIME_S = 4.5;
const MAX_VISIBLE = 4;
const WIDTH = 168;

export function makeToasts({ frozen = false } = {}) {
  /** @type {{text:string, kind:string, age:number, lines:string[]}[]} */
  let queue = [];

  function push(text, kind = 'info') {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const entry = { text: t, kind: TOAST_COLOUR[kind] ? kind : 'info', age: 0, lines: wrap(t, WIDTH - 23) };
    queue.push(entry);
    // Older ones fall off the top rather than growing the stack off the screen.
    if (queue.length > MAX_VISIBLE) queue = queue.slice(-MAX_VISIBLE);
    return entry;
  }

  /** @returns {boolean} whether anything changed and the screen needs a repaint */
  function step(dt) {
    if (frozen || !queue.length) return false;
    let changed = false;
    for (const t of queue) t.age += dt;
    const before = queue.length;
    queue = queue.filter((t) => t.age < LIFETIME_S);
    if (queue.length !== before) changed = true;
    return changed;
  }

  function draw(g, { bottom = g.height - 6, right = g.width - 6 } = {}) {
    let y = bottom;
    for (let i = queue.length - 1; i >= 0; i--) {
      const t = queue[i];
      const h = 8 + t.lines.length * 9;
      const box = { x: right - WIDTH, y: y - h, w: WIDTH, h };
      const colour = TOAST_COLOUR[t.kind];
      panel(g, box, { paper: C.wallLight });
      // A rail *and* a mark. Colour alone cannot carry the kind — the round-1 rails were
      // 1.3 luminance apart between `good` and `info` — so the rail is a value ramp and the
      // mark is a shape that reads with no colour vision at all.
      g.fill(box.x + 1, box.y + 1, 4, box.h - 2, colour.bar);
      g.fill(box.x + 1, box.y + 1, 4, 1, colour.edge);
      g.fill(box.x + 6, box.y + 1, 8, box.h - 2, colour.edge);
      g.textCentre(box.x + 10, box.y + Math.round((box.h - 7) / 2), colour.mark ?? '·', C.wallHi);
      t.lines.forEach((line, n) => g.text(box.x + 17, box.y + 4 + n * 9, line, C.ink));
      y -= h + 3;
    }
  }

  return {
    push,
    step,
    draw,
    count: () => queue.length,
    clear() { queue = []; },
    /** The showcase stages a stack without waiting for the game to produce one. */
    all: () => queue.slice(),
  };
}

/**
 * The message box (src/ui/index.js "dialogue boxes").
 *
 * Nothing in the tree publishes NPC lines yet — `city` spawns its cast with routes and no
 * script — so this is the seam rather than a consumer of one: any module can call
 * `ctx.get('ui').say(text, { speaker })` with a string or an array of pages, and the box
 * behaves the way the games' does. Z, Enter, Space or a click advances a page; the last page
 * closes it. The HUD stays up behind it, because in the mainline a message is not a menu.
 */

import { C, panel } from '../theme.js';
import { wrap } from '../font.js';

export function makeDialogue(app) {
  /** @type {string[]} */ let pages = [];
  let index = 0;
  let speaker = null;
  let onDone = null;

  function advance() {
    index += 1;
    if (index < pages.length) { app.markDirty(); return; }
    const done = onDone;
    app.close();
    if (typeof done === 'function') { try { done(); } catch { /* the caller's problem */ } }
  }

  return {
    id: 'dialogue',
    /** Keeps the wallet and the clock; stands the party bar and the button strip down. */
    hidesHud: true,
    open(opts = {}) {
      const text = opts.text ?? opts.pages ?? '';
      pages = (Array.isArray(text) ? text : [text]).map((t) => String(t ?? '')).filter(Boolean);
      if (!pages.length) pages = ['…'];
      index = 0;
      speaker = opts.speaker ? String(opts.speaker) : null;
      onDone = opts.onDone ?? null;
    },
    close() { pages = []; index = 0; speaker = null; onDone = null; },
    /** How many pages are left, for a caller that wants to know. */
    remaining: () => Math.max(0, pages.length - index),

    key(ev) {
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') { advance(); return true; }
      return false;
    },

    draw(g) {
      // The box is as tall as the message, not four lines tall regardless: a one-line
      // greeting in a 46 px frame is three empty lines of cream across the bottom third of
      // the screen, which is what round 1 shipped.
      const lines = wrap(pages[index] ?? '', g.width - 36).slice(0, 3);
      const h = lines.length * 11 + 20;
      const box = { x: 8, y: g.height - h - 8, w: g.width - 16, h };
      panel(g, box, { paper: C.wallLight });
      // the inner rule the DS boxes have, one pixel in from the frame
      g.fill(box.x + 3, box.y + 3, box.w - 6, 1, C.wallDeep);
      g.fill(box.x + 3, box.y + box.h - 4, box.w - 6, 1, C.wallDeep);
      g.fill(box.x + 3, box.y + 3, 1, box.h - 6, C.wallDeep);
      g.fill(box.x + box.w - 4, box.y + 3, 1, box.h - 6, C.wallDeep);

      if (speaker) {
        const w = g.measure(speaker) + 12;
        const tab = { x: box.x + 8, y: box.y - 12, w, h: 13 };
        panel(g, tab, { paper: C.martBase, bevel: C.martLight, shade: C.martDeep, drop: false });
        g.text(tab.x + 6, tab.y + 3, speaker, C.white, { shadow: C.martDeep });
      }

      lines.forEach((line, i) => g.text(box.x + 10, box.y + 8 + i * 11, line, C.ink));

      // the advance marker, and the page count when there is more than one
      g.text(box.x + box.w - 14, box.y + box.h - 13, '▾', C.roofBase);
      if (pages.length > 1) {
        g.textRight(box.x + box.w - 22, box.y + box.h - 13, `${index + 1}/${pages.length}`, C.stoneShadow);
      }
      g.hit(box, advance, 'dialogue');
    },
  };
}

/**
 * The start menu — the spine of the whole UI, and the only panel that opens without a key
 * of its own. It is a column on the right in the Black & White idiom rather than a modal in
 * the middle, so the city stays readable behind it while the player picks.
 */

import { C, panel, windowFrame } from './common.js';
import { pokeball } from '../theme.js';

const ITEMS = [
  { id: 'travel', label: 'TRAVEL', blurb: 'the city and four hunts' },
  { id: 'party', label: 'PARTY', blurb: 'who leads, and the bench' },
  { id: 'trainer', label: 'TRAINER', blurb: 'level, buffs, upgrades and the dex' },
  { id: 'shop', label: 'SHOP', blurb: 'four shops and the deal' },
  { id: 'boxes', label: 'BOXES', blurb: '960 slots, ten orders' },
  { id: 'dex', label: 'DEX', blurb: 'by generation and type' },
  { id: 'automation', label: 'AUTO', blurb: 'what the party does on its own' },
  { id: 'away', label: 'REPORT', blurb: 'the last away card' },
  { id: 'close', label: 'CLOSE', blurb: '' },
];

export function makeMenu(app) {
  let cursor = 0;

  function choose(id) {
    if (id === 'close') { app.close(); return; }
    if (id === 'away') { app.openReport(); return; }
    app.open(id);
  }

  return {
    id: 'menu',
    open() { cursor = 0; },
    close() {},

    key(ev) {
      const code = ev.code;
      if (code === 'ArrowUp' || code === 'KeyW') { cursor = (cursor + ITEMS.length - 1) % ITEMS.length; app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { cursor = (cursor + 1) % ITEMS.length; app.markDirty(); return true; }
      if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { choose(ITEMS[cursor].id); return true; }
      return false;
    },

    draw(g) {
      const w = 156;
      const rowH = 21;
      const h = ITEMS.length * rowH + 18;
      // Anchored to the **MENU button that opened it**, bottom-right above the strip, and
      // never above the clock. Round 1 pinned it to y = 22 in the top-right corner, where it
      // sliced the clock's phase line in half every single time it opened, and where it was
      // nowhere near the control that summoned it.
      const strip = app.stripBox?.();
      const bottom = (strip ? strip.y : g.height - 17) - 4;
      const clock = app.clockBox?.();
      const floorY = clock ? clock.y + clock.h + 4 : 22;
      const box = { x: g.width - w - 6, y: Math.max(floorY, bottom - h), w, h };
      g.hit({ x: 0, y: 0, w: g.width, h: g.height }, () => app.close(), 'scrim');
      panel(g, box, { paper: C.wallBase });
      // Swallows a pointerdown on the column's own paper so it stops here rather than falling
      // through to the scrim above it — every row registers its own hit region strictly later,
      // in the `forEach` below, and so still wins over this one (DECISIONS #84).
      g.hit(box, { swallow: true }, 'window-body');

      // The header is the Poké Ball mark rather than a word: it is the game's own bullet.
      g.fill(box.x + 1, box.y + 1, box.w - 2, 12, C.roofBase);
      g.fill(box.x + 1, box.y + 1, box.w - 2, 1, C.roofLight);
      g.fill(box.x + 1, box.y + 13, box.w - 2, 1, C.roofDeep);
      pokeball(g, box.x + 4, box.y + 3);
      g.text(box.x + 14, box.y + 3, 'MENU', C.white, { shadow: C.roofDeep });

      ITEMS.forEach((item, i) => {
        const r = { x: box.x + 3, y: box.y + 16 + i * rowH, w: box.w - 6, h: rowH - 1 };
        const on = cursor === i || app.hovered() === `menu-${item.id}`;
        if (on) {
          g.fill(r.x, r.y, r.w, r.h, C.martBase);
          g.fill(r.x, r.y, r.w, 1, C.martLight);
          g.fill(r.x, r.y + r.h - 1, r.w, 1, C.martDeep);
        }
        // Leading, measured against the font's own metrics rather than guessed: a capital
        // occupies rows 0..6 of its cell (`font.js` BASELINE 6) so the label's baseline is
        // r.y + 9, and the blurb's ascenders start at r.y + 12 — three clear rows. Round 1
        // put them one row apart and the descenders of "the last away card" tucked under the
        // bowl of the O, so REPORT read as REPQRT.
        g.text(r.x + 12, r.y + 3, item.label, on ? C.white : C.ink);
        if (item.blurb) g.text(r.x + 12, r.y + 12, item.blurb, on ? C.white : C.stoneShadow, { max: r.w - 15 });
        if (on) g.text(r.x + 3, r.y + 3, '▸', C.glowLight);
        g.hit(r, () => { cursor = i; choose(item.id); }, `menu-${item.id}`);
      });
    },
  };
}

export { windowFrame };

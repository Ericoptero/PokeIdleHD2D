/**
 * Storage. `collection` owns 960 slots across 32 boxes, ten sort orderings and the
 * duplicate-release rules (§5.10); this is the box screen over them.
 *
 * The grid is the real 6×5 box `collection.layout()` reports, drawn with the species' own
 * overworld sprite at its authored size, so a box of Pokemon looks like the same art that is
 * walking around outside. The right-hand pane is the one place in the UI where the numbers a
 * collector cares about — IV total and grade, level, origin, whether it is the last of its
 * species — are all in one frame, because "is this one safe to release" is the only question
 * this screen exists to answer.
 */

import { C, windowFrame, section, tabs, action, list, well, fit } from './common.js';
import { meter } from '../theme.js';

/** The sort labels, shortened to fit one row of tabs across the window. */
const SHORT_SORT = {
  species: 'Dex', name: 'Name', level: 'Level', iv: 'IV', bst: 'BST',
  shiny: 'Shiny', type: 'Type', caught: 'Caught', favourite: 'Fav', duplicates: 'Dupes',
};
const IV_KEYS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

const isLive = (api) => !!api && api.__missing === undefined;

export function makeBoxes(app) {
  let boxIndex = 0;
  let slot = 0;
  let sortMode = 'species';
  let confirmRelease = false;

  const col = () => app.ctx.get('collection');

  function boxes() {
    const c = col();
    if (!isLive(c) || typeof c.boxes !== 'function') return [];
    return c.boxes() ?? [];
  }

  function layout() {
    const c = col();
    const l = isLive(c) && typeof c.layout === 'function' ? c.layout() : null;
    return { cols: l?.cols ?? 6, rows: l?.rows ?? 5, capacity: l?.capacity ?? 30 };
  }

  function release(entry) {
    const c = col();
    if (!isLive(c) || !entry) return;
    c.release?.(entry.uid ?? entry);
    confirmRelease = false;
    app.markDirty();
  }

  return {
    id: 'boxes',
    full: true,
    open(opts = {}) {
      confirmRelease = false;
      if (Number.isFinite(opts.box)) boxIndex = opts.box;
      if (Number.isFinite(opts.slot)) slot = opts.slot;
    },
    close() { confirmRelease = false; },

    key(ev) {
      const { cols, capacity } = layout();
      const all = boxes();
      const code = ev.code;
      if (code === 'ArrowLeft' || code === 'KeyA') { slot = (slot + capacity - 1) % capacity; app.markDirty(); return true; }
      if (code === 'ArrowRight' || code === 'KeyD') { slot = (slot + 1) % capacity; app.markDirty(); return true; }
      if (code === 'ArrowUp' || code === 'KeyW') { slot = (slot + capacity - cols) % capacity; app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { slot = (slot + cols) % capacity; app.markDirty(); return true; }
      if (code === 'BracketLeft' || code === 'PageUp') { boxIndex = (boxIndex + all.length - 1) % Math.max(1, all.length); app.markDirty(); return true; }
      if (code === 'BracketRight' || code === 'PageDown') { boxIndex = (boxIndex + 1) % Math.max(1, all.length); app.markDirty(); return true; }
      return false;
    },

    draw(g) {
      const c = col();
      const all = boxes();
      const { cols, rows, capacity } = layout();
      if (boxIndex >= all.length) boxIndex = 0;
      const box = all[boxIndex] ?? null;
      const stats = isLive(c) && typeof c.stats === 'function' ? c.stats() : null;
      const entry = box ? (box[slot] ?? null) : null;

      const win = windowFrame(g, {
        title: 'STORAGE', bar: C.martBase, edge: C.martDeep, light: C.martLight,
        footer: '↑←↓→ move    [ ] change box    X close',
        footerRight: stats
          ? `${stats.stored} stored · ${stats.uniqueOwned} species · ${stats.shiny} ★`
          : '',
        onClose: () => app.close(), ...fit(g, 502, 264),
      });

      // --- sort row ---------------------------------------------------------
      const modes = isLive(c) && typeof c.sortModes === 'function' ? c.sortModes() : [];
      g.text(win.x, win.y + 3, 'SORT', C.shadowInk);
      tabs(g, win.x + 24, win.y, modes.map((m) => ({ id: m.id, label: SHORT_SORT[m.id] ?? m.label })), {
        active: sortMode, tag: 'sort', h: 12,
        onPick: (id) => { sortMode = id; c.sort?.(id); app.markDirty(); },
      });

      const bodyY = win.y + 16;
      const bodyH = win.h - 16;

      // --- box list ---------------------------------------------------------
      const leftW = Math.max(62, Math.min(80, Math.round(win.w * 0.17)));
      const leftBox = section(g, { x: win.x, y: bodyY, w: leftW, h: bodyH }, 'BOXES',
        { bar: C.stoneShadow, light: C.stoneBase, dark: true });
      const rowH = 11;
      const visible = Math.floor(leftBox.h / rowH);
      const top = Math.max(0, Math.min(all.length - visible, boxIndex - Math.floor(visible / 2)));
      list(g, leftBox, {
        items: all.map((b, i) => ({ b, i })), rowH, top, selected: boxIndex, tag: 'box', dark: true,
        onPick: (i) => { boxIndex = i; slot = 0; app.markDirty(); },
        draw: (gg, item, rect, st) => {
          gg.text(rect.x + 4, rect.y + 2, item.b.name ?? `Box ${item.i + 1}`, st.ink, { max: rect.w - 26 });
          gg.textRight(rect.x + rect.w - 4, rect.y + 2, `${item.b.count}`, st.selected ? C.glassHi : C.deepDim);
        },
      });

      // --- the grid ---------------------------------------------------------
      // The cell is whatever fits, never 34: at 720p the buffer is 426x239 and six columns
      // of 34 plus a 108 px detail pane is wider than the whole window, and five rows of 34
      // is taller than the body. Both axes are solved before a single slot is drawn.
      const detailMin = 104;
      const cellByW = Math.floor((win.w - leftW - 8 - detailMin - 6) / cols);
      const cellByH = Math.floor((bodyH - 9 - 6 - 11) / rows);
      const cell = Math.max(14, Math.min(34, cellByW, cellByH));
      const gridW = cols * cell + 6;
      const gridX = win.x + leftW + 4;
      // The box interior is the deep recess — the dark blue tray a DS PC box is, which is
      // also what gives this window a shadow end and lets the sprites read as art rather
      // than as thirty stickers on a tan sheet.
      const grid = section(g, { x: gridX, y: bodyY, w: gridW, h: bodyH },
        (box?.name ?? 'BOX').toUpperCase(), { bar: C.stoneShadow, light: C.stoneBase, dark: true });
      for (let i = 0; i < capacity; i++) {
        const cx = grid.x + 3 + (i % cols) * cell;
        const cy = grid.y + 3 + Math.floor(i / cols) * cell;
        const r = { x: cx, y: cy, w: cell - 2, h: cell - 2 };
        const occupant = box ? box[i] : null;
        const on = i === slot;
        g.fill(r.x, r.y, r.w, r.h, on ? C.martBase : C.deepShade);
        g.fill(r.x, r.y, r.w, 1, on ? C.martLight : C.deepLight);
        g.fill(r.x, r.y + r.h - 1, r.w, 1, on ? C.martDeep : C.deepDeep);
        if (occupant) {
          app.hud.drawIcon(g, iconOf(app, occupant), r.x, r.y, r.w);
          // A badge, not a bare glyph: a 5x5 star sitting alone on the cell's top border
          // reads as though it belongs to the row above (the critic filed it as exactly
          // that). On its own ink chip it belongs to this cell and nothing else.
          if (occupant.shiny) {
            g.fill(r.x + r.w - 8, r.y + 1, 7, 7, C.ink);
            g.text(r.x + r.w - 7, r.y + 2, '★', C.glowLight);
          }
        }
        g.hit(r, () => { slot = i; confirmRelease = false; }, `slot-${i}`);
      }
      const used = box ? box.count : 0;
      g.text(grid.x + 3, grid.y + rows * cell + 5, `${used} / ${capacity} slots used`, C.deepDim);

      // --- detail -----------------------------------------------------------
      const rightX = gridX + gridW + 4;
      const rightW = win.x + win.w - rightX;
      const detail = section(g, { x: rightX, y: bodyY, w: rightW, h: bodyH }, 'DETAIL',
        { bar: C.stoneShadow, light: C.stoneBase });

      if (!entry) {
        g.text(detail.x + 5, detail.y + 6, 'empty slot', C.stoneShadow);
        g.text(detail.x + 5, detail.y + 16, 'Pokemon caught by the idle', C.stoneShadow, { max: detail.w - 10 });
        g.text(detail.x + 5, detail.y + 24, 'loop land here automatically.', C.stoneShadow, { max: detail.w - 10 });
      } else {
        let y = detail.y + 5;
        const port = { x: detail.x + 4, y, w: 36, h: 36 };
        g.fill(port.x, port.y, port.w, port.h, C.glassDeep);
        app.hud.drawIcon(g, iconOf(app, entry), port.x + 2, port.y + 2, 32);
        g.text(port.x + 42, y + 2, entry.nickname ?? entry.display, C.ink, { max: detail.w - 50 });
        g.text(port.x + 42, y + 12, `Lv ${entry.level}`, C.shadowInk);
        if (entry.shiny) g.text(port.x + 42, y + 22, '★ shiny', C.glowDeep);
        y += 40;

        // Everything below is drawn against a **budget**, because the pane is 236 px tall at
        // 1080p and 163 at 720p: round 1 laid it out for the tall case and at 720p the IV
        // bars ran under the buttons and the buttons ran into the footer. Rows are drawn in
        // priority order and stop at the line the controls start on.
        const by = detail.y + detail.h - 16;
        const contentBottom = by - 12;

        // `ivPct` and `ivGrade` take the *total*, not the entry (src/collection/dex.js).
        const ivPct = isLive(c) && typeof c.ivPct === 'function' ? c.ivPct(entry.ivTotal ?? 0) : null;
        const grade = isLive(c) && typeof c.ivGrade === 'function' ? c.ivGrade(entry.ivTotal ?? 0) : null;
        const facts = [
          ['Type', (entry.types ?? []).join(' / ') || '—'],
          ['Dex', entry.dexId ? `#${String(entry.dexId).padStart(3, '0')}` : '—'],
          ['IV total', `${entry.ivTotal ?? 0}${ivPct != null ? `  ${Math.round(ivPct)}%` : ''}`],
          ...(grade ? [['Grade', String(grade)]] : []),
          ['Origin', entry.origin ?? '—'],
          ['Gen', entry.gen ? `${entry.gen}` : '—'],
          ...(entry.ball ? [['Ball', entry.ball]] : []),
        ];
        // The six individual values are the number a collector releases on, so they get the
        // room before the last two facts do.
        const ivBlock = IV_KEYS.length * 8 + 4;
        for (const [label, value] of facts) {
          if (y + 9 + ivBlock > contentBottom) break;
          row2(g, detail, y, label, value);
          y += 9;
        }
        y += 4;
        for (const [key, label] of IV_KEYS) {
          if (y + 8 > contentBottom) break;
          const iv = Number(entry.ivs?.[key] ?? 0);
          g.text(detail.x + 5, y, label, C.shadowInk);
          meter(g, { x: detail.x + 26, y: y + 1, w: detail.w - 52, h: 5 }, iv / 31,
            { fill: iv >= 28 ? C.glowBase : C.martBase, light: iv >= 28 ? C.glowLight : C.martLight, back: C.wallDeep });
          g.textRight(detail.x + detail.w - 5, y, String(iv), C.ink);
          y += 8;
        }

        const owned = isLive(c) && typeof c.owned === 'function' ? c.owned(entry.species) : 0;
        const onlyOne = owned <= 1;
        // Not red: "the only one you hold" is a fact about the collection, not an error, and
        // red is this palette's error colour. It is the lamp amber the rest of the UI uses
        // for "pay attention to this".
        if (!confirmRelease) {
          g.text(detail.x + 5, by - 10, onlyOne ? 'the only one you hold' : `${owned} of this species held`,
            onlyOne ? C.glowDeep : C.stoneShadow, { max: detail.w - 10 });
        }
        if (!confirmRelease) {
          // Release is the one irreversible act in the module, so it is the *small* control
          // and the reversible one is the wide plate beside it. Round 1 had RELEASE as a
          // full-width cream bar — the brightest, biggest thing on the screen.
          const favOn = !!entry.favourite;
          const relW = Math.max(52, Math.round((detail.w - 10) * 0.38));
          const favW = detail.w - 10 - relW;
          action(g, { x: detail.x + 4, y: by, w: favW, h: 13 },
            favOn ? '★ FAVOURITE' : 'MARK FAVOURITE', {
              active: favOn,
              onPick: () => { c.favourite?.(entry.uid ?? entry, !favOn); app.markDirty(); },
              tag: 'favourite',
            });
          action(g, { x: detail.x + 6 + favW, y: by, w: relW, h: 13 }, 'RELEASE', {
            danger: true, onPick: () => { confirmRelease = true; }, tag: 'release',
          });
        } else {
          g.text(detail.x + 5, by - 10, onlyOne ? 'Release your only one?' : 'Release for good?', C.roofShadow);
          action(g, { x: detail.x + 4, y: by, w: (detail.w - 10) / 2, h: 13 }, 'YES, RELEASE', {
            danger: true, onPick: () => release(entry), tag: 'release-yes',
          });
          action(g, { x: detail.x + 6 + (detail.w - 10) / 2, y: by, w: (detail.w - 10) / 2, h: 13 }, 'KEEP', {
            active: true, onPick: () => { confirmRelease = false; }, tag: 'release-no',
          });
        }
      }
    },
  };
}

/** A storage entry carries a species *key*; the sprite URL comes from `pokemon`. */
function iconOf(app, entry) {
  const pokemon = app.ctx.get('pokemon');
  const url = isLive(pokemon) && typeof pokemon.spriteUrl === 'function'
    ? pokemon.spriteUrl(entry.species, { shiny: !!entry.shiny }) : null;
  return { url, shiny: !!entry.shiny, display: entry.display };
}

function row2(g, box, y, label, value) {
  g.text(box.x + 5, y, label, C.shadowInk);
  g.textRight(box.x + box.w - 5, y, String(value), C.ink);
}

export { list, well };

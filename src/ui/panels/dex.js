/**
 * The dex. `collection` records every sighting and every catch and reports completion per
 * generation and per type (§5.10); this panel is that report.
 *
 * It is deliberately a *progress* screen and not a species browser: 1025 rows of "not seen"
 * tell the player nothing, while "gen 1 is 12 %, ghost is 0 %" tells them where to hunt
 * next. The list on the right is the dex in national order with the seen/caught state each
 * record actually carries, so the two readings — the summary and the entries — cannot
 * disagree.
 */

import { C, windowFrame, section, list, tabs, well, fit, reconciledTop, registerScroll } from './common.js';
import { meter, pokeball } from '../theme.js';

const isLive = (api) => !!api && api.__missing === undefined;

/** The eighteen types, in the colours the games use. Kept short so a bar can be labelled. */
const TYPE_COLOUR = {
  normal: '#A8A878', fire: '#F08030', water: '#6890F0', electric: '#F8D030', grass: '#78C850',
  ice: '#98D8D8', fighting: '#C03028', poison: '#A040A0', ground: '#E0C068', flying: '#A890F0',
  psychic: '#F85888', bug: '#A8B820', rock: '#B8A038', ghost: '#705898', dragon: '#7038F8',
  dark: '#705848', steel: '#B8B8D0', fairy: '#EE99AC',
};

export function makeDex(app) {
  let tab = 'gen';
  let top = 0;
  let cursor = 0;

  const col = () => app.ctx.get('collection');

  return {
    id: 'dex',
    /** Inert data since slice 016 (DECISIONS #85): nothing reads `panel.full` for sizing or
     *  anything else any more. Kept as a record of which panels used to stand the whole HUD
     *  down while open — only `dialogue`'s `hidesHud` still does that — and for `battle.js`'s
     *  own header comment, which contrasts its `full: false` against every panel here. */
    full: true,
    open() { top = 0; cursor = 0; },
    close() {},

    key(ev) {
      const code = ev.code;
      if (code === 'ArrowUp' || code === 'KeyW') { cursor = Math.max(0, cursor - 1); app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { cursor += 1; app.markDirty(); return true; }
      if (code === 'ArrowLeft' || code === 'ArrowRight') { tab = tab === 'gen' ? 'type' : 'gen'; app.markDirty(); return true; }
      return false;
    },

    draw(g) {
      const c = col();
      const completion = isLive(c) && typeof c.completion === 'function' ? c.completion() : null;
      const stats = isLive(c) && typeof c.stats === 'function' ? c.stats() : null;
      const records = isLive(c) && typeof c.records === 'function' ? (c.records() ?? []) : [];

      const win = windowFrame(g, {
        windowId: 'dex', reserved: app.hudReserved(),
        title: 'POKéDEX', bar: C.roofBase, edge: C.roofDeep, light: C.roofLight,
        footer: '↑↓ scroll    ←→ generation / type    X close',
        onClose: () => app.close(), ...fit(g, 560, 288),
      });

      // --- the headline -----------------------------------------------------
      // Every column is a fraction of the window that actually got drawn, never a constant:
      // the window is 540 px wide at 1080p, 501 at 1600x900 and 398 at 720p.
      const headW = Math.max(118, Math.min(158, Math.round(win.w * 0.3)));
      const headH = Math.min(100, Math.max(74, win.h - 90));
      const head = section(g, { x: win.x, y: win.y, w: headW, h: headH }, 'COMPLETION',
        { bar: C.stoneShadow, light: C.stoneBase });
      const caught = completion?.caught ?? 0;
      const total = completion?.total ?? 0;
      pokeball(g, head.x + 5, head.y + 6);
      g.text(head.x + 16, head.y + 6, `${caught} / ${total}`, C.ink);
      g.textRight(head.x + head.w - 5, head.y + 6, `${(completion?.caughtPct ?? 0).toFixed(1)}%`, C.roofShadow);
      meter(g, { x: head.x + 5, y: head.y + 17, w: head.w - 10, h: 7 }, total ? caught / total : 0,
        { fill: C.roofBase, light: C.roofLight, back: C.wallDeep });
      let hy = head.y + 29;
      const statRows = [
        ['Seen', `${completion?.seen ?? 0}`],
        ['Living dex', `${(completion?.livingPct ?? 0).toFixed(1)}%`],
        ['Forms', `${completion?.forms?.caught ?? 0} / ${completion?.forms?.total ?? 0}`],
        ['Shinies', `${stats?.shiny ?? 0}`],
        ['Stored', `${stats?.stored ?? 0} of ${(isLive(c) && typeof c.totalSlots === 'function' ? c.totalSlots() : 0)}`],
        ['Best IV', stats?.averageIvPct != null ? `avg ${stats.averageIvPct}%` : '—'],
      ];
      const statStep = Math.max(7, Math.min(9, Math.floor((head.h - 31) / statRows.length)));
      for (const [label, value] of statRows) {
        g.text(head.x + 5, hy, label, C.shadowInk);
        g.textRight(head.x + head.w - 5, hy, value, C.ink);
        hy += statStep;
      }

      // --- generation / type breakdown --------------------------------------
      const midY = win.y + headH + 4;
      const midH = win.h - headH - 4;
      // The switches sit on the section's own header bar, right-aligned — so the title has to
      // shorten when the column does, or they land on top of it (they did at 720p, where the
      // column is 121 px wide and "BY GENERATION" is 76 of them).
      const midTitle = headW >= 150
        ? (tab === 'gen' ? 'BY GENERATION' : 'BY TYPE')
        : (tab === 'gen' ? 'BY GEN' : 'BY TYPE');
      const mid = section(g, { x: win.x, y: midY, w: headW, h: midH }, midTitle,
        { bar: C.stoneShadow, light: C.stoneBase });
      tabs(g, Math.max(win.x + g.measure(midTitle) + 8, win.x + headW - 58), midY,
        [{ id: 'gen', label: 'GEN' }, { id: 'type', label: 'TYPE' }], {
          active: tab, h: 9, tag: 'dextab', onPick: (id) => { tab = id; app.markDirty(); },
        });

      const bars = tab === 'gen'
        ? (completion?.byGen ?? []).map((b) => ({ label: `Gen ${b.gen}`, pct: b.pct, caught: b.caught, total: b.total, colour: C.martBase }))
        : (completion?.byType ?? []).map((b) => ({ label: b.type, pct: b.pct, caught: b.caught, total: b.total, colour: TYPE_COLOUR[b.type] ?? C.stoneBase }));
      const barH = Math.max(8, Math.min(13, Math.floor((mid.h - 4) / Math.max(1, bars.length))));
      bars.forEach((b, i) => {
        const y = mid.y + 2 + i * barH;
        if (y + barH > mid.y + mid.h) return;
        const labelW = Math.max(26, Math.min(40, Math.round(mid.w * 0.28)));
        const countW = Math.max(38, Math.min(46, Math.round(mid.w * 0.32)));
        g.text(mid.x + 4, y + 1, b.label, C.ink, { max: labelW - 4 });
        const bx = mid.x + labelW + 4;
        const bw = mid.w - labelW - 4 - countW;
        meter(g, { x: bx, y: y + 1, w: bw, h: barH - 3 }, b.total ? b.caught / b.total : 0,
          { fill: b.colour, light: C.wallHi, back: C.wallDeep });
        g.textRight(mid.x + mid.w - 4, y + 1, `${b.caught}/${b.total}`, C.shadowInk);
      });

      // --- the records ------------------------------------------------------
      const listX = win.x + headW + 4;
      const listW = win.x + win.w - listX;
      // The whole national dex, not only the rows `collection` has a record for: an empty
      // dex is 995 locked slots, and showing thirty rows on a screen this size would be a
      // list of what you have rather than a dex. The species table is `pokemon`'s.
      const entries = nationalList(app, records);
      // The entries sit in the deep recess, light type on dark, the way a DS dex list does —
      // and it is what puts a shadow end into a window that otherwise had none.
      const listBox = section(g, { x: listX, y: win.y, w: listW, h: win.h }, 'ENTRIES',
        { bar: C.stoneShadow, light: C.stoneBase, dark: true });

      if (!entries.length) {
        g.text(listBox.x + 6, listBox.y + 8, 'Nothing recorded yet.', C.deepDim);
        g.text(listBox.x + 6, listBox.y + 18, 'The idle loop meets Pokemon while you are away —', C.deepDim, { max: listBox.w - 12 });
        g.text(listBox.x + 6, listBox.y + 27, 'every sighting and catch lands here.', C.deepDim, { max: listBox.w - 12 });
        return;
      }

      const rowH = 11;
      // Three columns is what 540 px of window affords; 398 px affords two. A column
      // narrower than this chops the name and the ×N count against each other, which is
      // exactly what the third column did at 1600x900.
      const cols = Math.max(1, Math.min(3, Math.floor((listBox.w - 4) / 122)));
      const colW = Math.floor((listBox.w - 4) / cols);
      const perCol = Math.floor(listBox.h / rowH);
      const capacity = perCol * cols;
      const maxTop = Math.max(0, entries.length - capacity);
      if (cursor < top) top = cursor;
      if (cursor >= top + capacity) top = cursor - capacity + 1;
      top = Math.max(0, Math.min(maxTop, top));
      cursor = Math.max(0, Math.min(entries.length - 1, cursor));

      // `top` above is the keyboard-driven position this panel owns in its own closure — a
      // cursor move always wins over a stale wheel offset, per `common.js`'s own rule. A wheel
      // notch instead lives in `registerScroll`'s shared memory, keyed by this tag, and is
      // reconciled onto `top` only for *this frame's* rendering — this panel is one of the ones
      // that predates `list()`'s wheel support (its multi-column grid does not fit `list()`'s
      // one-row-per-item layout), and slice 015 left it out (docs/slices/015-pointer-layer.md);
      // this closes that gap with the same primitive rather than inventing a second one.
      const scrollTag = 'dex-national';
      const renderTop = reconciledTop(scrollTag, top, entries.length, capacity);
      registerScroll(g, listBox, scrollTag, top, entries.length, capacity, cols);

      for (let i = 0; i < capacity && renderTop + i < entries.length; i++) {
        const r = entries[renderTop + i];
        const cx = listBox.x + Math.floor(i / perCol) * colW;
        const cy = listBox.y + (i % perCol) * rowH;
        const rect = { x: cx, y: cy, w: colW - 2, h: rowH };
        const on = renderTop + i === cursor;
        if (on) {
          g.fill(rect.x, rect.y, rect.w, rect.h, C.martBase);
          g.fill(rect.x, rect.y, rect.w, 1, C.martLight);
        }
        const ink = r.caught > 0 ? (on ? C.white : C.deepInk) : (r.seen > 0 ? C.deepDim : C.deepFaint);
        g.text(rect.x + 3, rect.y + 2, `${String(r.id).padStart(3, '0')}`, on ? C.glassHi : C.deepFaint);
        g.text(rect.x + 22, rect.y + 2, r.caught > 0 ? '✓' : (r.seen > 0 ? '·' : ''), r.caught > 0 ? C.glowLight : C.deepFaint);
        g.text(rect.x + 30, rect.y + 2, r.caught > 0 || r.seen > 0 ? r.display : '------', ink, { max: colW - 54 });
        if (r.shinyCaught > 0) g.text(rect.x + rect.w - 8, rect.y + 2, '★', C.glowLight);
        else if (r.owned > 0) g.textRight(rect.x + rect.w - 4, rect.y + 2, `×${r.owned}`, on ? C.glassHi : C.deepDim);
        g.hit(rect, () => { cursor = renderTop + i; }, `dex-${r.key}`);
      }

      if (entries.length > capacity) {
        const bx = listBox.x + listBox.w - 3;
        g.fill(bx, listBox.y, 3, listBox.h, C.deepDeep);
        const thumb = Math.max(6, Math.round(listBox.h * capacity / entries.length));
        const ty = listBox.y + Math.round((listBox.h - thumb) * (maxTop ? renderTop / maxTop : 0));
        g.fill(bx, ty, 3, thumb, C.deepLight);
      }
    },
  };
}

/**
 * The national dex: every base-form species `pokemon` knows about, in dex order, carrying
 * whatever record `collection` holds for it. Species with no record read as locked slots,
 * which is what makes the screen a dex rather than an inventory.
 */
function nationalList(app, records) {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const pokemon = app.ctx.get('pokemon');
  const table = isLive(pokemon) && typeof pokemon.baseForms === 'function' ? pokemon.baseForms() : [];
  if (!table.length) return records.filter((r) => r.id !== null).sort((a, b) => a.id - b.id);
  const out = [];
  for (const sp of table) {
    if (!Number.isFinite(sp.id)) continue;
    const r = byKey.get(sp.name);
    out.push(r ?? {
      key: sp.name, id: sp.id, display: sp.display ?? sp.name,
      seen: 0, caught: 0, owned: 0, shinyCaught: 0,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

export { list, well };

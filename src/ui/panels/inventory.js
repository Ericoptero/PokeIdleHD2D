/**
 * The inventory — every held item, in a grid. `economy.bag()`/`stash()` (`economy/index.js`)
 * already hand back exactly the rows a grid needs: category, tier, count, unit/total sell
 * value and lock state, sorted tier-ascending then value-descending. This panel adds nothing
 * to that ordering — it only filters by tab (Bag / Stash) and, optionally, by category.
 *
 * The one write action this panel performs is the sell-lock toggle
 * (`economy.setSellLock(id, on)`); everything else here is a read.
 *
 * `economy` has no bus event for a bare item-count change (`economy:changed` is currency-only,
 * `economy/index.js:103-108`) — buying, dropping or selling something moves a count with no
 * event at all — so this panel marks itself dirty off `economy.onChange(fn)`, a local
 * subscriber set, rather than `ctx.bus.on`.
 */

import {
  C, windowFrame, section, list, action, tabs, stat, fit,
} from './common.js';
import { itemMark, meter } from '../theme.js';
import { wrap } from '../font.js';
import { fmt } from '../format.js';

const isLive = (api) => !!api && api.__missing === undefined;

/** The seven live categories `economy/items.js`'s `ITEMS` populates today (`key` appears in
 *  the typedef but nothing ships in it) — used only to give a filter tab a readable label; the
 *  filter itself works on whatever category a row actually carries. */
export const CATEGORY_LABEL = {
  ball: 'BALL', medicine: 'MEDICINE', candy: 'CANDY', evolution: 'EVOLUTION',
  lure: 'LURE', held: 'HELD', treasure: 'TREASURE',
};

/**
 * The row-building function acceptance criterion 1 names: `tab` picks `economy.bag()` or
 * `economy.stash()`, `category` (falsy = every category) filters what comes back — no
 * re-sorting on top of either, since both already sort tier-ascending then value-descending.
 * A free function, not a closure method, so a test can call it with a fake `economy` with no
 * `app` at all beyond `ctx.get`.
 */
export function filterRows(app, tab, category) {
  const eco = app.ctx.get('economy');
  if (!isLive(eco)) return [];
  const source = tab === 'stash'
    ? (typeof eco.stash === 'function' ? eco.stash() ?? [] : [])
    : (typeof eco.bag === 'function' ? eco.bag() ?? [] : []);
  return category ? source.filter((r) => r.category === category) : source;
}

export function makeInventory(app) {
  let tab = 'bag';
  let category = null;
  let cursor = 0;
  let top = 0;
  /** Unsubscribes from `economy.onChange` — installed on `open()`, torn down on `close()`, so
   *  a panel nobody has opened this session holds no subscription at all. */
  let offChange = null;

  const eco = () => app.ctx.get('economy');

  function setTab(next) {
    if (next === tab) return;
    tab = next; category = null; cursor = 0; top = 0;
  }

  function toggleLock(row) {
    const e = eco();
    if (!isLive(e) || !row || typeof e.setSellLock !== 'function') return;
    e.setSellLock(row.id, !row.locked);
    app.toast(`${row.name} ${row.locked ? 'unlocked' : 'locked'} — automation ${row.locked ? 'may sell it again' : 'will never sell it'}`, 'good');
    app.markDirty();
  }

  return {
    id: 'inventory',
    /** Inert data since slice 016 (DECISIONS #85): nothing reads `panel.full` for sizing or
     *  anything else any more. Kept on the descriptor only as a record of which panels used to
     *  stand the whole HUD down while open (`battle.js`'s own header comment). */
    full: true,

    open(opts) {
      tab = opts?.tab === 'stash' ? 'stash' : 'bag';
      category = null; cursor = 0; top = 0;
      const e = eco();
      if (isLive(e) && typeof e.onChange === 'function') {
        offChange = e.onChange(() => app.markDirty());
      }
    },
    close() {
      offChange?.();
      offChange = null;
    },

    /**
     * Not part of the panel contract `ui/index.js` drives (`open`, `close`, `key`, `draw`) —
     * `travel.js`'s `rows()` precedent for exposing a model function a test needs with no
     * canvas. Takes `tab`/`category` explicitly rather than reading this closure's own state,
     * so a fixture can drive it without going through `open()`/`key()` first.
     */
    rows: (t, cat) => filterRows(app, t, cat),

    key(ev) {
      const items = filterRows(app, tab, category);
      const code = ev.code;
      if (code === 'ArrowUp' || code === 'KeyW') { cursor = Math.max(0, cursor - 1); app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { cursor = Math.min(items.length - 1, cursor + 1); app.markDirty(); return true; }
      if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyA' || code === 'KeyD') {
        setTab(tab === 'bag' ? 'stash' : 'bag'); app.markDirty(); return true;
      }
      if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { toggleLock(items[cursor]); return true; }
      return false;
    },

    draw(g) {
      const win = windowFrame(g, {
        windowId: 'inventory', reserved: app.hudReserved(),
        title: 'INVENTORY', bar: C.martBase, edge: C.martDeep, light: C.martLight,
        footer: '↑↓ choose    ←→ bag / stash    Z lock / unlock    X close',
        onClose: () => app.close(), ...fit(g, 480, 264),
      });

      // --- BAG / STASH --------------------------------------------------------
      tabs(g, win.x, win.y, [{ id: 'bag', label: 'BAG' }, { id: 'stash', label: 'STASH' }], {
        active: tab, tag: 'inv-tab',
        onPick: (id) => { setTab(id); app.markDirty(); },
      });

      // --- category filter -----------------------------------------------------
      // Built off the *unfiltered* rows for the current tab, so a category with nothing in it
      // never shows an empty tab — a fresh save's Bag has only `ball` and `medicine`, and the
      // Stash tab, `STASH_CATEGORIES` being one category wide (`economy/items.js:313`), never
      // has more than one tab beyond ALL.
      const allRows = filterRows(app, tab, null);
      const present = [...new Set(allRows.map((r) => r.category))];
      const catTabs = [
        { id: null, label: 'ALL' },
        ...present.map((c) => ({ id: c, label: CATEGORY_LABEL[c] ?? c.toUpperCase() })),
      ];
      if (category && !present.includes(category)) category = null;
      tabs(g, win.x, win.y + 14, catTabs, {
        active: category, tag: 'inv-cat', h: 11,
        onPick: (id) => { category = id; cursor = 0; top = 0; app.markDirty(); },
      });

      const items = category ? allRows.filter((r) => r.category === category) : allRows;
      cursor = Math.max(0, Math.min(items.length - 1, cursor));

      const bodyY = win.y + 27;
      const bodyH = win.h - 27;
      const leftW = Math.max(160, Math.min(230, Math.round(win.w * 0.56)));

      const grid = section(g, { x: win.x, y: bodyY, w: leftW, h: bodyH }, 'ITEMS',
        { bar: C.stoneShadow, light: C.stoneBase, dark: true });

      const rowH = 15;
      const visible = Math.max(1, Math.floor(grid.h / rowH));
      if (cursor < top) top = cursor;
      if (cursor >= top + visible) top = cursor - visible + 1;

      if (!items.length) {
        g.text(grid.x + 4, grid.y + 3, tab === 'bag' ? 'nothing in the bag' : 'nothing in the stash', C.deepFaint);
      }
      list(g, grid, {
        items, rowH, top, selected: cursor, tag: 'inv-row', dark: true,
        onPick: (i) => { cursor = i; app.markDirty(); },
        draw: (gg, item, rect, st) => {
          itemMark(gg, rect.x + 2, rect.y + 2, item.category, item.tier, { ink: st.selected ? C.white : C.deepInk });
          gg.text(rect.x + 12, rect.y + 1, item.name, st.ink, { max: rect.w - 46 });
          if (item.locked) gg.text(rect.x + rect.w - 40, rect.y + 1, 'L', st.selected ? C.glowLight : C.glowDeep);
          gg.textRight(rect.x + rect.w - 4, rect.y + 1, `×${fmt(item.n)}`, st.selected ? C.glassLight : C.deepDim);
          meter(gg, { x: rect.x + 12, y: rect.y + 9, w: rect.w - 16, h: 4 }, item.n / Math.max(1, item.cap),
            { fill: C.martBase, light: C.martLight, back: C.deepDeep });
        },
      });

      // --- detail ---------------------------------------------------------------
      const rightX = win.x + leftW + 4;
      const rightW = win.x + win.w - rightX;
      const detail = section(g, { x: rightX, y: bodyY, w: rightW, h: bodyH }, 'DETAIL',
        { bar: C.stoneShadow, light: C.stoneBase });
      const row = items[cursor];
      if (!row) {
        g.text(detail.x + 5, detail.y + 6, 'nothing selected', C.stoneShadow);
        return;
      }

      let y = detail.y + 5;
      g.text(detail.x + 5, y, row.name, C.ink, { max: detail.w - 10 });
      y += 11;
      for (const line of wrap(row.desc ?? '', detail.w - 10).slice(0, 4)) {
        g.text(detail.x + 5, y, line, C.shadowInk);
        y += 8;
      }
      y += 3;
      g.fill(detail.x + 4, y, detail.w - 8, 1, C.wallDeep);
      y += 4;
      stat(g, detail.x + 5, y, 'Category', CATEGORY_LABEL[row.category] ?? row.category, { w: detail.w - 10 }); y += 9;
      stat(g, detail.x + 5, y, 'Held', `${fmt(row.n)} / ${fmt(row.cap)}`, { w: detail.w - 10 }); y += 9;
      stat(g, detail.x + 5, y, 'Sells for', `₽${fmt(row.unitSell)} each`, { w: detail.w - 10 }); y += 9;
      stat(g, detail.x + 5, y, 'Stack worth', `₽${fmt(row.totalSell)}`, { w: detail.w - 10 });

      const by = detail.y + detail.h - 15;
      action(g, { x: detail.x + 4, y: by, w: detail.w - 8, h: 13 },
        row.locked ? 'UNLOCK (auto-sell allowed)' : 'LOCK (never auto-sold)', {
          active: row.locked, onPick: () => toggleLock(row), tag: 'sell-lock',
        });
    },
  };
}

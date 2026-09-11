/**
 * The shop. `economy` ships about seventy items, four currencies, eleven upgrade tracks,
 * four shops and a daily deal with a live API (§5.9); this panel is the counter.
 *
 * Three columns: the shops down the left with their unlock gates, the shelf in the middle,
 * and what the player is pointing at on the right with the buy buttons under it. The
 * upgrade tracks are a fifth "shop", because from the player's side buying a permanent
 * multiplier is the same decision as buying a stack of balls, and splitting them into two
 * screens would hide the comparison the pacing table (DECISIONS #16) is built around.
 *
 * Every number is pulled from the module at paint time. Nothing here re-derives a price.
 */

import { C, windowFrame, section, list, action, well, fit } from './common.js';
import { CURRENCY_COLOUR } from '../theme.js';
import { WALLET } from '../hud.js';

const isLive = (api) => !!api && api.__missing === undefined;
const fmt = (n) => Math.floor(Number(n) || 0).toLocaleString('en-US');
const SYMBOL = { money: '₽', research: '◈', bp: 'BP', shards: '◆', tokens: '◈' };

const priceText = (currency, n) => (currency === 'money' ? `₽${fmt(n)}` : `${fmt(n)} ${SYMBOL[currency] ?? ''}`);

export function makeShop(app) {
  let shopId = null;
  let cursor = 0;
  let top = 0;
  let bulk = 1;

  const eco = () => app.ctx.get('economy');

  function shops() {
    const e = eco();
    if (!isLive(e) || typeof e.shops !== 'function') return [];
    return [...(e.shops() ?? []), { id: 'upgrades', name: 'Upgrades', blurb: 'permanent multipliers', unlocked: true, requires: '', size: 11 }];
  }

  function rows() {
    const e = eco();
    if (!isLive(e)) return [];
    if (shopId === 'upgrades') {
      return (e.upgrades?.() ?? []).map((u) => ({
        kind: 'upgrade', id: u.id, name: u.name, desc: u.desc, currency: u.currency,
        price: u.cost, level: u.level, max: u.max, value: u.value, mode: u.mode,
        unlocked: u.unlocked, affordable: u.affordable, disabled: !u.unlocked,
        maxed: Number.isFinite(u.max) && u.level >= u.max,
      }));
    }
    return (e.stock?.(shopId) ?? []).map((s) => ({
      kind: 'item', id: s.id, name: s.name, desc: s.desc, currency: s.currency,
      price: s.price, base: s.base, discount: s.discount, onDeal: s.onDeal,
      owned: s.owned, sell: s.sell, limit: s.limit, limitLeft: s.limitLeft,
      unlocked: s.unlocked, requires: s.requires, category: s.category, when: s.when,
      disabled: !s.unlocked,
      affordable: (e.balance?.(s.currency) ?? 0) >= (s.price ?? Infinity),
    }));
  }

  function ensureShop() {
    if (shopId) return;
    const all = shops();
    shopId = (all.find((s) => s.unlocked) ?? all[0])?.id ?? null;
  }

  function buy(item, n) {
    const e = eco();
    if (!isLive(e) || !item) return;
    if (item.kind === 'upgrade') {
      const got = e.buyUpgrade?.(item.id, n) ?? 0;
      app.toast(got ? `${item.name} → level ${item.level + got}` : `Not enough ${SYMBOL[item.currency] ?? item.currency}`, got ? 'good' : 'warn');
    } else {
      const ok = e.buy?.(item.id, n);
      app.toast(ok ? `Bought ${n}× ${item.name}` : `Cannot buy ${item.name}`, ok ? 'good' : 'warn');
    }
    app.markDirty();
  }

  return {
    id: 'shop',
    /** A full-frame window: `index.js` stands the HUD down while one is open. */
    full: true,
    open() { ensureShop(); cursor = 0; top = 0; },
    close() {},

    key(ev) {
      const items = rows();
      const code = ev.code;
      if (code === 'ArrowUp' || code === 'KeyW') { cursor = Math.max(0, cursor - 1); if (cursor < top) top = cursor; app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { cursor = Math.min(items.length - 1, cursor + 1); app.markDirty(); return true; }
      if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyA' || code === 'KeyD') {
        const all = shops();
        const i = all.findIndex((s) => s.id === shopId);
        const step = (code === 'ArrowLeft' || code === 'KeyA') ? -1 : 1;
        shopId = all[(i + step + all.length) % all.length].id;
        cursor = 0; top = 0; app.markDirty(); return true;
      }
      if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { buy(items[cursor], bulk); return true; }
      return false;
    },

    draw(g) {
      ensureShop();
      const e = eco();
      const all = shops();
      const items = rows();
      const shop = all.find((s) => s.id === shopId) ?? null;
      const deal = isLive(e) && typeof e.deal === 'function' ? e.deal() : null;
      const win = windowFrame(g, {
        title: 'SHOP', bar: C.martBase, edge: C.martDeep, light: C.martLight,
        footer: '↑↓ choose    ←→ shop    Z buy    X close',
        onClose: () => app.close(), ...fit(g, 540, 278),
      });

      // --- wallet strip -----------------------------------------------------
      const walletY = win.y;
      let wx = win.x;
      // The order is `hud.js`'s own WALLET, imported rather than re-listed: round 1 had the
      // HUD reading money/research/shards/bp and this strip reading money/research/bp/shards,
      // so two currencies swapped places one keypress apart.
      for (const { id } of WALLET) {
        const text = id === 'money' ? `₽${fmt(e.balance?.(id) ?? 0)}` : `${fmt(e.balance?.(id) ?? 0)} ${SYMBOL[id]}`;
        const w = g.measure(text) + 10;
        well(g, { x: wx, y: walletY, w, h: 12 });
        g.text(wx + 5, walletY + 3, text, C.ink);
        const sym = SYMBOL[id];
        const sx = id === 'money' ? wx + 5 : wx + 5 + g.measure(text) - g.measure(sym);
        g.text(sx, walletY + 3, sym, CURRENCY_COLOUR[id] ?? C.ink);
        wx += w + 3;
      }
      if (deal?.itemId) {
        const dealName = e.item?.(deal.itemId)?.name ?? String(deal.itemId);
        const label = `DEAL TODAY  ${dealName}  -${Math.round((deal.discount ?? 0) * 100)}%`;
        const w = g.measure(label) + 10;
        well(g, { x: win.x + win.w - w, y: walletY, w, h: 12 }, { paper: C.glowDeep, shade: '#3A2508', bevel: C.glowBase });
        g.text(win.x + win.w - w + 5, walletY + 3, label, C.glowHi);
      }

      const bodyY = walletY + 16;
      const bodyH = win.h - 16;

      // --- shops ------------------------------------------------------------
      const leftW = Math.max(84, Math.min(108, Math.round(win.w * 0.21)));
      // The column is two sections, not one list with a third of it blank under it
      // (round-1 issue 11): the shops, sized to their own rows, and under them the
      // permanent multipliers the player has already bought — which is the one number the
      // upgrade shelf across the way is asking them to spend on.
      const shopPitch = 26;
      const shopsH = Math.min(bodyH, all.length * shopPitch + 12);
      const leftBox = section(g, { x: win.x, y: bodyY, w: leftW, h: shopsH }, 'SHOPS',
        { bar: C.stoneShadow, light: C.stoneBase });
      all.forEach((s, i) => {
        const r = { x: leftBox.x, y: leftBox.y + 1 + i * shopPitch, w: leftBox.w, h: shopPitch - 1 };
        const on = s.id === shopId;
        if (on) {
          g.fill(r.x, r.y, r.w, r.h, C.martBase);
          g.fill(r.x, r.y, r.w, 1, C.martLight);
          g.fill(r.x, r.y + r.h - 1, r.w, 1, C.martDeep);
        }
        g.text(r.x + 4, r.y + 3, s.name, s.unlocked ? (on ? C.white : C.ink) : C.stoneShadow, { max: r.w - 8 });
        g.text(r.x + 4, r.y + 12, s.unlocked ? s.blurb : s.requires, on ? C.glassLight : C.stoneShadow, { max: r.w - 8 });
        g.hit(r, () => { shopId = s.id; cursor = 0; top = 0; }, `shop-${s.id}`);
      });

      const multY = bodyY + shopsH + 4;
      const multH = bodyH - shopsH - 4;
      if (multH >= 36) {
        const mb = section(g, { x: win.x, y: multY, w: leftW, h: multH }, 'IN EFFECT',
          { bar: C.stoneShadow, light: C.stoneBase });
        const bought = (e.upgrades?.() ?? []).filter((u) => (u.level ?? 0) > 0);
        let my = mb.y + 3;
        if (!bought.length) g.text(mb.x + 4, my, 'nothing bought yet', C.stoneShadow, { max: mb.w - 8 });
        for (const u of bought) {
          if (my + 16 > mb.y + mb.h) break;
          g.text(mb.x + 4, my, u.name, C.shadowInk, { max: mb.w - 8 });
          g.text(mb.x + 4, my + 8, `Lv ${u.level}`, C.stoneShadow);
          g.textRight(mb.x + mb.w - 4, my + 8,
            u.mode === 'flat' ? `+${u.value}` : `×${Number(u.value).toFixed(2)}`, C.glowDeep);
          my += 18;
        }
      }

      // --- shelf ------------------------------------------------------------
      const midX = win.x + leftW + 4;
      const detailW = Math.max(124, Math.min(172, Math.round(win.w * 0.31)));
      const midW = win.w - leftW - detailW - 8;
      // The shelf is the deep recess; the shops on the left and the detail on the right stay
      // on paper. That is the DS split — a dark list against two light cards — and it is what
      // puts a real shadow end into a window that was one flat tan from edge to edge.
      const shelf = section(g, { x: midX, y: bodyY, w: midW, h: bodyH },
        shopId === 'upgrades' ? 'UPGRADE TRACKS' : (shop?.name ?? 'STOCK').toUpperCase(),
        { bar: C.stoneShadow, light: C.stoneBase, dark: true });

      const rowH = 13;
      const visible = Math.floor(shelf.h / rowH);
      if (cursor < top) top = cursor;
      if (cursor >= top + visible) top = cursor - visible + 1;
      list(g, shelf, {
        items, rowH, top, selected: cursor, tag: 'stock', dark: true,
        onPick: (i) => { cursor = i; app.markDirty(); },
        draw: (gg, item, rect, st) => {
          const ink = st.ink;
          // Every column here is measured back from the row's own right edge; the round-1
          // constants (128, 152, max 122) were tuned for one shelf width and overprinted
          // the price on any narrower one.
          const priceW = 56;
          const qtyX = rect.x + rect.w - priceW - 40;
          const dealX = rect.x + rect.w - priceW - 16;
          gg.text(rect.x + 4, rect.y + 3, item.name, ink, { max: qtyX - rect.x - 8 });
          if (item.kind === 'upgrade') {
            gg.text(qtyX, rect.y + 3, item.maxed ? 'MAX' : `Lv ${item.level}`, st.selected ? C.glassHi : C.deepDim);
            gg.textRight(rect.x + rect.w - 4, rect.y + 3,
              item.maxed ? '—' : priceText(item.currency, item.price),
              item.maxed ? C.deepDim : (item.affordable ? ink : C.roofLight));
          } else if (!item.unlocked) {
            gg.textRight(rect.x + rect.w - 4, rect.y + 3, item.requires || 'locked', C.deepDim, { max: 110 });
          } else {
            if (item.owned) gg.text(qtyX, rect.y + 3, `×${item.owned}`, st.selected ? C.glassHi : C.deepDim);
            if (item.onDeal) gg.text(dealX, rect.y + 3, 'DEAL', C.glowBase);
            gg.textRight(rect.x + rect.w - 4, rect.y + 3, priceText(item.currency, item.price),
              item.affordable ? ink : C.roofLight);
          }
        },
      });

      // --- detail -----------------------------------------------------------
      const rightX = midX + midW + 4;
      const rightW = win.x + win.w - rightX;
      const detail = section(g, { x: rightX, y: bodyY, w: rightW, h: bodyH }, 'DETAIL',
        { bar: C.stoneShadow, light: C.stoneBase });
      const item = items[cursor];
      if (!item) {
        g.text(detail.x + 5, detail.y + 6, 'nothing on this shelf', C.stoneShadow);
      } else {
        let y = detail.y + 5;
        g.text(detail.x + 5, y, item.name, C.ink, { max: detail.w - 10 });
        y += 11;
        for (const line of wrapText(g, item.desc ?? '', detail.w - 10, 3)) {
          g.text(detail.x + 5, y, line, C.shadowInk);
          y += 8;
        }
        y += 3;
        if (item.kind === 'upgrade') {
          line(g, detail, y, 'Level', item.maxed ? `${item.level} (max)` : `${item.level}${Number.isFinite(item.max) ? ` / ${item.max}` : ''}`); y += 9;
          line(g, detail, y, 'Now', item.mode === 'flat' ? `+${item.value}` : `×${Number(item.value).toFixed(2)}`); y += 9;
          line(g, detail, y, 'Next level', item.maxed ? '—' : priceText(item.currency, item.price)); y += 9;
        } else {
          line(g, detail, y, 'Category', item.category ?? '—'); y += 9;
          line(g, detail, y, 'In bag', String(item.owned ?? 0)); y += 9;
          line(g, detail, y, 'Price', priceText(item.currency, item.price)); y += 9;
          if (item.sell) { line(g, detail, y, 'Resells for', priceText('money', item.sell)); y += 9; }
          if (item.limit != null) { line(g, detail, y, 'Left today', String(item.limitLeft)); y += 9; }
          if (item.when) { y += 2; for (const l of wrapText(g, item.when, detail.w - 10, 2)) { g.text(detail.x + 5, y, l, C.martShadow); y += 8; } }
        }

        // --- what you already hold ------------------------------------------
        // The bag has no screen of its own yet, and this column was a third empty under
        // five stat lines (round-1 issue 11). The same pane that quotes a price now says
        // what the player is already carrying, which is the question a price provokes.
        const by = detail.y + detail.h - 30;
        const bagTop = y + 5;
        const bagRoom = Math.floor((by - 14 - bagTop - 10) / 9);
        if (bagRoom >= 2) {
          g.fill(detail.x + 4, bagTop - 3, detail.w - 8, 1, C.wallDeep);
          g.text(detail.x + 5, bagTop, 'IN YOUR BAG', C.stoneShadow);
          const bag = (typeof e.inventory === 'function' ? e.inventory() : null) ?? {};
          const held = Object.entries(bag)
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, bagRoom);
          let byy = bagTop + 10;
          if (!held.length) g.text(detail.x + 5, byy, 'nothing yet', C.stoneShadow);
          for (const [id, n] of held) {
            const nm = e.item?.(id)?.name ?? id;
            const mine = id === item.id;
            g.text(detail.x + 5, byy, nm, mine ? C.ink : C.shadowInk, { max: detail.w - 40 });
            g.textRight(detail.x + detail.w - 5, byy, `×${n}`, mine ? C.glowDeep : C.stoneShadow);
            byy += 9;
          }
        }

        // --- buy ------------------------------------------------------------
        const balance = e.balance?.(item.currency) ?? 0;
        const affordable = item.price > 0 ? Math.floor(balance / item.price) : 0;
        g.fill(detail.x + 4, by - 12, detail.w - 8, 1, C.wallDeep);
        if (!item.maxed && item.unlocked) {
          g.text(detail.x + 5, by - 9,
            affordable >= 1 ? `you can afford ${affordable.toLocaleString('en-US')}` : 'you cannot afford one',
            affordable >= 1 ? C.shadowInk : C.roofShadow, { max: detail.w - 10 });
        } else if (!item.unlocked) {
          g.text(detail.x + 5, by - 9, item.requires || 'locked', C.roofShadow, { max: detail.w - 10 });
        }
        const amounts = item.kind === 'upgrade' ? [1, 5] : [1, 5, 10];
        let bx2 = detail.x + 4;
        for (const n of amounts) {
          const bw = 22;
          action(g, { x: bx2, y: by, w: bw, h: 12 }, `×${n}`, {
            active: bulk === n, onPick: () => { bulk = n; }, tag: `bulk-${n}`,
          });
          bx2 += bw + 2;
        }
        const canBuy = item.unlocked && !item.maxed && item.affordable;
        action(g, { x: detail.x + 4, y: by + 14, w: detail.w - 8, h: 13 },
          item.maxed ? 'MAXED' : (item.unlocked ? `BUY ×${bulk}` : 'LOCKED'), {
            disabled: !canBuy, onPick: () => buy(item, bulk), tag: 'buy',
          });
      }
    },
  };
}

function line(g, box, y, label, value) {
  g.text(box.x + 5, y, label, C.shadowInk);
  g.textRight(box.x + box.w - 5, y, value, C.ink);
}

function wrapText(g, text, width, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measure(t) <= width || !cur) cur = t;
    else { out.push(cur); cur = w; if (out.length === maxLines) return out; }
  }
  if (cur && out.length < maxLines) out.push(cur);
  return out;
}

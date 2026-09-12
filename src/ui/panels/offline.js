/**
 * The "while you were away" card.
 *
 * `offline` does all of the arithmetic and publishes it (src/offline/index.js): `summary()` returns the
 * payload and `offline:applied` announces that a payout actually happened. This module only
 * draws it — and it draws the *whole* payload, including the parts a card usually hides:
 * the cap, the efficiency curve's bands, and the difference between what was banked
 * (`applied`) and what is only recorded as pending (`pending`) because nothing accepts
 * experience or a background catch yet. A card that quietly rounded those away would be
 * claiming the player got something they did not.
 *
 * It is opened by the **event**, never by polling `summary()`: in showcase mode `offline`
 * runs read-only against a copy of the save and still builds a summary, so a
 * card driven by `summary() != null` would appear over every other module's showcase.
 */

import { C, panel, header, well, action, stat } from './common.js';
import { wrap } from '../font.js';
import { fmt, duration } from '../format.js';
import { pokeball, meter, CURRENCY_COLOUR } from '../theme.js';


const CURRENCY_LABEL = { money: '₽', tokens: '◈', research: '◈', shards: '◆', bp: 'BP' };
const CURRENCY_NAME = { money: 'Poké Dollars', tokens: 'Research', research: 'Research', shards: 'Shards', bp: 'Battle Points' };

export function makeOfflineCard(app) {
  /** @type {object|null} */
  let summary = null;

  return {
    id: 'offline',
    /** @param {{summary:object}} opts */
    open(opts = {}) { summary = opts.summary ?? null; },
    close() { summary = null; },
    payload: () => summary,

    key(ev) {
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') { app.close(); return true; }
      return false;
    },

    draw(g) {
      if (!summary) { app.close(); return; }
      const s = summary;

      const w = Math.min(262, g.width - 16);
      const gains = Object.entries(s.applied ?? {}).filter(([, v]) => v > 0);
      const pending = Object.entries(s.pending ?? {}).filter(([, v]) => v > 0);
      // A wrapped note is one bullet, so its continuation lines are indented past the
      // bullet column. Round 1 wrapped "preview: offline is read-only in showcase / mode"
      // flush left and the orphaned "mode" read as a second bullet.
      const bulletW = g.measure('· ');
      /** @type {{text:string, indent:number}[]} */
      const noteLines = [];
      for (const note of (s.notes ?? []).filter(Boolean).slice(0, 3)) {
        const lines = wrap(String(note), w - 24 - bulletW);
        lines.forEach((line, i) => {
          if (noteLines.length >= 4) return;
          noteLines.push({ text: i === 0 ? `· ${line}` : line, indent: i === 0 ? 0 : bulletW });
        });
      }
      const rowsH = Math.max(gains.length, 1) * 11 + (pending.length ? pending.length * 9 + 4 : 0);
      const h = Math.min(92 + rowsH + noteLines.length * 9, g.height - 12);
      const box = { x: Math.round((g.width - w) / 2), y: Math.round((g.height - h) / 2), w, h };

      g.scrim(0, 0, g.width, g.height, 0.55);
      g.hit({ x: 0, y: 0, w: g.width, h: g.height }, () => app.close(), 'scrim');
      panel(g, box, { paper: C.wallBase });
      // Swallows a pointerdown on the card's own paper so it stops here rather than falling
      // through to the scrim above it — the CONTINUE button below registers its own hit region
      // strictly later and so still wins over this one.
      g.hit(box, { swallow: true }, 'window-body');
      const inner = header(g, box, 'WHILE YOU WERE AWAY', {
        bar: C.martBase, edge: C.martDeep, light: C.martLight,
      });
      pokeball(g, box.x + box.w - 12, box.y + 3);

      let y = inner.y + 4;
      const left = inner.x + 6;
      const right = inner.x + inner.w - 6;

      // --- the absence ------------------------------------------------------
      g.text(left, y, 'Away', C.shadowInk);
      g.textRight(right, y, s.awayText ?? duration(s.awayS), C.ink);
      y += 10;
      if (s.capped) {
        g.text(left, y, 'Credited (capped)', C.roofShadow);
        g.textRight(right, y, `${s.creditedText ?? duration(s.creditedS)} of ${s.capText ?? duration(s.capS)}`, C.roofShadow);
        y += 10;
      }
      g.text(left, y, 'Worth', C.shadowInk);
      g.textRight(right, y, `${s.effectiveText ?? duration(s.effectiveS)} of play`, C.ink);
      y += 11;

      // --- the efficiency curve, band by band -------------------------------
      // `offline` discounts the *time axis*, not the rate, so the honest
      // picture of the discount is a bar of the absence with each band's own efficiency.
      const bar = { x: left, y, w: right - left, h: 9 };
      const bands = s.bands ?? [];
      const totalS = bands.reduce((a, b) => a + b.seconds, 0) || 1;
      g.fill(bar.x - 1, bar.y - 1, bar.w + 2, bar.h + 2, C.ink);
      let bx = bar.x;
      bands.forEach((b, i) => {
        const bw = i === bands.length - 1 ? bar.x + bar.w - bx : Math.round(bar.w * b.seconds / totalS);
        const t = Math.max(0, Math.min(1, b.avgEfficiency));
        // The band is a **flat** colour off a five-step ramp, and the ink is chosen against
        // that colour, so every label is measurable. Round 1 drew a part-height bar and put
        // C.ink on whatever happened to be behind the digits: 63 % and 57 % came out at
        // 2.47:1 and 59 % at 1.41:1 — the three bands that tell the player how much of their
        // idle time was thrown away were the three hardest to read. Measured now, worst case
        // 4.76:1 (#241E1B on #B87B1C) and 5.35:1 (#FFF8E6 on #8A5A18).
        const ramp = t > 0.9 ? C.glowHi : t > 0.75 ? C.glowLight
          : t > 0.6 ? C.glowBase : t > 0.45 ? C.bandMid : C.glowDeep;
        g.fill(bx, bar.y, bw, bar.h, ramp);
        // and the value keeps a shape channel too: a rule at the band's own height
        g.fill(bx, bar.y + bar.h - Math.max(1, Math.round(bar.h * t)), bw, 1, C.woodDeep);
        if (bw > 22) g.textCentre(bx + bw / 2, bar.y + 1, `${Math.round(t * 100)}%`, t > 0.45 ? C.ink : C.wallHi);
        if (i > 0) g.fill(bx, bar.y, 1, bar.h, C.woodDeep);
        bx += bw;
      });
      y += bar.h + 3;
      g.text(left, y, 'full rate', C.stoneShadow);
      g.textRight(right, y, `average ${Math.round((s.efficiency ?? 0) * 100)}%`, C.stoneShadow);
      y += 12;

      // --- what was banked --------------------------------------------------
      const wellBox = well(g, { x: left - 2, y, w: right - left + 4, h: rowsH + 6 });
      let gy = wellBox.y + 3;
      if (!gains.length) {
        g.text(wellBox.x + 4, gy, 'nothing banked this session', C.stoneShadow);
      }
      for (const [id, value] of gains) {
        const label = CURRENCY_LABEL[id];
        g.text(wellBox.x + 4, gy, CURRENCY_NAME[id] ?? id, C.shadowInk, { max: wellBox.w - 90 });
        const text = label === '₽' ? `₽${fmt(value)}` : label ? `${fmt(value)} ${label}` : `×${fmt(value)}`;
        g.textRight(wellBox.x + wellBox.w - 4, gy, text, C.ink);
        const sym = label ?? '';
        if (sym) {
          const tw = g.measure(text);
          const sx = sym === '₽' ? wellBox.x + wellBox.w - 4 - tw : wellBox.x + wellBox.w - 4 - g.measure(sym);
          g.text(sx, gy, sym, CURRENCY_COLOUR[id === 'tokens' ? 'research' : id] ?? C.ink);
        }
        gy += 11;
      }
      if (pending.length) {
        g.fill(wellBox.x + 3, gy, wellBox.w - 6, 1, C.wallDeep);
        gy += 3;
        for (const [id, value] of pending) {
          g.text(wellBox.x + 4, gy, `${id} (held)`, C.stoneShadow);
          g.textRight(wellBox.x + wellBox.w - 4, gy, fmt(value), C.stoneShadow);
          gy += 9;
        }
      }
      y += rowsH + 9;

      for (const noteLine of noteLines) {
        g.text(left + noteLine.indent, y, noteLine.text, C.stoneShadow, { max: right - left - noteLine.indent });
        y += 9;
      }

      action(g, { x: box.x + box.w / 2 - 34, y: box.y + box.h - 17, w: 68, h: 13 }, 'CONTINUE', {
        active: true, onPick: () => app.close(), tag: 'offline-continue',
      });
    },
  };
}

export { stat, meter };

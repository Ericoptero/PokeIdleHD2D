/**
 * The party — and in this game that is not a bookkeeping screen. The **active Pokemon
 * leads** and the trainer follows it (DECISIONS #27), so the first slot here is the sprite
 * walking around the city, and changing it changes the picture.
 *
 * `pokemon.setLead(i)` emits `party:leadChanged`; `simulation` listens for it, rebuilds the
 * conga line and re-packs the sprite atlas. This panel therefore never touches the walker
 * itself — it makes one call on `pokemon` and the world catches up on its own.
 */

import { C, windowFrame, section, action, well, fit } from './common.js';
import { pokeball, meter } from '../theme.js';
import { wrap } from '../font.js';

const isLive = (api) => !!api && api.__missing === undefined;
const STAT_KEYS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

export function makeParty(app) {
  let cursor = 0;

  const mon = () => app.ctx.get('pokemon');

  function members() {
    const p = mon();
    if (!isLive(p) || typeof p.party !== 'function') return [];
    return (p.party() ?? []).map((inst, i) => ({
      inst,
      index: i,
      display: app.hud.displayName(inst?.species),
      level: inst?.level ?? 1,
      shiny: !!inst?.shiny,
      types: inst?.species?.types ?? [],
      stats: inst?.species?.baseStats ?? {},
      ivs: inst?.ivs ?? {},
      url: typeof p.spriteUrl === 'function' && inst?.species
        ? p.spriteUrl(inst.species, { shiny: !!inst.shiny }) : null,
    }));
  }

  function setLead(i) {
    const p = mon();
    if (!isLive(p) || typeof p.setLead !== 'function' || i === 0) return;
    const who = members()[i];
    p.setLead(i);
    cursor = 0;
    app.toast(`${who?.display ?? 'Your Pokemon'} takes the lead`, 'good');
    app.markDirty();
  }

  return {
    id: 'party',
    full: true,
    open() { cursor = 0; },
    close() {},

    key(ev) {
      const list = members();
      const code = ev.code;
      if (code === 'ArrowUp' || code === 'KeyW') { cursor = Math.max(0, cursor - 1); app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { cursor = Math.min(list.length - 1, cursor + 1); app.markDirty(); return true; }
      if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { setLead(cursor); return true; }
      return false;
    },

    draw(g) {
      const list = members();
      cursor = Math.max(0, Math.min(list.length - 1, cursor));
      const win = windowFrame(g, {
        title: 'PARTY', bar: C.roofBase, edge: C.roofDeep, light: C.roofLight,
        footer: '↑↓ choose    Z make it lead    X close',
        onClose: () => app.close(), ...fit(g, 424, 250),
      });

      const leftW = Math.max(150, Math.min(214, Math.round(win.w * 0.52)));
      // Light plates in a dark tray: the cards keep their paper and their ink, and the recess
      // behind them is what gives this window its shadow end.
      const left = section(g, { x: win.x, y: win.y, w: leftW, h: win.h }, 'ON HAND',
        { bar: C.stoneShadow, light: C.stoneBase, dark: true });

      if (!list.length) {
        g.text(left.x + 6, left.y + 8, 'No Pokemon yet.', C.deepDim);
      }

      // Six cards, always: the bench is what the screen is for, so the card shrinks rather
      // than the sixth slot falling off the bottom. Below 30 px the type line is dropped and
      // the level moves up beside the name instead of overprinting it.
      const cardH = Math.max(20, Math.min(32, Math.floor((left.h - 4) / 6) - 2));
      const tight = cardH < 30;
      list.forEach((m, i) => {
        const r = { x: left.x + 2, y: left.y + 2 + i * (cardH + 2), w: left.w - 4, h: cardH };
        const on = i === cursor;
        const lead = i === 0;
        g.fill(r.x, r.y, r.w, r.h, on ? C.martBase : (lead ? C.wallLight : C.wallBase));
        g.fill(r.x, r.y, r.w, 1, on ? C.martLight : C.wallHi);
        g.fill(r.x, r.y + r.h - 1, r.w, 1, on ? C.martDeep : C.wallDeep);
        // 32, always, so the 32 px sprite frame lands at exactly 1:1 — a 30 px box would
        // drop two rows of every Pokemon on a screen whose whole point is the pixel grid.
        app.hud.drawIcon(g, m, r.x + 2, r.y + cardH - 32, 32);
        const ink = on ? C.white : C.ink;
        const nameW = Math.max(52, r.w - 120);
        g.text(r.x + 36, r.y + 3, m.display, ink, { max: nameW });
        const lvY = r.y + (tight ? 12 : 13);
        g.text(r.x + 36, lvY, `Lv ${m.level}`, on ? C.glassLight : C.shadowInk);
        if (m.shiny) g.text(r.x + 36 + 30, lvY, '★', C.glowLight);
        if (!tight) {
          const typeText = m.types.join(' / ');
          g.text(r.x + 36, r.y + 22, typeText, on ? C.glassLight : C.stoneShadow, { max: nameW });
        }
        if (lead) {
          const label = 'LEADING';
          const lw = g.measure(label);
          pokeball(g, r.x + r.w - lw - 14, r.y + 3);
          g.textRight(r.x + r.w - 5, r.y + 3, label, on ? C.glowLight : C.roofShadow);
          if (!tight) g.textRight(r.x + r.w - 5, r.y + 13, 'the one on screen', on ? C.glassLight : C.stoneShadow);
        }
        g.hit(r, () => { cursor = i; }, `party-${i}`);
      });

      // The bench a party of three has room for, drawn as empty plates rather than as blank
      // paper: six is the size of a party, and the screen should say so.
      for (let i = list.length; i < 6; i++) {
        const r = { x: left.x + 2, y: left.y + 2 + i * (cardH + 2), w: left.w - 4, h: cardH };
        if (r.y + r.h > left.y + left.h) break;
        // A plate, not a hairline: an empty bench slot is a place a Pokemon goes, so it is
        // drawn as an empty plate with a hollow ball mark on it rather than as a line of
        // grey text on bare paper.
        g.fill(r.x, r.y, r.w, r.h, C.deepShade);
        g.fill(r.x, r.y, r.w, 1, C.deepDeep);
        g.fill(r.x, r.y + r.h - 1, r.w, 1, C.deepLight);
        const bx = r.x + 14;
        const by = r.y + Math.round((r.h - 7) / 2);
        g.fill(bx + 1, by, 5, 1, C.deepFaint);
        g.fill(bx + 1, by + 6, 5, 1, C.deepFaint);
        g.fill(bx, by + 1, 1, 5, C.deepFaint);
        g.fill(bx + 6, by + 1, 1, 5, C.deepFaint);
        g.text(r.x + 28, r.y + Math.round((r.h - 7) / 2), 'empty slot', C.deepFaint);
      }

      // --- detail -----------------------------------------------------------
      const rightX = win.x + leftW + 4;
      const rightW = win.x + win.w - rightX;
      const detail = section(g, { x: rightX, y: win.y, w: rightW, h: win.h }, 'DETAIL',
        { bar: C.stoneShadow, light: C.stoneBase });
      const m = list[cursor];
      if (!m) return;

      let y = detail.y + 5;
      const port = { x: detail.x + 4, y, w: 40, h: 40 };
      g.fill(port.x, port.y, port.w, port.h, C.glassDeep);
      g.fill(port.x, port.y, port.w, 1, C.ink);
      app.hud.drawIcon(g, m, port.x + 4, port.y + 4, 32);
      g.text(port.x + 46, y + 3, m.display, C.ink, { max: detail.w - 54 });
      g.text(port.x + 46, y + 13, `Lv ${m.level}`, C.shadowInk);
      g.text(port.x + 46, y + 23, m.types.join(' / ') || '—', C.martShadow);
      if (m.shiny) g.text(port.x + 46, y + 33, '★ shiny', C.glowDeep);
      y += 46;

      // base stats, with the individual value drawn over them as a lighter tick
      const maxStat = 180;
      for (const [key, label] of STAT_KEYS) {
        const base = Number(m.stats?.[key] ?? 0);
        g.text(detail.x + 5, y, label, C.shadowInk);
        const bx = detail.x + 26;
        const bw = detail.w - 58;
        meter(g, { x: bx, y: y + 1, w: bw, h: 5 }, base / maxStat,
          { fill: C.martBase, light: C.martLight, back: C.wallDeep });
        const iv = Number(m.ivs?.[key] ?? 0);
        const ix = bx + 1 + Math.round((bw - 2) * Math.min(1, iv / 31));
        g.fill(ix, y, 1, 7, iv >= 28 ? C.glowLight : C.stoneLight);
        g.textRight(detail.x + detail.w - 5, y, String(base), C.ink);
        y += 8;
      }
      y += 3;
      g.text(detail.x + 5, y, 'the tick is that stat\'s IV', C.stoneShadow, { max: detail.w - 10 });
      y += 12;

      // The lead is a *rule of this game*, not a checkbox, so the pane says what it does
      // instead of leaving a third of the window blank above the button (round-1 issue 11).
      g.fill(detail.x + 4, y, detail.w - 8, 1, C.wallDeep);
      y += 4;
      const ivTotal = STAT_KEYS.reduce((a, [k]) => a + Number(m.ivs?.[k] ?? 0), 0);
      const bst = STAT_KEYS.reduce((a, [k]) => a + Number(m.stats?.[k] ?? 0), 0);
      for (const [label, value] of [
        ['IV total', `${ivTotal} / 186`],
        ['Base stat total', String(bst)],
        ['Slot', cursor === 0 ? 'leading' : `bench ${cursor + 1}`],
      ]) {
        g.text(detail.x + 5, y, label, C.shadowInk);
        g.textRight(detail.x + detail.w - 5, y, value, C.ink);
        y += 9;
      }
      y += 3;
      // Wrapped to the pane that actually got drawn, not to three hand-cut lines: the pane is
      // 158 px wide at 1080p and 124 at 720p, and a hand-cut line ellipsises at both.
      const blurb = wrap('The lead walks the city and the trainer follows it, so this is also the sprite you see on screen.', detail.w - 10);
      // All of it or none of it: half a sentence cut off mid-word is worse than the gap it
      // was put there to fill.
      if (y + blurb.length * 8 <= detail.y + detail.h - 20) {
        for (const line of blurb) { g.text(detail.x + 5, y, line, C.stoneShadow); y += 8; }
      }

      const by = detail.y + detail.h - 16;
      action(g, { x: detail.x + 4, y: by, w: detail.w - 8, h: 13 },
        cursor === 0 ? 'ALREADY LEADING' : 'MAKE IT LEAD', {
          disabled: cursor === 0, active: cursor !== 0,
          onPick: () => setLead(cursor), tag: 'set-lead',
        });
    },
  };
}

export { well };

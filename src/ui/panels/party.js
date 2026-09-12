/**
 * The party — and in this game that is not a bookkeeping screen. The **active Pokemon
 * leads** and the trainer follows it, so the first slot here is the sprite
 * walking around the city, and changing it changes the picture.
 *
 * `pokemon.setLead(i)` emits `party:leadChanged`; `simulation` listens for it, rebuilds the
 * conga line and re-packs the sprite atlas. This panel therefore never touches the walker
 * itself — it makes one call on `pokemon` and the world catches up on its own.
 */

import { C, windowFrame, section, action, well, fit, list as listWidget, tabs } from './common.js';
import { pokeball, meter } from '../theme.js';
import { wrap } from '../font.js';

const isLive = (api) => !!api && api.__missing === undefined;
const STAT_KEYS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

export function makeParty(app) {
  let cursor = 0;
  /** Which half of the detail pane is showing: the stat block, or the move list. */
  let view = 'stats';
  let moveCursor = 0;
  let moveTop = 0;

  const mon = () => app.ctx.get('pokemon');

  /** An item's shop name, so the list reads "Tiny Mushroom" rather than "tinymushroom". */
  function itemLabel(id) {
    const eco = app.ctx.get('economy');
    const def = isLive(eco) && typeof eco.item === 'function' ? eco.item(id) : null;
    return def?.name ?? id;
  }

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

  /** What the highlighted Pokemon is closest to evolving into, priced, or null. */
  function evolution(i) {
    const p = mon();
    const inst = members()[i]?.inst;
    if (!isLive(p) || typeof p.canEvolve !== 'function' || !inst) return null;
    return p.canEvolve(inst.instanceId);
  }

  /**
   * Presses it. **This is the only path into an evolution in the whole game** — nothing
   * evolves on its own any more, so the refusal has to be legible: `evolve()`
   * answers with the reason, and it is shown rather than swallowed.
   */
  function evolve(i) {
    const p = mon();
    const inst = members()[i]?.inst;
    if (!isLive(p) || typeof p.evolve !== 'function' || !inst) return;
    const res = p.evolve(inst.instanceId);
    if (!res?.ok) app.toast(res?.why ?? 'it cannot evolve yet', 'warn');
    app.markDirty();
  }

  /**
   * The move list, and the part of it the player controls.
   *
   * `battle.movesFor` fills the four slots with **the last four moves the species learned**,
   * biased by a preference list the player owns (`battle/moves.js`). That heuristic is right
   * far more often than not and it is not always right — a Pokemon that learns a good STAB
   * move early and three utility moves late walks into the grass with the utility. So the
   * pool is shown, the four in use are shown, and up to four can be pinned.
   *
   * The pool is what the species has learned **by this level**, exactly the set `movesFor`
   * chooses from; showing moves it cannot yet use would be a shopping list with no shop.
   */
  function moveModel(i) {
    const bt = app.ctx.get('battle');
    const inst = members()[i]?.inst;
    if (!isLive(bt) || typeof bt.learnset !== 'function' || !inst?.species) return null;
    const seen = new Set();
    const pool = [];
    for (const row of bt.learnset(inst.species.name)) {
      if (row.level > (inst.level ?? 1)) break;      // the list is level-ascending
      if (seen.has(row.move)) continue;
      seen.add(row.move);
      const def = bt.move(row.move);
      if (def) pool.push({ id: row.move, at: row.level, name: def.n, type: def.t, power: def.p, pp: def.pp, cat: def.c });
    }
    const raw = typeof bt.priority === 'function' ? bt.priority(inst.instanceId) : (inst.priority ?? []);
    return {
      inst,
      pool,
      pinned: raw.filter((id) => seen.has(id)),
      slots: (inst.moves ?? []).map((slot) => ({ ...slot, def: bt.move(slot.id) })),
    };
  }

  /**
   * Pins or unpins one move. Four is the ceiling because four is the number of slots — a
   * fifth pin would silently lose to `MOVE_SLOTS` inside `movesFor`, and a control that
   * accepts an input and then discards it is worse than one that refuses it.
   */
  function togglePin(i, id) {
    const model = moveModel(i);
    const p = mon();
    if (!model || !isLive(p) || typeof p.setPriority !== 'function') return;
    const next = model.pinned.includes(id)
      ? model.pinned.filter((x) => x !== id)
      : [...model.pinned, id];
    if (next.length > 4) { app.toast('Four moves is the whole of it — unpin one first', 'warn'); return; }
    p.setPriority(model.inst.instanceId, next);
    app.markDirty();
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

  /**
   * The move view.
   *
   * Two blocks: the four slots the Pokemon is actually carrying (with the PP left in each,
   * which a hunt spends and a Pokemon Center restores), and the pool it chooses them from.
   * A pinned move is one the player has told `movesFor` to keep; everything else is filled by
   * the recency heuristic.
   */
  function drawMoves(g, detail, y0, room) {
    const model = moveModel(cursor);
    let y = y0;
    if (!model) {
      for (const line of wrap('Move data is not loaded — the battle module is unavailable.', detail.w - 10)) {
        g.text(detail.x + 5, y, line, C.stoneShadow);
        y += 8;
      }
      return;
    }

    g.text(detail.x + 5, y, 'IN BATTLE', C.shadowInk);
    g.textRight(detail.x + detail.w - 5, y, 'PP', C.stoneShadow);
    y += 9;
    for (let i = 0; i < 4; i++) {
      const slot = model.slots[i];
      if (!slot) { g.text(detail.x + 5, y, '·  —', C.stoneShadow); y += 9; continue; }
      const pinned = model.pinned.includes(slot.id);
      g.text(detail.x + 5, y, pinned ? '★' : '·', pinned ? C.glowDeep : C.stoneShadow);
      g.text(detail.x + 14, y, slot.def?.n ?? slot.id, C.ink, { max: detail.w - 52 });
      // Zero PP is not cosmetic — it is why a Pokemon Struggles — so it is the one number
      // in this block that changes colour.
      g.textRight(detail.x + detail.w - 5, y, `${slot.pp}/${slot.maxPp}`,
        slot.pp === 0 ? C.roofBase : C.shadowInk);
      y += 9;
    }
    y += 3;

    g.text(detail.x + 5, y, 'LEARNED', C.shadowInk);
    g.textRight(detail.x + detail.w - 5, y, `${model.pinned.length}/4 pinned`,
      model.pinned.length ? C.glowDeep : C.stoneShadow);
    y += 9;

    // The note is drawn before the list is sized, because it is not optional: a player who
    // pins four status moves and sees two of them replaced would otherwise conclude the
    // control is broken. `movesFor` guarantees two attacks (`MIN_ATTACKS`) and takes the
    // slots it needs from whatever is NOT pinned.
    const note = 'two slots always hold attacks';
    const listH = Math.max(20, room - y - 9);
    moveCursor = Math.max(0, Math.min(model.pool.length - 1, moveCursor));
    const rowH = 10;
    const rows = Math.max(1, Math.floor(listH / rowH));
    if (moveCursor < moveTop) moveTop = moveCursor;
    if (moveCursor >= moveTop + rows) moveTop = moveCursor - rows + 1;

    const out = listWidget(g, { x: detail.x + 4, y, w: detail.w - 8, h: listH }, {
      items: model.pool, rowH, top: moveTop, selected: moveCursor, tag: 'move',
      onPick: (i, item) => { moveCursor = i; togglePin(cursor, item.id); },
      draw(gg, item, rect, st) {
        const pinned = model.pinned.includes(item.id);
        gg.text(rect.x + 2, rect.y + 2, pinned ? '★' : '·', pinned ? C.glowDeep : st.ink);
        gg.text(rect.x + 11, rect.y + 2, item.name, st.ink, { max: rect.w - 52 });
        // Type and power, because that is what a choice between two moves is made on. A
        // status move has no power and says so rather than printing a zero.
        gg.textRight(rect.x + rect.w - 3, rect.y + 2,
          `${item.type.slice(0, 3).toUpperCase()} ${item.power ? item.power : '—'}`,
          st.selected ? C.glassLight : C.stoneShadow);
      },
    });
    moveTop = out.top;
    g.text(detail.x + 5, y + listH + 1, note, C.stoneShadow, { max: detail.w - 10 });
  }

  return {
    id: 'party',
    /** Inert data: nothing reads `panel.full` for sizing or
     *  anything else any more. Kept as a record of which panels used to stand the whole HUD
     *  down while open — only `dialogue`'s `hidesHud` still does that — and for `battle.js`'s
     *  own header comment, which contrasts its `full: false` against every panel here. */
    full: true,
    /** Not part of the panel contract `ui/index.js` drives — `travel.js`'s `rows()` precedent
     *  for exposing internal state a test needs and nothing else reads (`state.panel.cursor()`
     *  off `ui`'s own `_state`, which is already exposed for exactly this). */
    cursor: () => cursor,
    /**
     * `view: 'moves'` opens straight on the move list — the showcase's way in (tools/shots/shoot.js).
     * `select: i` opens with slot `i` already highlighted — the party bar's own
     * click, `ui.open('party', { select: i })` — and falls back to today's default of slot 0
     * when no `select` is given, so every existing caller (the keyboard shortcut, the menu)
     * is unaffected.
     */
    open(opts) {
      cursor = Number.isInteger(opts?.select) ? opts.select : 0;
      view = opts?.view === 'moves' ? 'moves' : 'stats';
      moveCursor = 0; moveTop = 0;
    },
    close() {},

    key(ev) {
      const roster = members();
      const code = ev.code;
      if (code === 'KeyM') { view = view === 'moves' ? 'stats' : 'moves'; moveCursor = 0; moveTop = 0; app.markDirty(); return true; }
      // In the move view the arrows belong to the move list — the party is six rows and the
      // pool is twenty, and the list that cannot be reached any other way gets the keys.
      if (view === 'moves') {
        const pool = moveModel(cursor)?.pool ?? [];
        if (code === 'ArrowUp' || code === 'KeyW') { moveCursor = Math.max(0, moveCursor - 1); app.markDirty(); return true; }
        if (code === 'ArrowDown' || code === 'KeyS') { moveCursor = Math.min(pool.length - 1, moveCursor + 1); app.markDirty(); return true; }
        if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { if (pool[moveCursor]) togglePin(cursor, pool[moveCursor].id); return true; }
        if (code === 'KeyE') { evolve(cursor); return true; }
        return false;
      }
      if (code === 'ArrowUp' || code === 'KeyW') { cursor = Math.max(0, cursor - 1); moveCursor = 0; moveTop = 0; app.markDirty(); return true; }
      if (code === 'ArrowDown' || code === 'KeyS') { cursor = Math.min(roster.length - 1, cursor + 1); moveCursor = 0; moveTop = 0; app.markDirty(); return true; }
      if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { setLead(cursor); return true; }
      if (code === 'KeyE') { evolve(cursor); return true; }
      return false;
    },

    draw(g) {
      const list = members();
      cursor = Math.max(0, Math.min(list.length - 1, cursor));
      const win = windowFrame(g, {
        windowId: 'party', reserved: app.hudReserved(),
        title: 'PARTY', bar: C.roofBase, edge: C.roofDeep, light: C.roofLight,
        footer: view === 'moves'
          ? '↑↓ choose    Z pin / unpin    M back to stats    X close'
          : '↑↓ choose    Z make it lead    E evolve    M moves    X close',
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

      // Two views of the same Pokemon, because the pane cannot hold both: what it *is*, and
       // what it *does*. The tabs are the affordance; `M` is the shortcut.
      tabs(g, detail.x + 4, y, [{ id: 'stats', label: 'STATS' }, { id: 'moves', label: 'MOVES' }], {
        active: view, h: 11, tag: 'party-view',
        onPick: (id) => { if (id !== view) { view = id; moveCursor = 0; moveTop = 0; } app.markDirty(); },
      });
      y += 14;

      const evo = evolution(cursor);
      const room = detail.y + detail.h - 32;

      if (view === 'moves') {
        drawMoves(g, detail, y, room);
      } else {
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

      // --- what it would take to evolve ------------------------------------
      // The bill, not a verdict. A greyed-out button that does not say WHY is the thing this
      // panel exists to avoid, so the level and every material are listed with what the bag
      // actually holds beside them — a shopping list the player can go and fill.
      if (evo) {
        g.fill(detail.x + 4, y - 2, detail.w - 8, 1, C.wallDeep);
        y += 2;
        // Ink when it is ready, muted when it is not. Deliberately NOT the red accent: red is
        // what the unmet rows below use, and a heading in the same colour as the failures read
        // as another failure.
        g.text(detail.x + 5, y, `EVOLVES INTO ${String(evo.display ?? evo.to).toUpperCase()}`,
          evo.ready ? C.ink : C.shadowInk, { max: detail.w - 10 });
        y += 9;
        const lvOk = evo.have >= evo.level;
        g.text(detail.x + 5, y, `Level ${evo.level}`, C.shadowInk);
        g.textRight(detail.x + detail.w - 5, y, lvOk ? `${evo.have} ✓` : String(evo.have),
          lvOk ? C.ink : C.roofBase);
        y += 9;
        for (const m of evo.materials ?? []) {
          if (y > room) break;
          const ok = m.have >= m.n;
          g.text(detail.x + 5, y, itemLabel(m.id), C.shadowInk, { max: detail.w - 46 });
          g.textRight(detail.x + detail.w - 5, y, `${m.have}/${m.n}${ok ? ' ✓' : ''}`,
            ok ? C.ink : C.roofBase);
          y += 9;
        }
      } else {
        // Wrapped to the pane that actually got drawn, not to three hand-cut lines: the pane
        // is 158 px wide at 1080p and 124 at 720p, and a hand-cut line ellipsises at both.
        const blurb = wrap('The lead walks the city and the trainer follows it, so this is also the sprite you see on screen.', detail.w - 10);
        // All of it or none of it: half a sentence cut off mid-word is worse than the gap it
        // was put there to fill.
        if (y + blurb.length * 8 <= room) {
          for (const line of blurb) { g.text(detail.x + 5, y, line, C.stoneShadow); y += 8; }
        }
      }
      }

      // Two rows, evolve on top, because it is the one that changes the Pokemon and the one
      // the player came here for once a hunt has paid out.
      const by = detail.y + detail.h - 16;
      if (evo) {
        action(g, { x: detail.x + 4, y: by - 15, w: detail.w - 8, h: 13 },
          evo.ready ? 'EVOLVE' : 'CANNOT EVOLVE YET', {
            disabled: !evo.ready, active: evo.ready,
            onPick: () => evolve(cursor), tag: 'evolve',
          });
      }
      action(g, { x: detail.x + 4, y: by, w: detail.w - 8, h: 13 },
        cursor === 0 ? 'ALREADY LEADING' : 'MAKE IT LEAD', {
          disabled: cursor === 0, active: cursor !== 0,
          onPick: () => setLead(cursor), tag: 'set-lead',
        });
    },
  };
}

export { well };

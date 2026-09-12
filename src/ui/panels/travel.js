/**
 * The travel panel — the only way the player reaches a hunt.
 *
 * Four biomes have been built and registered since `hunts` was written and none of them was
 * reachable without editing a URL. This is the menu that connects them to the lobby, and it
 * is deliberately the plainest panel in the game: a list of places, the one you are standing
 * in marked, and nothing else to decide.
 *
 * It owns no knowledge of what a destination is. `travel.destinations()` is the authority —
 * the city and every biome, each carrying the formation its own scene declared — so adding a
 * biome adds a row here with no edit.
 */

import { C, fit, list, section, windowFrame } from './common.js';

/** The registry's null object answers every property with a function — this is the tell. */
const isLive = (api) => !!api && api.__missing === undefined;

export function makeTravel(app) {
  let cursor = 0;
  let top = 0;
  /** The destination a `go()` is in flight for, so the panel can show which row is loading. */
  let pending = null;

  const travel = () => app.ctx.get('travel');

  /** Also handed back on the returned panel object, purely so `travel.test.js` can assert
   *  the `hidden` filter without a canvas — `draw()` is the only other consumer and it
   *  needs one. Not part of the panel contract `ui/index.js` drives. */
  function rows() {
    const t = travel();
    if (!isLive(t) || typeof t.destinations !== 'function') return [];
    const here = t.current()?.id ?? null;
    // `hidden` is door-only entry (§5.16) — the Pokemon Center is reached by walking through
    // it in the city, never by picking it here. `travel.go()` still accepts the id; only the
    // row is gone.
    return t.destinations().filter((d) => !d.hidden).map((d) => ({
      id: d.id,
      label: d.name,
      kind: d.kind,
      here: d.id === here,
      loading: d.id === pending,
      // A hunt the trainer is too low for is SHOWN AND GREYED, never hidden — the same rule
      // `economy/shops.js` uses for a shelf that is not unlocked yet. A destination you cannot
      // see is not a goal; one you can see with its price on it is (DECISIONS #70).
      locked: !!d.locked,
      need: Number(d.requiredLevel) || 0,
      // The place you are already standing in is not a destination, and nothing is pickable
      // while a map is being built. **A locked row is NOT disabled**: pressing it is how the
      // player finds out what it wants, because `go()` refuses it with a sentence. A greyed
      // row that swallows the keypress is the fault `panels/party.js` was rewritten to avoid.
      disabled: d.id === here || !!pending,
    }));
  }

  /**
   * Three independent locks, because a click and a keypress can land in the same frame and
   * `enter()` is asynchronous: this panel's own `pending`, `travel.busy()` — which is the
   * authoritative one, since travel can also be driven from the console — and the fact that
   * an open panel swallows every key (`ui/input.js`).
   */
  function pick(item) {
    if (!item || item.disabled || pending) return;
    const t = travel();
    if (!isLive(t) || typeof t.go !== 'function' || t.busy?.()) return;
    // Locked: let `go()` refuse it out loud. No `pending`, because nothing is loading — the
    // player gets the toast that names the level and the panel stays open on the row.
    if (item.locked) { t.go(item.id); app.markDirty(); return; }
    pending = item.id;
    app.markDirty();
    Promise.resolve(t.go(item.id))
      .then((ok) => { pending = null; if (ok) app.close(); else app.markDirty(); })
      .catch(() => { pending = null; app.markDirty(); });
  }

  return {
    id: 'travel',
    /** Not part of the panel contract `ui/input.js` drives — see the comment on `rows()`. */
    rows,

    open() {
      const items = rows();
      // Open on the first row below the one you are standing in that is somewhere you can
      // actually go. Every hunt but the meadow is gated now, so "the row below" on its own
      // opens the panel with the cursor sitting on a wall.
      const here = items.findIndex((r) => r.here);
      cursor = 0;
      for (let i = 1; i <= items.length; i++) {
        const k = (here + i + items.length) % items.length;
        if (!items[k].here && !items[k].locked) { cursor = k; break; }
        if (i === items.length) cursor = items.length ? (here + 1) % items.length : 0;
      }
      top = 0;
    },
    close() { pending = null; },

    key(ev) {
      const items = rows();
      if (!items.length) return false;
      const code = ev.code;
      if (code === 'ArrowUp' || code === 'KeyW') {
        cursor = (cursor + items.length - 1) % items.length; app.markDirty(); return true;
      }
      if (code === 'ArrowDown' || code === 'KeyS') {
        cursor = (cursor + 1) % items.length; app.markDirty(); return true;
      }
      if (code === 'Enter' || code === 'KeyZ' || code === 'Space') { pick(items[cursor]); return true; }
      return false;
    },

    draw(g) {
      const items = rows();
      // Sized through `fit`, never hard-coded: the buffer is 640x360 at 1080p but 426x239 at
      // 720p, and an authored number is what put two panels off the left edge in round 1.
      const { w, h } = fit(g, 212, 128);
      const inner = windowFrame(g, {
        title: 'TRAVEL', w, h,
        bar: C.deepBase ?? C.roofBase, edge: C.roofDeep, light: C.roofLight,
        footer: pending ? 'travelling…' : '↑↓ choose   Z go   X back',
        onClose: () => app.close(),
      });

      if (!items.length) {
        g.textCentre(inner.x + inner.w / 2, inner.y + Math.round(inner.h / 2) - 4,
          'Travel is unavailable', C.shadowInk);
        return;
      }

      const box = section(g, inner, 'DESTINATIONS');
      const rowH = 13;
      const rows_ = Math.max(1, Math.floor(box.h / rowH));
      // Keep the cursor in view without a scroll model of its own.
      if (cursor < top) top = cursor;
      if (cursor >= top + rows_) top = cursor - rows_ + 1;

      list(g, box, {
        items, rowH, top, selected: cursor, tag: 'travel',
        onPick: (_i, item) => pick(item),
        draw: (g2, item, rect, st) => {
          g2.text(rect.x + 4, rect.y + 3, item.label, item.locked ? C.stoneShadow : st.ink);
          const note = item.loading ? '…'
            : item.here ? 'HERE'
              : item.locked ? `Lv${item.need}` : item.kind;
          g2.textRight(rect.x + rect.w - 4, rect.y + 3, note,
            item.here ? C.martBase : item.locked ? C.roofBase : C.shadowInk);
        },
      });
    },
  };
}

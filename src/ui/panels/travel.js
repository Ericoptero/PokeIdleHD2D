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

  function rows() {
    const t = travel();
    if (!isLive(t) || typeof t.destinations !== 'function') return [];
    const here = t.current()?.id ?? null;
    return t.destinations().map((d) => ({
      id: d.id,
      label: d.name,
      kind: d.kind,
      here: d.id === here,
      loading: d.id === pending,
      // The place you are already standing in is not a destination, and nothing is pickable
      // while a map is being built.
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
    pending = item.id;
    app.markDirty();
    Promise.resolve(t.go(item.id))
      .then((ok) => { pending = null; if (ok) app.close(); else app.markDirty(); })
      .catch(() => { pending = null; app.markDirty(); });
  }

  return {
    id: 'travel',

    open() {
      const items = rows();
      // Open on the row below the one you are standing in, so the first thing under the
      // cursor is somewhere you can actually go.
      const here = items.findIndex((r) => r.here);
      cursor = items.length ? (here + 1) % items.length : 0;
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
          g2.text(rect.x + 4, rect.y + 3, item.label, st.ink);
          const note = item.loading ? '…' : item.here ? 'HERE' : item.kind;
          g2.textRight(rect.x + rect.w - 4, rect.y + 3, note,
            item.here ? C.martBase : C.shadowInk);
        },
      });
    },
  };
}

/**
 * Box storage — real storage, with a real capacity.
 *
 * Pure data, like `dex.js`: no ctx, no bus, no DOM. It owns *where things are*, and nothing
 * else. The dex counts, the module wires, this file addresses slots.
 *
 * ### Shape
 *
 * `BOX_CAPACITY` 30 and `DEFAULT_BOXES` 32 are the mainline's own numbers from Gen 8
 * onwards (5 × 6 to a page, 32 pages, 960 slots). They matter because an idle game with
 * auto-catch fills them: the interesting behaviour of this module is what happens when
 * storage runs out, and that only exists if storage can run out.
 *
 * ### Two placement calls, deliberately different
 *
 * `deposit(entry)` takes the first free slot in box order — what happens when a Pokémon is
 * caught. `place(entry, box, slot)` puts one in an exact slot and fails if it is taken.
 * `move(uid, box, slot)` is the player's drag: it **swaps** with whatever is already there
 * rather than refusing, because refusing is what makes a box screen infuriating, and a swap
 * is always legal (both Pokémon have somewhere to be).
 *
 * A slot is `null` when empty; boxes are sparse and stay sparse until something asks for a
 * compaction. `sort()` in `sorting.js` is the only thing that compacts, and it does so
 * across the whole storage.
 */

export const BOX_CAPACITY = 30;
export const DEFAULT_BOXES = 32;
/** Page geometry the box screen draws with; 5 across × 6 down is the mainline layout. */
export const BOX_COLS = 6;
export const BOX_ROWS = BOX_CAPACITY / BOX_COLS;

/**
 * Wallpapers, cycled deterministically by box index. Names only — this module renders
 * nothing; whoever draws the box screen decides what a "forest" wallpaper looks like.
 */
export const WALLPAPERS = Object.freeze([
  'meadow', 'forest', 'cave', 'coast', 'city', 'volcano', 'tundra', 'ruins',
]);

export function makeBoxes({ count = DEFAULT_BOXES, capacity = BOX_CAPACITY } = {}) {
  const boxes = [];
  /** uid -> { box, slot }, so `find` is O(1) instead of a scan over 960 slots. */
  const index = new Map();

  function makeBox(i) {
    return {
      index: i,
      name: `Box ${i + 1}`,
      wallpaper: WALLPAPERS[i % WALLPAPERS.length],
      slots: new Array(capacity).fill(null),
    };
  }
  for (let i = 0; i < count; i++) boxes.push(makeBox(i));

  const valid = (b, s) => Number.isInteger(b) && Number.isInteger(s)
    && b >= 0 && b < boxes.length && s >= 0 && s < capacity;

  function set(b, s, entry) {
    boxes[b].slots[s] = entry;
    if (entry) {
      entry.box = b;
      entry.slot = s;
      index.set(entry.uid, { box: b, slot: s });
    }
  }

  function clear(b, s) {
    const held = boxes[b].slots[s];
    boxes[b].slots[s] = null;
    if (held) index.delete(held.uid);
    return held;
  }

  const api = {
    capacity,
    count: () => boxes.length,
    totalSlots: () => boxes.length * capacity,

    /** Live boxes, for internal callers. `list()` is the copy the public API hands out. */
    raw: () => boxes,

    box(i) { return boxes[i] ?? null; },
    at(b, s) { return valid(b, s) ? boxes[b].slots[s] : null; },

    find(uid) {
      const at = index.get(uid);
      return at ? boxes[at.box].slots[at.slot] : null;
    },
    locate: (uid) => (index.has(uid) ? { ...index.get(uid) } : null),
    has: (uid) => index.has(uid),

    /** Every stored entry, in box then slot order. */
    all() {
      const out = [];
      for (const b of boxes) for (const e of b.slots) if (e) out.push(e);
      return out;
    },
    used: () => index.size,
    free() { return boxes.length * capacity - index.size; },
    isFull() { return index.size >= boxes.length * capacity; },

    /** @returns {{box:number, slot:number}|null} */
    firstFree() {
      for (const b of boxes) {
        const s = b.slots.indexOf(null);
        if (s >= 0) return { box: b.index, slot: s };
      }
      return null;
    },

    /** First free slot, in box order. `null` when storage is full — the caller decides. */
    deposit(entry) {
      const at = api.firstFree();
      if (!at) return null;
      set(at.box, at.slot, entry);
      return at;
    },

    /** Exact placement. Fails rather than displacing; used by `sort` and by `loadState`. */
    place(entry, b, s) {
      if (!valid(b, s) || boxes[b].slots[s]) return false;
      set(b, s, entry);
      return true;
    },

    /** The player's drag: swaps with the occupant instead of refusing. */
    move(uid, b, s) {
      const at = index.get(uid);
      if (!at || !valid(b, s)) return false;
      if (at.box === b && at.slot === s) return true;
      const moving = boxes[at.box].slots[at.slot];
      const displaced = boxes[b].slots[s];
      clear(at.box, at.slot);
      if (displaced) { boxes[b].slots[s] = null; index.delete(displaced.uid); }
      set(b, s, moving);
      if (displaced) set(at.box, at.slot, displaced);
      return true;
    },

    /** Straight swap of two addresses, either of which may be empty. */
    swap(b1, s1, b2, s2) {
      if (!valid(b1, s1) || !valid(b2, s2)) return false;
      const a = clear(b1, s1);
      const c = clear(b2, s2);
      if (c) set(b1, s1, c);
      if (a) set(b2, s2, a);
      return true;
    },

    take(uid) {
      const at = index.get(uid);
      if (!at) return null;
      return clear(at.box, at.slot);
    },

    /** Removes everything, leaving the boxes' names and wallpapers alone. */
    clearAll() {
      for (const b of boxes) b.slots.fill(null);
      index.clear();
    },

    /** Re-lays one box from slot 0 with no gaps. Anything past its capacity is dropped. */
    layoutBox(i, entries) {
      const b = boxes[i];
      if (!b) return 0;
      for (let s = 0; s < capacity; s++) {
        const held = b.slots[s];
        if (held) index.delete(held.uid);
        b.slots[s] = null;
      }
      let n = 0;
      for (const e of entries) {
        if (n >= capacity) break;
        set(i, n, e);
        n++;
      }
      return n;
    },

    /** Re-lays a list of entries from box 0 slot 0 with no gaps. */
    layout(entries) {
      api.clearAll();
      let b = 0, s = 0;
      let placed = 0;
      for (const e of entries) {
        if (b >= boxes.length) break;
        set(b, s, e);
        placed++;
        if (++s >= capacity) { s = 0; b++; }
      }
      return placed;
    },

    rename(i, name) {
      if (!boxes[i] || typeof name !== 'string' || !name.trim()) return false;
      boxes[i].name = name.trim().slice(0, 24);
      return true;
    },
    setWallpaper(i, wallpaper) {
      if (!boxes[i] || !WALLPAPERS.includes(wallpaper)) return false;
      boxes[i].wallpaper = wallpaper;
      return true;
    },

    /** Adds a box, up to `max`. Storage grows; it never shrinks under a stored Pokémon. */
    addBox(max = 64) {
      if (boxes.length >= max) return null;
      const b = makeBox(boxes.length);
      boxes.push(b);
      return b.index;
    },

    stats() {
      const perBox = boxes.map((b) => b.slots.reduce((n, e) => n + (e ? 1 : 0), 0));
      const used = index.size;
      const total = boxes.length * capacity;
      let fullest = 0;
      for (let i = 1; i < perBox.length; i++) if (perBox[i] > perBox[fullest]) fullest = i;
      return {
        count: boxes.length, capacity, total, used, free: total - used,
        pct: total ? +((used / total) * 100).toFixed(1) : 0,
        fullest: { index: fullest, name: boxes[fullest].name, used: perBox[fullest] },
        perBox,
        boxesInUse: perBox.filter((n) => n > 0).length,
      };
    },

    /** Metadata only; the entries themselves are serialised by the module. */
    meta: () => boxes.map((b) => ({ name: b.name, wallpaper: b.wallpaper })),
    setMeta(meta = []) {
      meta.forEach((m, i) => {
        while (i >= boxes.length) boxes.push(makeBox(boxes.length));
        if (m?.name) boxes[i].name = String(m.name).slice(0, 24);
        if (m?.wallpaper) boxes[i].wallpaper = String(m.wallpaper);
      });
    },
  };

  return api;
}

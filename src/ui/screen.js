/**
 * The UI surface: one 2-D canvas whose backing store is **exactly the renderer's internal
 * buffer** (640×360 at 1080p), stretched over the viewport with `image-rendering: pixelated`.
 *
 * Why not DOM, which is what the seed did and what §5.12 assumes: the game is drawn into a
 * low-resolution buffer and upscaled with NEAREST so geometry and sprites share one pixel
 * grid (ARCHITECTURE §2.7). Text and panels laid out in CSS pixels are the one thing on
 * screen that is *not* on that grid — a 12 px antialiased label over a 3×-blocky world reads
 * as a debug overlay, not as the game's own menu. Taking the size from
 * `ctx.three.view.internalSize` rather than recomputing it from `pixelScale` means the UI
 * inherits the scene's own rounding, including the non-integer upscale at 1600×900
 * (533 → 1600 is ×3.002): the two surfaces are stretched by the same factor, so a panel edge
 * lands on a tile edge.
 *
 * It costs **zero draw calls**: this is a 2-D canvas composited by the browser, not geometry
 * handed to WebGL, and `renderer.info.render.calls` — the number §7 budgets — never sees it.
 * It is repainted only when something marks it dirty.
 */

import { HEIGHT, TRACKING, glyph, ellipsize, characters } from './font.js';
import { startDrag, move as moveDrag, drop as dropDrag, cancel as cancelDrag } from './gesture.js';

/** Ink colour of the atlas before it is tinted. */
const ATLAS_INK = '#ffffff';

function buildAtlas(chars) {
  const cells = new Map();
  let x = 0;
  for (const ch of chars) {
    const g = glyph(ch);
    cells.set(ch, { x, w: g.w, g });
    x += g.w + 1;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, x);
  canvas.height = HEIGHT;
  const c2 = canvas.getContext('2d');
  c2.fillStyle = ATLAS_INK;
  for (const { x: gx, g } of cells.values()) {
    for (let j = 0; j < g.rows.length; j++) {
      const row = g.rows[j];
      let i = 0;
      while (i < row.length) {
        if (row[i] !== '#') { i++; continue; }
        let run = 1;
        while (row[i + run] === '#') run++;
        c2.fillRect(gx + i, g.top + j, run, 1);
        i += run;
      }
    }
  }
  return { canvas, cells };
}

export function makeScreen({ root, view, log }) {
  const canvas = document.createElement('canvas');
  canvas.id = 'ui-screen';
  canvas.style.cssText = 'position:absolute;left:0;top:0;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;pointer-events:none;';
  const g2 = canvas.getContext('2d', { alpha: true, desynchronized: false });
  root.appendChild(canvas);

  // -1 rather than 0: `internalSize` is [0, 0] until `src/main.js` sizes the renderer, which
  // happens *after* every module's init, so the first honest size arrives on a later frame
  // and the guard below must not mistake "not sized yet" for "already this size".
  let W = -1, H = -1;
  let dirty = true;

  // --- the font atlas, and one tinted copy per colour actually used ----------
  // Every glyph the font defines, not a hand-listed subset: a glyph that exists in the data
  // but is missing from the atlas draws as a blank of the right width, which is exactly the
  // kind of bug that survives review ("POKé MART" rendered "POK  MART" for one round).
  const atlas = buildAtlas(characters());
  const tints = new Map();

  function tinted(colour) {
    let c = tints.get(colour);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = atlas.canvas.width;
    c.height = atlas.canvas.height;
    const cx = c.getContext('2d');
    cx.drawImage(atlas.canvas, 0, 0);
    cx.globalCompositeOperation = 'source-in';
    cx.fillStyle = colour;
    cx.fillRect(0, 0, c.width, c.height);
    tints.set(colour, c);
    return c;
  }

  // --- images (sprite sheets) ------------------------------------------------
  const images = new Map();
  /** Loads once, repaints when it lands. Returns null until then — never blocks a frame. */
  function image(url) {
    if (!url) return null;
    let rec = images.get(url);
    if (rec) return rec.ok ? rec.img : null;
    const img = new Image();
    rec = { img, ok: false };
    images.set(url, rec);
    img.onload = () => { rec.ok = true; dirty = true; };
    img.onerror = () => { log?.warn?.(`ui: sprite sheet failed to load — ${url}`); };
    img.src = url;
    return null;
  }
  /** Resolves once every sheet asked for so far has landed; the showcase awaits it. */
  function imagesSettled() {
    const pending = [...images.values()].filter((r) => !r.ok);
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map((r) => new Promise((done) => {
      if (r.ok || r.img.complete) return done();
      r.img.addEventListener('load', done, { once: true });
      r.img.addEventListener('error', done, { once: true });
      return undefined;
    })));
  }

  // --- hit regions -----------------------------------------------------------
  /**
   * @type {{x:number,y:number,w:number,h:number,on:Function|undefined,tag:string,
   *   drag:{payload:*}|undefined, drop:{accepts:Function,on:Function}|undefined,
   *   scroll:Function|undefined, swallow:boolean}[]}
   */
  let regions = [];
  let hovered = null;
  /**
   * The gesture that survives the `regions = []` reset every `paint()` does (DECISIONS #84):
   * keyed on what was picked up (a tag and a payload), never on a rectangle, because a
   * rectangle drawn this frame is meaningless the instant the next one moves it.
   * @type {import('./gesture.js').DragState|null}
   */
  let dragState = null;
  /** The last point a pointermove saw, so the next one can compute a delta rather than a
   *  new absolute position — `move()` only ever takes a delta (`gesture.js`). */
  let lastPoint = null;

  /**
   * Takes the renderer's own internal buffer size rather than recomputing it, so the UI grid
   * and the scene's grid are the same grid. Called every frame — two array reads — because
   * the renderer resizes on its own schedule and a window listener can run before it does.
   */
  function resize() {
    const size = view?.internalSize;
    const iw = Number(size?.[0]) >= 2 ? Math.floor(size[0]) : 640;
    const ih = Number(size?.[1]) >= 2 ? Math.floor(size[1]) : 360;
    // The scene's canvas is an integer multiple of the internal buffer and letterboxed
    // inside the viewport (`core/render.js`), so this one has to sit on exactly the same
    // rect. Stretching it over the whole viewport instead would put the HUD on a different
    // grid from the world and send every click a pixel or two off the row under the cursor.
    const rect = view?.displayRect;
    if (rect && rect.w > 0) {
      canvas.style.left = `${rect.left}px`;
      canvas.style.top = `${rect.top}px`;
      canvas.style.width = `${rect.w}px`;
      canvas.style.height = `${rect.h}px`;
    }
    if (iw === W && ih === H) return false;
    W = iw; H = ih;
    canvas.width = W;
    canvas.height = H;
    g2.imageSmoothingEnabled = false;
    dirty = true;
    return true;
  }
  resize();

  const toUi = (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.floor((ev.clientX - r.left) / r.width * W),
      y: Math.floor((ev.clientY - r.top) / r.height * H),
    };
  };
  const inside = (r, p) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
  /** Last registered wins, matching paint order — see the comment on `hit()` below. */
  const pick = (p) => {
    for (let i = regions.length - 1; i >= 0; i--) if (inside(regions[i], p)) return regions[i];
    return null;
  };
  /**
   * Finds the region a `wheel` or a drop should act on by the field it carries
   * (`'scroll'`/`'drop'`), not by z-order: a `list()`'s scroll target covers its whole box and
   * is registered *before* its own rows so an ordinary click still finds a row first via
   * `pick()`, but a wheel event has to find the scroll target regardless of what is drawn on
   * top of it. `test`, when given, additionally filters (used for `drop.accepts(payload)`).
   */
  const pickBy = (p, key, test) => {
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (r[key] && inside(r, p) && (!test || test(r))) return r;
    }
    return null;
  };

  const listeners = [];
  const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); listeners.push(() => el.removeEventListener(type, fn, opts)); };

  // The canvas itself never claims pointer events — it covers the whole viewport, and other
  // modules' showcases append their own DOM into `#ui` beside it. Instead the listeners sit
  // on the window and only act when one of the regions *this* module drew is actually under
  // the pointer, so a click anywhere else reaches whatever else is on the page.
  on(window, 'pointerdown', (ev) => {
    const p = toUi(ev);
    if (!p) return;
    const r = pick(p);
    if (!r) return;
    ev.preventDefault();
    if (r.drag) {
      // Picked up, not clicked: the state that survives is `{tag, payload}` (`gesture.js`),
      // never the rectangle `r` — `r` does not outlive this frame's `paint()`.
      dragState = startDrag(r.drag.payload, r.tag, p.x, p.y);
    } else if (r.swallow) {
      // Consumes the pointerdown without calling anything — the window-body catcher: it sits
      // over the panel's own paper so a click there stops here rather than falling through to
      // the full-buffer scrim registered under it (DECISIONS #84).
    } else if (typeof r.on === 'function') {
      try { r.on(r, p); } catch (err) { log?.warn?.('ui: a panel handler threw', err); }
    }
    dirty = true;
  }, true);
  on(window, 'pointermove', (ev) => {
    const p = toUi(ev);
    if (!p) return;
    if (dragState) {
      const dx = lastPoint ? p.x - lastPoint.x : 0;
      const dy = lastPoint ? p.y - lastPoint.y : 0;
      dragState = moveDrag(dragState, dx, dy);
      dirty = true;
    }
    lastPoint = p;
    const r = pick(p);
    const tag = r?.tag ?? null;
    if (tag !== hovered) { hovered = tag; dirty = true; }
    document.documentElement.style.cursor = dragState ? 'grabbing' : (r && (r.on || r.drag) ? 'pointer' : '');
  });
  // No drag survives the pointer leaving the window without a matching up/cancel: dropping
  // outside the buffer, or the OS taking the gesture away (an alt-tab, a touch that left the
  // screen), must not leave `dragState` picked up forever.
  on(window, 'pointerup', (ev) => {
    if (!dragState) return;
    const state = dragState;
    const p = toUi(ev) ?? lastPoint;
    const target = p ? pickBy(p, 'drop', (r) => r.drop.accepts?.(state.payload)) : null;
    if (target) {
      try { target.drop.on(state.payload, p); } catch (err) { log?.warn?.('ui: a drop handler threw', err); }
    }
    dragState = dropDrag(state, target);
    dragState = null; // the gesture is over either way — dropped or cancelled, nothing survives it
    dirty = true;
  });
  on(window, 'pointercancel', () => {
    if (!dragState) return;
    dragState = cancelDrag(dragState);
    dirty = true;
  });
  on(window, 'wheel', (ev) => {
    const p = toUi(ev);
    if (!p) return;
    const r = pickBy(p, 'scroll');
    if (!r) return;
    ev.preventDefault();
    try { r.scroll(ev.deltaY, ev.deltaX); } catch (err) { log?.warn?.('ui: a scroll handler threw', err); }
    dirty = true;
  }, { passive: false });

  // ---------------------------------------------------------------- painter
  const g = {
    get width() { return W; },
    get height() { return H; },
    /** Everything is drawn through this: integer rectangles, flat colour, no blending tricks. */
    fill(x, y, w, h, colour) {
      if (w <= 0 || h <= 0) return;
      g2.fillStyle = colour;
      g2.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    },
    /**
     * One line of bitmap text, `y` being the top of the glyph cell.
     * @returns {number} the x the next glyph would start at
     */
    text(x, y, str, colour, { shadow = null, max = Infinity } = {}) {
      // A label that does not fit is cut with an ellipsis rather than sliced mid-glyph:
      // "Department Stor" is a bug report waiting to happen, "Department S…" is a label.
      const s = max === Infinity ? String(str ?? '') : ellipsize(str, max);
      if (shadow) g.text(x + 1, y + 1, s, shadow, { max });
      const sheet = tinted(colour);
      let cx = Math.round(x);
      const top = Math.round(y);
      const limit = cx + max + 2;
      for (const ch of s) {
        const cell = atlas.cells.get(ch);
        if (ch === ' ') { cx += glyph(ch).w + TRACKING; continue; }
        const cw = cell ? cell.w : glyph(ch).w;
        if (cx + cw > limit) break;
        if (cell) g2.drawImage(sheet, cell.x, 0, cell.w, HEIGHT, cx, top, cell.w, HEIGHT);
        cx += cw + TRACKING;
      }
      return cx - TRACKING;
    },
    textRight(x, y, str, colour, opts) {
      const w = measureText(str);
      return g.text(x - w, y, str, colour, opts);
    },
    textCentre(cx, y, str, colour, opts) {
      const w = measureText(str);
      return g.text(Math.round(cx - w / 2), y, str, colour, opts);
    },
    /** A sprite-sheet blit, nearest-neighbour, integer destination. */
    sprite(img, sx, sy, sw, sh, dx, dy, dw = sw, dh = sh) {
      if (!img) return;
      g2.drawImage(img, sx, sy, sw, sh, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    },
    /** Dims everything already painted, inside a box. */
    scrim(x, y, w, h, alpha = 0.55) {
      g2.fillStyle = `rgba(8,7,12,${alpha})`;
      g2.fillRect(x, y, w, h);
    },
    /**
     * Registers a region. Later registrations win, matching paint order (whatever is drawn
     * later sits visually on top, so a `pick()` walks the list backwards).
     *
     * The second argument is either a bare function — `on(region, point)`, the original and
     * still the common shape — or an options object: `{on, drag, drop, scroll, swallow}`.
     *  - `on(region, point)` — a plain click, as before.
     *  - `drag: {payload}` — picks this region up into a held gesture on `pointerdown`
     *    instead of calling `on` (the two are mutually exclusive on one region).
     *  - `drop: {accepts(payload), on(payload, point)}` — receives a held drag released over
     *    it, if `accepts` says yes.
     *  - `scroll(deltaY, deltaX)` — receives wheel deltas while the pointer is over it.
     *  - `swallow: true` — consumes a `pointerdown` without calling anything (the window-body
     *    catcher: a click on a panel's own paper does nothing rather than falling through to
     *    whatever is registered under it).
     */
    hit(box, on2, tag = '') {
      if (typeof on2 === 'function') regions.push({ ...box, on: on2, tag });
      else {
        const o = on2 ?? {};
        regions.push({ ...box, on: o.on, drag: o.drag, drop: o.drop, scroll: o.scroll, swallow: !!o.swallow, tag });
      }
      return box;
    },
    /**
     * Clips `draw()` to a rectangle: the one primitive `src/` had none of before this slice
     * (`grep -rn 'ctx\.save\|\.clip(' src/` found nothing). `save`/`restore` are paired here
     * so a caller can never forget the `restore` half and leave every later draw call clipped.
     */
    clip(x, y, w, h, draw) {
      g2.save();
      g2.beginPath();
      g2.rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      g2.clip();
      try { draw(); } finally { g2.restore(); }
    },
    hovered: () => hovered,
    image,
  };

  const measureTextCache = new Map();
  function measureText(str) {
    const s = String(str ?? '');
    let w = measureTextCache.get(s);
    if (w === undefined) {
      w = 0;
      for (const ch of s) w += glyph(ch).w + TRACKING;
      w = Math.max(0, w - TRACKING);
      if (measureTextCache.size < 4096) measureTextCache.set(s, w);
    }
    return w;
  }
  g.measure = measureText;

  return {
    canvas,
    painter: g,
    get width() { return W; },
    get height() { return H; },
    resize,
    /**
     * Drops every tinted copy of the glyph atlas. Called when `theme.applyLight` moves the
     * palette: the cache is keyed by colour string, so without this a day of simulated time
     * would leave ninety-six generations of dead atlases in memory.
     */
    clearTints() { tints.clear(); dirty = true; },
    markDirty() { dirty = true; },
    /**
     * The clickable boxes the last paint registered, in paint order.
     *
     * A diagnostic surface, like `bus.spy()`: it is what lets a capture assert that a control is
     * actually *reachable* rather than merely drawn. A button painted under another panel, or
     * off the buffer, looks identical in a screenshot to one that works (DECISIONS #77). Also
     * reports `swallow`/`drag`/`drop`/`scroll`, so a test can assert a control exists in one of
     * these new modes without executing it (DECISIONS #84).
     */
    regions: () => regions.map((r) => ({
      tag: r.tag, box: { x: r.x, y: r.y, w: r.w, h: r.h },
      swallow: !!r.swallow, drag: !!r.drag, drop: !!r.drop, scroll: !!r.scroll,
    })),
    get dirty() { return dirty; },
    imagesSettled,
    /** The held drag, if any: `{tag, payload, x, y}` in UI buffer pixels — read by `index.js`
     *  to draw the drag's ghost, last, over everything else `draw()` just painted. */
    drag: () => dragState,
    /** Clears, resets the hit list, and hands the painter to `draw`. */
    paint(draw) {
      g2.clearRect(0, 0, W, H);
      regions = [];
      draw(g);
      dirty = false;
    },
    dispose() {
      for (const off of listeners) off();
      dragState = null;
      canvas.remove();
    },
  };
}

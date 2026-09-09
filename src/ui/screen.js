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
  /** @type {{x:number,y:number,w:number,h:number,on:Function,tag:string}[]} */
  let regions = [];
  let hovered = null;

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
  const pick = (p) => {
    for (let i = regions.length - 1; i >= 0; i--) if (inside(regions[i], p)) return regions[i];
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
    try { r.on(r, p); } catch (err) { log?.warn?.('ui: a panel handler threw', err); }
    dirty = true;
  }, true);
  on(window, 'pointermove', (ev) => {
    const p = toUi(ev);
    if (!p) return;
    const r = pick(p);
    const tag = r?.tag ?? null;
    if (tag !== hovered) { hovered = tag; dirty = true; }
    document.documentElement.style.cursor = r ? 'pointer' : '';
  });

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
    /** Registers a clickable region. Later registrations win, matching paint order. */
    hit(box, on2, tag = '') { regions.push({ ...box, on: on2, tag }); return box; },
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
    get dirty() { return dirty; },
    imagesSettled,
    /** Clears, resets the hit list, and hands the painter to `draw`. */
    paint(draw) {
      g2.clearRect(0, 0, W, H);
      regions = [];
      draw(g);
      dirty = false;
    },
    dispose() {
      for (const off of listeners) off();
      canvas.remove();
    },
  };
}

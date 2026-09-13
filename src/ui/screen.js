/**
 * The world-overlay canvas: one 2-D surface, drawn with the bitmap font, for the handful of
 * things still projected against the 3-D world every rendered frame — `plates.js`'s
 * nameplates, `callout.js`'s speech balloons, `floaters.js`'s damage numbers, and `index.js`'s
 * own debug overlay and walk hint. Its backing store is **the renderer's internal buffer**
 * (640×360 at 1080p) — divided by `config.uiScale` (any whole number, `resize()`'s own
 * comment on why it stays an integer) when that knob is not its default — stretched over the
 * viewport with `image-rendering: pixelated`.
 *
 * **Every panel and every piece of always-on chrome has been DOM since Stage 9** — `#ui-dom`
 * (`dom/layer.js`), not this canvas. What is left here is projected with no depth divide
 * against the orthographic camera, which is what keeps a nameplate on the same pixel grid as
 * the sprite it names; a DOM element positioned from a 3-D world coordinate cannot be that
 * precise without reintroducing the sub-pixel drift this whole architecture exists to avoid.
 * That is also why this module owns no click/drag handling any more — nothing painted here
 * has ever been interactive, and the hit-region/pointer-event system a panel-driven canvas
 * used to need left with the last panel that used it.
 *
 * Text and panels laid out in CSS pixels are the one thing on screen that is *not* on the
 * world's own pixel grid — a 12 px antialiased label over a 3×-blocky world reads as a debug
 * overlay, not as the game's own menu — which is `#ui-dom`'s reason to exist at real
 * resolution instead of on this buffer. Taking the size from `ctx.three.view.internalSize`
 * rather than recomputing it from `pixelScale` means this surface inherits the scene's own
 * rounding, including the non-integer upscale at 1600×900 (533 → 1600 is ×3.002): at
 * `uiScale: 1` this surface and the world's own canvas are stretched by the same factor, so a
 * plate edge lands on a tile edge; at any higher whole number this surface is stretched by
 * that same factor again on top, so a plate edge lands on every Nth tile edge instead — still
 * crisp (`imageSmoothingEnabled` stays off), just a coarser overlay grid than the world's,
 * which is the whole point of the knob.
 *
 * It costs **zero draw calls**: this is a 2-D canvas composited by the browser, not geometry
 * handed to WebGL, and `renderer.info.render.calls` — the number tools/shots/shoot.js budgets — never sees it.
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

export function makeScreen({ root, view, log, config }) {
  const canvas = document.createElement('canvas');
  canvas.id = 'ui-world';
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

  /**
   * Takes the renderer's own internal buffer size rather than recomputing it, so this
   * surface's grid and the scene's grid are the same grid. Called every frame — two array
   * reads — because the renderer resizes on its own schedule and a window listener can run
   * before it does.
   */
  function resize() {
    const size = view?.internalSize;
    const rawW = Number(size?.[0]) >= 2 ? Math.floor(size[0]) : 640;
    const rawH = Number(size?.[1]) >= 2 ? Math.floor(size[1]) : 360;
    // `uiScale` (`core/config.js` `DEFAULTS`) is a second, independent pixel scale for this
    // surface alone. Whole numbers only, never clamped to a hard ceiling any more — the {1,2}
    // ladder existed so this buffer and `#ui-dom`'s own `--ui-scale` (`dom/layer.js`) stayed
    // in lockstep while a canvas-drawn HUD still had to share this exact grid; now that every
    // panel and every piece of chrome is DOM, the two scales are independent (`dom/layer.js`'s
    // own comment), and only the reason *this* one stays an integer remains: a fractional
    // scale would resample a texel across a fraction of a pixel on a NEAREST-filtered atlas —
    // the same defect a non-integer `pixelsPerUnit` would be everywhere else in this project.
    const scale = Math.max(1, Math.round(Number(config?.uiScale) || 1));
    const iw = Math.max(1, Math.floor(rawW / scale));
    const ih = Math.max(1, Math.floor(rawH / scale));
    // The scene's canvas is an integer multiple of the internal buffer and letterboxed
    // inside the viewport (`core/render.js`), so this one has to sit on exactly the same
    // rect — a plate projected against the world has to land on the same pixel the sprite
    // it names does.
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
    /**
     * `text()` at an integer multiple of its normal size — a damage number's own crit
     * emphasis (`ui/floaters.js`), and the only place this project draws text bigger than the
     * font's authored 8px cell. `scale` has to be a whole number: the atlas is nearest-filtered
     * and every glyph is already on the internal-pixel grid, so a fractional scale would
     * resample a texel across a fraction of a pixel — precisely the defect `pixelsPerUnit`
     * being 16/32/64 and nothing else exists to prevent everywhere else in this project
     *.
     * @returns {number} the x the next glyph would start at
     */
    textScaled(x, y, str, colour, scale = 2, { shadow = null, max = Infinity } = {}) {
      const k = Math.max(1, Math.round(scale));
      if (k === 1) return g.text(x, y, str, colour, { shadow, max });
      const s = max === Infinity ? String(str ?? '') : ellipsize(str, max);
      if (shadow) g.textScaled(x + k, y + k, s, shadow, k, { max });
      const sheet = tinted(colour);
      let cx = Math.round(x);
      const top = Math.round(y);
      const limit = cx + max * k + 2;
      for (const ch of s) {
        const cell = atlas.cells.get(ch);
        if (ch === ' ') { cx += (glyph(ch).w + TRACKING) * k; continue; }
        const cw = cell ? cell.w : glyph(ch).w;
        if (cx + cw * k > limit) break;
        if (cell) g2.drawImage(sheet, cell.x, 0, cell.w, HEIGHT, cx, top, cell.w * k, HEIGHT * k);
        cx += (cw + TRACKING) * k;
      }
      return cx - TRACKING * k;
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
    /** Hands the painter to `draw` — nothing here needs a hit-list reset any more, since
     *  nothing painted on this surface is ever interactive (see this file's own header). */
    paint(draw) {
      g2.clearRect(0, 0, W, H);
      draw(g);
      dirty = false;
    },
    dispose() {
      canvas.remove();
    },
  };
}

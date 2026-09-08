/**
 * The runtime sprite atlas.
 *
 * Every sheet the scene actually needs is cut into its individual frames and shelf-packed
 * into one texture, so the whole cast — any number of species plus the trainer — is drawn
 * by a single InstancedMesh in a single draw call. Packing *frames* rather than whole
 * sheets matters: the trainer sheet is 32x768, and packing it whole would force a 770 px
 * tall atlas for 24 tiny frames.
 *
 * Filtering is NEAREST with no mipmaps, and every cell carries a one-pixel transparent
 * gutter so that a uv that lands exactly on a cell edge samples empty space and is thrown
 * away by the alpha test, instead of picking up the neighbouring frame.
 */

import { sheetLayout } from './sprites.js';

const PAD = 1;
const MAX_SIZE = 2048;

/** Loads an image element; resolves to null (never throws) so one bad sheet cannot fail a scene. */
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Shelf packer. Cells are placed left to right on rows whose height is the tallest cell in
 * them; with only two cell sizes in play (34 and 66 px) sorting by height descending gets
 * within a few percent of perfect.
 */
function pack(cells, size) {
  let x = 0, y = 0, shelfH = 0;
  for (const c of cells) {
    if (x + c.w > size) { x = 0; y += shelfH; shelfH = 0; }
    if (y + c.h > size) return false;
    c.x = x; c.y = y;
    x += c.w;
    shelfH = Math.max(shelfH, c.h);
  }
  return true;
}

export class SpriteAtlas {
  /** @param {typeof import('three')} THREE */
  constructor(THREE, { log } = {}) {
    this.THREE = THREE;
    this.log = log ?? console;
    /** @type {Map<string, {url:string, kind:string, img:HTMLImageElement|null}>} */
    this.sheets = new Map();
    /** @type {Map<string, {frame:number, cols:number, rows:number, count:number, rects:Float32Array}>} */
    this.entries = new Map();
    this.texture = null;
    this.size = 0;
    this.canvas = null;
    this.version = 0;
  }

  has(key) { return this.entries.has(key); }

  /**
   * Adds any sheets that are not in the atlas yet and rebuilds the texture if the set grew.
   * @param {{key:string, url:string, kind:'pokemon'|'trainer'}[]} wanted
   * @returns {Promise<boolean>} whether the texture was rebuilt
   */
  async ensure(wanted) {
    const fresh = wanted.filter((w) => !this.sheets.has(w.key));
    if (!fresh.length) return false;

    const images = await Promise.all(fresh.map((w) => loadImage(w.url)));
    let added = 0;
    fresh.forEach((w, i) => {
      if (!images[i]) { this.log.warn?.(`sprite atlas: could not load ${w.url}`); return; }
      this.sheets.set(w.key, { ...w, img: images[i] });
      added++;
    });
    if (!added) return false;

    this.#rebuild();
    return true;
  }

  /**
   * Content box of one frame, as fractions of the frame: `{ cx, cw }` — the horizontal
   * centre and width of the non-transparent pixels. The contact shadow uses it so a blob
   * sits under the body rather than under the empty margin, and so a leaning run frame
   * throws its shadow where the feet are.
   */
  box(key, frameIndex) {
    const e = this.entries.get(key);
    if (!e) return null;
    const i = (frameIndex % e.count + e.count) % e.count;
    return { cx: e.boxes[i * 2], cw: e.boxes[i * 2 + 1] };
  }

  /** uv rect of one frame: [u0, v0, du, dv], with v0 at the *bottom* of the frame. */
  rect(key, frameIndex, out) {
    const e = this.entries.get(key);
    if (!e) return null;
    const i = (frameIndex % e.count + e.count) % e.count;
    const r = e.rects;
    out[0] = r[i * 4]; out[1] = r[i * 4 + 1]; out[2] = r[i * 4 + 2]; out[3] = r[i * 4 + 3];
    return out;
  }

  layout(key) { return this.entries.get(key) ?? null; }

  #rebuild() {
    const cells = [];
    for (const [key, sheet] of this.sheets) {
      const l = sheetLayout(sheet.kind, sheet.img.width, sheet.img.height);
      for (let i = 0; i < l.count; i++) {
        cells.push({
          key, index: i, sheet, layout: l,
          sx: (i % l.cols) * l.frame,
          sy: Math.floor(i / l.cols) * l.frame,
          w: l.frame + PAD * 2,
          h: l.frame + PAD * 2,
        });
      }
    }
    // Tallest first, then by key so the packing is deterministic for a given cast.
    cells.sort((a, b) => (b.h - a.h) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.index - b.index));

    let size = 128;
    while (size <= MAX_SIZE && !pack(cells, size)) size *= 2;
    if (size > MAX_SIZE) throw new Error(`sprite atlas: ${cells.length} frames do not fit in ${MAX_SIZE}px`);

    const canvas = this.canvas && this.canvas.width === size ? this.canvas : document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d', { willReadFrequently: false });
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, size, size);

    this.entries.clear();
    for (const c of cells) {
      let e = this.entries.get(c.key);
      if (!e) {
        e = { ...c.layout, rects: new Float32Array(c.layout.count * 4), boxes: new Float32Array(c.layout.count * 2) };
        this.entries.set(c.key, e);
      }
      const px = c.x + PAD, py = c.y + PAD, f = c.layout.frame;
      g.drawImage(c.sheet.img, c.sx, c.sy, f, f, px, py, f, f);
      // flipY is off on the texture, so v is measured from the top of the canvas and the
      // rect runs upward: v0 is the frame's bottom edge and dv is negative.
      const o = c.index * 4;
      e.rects[o] = px / size;
      e.rects[o + 1] = (py + f) / size;
      e.rects[o + 2] = f / size;
      e.rects[o + 3] = -f / size;
      c.px = px; c.py = py;
    }

    this.#measure(g, cells, size);

    const { THREE } = this;
    if (this.texture && this.canvas === canvas) {
      this.texture.needsUpdate = true;
    } else {
      this.texture?.dispose();
      const tex = new THREE.CanvasTexture(canvas);
      tex.name = 'pokemon:atlas';
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 1;
      this.texture = tex;
    }
    this.canvas = canvas;
    this.size = size;
    this.version++;
  }

  /**
   * One read of the finished atlas gives every frame's content box. Doing it here rather
   * than per sheet costs a single getImageData instead of one per species.
   */
  #measure(g, cells, size) {
    const data = g.getImageData(0, 0, size, size).data;
    for (const c of cells) {
      const e = this.entries.get(c.key);
      const f = c.layout.frame;
      let x0 = f, x1 = -1;
      for (let y = 0; y < f; y++) {
        const row = ((c.py + y) * size + c.px) * 4 + 3;
        for (let x = 0; x < f; x++) {
          if (data[row + x * 4] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
        }
      }
      const o = c.index * 2;
      if (x1 < x0) { e.boxes[o] = 0.5; e.boxes[o + 1] = 0.5; }
      else { e.boxes[o] = (x0 + x1 + 1) / 2 / f; e.boxes[o + 1] = (x1 - x0 + 1) / f; }
    }
  }

  stats() {
    return { size: this.size, sheets: this.sheets.size, frames: [...this.entries.values()].reduce((a, e) => a + e.count, 0) };
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this.sheets.clear();
    this.entries.clear();
    this.canvas = null;
  }
}

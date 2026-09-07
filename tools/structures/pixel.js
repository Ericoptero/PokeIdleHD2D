/**
 * A tiny indexed-pixel canvas plus a PNG writer, for authoring building textures in code.
 *
 * Writing pixel art as code sounds like a way to get programmer art, and it is — unless the
 * palette and the shading rules come from the reference material rather than from a hue
 * slider. Everything here works on a fixed, named palette lifted from the Black & White 2
 * overworld buildings, and the shading helpers do what a pixel artist does by hand: a light
 * edge on the sun side, a dark edge on the shade side, and a one-pixel darker line where two
 * planes meet. No gradients, no antialiasing, no colours outside the palette.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The BW2 building palette. Each family runs deep -> shadow -> base -> light -> highlight,
 * which is the five-tone ramp DS-era artists used for a lit plane.
 */
export const PALETTE = {
  // Pokemon Center red roof
  roofDeep: '#6E1A1C', roofShadow: '#9E2B2C', roofBase: '#C93B38', roofLight: '#E05B4F', roofHi: '#F0857A',
  // Mart blue roof
  martDeep: '#123A5E', martShadow: '#1B5788', martBase: '#2A79B0', martLight: '#4A9BCE', martHi: '#7FC0E4',
  // stucco walls
  wallDeep: '#9A8A6E', wallShadow: '#C4B08C', wallBase: '#E6D6B4', wallLight: '#F5E9CE', wallHi: '#FFF8E6',
  // stone plinth and trim
  stoneDeep: '#4A4A46', stoneShadow: '#6B6B63', stoneBase: '#8C8C80', stoneLight: '#A8A89A', stoneHi: '#C4C4B6',
  // glass
  glassDeep: '#1D4E68', glassShadow: '#2E7392', glassBase: '#4E9BBE', glassLight: '#79C0DC', glassHi: '#B8E6F5',
  // warm interior glow, used on the night emissive maps
  glowDeep: '#8A5A18', glowBase: '#E0A73C', glowLight: '#F6D488', glowHi: '#FFF0C4',
  // painted wood
  woodDeep: '#5A3524', woodShadow: '#7E4A31', woodBase: '#A5673F', woodLight: '#C4854F', woodHi: '#DDA66C',
  // whites and blacks
  white: '#FAF7EE', offWhite: '#E8E2D2', ink: '#241E1B', shadowInk: '#3A322C',
  // Poke Ball
  ballRed: '#D6453C', ballWhite: '#F5F1E6', ballBand: '#2A2320',
  transparent: null,
};

const hexToRgb = (hex) => hex === null
  ? [0, 0, 0, 0]
  : [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];

export class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8Array(w * h * 4);   // starts fully transparent
  }

  /** @param {string|null} colour palette hex, or null to erase to transparent */
  set(x, y, colour) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    const [r, g, b, a] = hexToRgb(colour);
    const i = (y * this.w + x) * 4;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a;
    return this;
  }

  get(x, y) {
    const i = ((y | 0) * this.w + (x | 0)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  fill(colour) { return this.rect(0, 0, this.w, this.h, colour); }

  rect(x, y, w, h, colour) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, colour);
    return this;
  }

  /** One-pixel outline inside the given box. */
  outline(x, y, w, h, colour) {
    for (let i = x; i < x + w; i++) { this.set(i, y, colour); this.set(i, y + h - 1, colour); }
    for (let j = y; j < y + h; j++) { this.set(x, j, colour); this.set(x + w - 1, j, colour); }
    return this;
  }

  hLine(x, y, w, colour) { for (let i = x; i < x + w; i++) this.set(i, y, colour); return this; }
  vLine(x, y, h, colour) { for (let j = y; j < y + h; j++) this.set(x, j, colour); return this; }

  /**
   * A lit plane: base fill, a highlight along the top edge, shadow along the bottom, and a
   * dark line at the very bottom where it meets whatever is below. This one helper is most
   * of what makes a flat rectangle read as a surface rather than as a swatch.
   */
  plane(x, y, w, h, ramp, { topLight = 1, bottomShade = 2, edge = true } = {}) {
    this.rect(x, y, w, h, ramp.base);
    for (let k = 0; k < topLight; k++) this.hLine(x, y + k, w, ramp.light);
    for (let k = 0; k < bottomShade; k++) this.hLine(x, y + h - 1 - k, w, k === 0 ? ramp.deep : ramp.shadow);
    if (edge) { this.vLine(x, y, h, ramp.shadow); this.vLine(x + w - 1, y, h, ramp.shadow); }
    return this;
  }

  /**
   * Deterministic ordered dither between two palette entries, used to break up a large flat
   * area without introducing a colour that is not in the ramp.
   */
  dither(x, y, w, h, a, b, density = 0.25) {
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const t = BAYER[(j & 3) * 4 + (i & 3)] / 16;
        this.set(x + i, y + j, t < density ? b : a);
      }
    }
    return this;
  }

  /** Roof shingles: rows of overlapping tiles, offset every other row. */
  shingles(x, y, w, h, ramp, { rowH = 4, tileW = 6 } = {}) {
    this.rect(x, y, w, h, ramp.base);
    for (let row = 0, j = y; j < y + h; j += rowH, row++) {
      const offset = (row & 1) ? (tileW >> 1) : 0;
      // top of each row catches light, the seam under it is the darkest line
      this.hLine(x, j, w, ramp.light);
      if (j + rowH - 1 < y + h) this.hLine(x, j + rowH - 1, w, ramp.deep);
      for (let i = x - offset; i < x + w; i += tileW) {
        for (let k = 1; k < rowH - 1; k++) this.set(i, j + k, ramp.shadow);
      }
    }
    return this;
  }

  /** Copies a region of another canvas in, skipping transparent source pixels. */
  blit(src, dx, dy, { sx = 0, sy = 0, sw = src.w, sh = src.h } = {}) {
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const s = ((sy + j) * src.w + (sx + i)) * 4;
        if (src.data[s + 3] === 0) continue;
        const d = ((dy + j) * this.w + (dx + i)) * 4;
        if (dx + i < 0 || dy + j < 0 || dx + i >= this.w || dy + j >= this.h) continue;
        this.data.set(src.data.subarray(s, s + 4), d);
      }
    }
    return this;
  }

  /** Mirrors the canvas horizontally into a new one. */
  mirrored() {
    const out = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const s = (y * this.w + (this.w - 1 - x)) * 4;
        out.data.set(this.data.subarray(s, s + 4), (y * this.w + x) * 4);
      }
    }
    return out;
  }

  save(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodePng(this.w, this.h, this.data));
    return path;
  }
}

/** Minimal RGBA PNG encoder — filter type 0 on every scanline, one IDAT. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** Convenience: the five-tone ramp for a palette family, e.g. ramp('roof'). */
export function ramp(family) {
  const cap = family[0].toUpperCase() + family.slice(1);
  return {
    deep: PALETTE[`${family}Deep`], shadow: PALETTE[`${family}Shadow`],
    base: PALETTE[`${family}Base`], light: PALETTE[`${family}Light`],
    hi: PALETTE[`${family}Hi`] ?? PALETTE[`${family}Light`],
    name: cap,
  };
}

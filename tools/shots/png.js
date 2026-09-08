/**
 * Just enough PNG to measure a screenshot: inflate, unfilter, hand back RGBA.
 *
 * The obvious alternative — reading the WebGL canvas back in-page — returns an all-black
 * buffer, because the drawing buffer is not preserved after the frame is presented and
 * turning that on costs performance in every frame the game ever renders. Puppeteer's
 * screenshot goes through the compositor and is correct, so the pixels are measured from the
 * same file a critic looks at, which is the point.
 */

import { inflateSync } from 'node:zlib';

const PAETH = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** @returns {{width:number, height:number, channels:number, data:Buffer}} 8-bit, RGB or RGBA */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9];
      if (body[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'tRNS') trns = Buffer.from(body);
    else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);

  const srcChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!srcChannels) throw new Error(`colour type ${colorType} not supported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * srcChannels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= srcChannels ? cur[i - srcChannels] : 0;
      const b = prev[i];
      const c = i >= srcChannels ? prev[i - srcChannels] : 0;
      const x = line[i];
      cur[i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b
        : filter === 3 ? x + ((a + b) >> 1) : x + PAETH(a, b, c)) & 0xff;
    }
    prev = cur;
  }

  // Expand a palette so callers only ever see RGB(A).
  if (colorType === 3) {
    if (!palette) throw new Error('indexed PNG with no palette');
    const ch = trns ? 4 : 3;
    const rgb = Buffer.alloc(width * height * ch);
    for (let i = 0; i < width * height; i++) {
      const p = out[i] * 3;
      rgb[i * ch] = palette[p]; rgb[i * ch + 1] = palette[p + 1]; rgb[i * ch + 2] = palette[p + 2];
      if (trns) rgb[i * ch + 3] = out[i] < trns.length ? trns[out[i]] : 255;
    }
    return { width, height, channels: ch, data: rgb };
  }
  return { width, height, channels: srcChannels, data: out };
}

/**
 * Luminance and saturation statistics for a frame, optionally skipping the top `hudRows`.
 * The HUD matters: measuring with the cream panels in frame reads p99 234 where the scene
 * itself reaches 150, which is exactly how a real defect got reported as "does not
 * reproduce" once already.
 */
export function sceneStats(png, { hudRows = 0 } = {}) {
  const { width, height, channels, data } = png;
  const hist = new Uint32Array(256);
  let n = 0, sum = 0, sat = 0;
  for (let y = Math.min(hudRows, height); y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      hist[l]++; n++; sum += l;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx ? (mx - mn) / mx : 0;
    }
  }
  if (!n) return null;
  const at = (q) => { let acc = 0; const t = n * q; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i; } return 255; };
  let below8 = 0, over200 = 0, max = 0;
  for (let i = 0; i < 8; i++) below8 += hist[i];
  for (let i = 201; i < 256; i++) over200 += hist[i];
  for (let i = 255; i >= 0; i--) if (hist[i]) { max = i; break; }
  return {
    pixels: n,
    mean: +(sum / n).toFixed(2),
    p50: at(0.50), p95: at(0.95), p99: at(0.99), max,
    belowL8Pct: +((below8 / n) * 100).toFixed(3),
    pureBlackPct: +((hist[0] / n) * 100).toFixed(3),
    over200Pct: +((over200 / n) * 100).toFixed(3),
    saturation: +(sat / n).toFixed(4),
  };
}

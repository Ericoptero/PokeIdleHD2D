/**
 * Re-tinting an authored building's own sheet, in place, at load.
 *
 * The `structures` pack ships three genuinely different models — `house_a` 5x4, `poke_mart`
 * 6x5, `pokemon_center` 8x6 — and `layout.js` resolves each by its own subcategory, so the
 * *mapping* was never wrong. What was wrong is that all three are painted from the same six
 * files: one `roof.png` (red pantiles), one `awning.png` (red and white stripes), one
 * `wall.png`. Six buildings, one red roof, and a town that reads as a single terrace.
 *
 * The Mart's roof is blue in every generation of the series, and that is the cheapest
 * possible separation of the two shops. `tools/assets` and `assets/structures/` belong to
 * the asset pipeline, not to `city`, so this does the equivalent at load time: the material
 * is looked up by the pack's own **per-building material name** (`poke_mart:roof`, which the
 * builder emits separately from `pokemon_center:roof` even though both point at the same
 * PNG), its texture is decoded once into a canvas, every non-grey texel is rotated in hue,
 * and the result is handed back as a `CanvasTexture` with the same sampling the original
 * had. Nothing else in the tileset can see it, because nothing else uses that material.
 *
 * Three details, each of which costs a wrong frame if it is skipped:
 *
 *  - **grey stays grey.** The roof's mortar lines and the awning's white stripes have a
 *    saturation near zero, and a hue rotation applied to them is a no-op in theory and a
 *    rounding-error tint in practice. They are left alone by a saturation gate, which also
 *    keeps the sign's black outline black.
 *  - **`flipY`, `colorSpace` and the wrapping are copied, never assumed.** `TextureLoader`
 *    hands back `flipY: true`; so does `CanvasTexture`; but the pair only agrees because
 *    the image is drawn into the canvas the right way up, and the whole point of copying
 *    the flag is that this file does not have to know that.
 *  - **the original is kept.** `city.enter()` is re-entrant, and re-tinting an already
 *    tinted material would rotate the hue twice. Every repaint starts from the stashed
 *    original, and `dispose()` puts it back.
 */

import * as THREE from 'three';

/** sRGB byte triple -> HSL, all three in 0..1. */
function toHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

const hue2rgb = (p, q, t) => {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
};

function toRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/**
 * @param {THREE.Texture} src
 * @param {{hue?:number, sat?:number, light?:number, name?:string, greyBelow?:number}} opts
 *   `hue` is degrees to rotate; `sat`/`light` are multipliers; `greyBelow` is the saturation
 *   under which a texel is treated as neutral and left alone.
 * @returns {THREE.CanvasTexture|null}
 */
export function recolorTexture(src, { hue = 0, sat = 1, light = 1, name = 'recolor', greyBelow = 0.12 } = {}) {
  const img = src?.image;
  if (!img || !img.width || !img.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);

  const data = g.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const dh = hue / 360;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [h, s, l] = toHsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    if (s < greyBelow) continue;
    const [r, gg, bb] = toRgb((h + dh + 1) % 1, Math.min(1, s * sat), Math.min(1, l * light));
    px[i] = Math.round(r * 255);
    px[i + 1] = Math.round(gg * 255);
    px[i + 2] = Math.round(bb * 255);
  }
  g.putImageData(data, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.colorSpace = src.colorSpace;
  tex.flipY = src.flipY;
  tex.anisotropy = 1;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Repaints named materials of a loaded tileset and returns the undo.
 *
 * @param {object} tileset  what `tiles.get(slug)` returns — needs `pack.materials` and `materials`
 * @param {Record<string, object>} specs  material name -> `recolorTexture` options
 * @param {{warn:Function}} log
 * @returns {() => void} restores every original map
 */
export function repaint(tileset, specs, log) {
  const undo = [];
  if (!tileset?.pack?.materials || !tileset.materials) return () => {};
  for (const [matName, opts] of Object.entries(specs)) {
    const i = tileset.pack.materials.findIndex((m) => m.name === matName);
    if (i < 0) {
      log.warn(`city: no material named "${matName}" in tileset "${tileset.slug}" — not re-tinted`);
      continue;
    }
    const mat = tileset.materials[i];
    if (!mat?.map) continue;
    // Always start from the sheet the artist shipped, never from a previous repaint: a
    // second `enter()` would otherwise rotate the hue a second time.
    const original = mat.userData.cityOriginalMap ?? mat.map;
    mat.userData.cityOriginalMap = original;
    const tex = recolorTexture(original, { ...opts, name: `${matName}:city` });
    if (!tex) continue;
    mat.userData.cityRepaint?.dispose();
    mat.userData.cityRepaint = tex;
    mat.map = tex;
    mat.needsUpdate = true;
    undo.push(() => {
      mat.map = original;
      mat.needsUpdate = true;
      tex.dispose();
      mat.userData.cityRepaint = null;
    });
  }
  return () => { for (const fn of undo) fn(); undo.length = 0; };
}

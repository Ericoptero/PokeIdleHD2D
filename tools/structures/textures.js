#!/usr/bin/env node
/**
 * Authors the pixel textures for the buildings we model ourselves (DECISIONS #3, #12).
 *
 * Texel density is fixed at 32 px per world unit, matching the mode of the AdAstra tileset,
 * so a wall painted here sits on the same pixel grid as the grass it stands on. Every
 * texture is a power of two and every colour comes from the BW2 palette in pixel.js.
 *
 *   node tools/structures/textures.js
 */

import { Canvas, PALETTE, ramp } from './pixel.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'assets', 'structures');

export const TEXELS_PER_UNIT = 32;

const roof = ramp('roof');
const mart = ramp('mart');
const wall = ramp('wall');
const stone = ramp('stone');
const glass = ramp('glass');
const wood = ramp('wood');
const glow = { deep: PALETTE.glowDeep, shadow: PALETTE.glowDeep, base: PALETTE.glowBase, light: PALETTE.glowLight, hi: PALETTE.glowHi };

// ---------------------------------------------------------------------------
// tiling surfaces
// ---------------------------------------------------------------------------

/** Red roof shingles, 2x2 units, tiles seamlessly in both axes. */
function roofTexture(r) {
  const c = new Canvas(64, 64);
  c.shingles(0, 0, 64, 64, r, { rowH: 8, tileW: 10 });
  // a slightly lighter band every fourth row keeps a big roof from banding
  for (let y = 2; y < 64; y += 32) c.hLine(0, y, 64, r.hi);
  return c;
}

/** Cream stucco wall, 2x2 units, seamless. Subtle dither so it is not a flat swatch. */
function wallTexture() {
  const c = new Canvas(64, 64);
  c.dither(0, 0, 64, 64, wall.base, wall.light, 0.18);
  c.dither(0, 0, 64, 64, wall.base, wall.shadow, 0.06);
  // faint horizontal render lines, as on stucco panels
  for (let y = 15; y < 64; y += 16) c.hLine(0, y, 64, wall.shadow);
  return c;
}

/** Stone plinth, 1x1 unit tall band; the course lines read at gameplay distance. */
function plinthTexture() {
  const c = new Canvas(32, 32);
  c.dither(0, 0, 32, 32, stone.base, stone.shadow, 0.3);
  for (let y = 0; y < 32; y += 8) {
    c.hLine(0, y, 32, stone.light);
    c.hLine(0, y + 7, 32, stone.deep);
    const offset = ((y / 8) & 1) ? 8 : 0;
    for (let x = offset; x < 32; x += 16) c.vLine(x, y + 1, 6, stone.deep);
  }
  return c;
}

/**
 * A window pane, 1x1 unit. Two variants share one image: the top half is the daytime pane
 * (sky reflection) and the bottom half the lit interior, so a night material only has to
 * shift V by 0.5 instead of loading a second texture.
 */
function windowTexture() {
  const c = new Canvas(32, 64);

  const pane = (y0, ramp5, reflect) => {
    c.rect(0, y0, 32, 32, ramp5.base);
    // frame
    c.outline(0, y0, 32, 32, wood.shadow);
    c.outline(1, y0 + 1, 30, 30, wood.base);
    // mullions
    c.vLine(15, y0 + 2, 28, wood.shadow); c.vLine(16, y0 + 2, 28, wood.base);
    c.hLine(2, y0 + 15, 28, wood.shadow); c.hLine(2, y0 + 16, 28, wood.base);
    if (reflect) {
      // a diagonal sky reflection across the top-left pane, the classic DS window read
      for (let i = 0; i < 11; i++) {
        c.set(3 + i, y0 + 12 - i, ramp5.hi);
        c.set(4 + i, y0 + 12 - i, ramp5.light);
      }
      for (let i = 0; i < 7; i++) {
        c.set(19 + i, y0 + 11 - i, ramp5.light);
      }
      c.rect(2, y0 + 24, 12, 5, ramp5.shadow);
    } else {
      // interior: warm pool, a silhouette of a shelf, brightest at the centre
      c.dither(2, y0 + 2, 28, 28, ramp5.base, ramp5.light, 0.4);
      c.rect(4, y0 + 20, 24, 3, PALETTE.woodShadow);
      c.rect(6, y0 + 6, 6, 8, ramp5.hi);
      c.rect(20, y0 + 8, 5, 6, ramp5.hi);
    }
  };

  pane(0, glass, true);
  pane(32, glow, false);
  return c;
}

/** Sliding glass double door, 2 units wide x 2 tall, with the interior visible through it. */
function doorTexture() {
  const c = new Canvas(64, 64);
  c.rect(0, 0, 64, 64, glass.base);
  c.dither(2, 2, 60, 60, glass.base, glass.light, 0.22);
  // interior warmth seen through the glass, brighter near the floor
  c.dither(4, 34, 56, 28, glass.base, glow.base, 0.28);
  // frame and the central meeting stiles of a sliding pair
  c.outline(0, 0, 64, 64, stone.deep);
  c.outline(1, 1, 62, 62, stone.base);
  c.rect(30, 2, 4, 60, stone.light);
  c.vLine(30, 2, 60, stone.deep); c.vLine(33, 2, 60, stone.deep);
  // floor line and the threshold
  c.hLine(2, 60, 60, stone.shadow);
  c.rect(2, 61, 60, 2, stone.deep);
  // highlight sweep
  for (let i = 0; i < 20; i++) { c.set(6 + i, 26 - i, glass.hi); c.set(7 + i, 26 - i, glass.light); }
  return c;
}

/** The awning above the entrance: a striped canopy, 2 units wide. */
function awningTexture(r) {
  const c = new Canvas(64, 32);
  for (let x = 0; x < 64; x++) {
    const band = Math.floor(x / 8) & 1;
    for (let y = 0; y < 32; y++) {
      c.set(x, y, band ? r.base : PALETTE.white);
    }
  }
  c.hLine(0, 0, 64, PALETTE.white);
  c.hLine(0, 1, 64, r.light);
  for (let x = 0; x < 64; x++) c.set(x, 30, (Math.floor(x / 8) & 1) ? r.deep : PALETTE.offWhite);
  c.hLine(0, 31, 64, PALETTE.shadowInk);
  return c;
}

/**
 * The Pokemon Center sign: a Poke Ball on a cream plate, 2 units wide x 1 tall.
 * Drawn on a 64x32 field with the ball centred, so it reads at gameplay zoom.
 */
function signTexture(kind) {
  const c = new Canvas(64, 32);
  c.plane(0, 0, 64, 32, wall, { topLight: 2, bottomShade: 2 });
  c.outline(0, 0, 64, 32, stone.shadow);

  if (kind === 'center') {
    const cx = 32, cy = 16, r = 11;
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y);
        if (d > r) continue;
        let col;
        if (d > r - 1.2) col = PALETTE.ballBand;
        else if (y < -1) col = PALETTE.ballRed;
        else if (y > 1) col = PALETTE.ballWhite;
        else col = PALETTE.ballBand;
        c.set(cx + x, cy + y, col);
      }
    }
    // centre button
    for (let y = -4; y <= 4; y++) {
      for (let x = -4; x <= 4; x++) {
        const d = Math.hypot(x, y);
        if (d > 4) continue;
        c.set(cx + x, cy + y, d > 3 ? PALETTE.ballBand : PALETTE.ballWhite);
      }
    }
    // specular dot, the thing that stops it looking like a flat decal
    c.set(cx - 4, cy - 6, PALETTE.white);
    c.set(cx - 3, cy - 6, PALETTE.white);
    c.set(cx - 4, cy - 5, PALETTE.white);
  } else {
    // Mart: a stylised shopping bag glyph in the roof colour
    c.rect(24, 10, 16, 14, mart.base);
    c.outline(24, 10, 16, 14, mart.deep);
    c.rect(28, 6, 2, 5, mart.shadow);
    c.rect(34, 6, 2, 5, mart.shadow);
    c.hLine(28, 6, 8, mart.shadow);
    c.rect(28, 14, 8, 2, PALETTE.white);
    c.rect(31, 12, 2, 8, PALETTE.white);
  }
  return c;
}

/** Painted timber for door frames, fascia boards and posts. 1x1 unit, seamless vertically. */
function timberTexture(r) {
  const c = new Canvas(32, 32);
  c.rect(0, 0, 32, 32, r.base);
  for (let x = 0; x < 32; x += 4) c.vLine(x, 0, 32, r.shadow);
  for (let x = 2; x < 32; x += 8) c.vLine(x, 0, 32, r.light);
  c.hLine(0, 0, 32, r.light);
  c.hLine(0, 31, 32, r.deep);
  return c;
}

// ---------------------------------------------------------------------------

const SETS = {
  pokemon_center: {
    'roof.png': () => roofTexture(roof),
    'wall.png': wallTexture,
    'plinth.png': plinthTexture,
    'window.png': windowTexture,
    'door.png': doorTexture,
    'awning.png': () => awningTexture(roof),
    'sign.png': () => signTexture('center'),
    'timber.png': () => timberTexture(wood),
  },
  poke_mart: {
    'roof.png': () => roofTexture(mart),
    'wall.png': wallTexture,
    'plinth.png': plinthTexture,
    'window.png': windowTexture,
    'door.png': doorTexture,
    'awning.png': () => awningTexture(mart),
    'sign.png': () => signTexture('mart'),
    'timber.png': () => timberTexture(wood),
  },
  house_a: {
    'roof.png': () => roofTexture(ramp('wood')),
    'wall.png': wallTexture,
    'plinth.png': plinthTexture,
    'window.png': windowTexture,
    'door.png': () => timberTexture(wood),
    'timber.png': () => timberTexture(wood),
  },
};

let n = 0;
for (const [building, files] of Object.entries(SETS)) {
  for (const [name, make] of Object.entries(files)) {
    const path = join(OUT, building, name);
    make().save(path);
    n++;
  }
  console.log(`✓ ${building}: ${Object.keys(files).length} textures`);
}
console.log(`${n} textures at ${TEXELS_PER_UNIT}px per world unit -> assets/structures/`);

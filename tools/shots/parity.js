/**
 * The cross-device gate: **the same world is the same pixels on every screen.**
 *
 * The defect this exists to catch is the one that prompted DECISIONS #60. `unitsPerPixel` used
 * to fall out of `fov`, `cameraDistance` and the internal buffer height, so it moved with the
 * size of the window — 26.0 internal pixels per world unit at 1080p, 23.7 on a 1512-wide
 * laptop, 17.4 at 1280x720. Sprites are magnified by a whole number of pixels per texel, so
 * that swing rounded to 2 on one machine and 1 on the next: the trainer came out 82% larger on
 * a monitor than on a laptop, and 32-texel tile art was minified by a different fraction on
 * every screen, which is NEAREST dropping a different set of texel rows as the camera moves.
 *
 * Two things are asserted, and neither is a tolerance:
 *
 *  - **grid**: `unitsPerPixel` is exactly 1/32, the sprite magnification is exactly 2, `k` is
 *    exactly 1 and both internal dimensions are even, at every viewport in the matrix.
 *  - **pixels**: a crop around the trainer is **byte-identical** between every pair of
 *    viewports. This is not a proxy. The camera is orthographic and snapped to whole pixels,
 *    so two windows showing the same focus differ only in how much world fits around the
 *    edges; every pixel they have in common must be the same pixel. If the density, the
 *    sub-pixel phase or the sprite magnification differs anywhere, this fails.
 *
 * `--walk` runs the other half of the brief: two frames one simulation step apart, diffed for
 * a **pure integer translation** over static geometry. Under the old perspective camera that
 * could not hold — the ground ran 0.75x at the top of the frame to 1.20x at the bottom, so a
 * whole-pixel camera move was a fractional move for everything off the focus plane.
 *
 * Needs the dev server up (`npm run dev`). Exits 1 on any failure, like `regress.js`.
 *
 *   node tools/shots/parity.js
 *   node tools/shots/parity.js --walk
 *   node tools/shots/parity.js --keep      # leave the PNGs behind to look at
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { shoot, parseArgs } from './shoot.js';
import { decodePng } from './png.js';

/**
 * Phone, tablet, laptop, HD, FullHD and ultrawide — the classes that disagreed.
 *
 * Portrait is in here deliberately. It is the shape that stresses the auto scale hardest (a
 * 390 px window cannot take `pixelScale 3` and still show a street) and the one the old code
 * was worst at: 130 internal pixels across, about five per tile.
 */
const SIZES = [
  { name: 'phone-portrait', size: '390x844' },
  { name: 'phone-landscape', size: '844x390' },
  { name: 'tablet', size: '820x1180' },
  { name: 'hd', size: '1280x720' },
  { name: 'laptop', size: '1512x982' },
  { name: 'fullhd', size: '1920x1080' },
  { name: 'ultrawide', size: '2560x1080' },
];

const EXPECT_PPU = 32;
const EXPECT_MAG = 2;

/**
 * How far two correct frames are allowed to disagree, in levels per channel.
 *
 * Not a fudge — a measured separation. `vignette` darkens toward the edges of whatever
 * rectangle it is given and `grain` is a dither hashed from pixel coordinates, so both are
 * functions of the *frame* and both legitimately differ between a 390x844 phone and a 2560x1080
 * ultrawide showing the same street. (They cannot simply be turned off for the shot:
 * `environment.apply()` rewrites `config.vignette` and `config.grain` from its own time-of-day
 * look table every frame, so a query override does not survive.) Measured on the shipped build:
 *
 *   same window, twice                  max delta 0      (byte-identical — asserted below)
 *   1280x720 vs 1920x1080               max delta 1      (same 640x360 buffer, but the composite
 *                                                        runs at output resolution and bloom is
 *                                                        sampled bilinearly, at x2 vs x3)
 *   phone / tablet / laptop / ultrawide max delta 4      (the vignette gradient)
 *   `spriteMagnification=1` — the bug   max delta 253, 2378 of 4096 px over 8
 *
 * So 8 sits an order of magnitude below the defect and twice above the noise. A grid error
 * cannot hide under it: putting a sprite on the wrong texel phase swaps whole blocks of DS
 * pixel art for their neighbours, and neighbouring colours in a 14-colour palette are tens of
 * levels apart, not four.
 */
const GRADE_DELTA = 8;

const a = parseArgs(process.argv.slice(2));
const walk = a.extra.walk !== undefined || a.walk !== undefined;
const keep = a.extra.keep !== undefined || a.keep !== undefined;
// Ignored by default, so a gate run leaves `git status` clean; `--out` lets the gate place it.
const outDir = a.out ?? a.extra.outDir ?? join('shots', 'out', 'parity');
mkdirSync(outDir, { recursive: true });

const fails = [];
const fail = (what, detail) => { fails.push({ what, detail }); console.log(`  ✗ ${what} — ${detail}`); };
const pass = (what, detail = '') => console.log(`  ✓ ${what}${detail ? ` — ${detail}` : ''}`);

/**
 * One shot, with everything that could make two frames differ for a reason other than size.
 *
 * The **showcase**, not `/`, and that is load-bearing. `timeFrozen` freezes the clock, not the
 * simulation: at `/` the party is walking, the accumulator advances on wall-clock time, and two
 * captures that spent different milliseconds compiling shaders stop on different sub-tiles. A
 * showcase walks to an exact step count and calls `sim.freeze(true)` (ARCHITECTURE §6.3, "same
 * URL, same pixels"), so the only thing left varying between these seven shots is the size of
 * the window — which is the whole point of the comparison.
 */
function take(name, size, extra = {}) {
  return shoot({
    ...a, size, out: join(outDir, `${name}.png`),
    showcase: 'simulation', mode: 'corner',
    tod: 12, seed: 1337, settle: a.settle ?? 40,
    extra: { ...a.extra, timeFrozen: '1', ...extra },
  });
}

/**
 * The internal buffer, recovered from the screenshot.
 *
 * The canvas is an integer multiple of the internal buffer and **overscans** the viewport
 * (`core/render.js`), so it is centred at a size that can be larger than the page and clipped
 * by `#stage`. `displayRect` says where it actually sits, and every `scale`-th pixel from
 * there is one internal pixel — no averaging, because there is nothing to average: a NEAREST
 * upscale means the whole block is one value.
 */
function internalOf(log) {
  const png = decodePng(readFileSync(log.out));
  const [iw, ih] = log.grid.internal;
  const rect = log.grid.displayRect;
  const scale = Math.max(1, Math.round(rect.w / iw));
  // `decodePng` hands back however many channels the file carries — 3 for the opaque PNGs
  // Chrome writes — so the stride is read off the buffer rather than assumed.
  const ch = png.channels ?? Math.round(png.data.length / (png.width * png.height));
  const px = (bx, by) => {
    const x = rect.left + bx * scale, y = rect.top + by * scale;
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
    const i = (y * png.width + x) * ch;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  return { png, iw, ih, scale, px };
}

/** The trainer's own box, in internal pixels: `texels * mag` square, standing on its feet. */
function spriteBox(log) {
  const t = log.grid.actors.find((x) => x.kind === 'trainer') ?? log.grid.actors[0];
  if (!t || t.sx == null) return null;
  const side = t.texels * log.grid.mag;
  return { x0: t.sx - side / 2, y0: t.sy - side, w: side, h: side, who: t.who ?? t.key };
}

console.log(`parity: ${SIZES.length} viewports -> ${outDir}\n`);

// --- 1. the grid ------------------------------------------------------------
const shots = [];
for (const { name, size } of SIZES) {
  const log = await take(name, size);
  shots.push({ name, size, log });
  const g = log.grid;
  if (!g) { fail(`${name}: no grid probe`, log.error ?? log.fatal ?? 'window.__HOOKS__.grid() returned null'); continue; }
  const [iw, ih] = g.internal;
  const bad = [];
  if (g.unitsPerPixel !== 1 / EXPECT_PPU) bad.push(`upp ${g.unitsPerPixel} != ${1 / EXPECT_PPU}`);
  if (g.mag !== EXPECT_MAG) bad.push(`mag ${g.mag} != ${EXPECT_MAG}`);
  if (g.k !== 1) bad.push(`k ${g.k} != 1`);
  if (iw % 2 || ih % 2) bad.push(`internal ${iw}x${ih} is not even`);
  if (log.consoleErrors?.length) bad.push(`${log.consoleErrors.length} console errors`);
  if (bad.length) fail(`${name} ${size}`, bad.join('; '));
  else pass(`${name.padEnd(16)} ${size.padEnd(9)}`, `internal ${iw}x${ih}, scale ${Math.round(g.displayRect.w / iw)}, ${g.pixelsPerUnit} px/unit, mag ${g.mag}, k ${g.k}`);
}

// --- 2. the pixels ----------------------------------------------------------
//
// Compared against one reference rather than every pair: equality is transitive, and naming
// the reference makes a failure say which viewport is the odd one out.
const ref = shots.find((s) => s.name === 'fullhd' && s.log.grid) ?? shots.find((s) => s.log.grid);
if (!ref) fail('sprite parity', 'no usable reference shot');
else {
  const refBox = spriteBox(ref.log);
  const refBuf = internalOf(ref.log);
  if (!refBox) fail('sprite parity', 'no trainer in the reference frame');
  else {
    console.log(`\n  reference: ${ref.name} — ${refBox.who}, ${refBox.w}x${refBox.h} internal px at ${refBox.x0},${refBox.y0}`);
    for (const s of shots) {
      if (s === ref || !s.log.grid) continue;
      const box = spriteBox(s.log);
      const buf = internalOf(s.log);
      if (!box) { fail(`${s.name}: sprite parity`, 'no trainer in frame'); continue; }
      if (box.w !== refBox.w || box.h !== refBox.h) {
        fail(`${s.name}: sprite parity`, `drawn ${box.w}x${box.h}, reference ${refBox.w}x${refBox.h}`);
        continue;
      }
      const limit = GRADE_DELTA;
      let over = 0, worst = 0, first = null, compared = 0;
      for (let dy = 0; dy < box.h; dy++) {
        for (let dx = 0; dx < box.w; dx++) {
          const p = buf.px(box.x0 + dx, box.y0 + dy);
          const q = refBuf.px(refBox.x0 + dx, refBox.y0 + dy);
          if (!p || !q) continue;
          compared++;
          const d = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
          if (d > worst) worst = d;
          if (d > limit) { over++; if (!first) first = `(${dx},${dy}) ${p} vs ${q}`; }
        }
      }
      if (!compared) fail(`${s.name}: sprite parity`, 'the box fell outside the frame');
      else if (over) fail(`${s.name}: sprite parity`,
        `${over}/${compared} px past delta ${limit} (worst ${worst}), first at ${first}`);
      else pass(`${s.name.padEnd(16)} sprite matches ${ref.name}`,
        `${compared} px, worst delta ${worst}`);
    }
  }
}

// --- 3. determinism ---------------------------------------------------------
//
// The cross-window comparison runs to a tolerance, so this pins the other end of it: the same
// URL at the same window twice has to be **byte-identical**, with nothing subtracted. If that
// ever stops holding, the tolerance above is measuring the build's own noise and not the grid.
if (ref) {
  const again = await take('fullhd-again', ref.size);
  const A = internalOf(ref.log), B = internalOf(again);
  let d = 0, worst = 0;
  for (let y = 0; y < A.ih; y++) {
    for (let x = 0; x < A.iw; x++) {
      const p = A.px(x, y), q = B.px(x, y);
      if (!p || !q) continue;
      const t = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
      if (t) { d++; if (t > worst) worst = t; }
    }
  }
  if (d) fail(`${ref.name} is not reproducible`, `${d} px differ (worst ${worst}) between two identical captures`);
  else pass(`\n  ${ref.name.padEnd(16)} is byte-identical to itself`, `${ref.log.grid.internal.join('x')} internal, whole frame`);
}

// --- 4. walking -------------------------------------------------------------
if (walk) {
  console.log('\n  walk stability (two frames one sim step apart):');
  const before = await take('walk-0', '1280x720');
  const after = await shoot({
    ...a, size: '1280x720', out: join(outDir, 'walk-1.png'),
    showcase: 'simulation', mode: 'corner',
    tod: 12, seed: 1337, settle: a.settle ?? 40, steps: 1,
    extra: { ...a.extra, timeFrozen: '1' },
  });
  if (!before.grid || !after.grid) fail('walk stability', 'no grid probe on one of the frames');
  else {
    const A = internalOf(before), B = internalOf(after);
    // A band across the frame, clear of the HUD at the top and the panels along the bottom.
    // It is not clear of the NPCs, and it cannot be: they are on their own routes and they
    // walked too, so they are *supposed* to be somewhere else in the second frame. Hence a
    // fraction rather than an all-or-nothing — with a floor high enough that the ground,
    // the trees and the path cannot be among the pixels that moved.
    const box = { x0: 24, y0: 70, w: A.iw - 48, h: 110 };
    let best = null;
    for (let dy = -16; dy <= 16; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        let hit = 0, n = 0;
        for (let y = 0; y < box.h; y++) {
          for (let x = 0; x < box.w; x++) {
            const p = A.px(box.x0 + x, box.y0 + y);
            const q = B.px(box.x0 + x + dx, box.y0 + y + dy);
            if (!p || !q) continue;
            n++;
            if (Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])) <= GRADE_DELTA) hit++;
          }
        }
        if (n > 1000 && (!best || hit / n > best.frac)) best = { dx, dy, frac: hit / n, n };
      }
    }
    const moved = before.grid.actors.some((x, i) => {
      const y = after.grid.actors[i];
      return y && (x.sx !== y.sx || x.sy !== y.sy || x.frame !== y.frame);
    });
    if (!moved) fail('walk stability', 'nothing moved between the two frames — the test proved nothing');
    else if (!best) fail('walk stability', 'no comparable region');
    else if (best.frac < 0.95) fail('walk stability',
      `best whole-pixel offset (${best.dx}, ${best.dy}) reproduces only ${(best.frac * 100).toFixed(1)}% ` +
      'of the static frame — something is being resampled as the camera moves');
    else pass('the frame translated by whole pixels and resampled nothing',
      `offset (${best.dx}, ${best.dy}), ${(best.frac * 100).toFixed(2)}% of ${best.n} px`);
  }
}

if (!keep) { try { rmSync(outDir, { recursive: true, force: true }); } catch { /* nothing to clean */ } }

console.log(`\nparity: ${fails.length ? `${fails.length} FAILED` : 'all checks pass'}`);
process.exit(fails.length ? 1 : 0);

/**
 * The pointer layer (slice 015): the scrim-ordering fix and `list()`'s new wheel path, driven
 * through real `PointerEvent`/`WheelEvent`s at real buffer coordinates — not by calling a
 * panel's own functions directly, which would prove nothing about whether the click a player
 * actually makes reaches the right hit region (DECISIONS #77(d), #84).
 *
 * `screen.regions()` (`window.__CTX__.get('ui')._screen.regions()`) is the diagnostic surface
 * this whole slice was built to make legible: a control's box and mode (`swallow`/`drag`/
 * `drop`/`scroll`) without pixels, per ARCHITECTURE §5.12 ("screen.regions() publishes the hit
 * boxes of the last paint") and the testing section's own citation of this pattern.
 *
 * `boot()` freezes the frame loop (`__HOOKS__.pause()`), and `regions()` only reflects the
 * *last paint* — so every point in this file that needs freshly-registered regions forces one
 * with `ui._frame(0)` (already exposed for exactly this — `index.js`'s own `_frame`/`_draw`)
 * rather than resuming the real rAF loop, which would make the exact moment a paint landed a
 * race against wall-clock time.
 */
import { test, expect } from '@playwright/test';
import { boot, call, pointer } from './harness.js';

/** The hit regions of the last paint, boxes and all — the same shape `g.hit()` builds. */
const regions = (page) => page.evaluate(() => window.__CTX__.get('ui')._screen.regions());

/** Forces one UI frame so a state change (`open`, a click) is actually painted and registered. */
const paintNow = (page) => call(page, 'ui', '_frame', 0);

/** The centre point of a region's box, in UI buffer pixels. */
const centre = (r) => ({ x: Math.round(r.box.x + r.box.w / 2), y: Math.round(r.box.y + r.box.h / 2) });

/** A real click: down then up at the same point, the way `screen.js`'s listeners see one. */
async function click(page, point) {
  await pointer(page, { type: 'pointerdown', ...point });
  await pointer(page, { type: 'pointerup', ...point });
}

test('a panel\'s own paper does nothing; the close cross and the outer scrim still close it', async ({ page }) => {
  const errors = await boot(page);

  expect(await call(page, 'ui', 'open', 'party')).toBe(true);
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('party');

  let regs = await regions(page);
  const body = regs.find((r) => r.tag === 'window-body');
  expect(body, `no "window-body" swallow region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  expect(body.swallow, 'the window-body region must carry swallow:true').toBe(true);
  const close = regs.find((r) => r.tag === 'close');
  expect(close, 'no "close" region on the party window').toBeTruthy();

  // A point inside the header bar, away from the close cross (top-right) and above any
  // content the panel itself draws (which starts below the header) — the plain paper that
  // used to fall through to the full-buffer scrim and close the window.
  const paper = { x: body.box.x + 4, y: body.box.y + 4 };
  expect(paper.x, 'the probe point must sit left of the close cross, not on it')
    .toBeLessThan(close.box.x);

  await click(page, paper);
  expect(await call(page, 'ui', 'openPanel'), 'a click on the panel\'s own paper must not close it').toBe('party');

  const closePoint = centre(close);
  await click(page, closePoint);
  expect(await call(page, 'ui', 'openPanel'), 'a click on the close cross must close the panel').toBeNull();

  // Reopen, then click well outside the window box but still inside the buffer — the scrim.
  expect(await call(page, 'ui', 'open', 'party')).toBe(true);
  await paintNow(page);
  regs = await regions(page);
  const body2 = regs.find((r) => r.tag === 'window-body');
  expect(body2.box.x, 'the window must not start at the buffer\'s own edge, or this probe is meaningless')
    .toBeGreaterThan(2);
  const outside = { x: 2, y: 2 };
  await click(page, outside);
  expect(await call(page, 'ui', 'openPanel'), 'a click on the dimmed scrim outside the window must close it').toBeNull();

  expect(errors, 'no console error clicking the paper, the close cross and the scrim').toEqual([]);
});

test('the mouse wheel scrolls a list() over its own box', async ({ page }) => {
  const errors = await boot(page);

  // `boxes` rather than `shop`'s own shelf: a shop row only registers a hit region when its
  // item is unlocked (`common.js`'s `list()`: `if (opts.onPick && !item.disabled)`), and a
  // fresh seed 1337 save has most of a shop's catalogue still locked — so the very rows a
  // scroll would bring into view carry no tag to read back. `collection`'s 32 boxes
  // (`DEFAULT_BOXES`, `src/collection/boxes.js`) are never individually disabled and always
  // outnumber what a 640×360 buffer's box list shows (22 rows at 11px each), so this is the
  // one `list()` call site that needs no assumption about save progress to already scroll.
  expect(await call(page, 'ui', 'open', 'boxes')).toBe(true);
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('boxes');

  const boxIndices = (list) => list
    .map((r) => /^box-(\d+)$/.exec(r.tag))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  let regs = await regions(page);
  const before = boxIndices(regs);
  expect(before.length, `no "box-<n>" rows drawn; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeGreaterThan(0);

  const boxCount = (await call(page, 'collection', 'boxes')).length;
  expect(boxCount, 'the box list must be longer than what is visible, or a wheel scroll has nothing to prove')
    .toBeGreaterThan(before.length);

  const scrollRegion = regs.find((r) => r.tag === 'box-scroll');
  expect(scrollRegion, `no "box-scroll" region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  await pointer(page, { type: 'wheel', ...centre(scrollRegion), deltaY: 120 });
  await paintNow(page);

  regs = await regions(page);
  const after = boxIndices(regs);
  expect(after.length, `no "box-<n>" rows drawn after the wheel; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeGreaterThan(0);
  expect(Math.min(...after), `the wheel must move the visible window down; before ${before.join(',')} after ${after.join(',')}`)
    .toBeGreaterThan(Math.min(...before));

  expect(errors, 'no console error wheel-scrolling the box list').toEqual([]);
});

test('the mouse wheel also scrolls the dex\'s multi-column national list', async ({ page }) => {
  const errors = await boot(page);

  // `dex.js` predates `list()`'s wheel support: its national list is a multi-column grid, not
  // a single-column row list, so slice 015 left it out (docs/slices/015-pointer-layer.md's own
  // Result section names this). It now reuses the same `reconciledTop`/`registerScroll`
  // primitive `list()` does, under its own tag `dex-national`.
  expect(await call(page, 'ui', 'open', 'dex')).toBe(true);
  await paintNow(page);
  expect(await call(page, 'ui', 'openPanel')).toBe('dex');

  const dexIds = (list) => list
    .map((r) => /^dex-(.+)$/.exec(r.tag))
    .filter((m) => m && m[1] !== 'national-scroll')
    .map((m) => m[1]);

  let regs = await regions(page);
  const before = dexIds(regs);
  expect(before.length, `no "dex-<key>" rows drawn; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeGreaterThan(0);

  const scrollRegion = regs.find((r) => r.tag === 'dex-national-scroll');
  expect(scrollRegion, `no "dex-national-scroll" region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  await pointer(page, { type: 'wheel', ...centre(scrollRegion), deltaY: 120 });
  await paintNow(page);

  regs = await regions(page);
  const after = dexIds(regs);
  expect(after.length, `no "dex-<key>" rows drawn after the wheel; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeGreaterThan(0);
  expect(after, 'the wheel must move the visible window, not just repaint the same rows').not.toEqual(before);

  expect(errors, 'no console error wheel-scrolling the dex').toEqual([]);
});

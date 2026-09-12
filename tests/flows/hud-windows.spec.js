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
 *
 * Slice 016 (movable/resizable/scalable windows) extends this same file rather than starting
 * a new one, for the reason its own slice doc names: these are the same `g.hit(box, {drag,
 * swallow}, tag)` primitives 015 built, used for the first time. `windowGeometry`'s own save
 * round-trip needs a real `page.reload()`, which none of the tests above do — `offline.persist`
 * is called explicitly first (the `pokecenter-cooldown-reload.spec.js` pattern) rather than
 * relying on `pagehide` to fire in time, so the write is deterministic and not a race.
 */
import { test, expect } from '@playwright/test';
import {
  boot, call, pointer, prop,
} from './harness.js';

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

/**
 * Picks a drag up at `from` and moves it to `to`, without releasing — so a caller can inspect
 * the *live*, still-held position before deciding whether to drop or cancel.
 *
 * Two things a real, running game gets for free that this paused harness has to do by hand:
 *
 *  - `screen.js`'s own `lastPoint` (module state, not part of the held gesture `gesture.js`
 *    returns) is `null` until the first `pointermove` this page has ever seen, and every delta
 *    after that is computed against whatever `lastPoint` last was — so the extra `pointermove`
 *    at `from` itself pins it there before the move that matters, or that move would compute
 *    its delta against `null` (`dx = lastPoint ? … : 0`) and silently move nothing.
 *  - `windowFrame`'s own reconciliation (`panels/common.js`'s `reconcileDrag`) anchors itself
 *    to wherever the drag's pointer *first appears in a paint* — which in an unpaused game is
 *    within one `requestAnimationFrame` tick of the `pointerdown` (`dirty` is set synchronously
 *    in the handler), imperceptibly close to the true click point. This harness's frame loop is
 *    paused (`boot()`), so without a paint in between, the very first paint of the whole drag
 *    would be the one after it has *already* moved all the way to `to`, anchoring there instead
 *    and measuring zero movement — the same "force a paint" discipline this file's own
 *    docstring already names for reading back freshly-registered regions.
 */
async function dragStart(page, from, to) {
  await pointer(page, { type: 'pointerdown', ...from });
  await pointer(page, { type: 'pointermove', ...from });
  await paintNow(page);
  await pointer(page, { type: 'pointermove', ...to });
}

/**
 * Releases a drag started with `dragStart`, at the point it was last moved to.
 *
 * Paints once *before* the release: `windowFrame`'s reconciliation (`reconcileDrag`) only
 * updates its own record of the live, still-held box on a paint while the drag is active, and
 * only *that* value is what gets committed into `windowGeometry` the moment the drag is no
 * longer held — a `pointerup` with no paint in between it and the last `pointermove` would
 * commit whatever the box was at the *previous* paint (possibly the pre-drag position, if nothing
 * painted after the last move), the same "one live paint" requirement `dragStart`'s own comment
 * names for the other end of the gesture. Paints once more after, so the commit itself — and
 * the drag clearing to `null` — is what the very next `regions()` read sees.
 */
async function dragEnd(page, at) {
  await paintNow(page);
  await pointer(page, { type: 'pointerup', ...at });
  await paintNow(page);
}

/** The bars `index.js`'s `draw()` decides to show or hide each frame — read straight off
 *  `ui`'s own `_state` rather than through `snapshot()`, which does not carry them. */
const hudBars = (page) => page.evaluate(() => {
  const s = window.__CTX__.get('ui')._state;
  return {
    panel: s.panel?.id ?? null,
    partyBox: s.partyBox, clockBox: s.clockBox, stripBox: s.stripBox,
  };
});

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

test('dragging a window\'s title bar moves it, live, and the moved position survives a reload', async ({ page }) => {
  const errors = await boot(page);

  expect(await call(page, 'ui', 'open', 'party')).toBe(true);
  await paintNow(page);

  let regs = await regions(page);
  const before = regs.find((r) => r.tag === 'window-body');
  const dragRegion = regs.find((r) => r.tag === 'window-drag');
  expect(before, `no "window-body" region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  expect(dragRegion, `no "window-drag" region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  expect(dragRegion.drag, 'the title bar region must carry drag:true').toBe(true);

  // Horizontal only: `party`'s own authored height, once `hudReserved()` (the post-review fix
  // for the reviewer's `uiScale:2` finding) reserves the wallet/clock and party-bar/strip
  // bands out of the buffer, exactly fills the vertical room left between them at this
  // viewport — a real, verified fact (`window.test.js`'s `clampToSafeArea` cases, and the
  // overlap-regression test below, cover *that* claim). A drag still has to prove it moves
  // the window, which the x-axis — untouched by any reservation — does unambiguously.
  const from = centre(dragRegion);
  const dx = 18;
  const dy = 0;
  const to = { x: from.x + dx, y: from.y + dy };

  await dragStart(page, from, to);
  await paintNow(page);
  regs = await regions(page);
  const mid = regs.find((r) => r.tag === 'window-body');
  expect(mid.box.x, 'the window must already have moved while the drag is still held')
    .toBe(before.box.x + dx);
  expect(mid.box.y, 'y is pinned by hudReserved() at this viewport; a move must not fight it')
    .toBe(before.box.y + dy);
  expect(mid.box.w, 'a move must not touch the size').toBe(before.box.w);
  expect(mid.box.h).toBe(before.box.h);

  await dragEnd(page, to);
  regs = await regions(page);
  const after = regs.find((r) => r.tag === 'window-body');
  expect(after.box, 'releasing must not change the position the drag already committed to')
    .toEqual(mid.box);

  // Persisted for real (the `pokecenter-cooldown-reload.spec.js` pattern), not left to a
  // `pagehide` racing the navigation below.
  await call(page, 'offline', 'persist', 'flow');
  const keys = await prop(page, 'offline', 'keys');
  const raw = await page.evaluate((k) => localStorage.getItem(k), keys.save);
  const doc = JSON.parse(raw);
  expect(doc.slices?.ui?.windows?.party, 'the saved document must carry party\'s moved geometry')
    .toEqual(after.box);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 45_000, polling: 100 });
  expect(await page.evaluate(() => window.__FATAL__ ?? null)).toBeNull();
  await page.evaluate(() => window.__HOOKS__.pause());

  expect(await call(page, 'ui', 'open', 'party')).toBe(true);
  await paintNow(page);
  regs = await regions(page);
  const reopened = regs.find((r) => r.tag === 'window-body');
  expect(reopened, 'no "window-body" region after reload').toBeTruthy();
  expect(reopened.box, 'the reopened window must be at the moved position, not the authored default')
    .toEqual(after.box);

  expect(errors, 'no console error dragging, persisting or reloading a window').toEqual([]);
});

test('dragging a window\'s resize grip resizes it, clamped to its minimum, and the size survives a reload', async ({ page }) => {
  const errors = await boot(page);

  expect(await call(page, 'ui', 'open', 'party')).toBe(true);
  await paintNow(page);

  let regs = await regions(page);
  const before = regs.find((r) => r.tag === 'window-body');
  const grip = regs.find((r) => r.tag === 'window-resize');
  expect(before, `no "window-body" region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  expect(grip, `no "window-resize" region; regions seen: ${regs.map((r) => r.tag).join(', ')}`).toBeTruthy();
  expect(grip.drag, 'the resize grip region must carry drag:true').toBe(true);

  // Shrinking rather than growing: growing risks the buffer's own clamp kicking in on a small
  // gate viewport and turning this into a test of `clampResize`'s ceiling instead of the plain
  // arithmetic path — that ceiling already has its own golden cases in `window.test.js`.
  const from = centre(grip);
  const dx = -26;
  const dy = -14;
  const to = { x: from.x + dx, y: from.y + dy };

  await dragStart(page, from, to);
  await dragEnd(page, to);

  regs = await regions(page);
  const after = regs.find((r) => r.tag === 'window-body');
  expect(after.box.w, 'the width must shrink by exactly the pointer delta').toBe(before.box.w + dx);
  expect(after.box.h, 'the height must shrink by exactly the pointer delta').toBe(before.box.h + dy);
  expect(after.box.x, 'a resize from the bottom-right grip must not move the top-left corner')
    .toBe(before.box.x);
  expect(after.box.y).toBe(before.box.y);

  await call(page, 'offline', 'persist', 'flow');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 45_000, polling: 100 });
  expect(await page.evaluate(() => window.__FATAL__ ?? null)).toBeNull();
  await page.evaluate(() => window.__HOOKS__.pause());

  expect(await call(page, 'ui', 'open', 'party')).toBe(true);
  await paintNow(page);
  regs = await regions(page);
  const reopened = regs.find((r) => r.tag === 'window-body');
  expect(reopened, 'no "window-body" region after reload').toBeTruthy();
  expect(reopened.box, 'the reopened window must be at the resized size, not the authored default')
    .toEqual(after.box);

  expect(errors, 'no console error resizing, persisting or reloading a window').toEqual([]);
});

test('?uiScale=2 halves the UI buffer; the world\'s own render buffer is untouched', async ({ page }) => {
  await boot(page);
  const base = await call(page, 'ui', 'metrics');
  expect(base.width, 'a real UI buffer must exist before this comparison means anything')
    .toBeGreaterThan(0);
  expect(base.height).toBeGreaterThan(0);

  // A fresh boot, not a live `config.set` — `uiScale` is a `DEFAULTS` key (CLAUDE.md: every
  // one is a URL param) and this is the plainest way to drive it exactly like a player would.
  const errors = await boot(page, { uiScale: '2' });
  const scaled = await call(page, 'ui', 'metrics');
  expect(scaled.width).toBe(Math.floor(base.width / 2));
  expect(scaled.height).toBe(Math.floor(base.height / 2));

  const worldSize = await page.evaluate(() => window.__CTX__.three.view.internalSize);
  expect(worldSize[0], 'uiScale must not touch the world\'s own internal buffer').toBe(base.width);
  expect(worldSize[1]).toBe(base.height);

  expect(errors, 'no console error booting at uiScale=2').toEqual([]);
});

test('opening a `full` panel (shop) keeps the wallet, the clock and the party bar up behind it', async ({ page }) => {
  const errors = await boot(page);

  const before = await hudBars(page);
  expect(before.partyBox, 'the party bar must already be up before any panel opens — otherwise the assertion below is vacuous')
    .toBeTruthy();
  expect(before.clockBox, 'the clock must already be up before any panel opens').toBeTruthy();

  expect(await call(page, 'ui', 'open', 'shop')).toBe(true);
  await paintNow(page);

  const opened = await hudBars(page);
  expect(opened.panel).toBe('shop');
  expect(opened.partyBox, 'shop is a `full` panel; the party bar must stay up behind it (DECISIONS #85)')
    .toBeTruthy();
  expect(opened.clockBox, 'shop is a `full` panel; the clock must stay up behind it').toBeTruthy();
  expect(opened.stripBox, 'the button strip must stay up behind a `full` panel too').toBeTruthy();

  expect(errors, 'no console error opening a full panel').toEqual([]);
});

/** True if two boxes ({x,y,w,h}) share any pixel. */
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('a `full` panel window never geometrically covers the wallet/clock/party-bar/strip, ' +
  'even at uiScale:2 (the reviewer\'s finding on slice 016, fixed by `hudReserved`/' +
  '`clampToSafeArea`)', async ({ page }) => {
  // The bug this guards: `bars` stayed up behind a `full` panel (the previous test in this
  // file), but nothing kept the window's own opaque box from being *drawn over* them — at
  // `uiScale:1` a full panel's authored size happened to leave enough margin that it went
  // unnoticed; at `uiScale:2` the same authored size covers nearly the whole halved buffer,
  // painting over the bars it was supposed to leave visible. This test is the one neither the
  // implementer's own suite nor the independent tester's combined: each tested `uiScale` and
  // "bars stay up" separately, never together.
  const errors = await boot(page, { uiScale: '2' });

  const bars = await hudBars(page);
  expect(bars.partyBox, 'the party bar must be up before this test means anything').toBeTruthy();
  expect(bars.clockBox, 'the clock must be up before this test means anything').toBeTruthy();
  expect(bars.stripBox, 'the button strip must be up before this test means anything').toBeTruthy();

  for (const id of ['shop', 'boxes', 'dex', 'party', 'automation']) {
    expect(await call(page, 'ui', 'open', id)).toBe(true);
    await paintNow(page);

    const regs = await regions(page);
    const body = regs.find((r) => r.tag === 'window-body');
    expect(body, `${id}: no "window-body" region at uiScale:2`).toBeTruthy();

    const b = await hudBars(page);
    for (const [name, box] of [['clockBox', b.clockBox], ['partyBox', b.partyBox], ['stripBox', b.stripBox]]) {
      expect(box, `${id}: ${name} must still be up at uiScale:2`).toBeTruthy();
      expect(overlaps(body.box, box),
        `${id}'s window ${JSON.stringify(body.box)} must not cover ${name} ${JSON.stringify(box)} at uiScale:2`)
        .toBe(false);
    }

    expect(await call(page, 'ui', 'close')).toBe(true);
    await paintNow(page);
  }

  expect(errors, 'no console error opening every full panel at uiScale:2').toEqual([]);
});

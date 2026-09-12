# 016 — Windows a player can move, resize and scale, and that survive a reload

Status: proposed          Branch / commit: hud/window-system / …

## Why

Slice 015 gave `screen.js` a gesture layer (drag/drop/wheel) and fixed every panel's
click-anywhere-closes-it bug, but no panel actually uses drag for anything yet, `fit(g, w, h)`
(`src/ui/panels/common.js:29-32`) still clamps every window to one **authored** size the panel
picked, and there is no way to make the whole HUD physically bigger for readability. This slice
is the second half of the user's "the whole HUD must be interactive, draggable and resizable"
direction: it turns `windowFrame` into an actual window (draggable title bar, resizable corner,
remembered position/size across a reload) and adds a HUD-wide scale knob, using exactly the
gesture primitives 015 built (`drag`/`drop` on `g.hit`, nothing new at the pointer layer).

It also has to resolve a real conflict already in the code: `full: true` today means two
different things bundled into one flag — "open at a large, fixed size" *and* "hide the wallet,
the clock and the party bar while this is open" (`src/ui/index.js:352-368`: `const full =
!!state.panel?.full; const bars = !full && !state.panel?.hidesHud;` — `bars` gates
`hud.drawParty`, the button strip and the walk hint on **not** being `full`). Five of the ten
panels are `full` (`shop`, `boxes`, `dex`, `automation`, `party` — confirmed by grep for `full:
true` in `src/ui/panels/*.js`), so today opening any one of them removes the party bar entirely.
Slice 017 needs the party bar visible in every scene, including with a panel open, so this slice
splits the flag: `full` keeps meaning "sized generously by default", and a **new**, independent
signal governs whether the wallet/clock/party bar stay up — which for every existing `full` panel
is "yes, they stay", matching what a modern game's inventory/menu screen does (resources visible,
main menu open on top). `hidesHud` (only `dialogue` uses it today) is unchanged: a message box
still stands the bottom bars down.

## Inspected before writing this slice

- `src/ui/panels/common.js:18-32` — `margin(g)` and `fit(g,w,h)`, pure, unchanged by this slice
  except that `fit`'s return becomes a **default** size for a window's first opening rather than
  its permanent size; the clamp behaviour itself (never bigger than the buffer minus margins)
  still has to hold for whatever size the player drags a window to, so `fit`'s clamp math is
  reused, not replaced, inside the new resize handler.
- `src/ui/panels/common.js:42-90` — `windowFrame(g, opts)`. The header is drawn at
  `header(g, box, opts.title, {...})` (theme.js's `header`, `:47`); this slice adds the title bar
  itself as a `drag` region (`g.hit(titleBar, {drag: () => ({kind:'window', id: opts.windowId}),
  swallow: true}, 'window-drag')`, using 015's overload) and a small resize grip in the box's
  bottom-right 8×8 px, registered as a second drag region reporting `{kind:'resize', id:
  opts.windowId}`. Both need `opts.windowId` — currently `windowFrame` has no id parameter at
  all; every caller passes `title`/`bar`/`edge`/`light`/`footer`/`onClose`/`w`/`h`. This slice
  adds a required `windowId` (the panel's own `id`, e.g. `'party'`) so geometry can be looked up
  and persisted per panel.
- `src/ui/index.js:148-159` (`PANELS` map) and `:352-368` (the `draw()` function quoted above) —
  the exact split point. `bars` currently reads `!full && !state.panel?.hidesHud`; this slice
  changes the condition that suppresses the wallet/clock/party-bar/strip to
  `!state.panel?.hidesHud` alone (dropping the `!full` term), and `full` becomes purely a sizing
  hint consumed inside `windowFrame`/the new `window.js` (a bigger default size, nothing about
  visibility). The four call sites that hard-code `!full` (`:352, 356, 359-368`) all move to the
  new single flag.
- `src/ui/panels/shop.js:78-80` and `src/ui/panels/party.js:205-207` (plus `boxes.js:55`,
  `dex.js:34`, `automation.js:110`) — every one carries the comment `/** A full-frame window:
  index.js stands the HUD down while one is open. */` (or the `party.js` equivalent). This
  sentence becomes false the moment `full` stops hiding the HUD; corrected in the same commit on
  all five (the flag stays, only its meaning and its comment change).
- `src/ui/index.js:138-139, 367-368` — `state.partyBox` is already published precisely so a panel
  can read where the party bar sits (e.g. to avoid drawing under it); unaffected by this slice's
  mechanics, but will now be non-null while a `full` panel is open too, which slice 017 depends on.
- `src/core/config.js:8-58` (`DEFAULTS`) and `:280-281` (`NUMERIC`/`BOOLEAN` sets, derived by
  `typeof DEFAULTS[key]`) — adding `uiScale: 1` to `DEFAULTS` automatically makes it a coerced
  numeric URL param (`?uiScale=2`) with no other change needed, per CLAUDE.md's "every key in
  `src/core/config.js` `DEFAULTS` is a URL param." `config.js:292-335` — the returned object is a
  `Proxy` readable as a plain object (`config.uiScale`) and additionally exposes `get`, `set(patch)`
  (only touches keys already in `DEFAULTS`, notifies `onChange` listeners), `onChange(fn)`,
  `persist()` (writes only values that differ from `DEFAULTS` to `localStorage['pokeidle.config']`
  — a **separate** store from the game save at `'pokeidle.save'`), `reset()`. Confirmed the only
  existing caller of `persist()` is `src/environment/index.js:881`; this slice adds a second
  caller (the menu's scale toggle) that calls `config.set({uiScale: 2 or 1})` then
  `config.persist()` — the established two-step pattern, not a new one.
- `src/ui/screen.js:127-149` (`resize()`, quoted at 015's inspection) — currently sets
  `W, H = iw, ih` straight from `view.internalSize`, with `canvas.width/height = W,H` and
  `canvas.style.width/height` pinned to `view.displayRect` (the on-screen CSS box). Because the
  UI canvas is a **separate layer** from the three.js world canvas (confirmed: `screen.js` never
  touches `ctx.three`'s own renderer, only reads `view.internalSize`/`view.displayRect`),
  shrinking the UI canvas's own backing store while leaving its CSS box unchanged simply makes
  each UI buffer pixel cover more screen pixels — it does not touch the world's pixel grid or
  `pixelsPerUnit` (DECISIONS #60), and needs no change to `core/render.js`. This slice divides
  `iw, ih` by `config.uiScale` (clamped to `{1, 2}`) before assigning `W, H`; `imageSmoothingEnabled
  = false` already holds, so the result stays crisp at the one supported extra step, exactly as
  the existing non-integer 533→1600 world upscale is already documented as staying crisp
  (`screen.js`'s top-of-file comment).
- `src/ui/index.js:271` — `config.onChange(() => { onResize(); screen.markDirty(); })` already
  exists, so a `uiScale` change already triggers a resize + repaint with **no new listener code**;
  confirmed by reading `onResize`'s body, which calls `screen.resize()`.
- `src/travel/index.js:280-292` — the self-registration pattern this slice's persistence copies
  verbatim: `offline.store.register(id, {capture, restore, source:'native', order})` inside the
  module's own `init`, guarded by `isLive(offline) && typeof offline.store?.register ===
  'function'`, then an immediate `offline.store.get?.(id)` restore for the case the module inits
  after `offline` already hydrated. Confirmed `ui` inits **after** `offline` in the real boot
  order (slice 014's own inspection section cites the reviewer's derived order ending "…
  simulation, idle, offline, travel, ui"), so `ui` is in exactly `travel`'s situation and needs
  the same self-registration rather than the ordinary discovery `offline.init` does once, before
  `ui` exists.
- `docs/baseline.json` / `tools/shots/regress.js` — window chrome (title bar drag affordance,
  resize grip) is a real pixel change to every panel capture. Confirmed which regress rows open a
  panel: `grep -n "'boxes'\|'shop'\|'party'\|'dex'\|'automation'" tools/shots/*.js` — none of the
  17 named rows in `docs/baseline.json` open a panel (they are all world/environment/hunt/city/
  tiles/boot/encounter/pokecenter frames), so this slice's chrome change is **not** expected to
  move the existing 17-row baseline; if it does, that is a finding to investigate, not something
  to wave through with `--accept`.
- `src/ui/selftest.js:179-203` (the `fit()`/buffer clamp block, quoted in 015's own inspection) —
  the `buffers` array this slice must extend with the halved cases a `uiScale: 2` HUD actually
  runs at: `[320, 180]` (half of `[640,360]`), `[267, 150]` (half of `[534,300]`), matching the
  existing pattern of testing real produced sizes, not invented ones.

## Files / modules affected

New: `src/ui/window.js` (pure geometry store: clamp, default size, bring-to-front, min size per
panel id — importable under plain Node for `selftest.js`, following `gesture.js`'s precedent from
015), `src/ui/window.test.js`.

Edited: `src/ui/panels/common.js` (`windowFrame` gains `windowId`, drag/resize regions, reads
from `window.js`'s store instead of always centring at `fit()`'s size), `src/ui/index.js` (the
`full`/`bars` split described above; `ui.saveState()`/`loadState()` + `offline.store.register`
self-registration; drag-ghost/resize-ghost already draws last per 015's ordering), `src/ui/screen.js`
(`resize()` divides by `config.uiScale`), `src/core/config.js` (`uiScale: 1` in `DEFAULTS`),
`src/ui/panels/shop.js`, `boxes.js`, `dex.js`, `party.js`, `automation.js` (the stale `full`
comment corrected on each), `src/ui/selftest.js` (new buffer cases + window-store clamp checks),
`ARCHITECTURE.md` §5.12 (`ui`'s save slice, `full`'s corrected meaning), §10 (new save-slice row),
`docs/DECISIONS.md` (new entry).

## Expected behaviour

- Dragging any window's title bar moves it; the window never leaves the buffer (clamped the same
  way `fit()` already clamps size).
- Dragging the resize grip in a window's bottom-right corner resizes it, never below a per-panel
  minimum and never past the buffer's own margins.
- A window's geometry (position, size) is remembered per panel id and restored after a reload,
  via the `ui` save slice; a panel opened for the first time in a save gets its authored `fit()`
  size, centred, as today.
- `?uiScale=2` (and the same toggle from the menu) doubles the HUD's own pixel scale — text,
  icons, panel chrome all render bigger — with no change to the world's own rendering. The choice
  persists across a reload once toggled from the menu (`config.persist()`), the same way any
  other config change does; the URL param overrides it for one session without persisting,
  matching every other `DEFAULTS` key's documented behaviour.
- Opening any of the five `full` panels (`shop`, `boxes`, `dex`, `automation`, `party`) **no
  longer hides the wallet, clock, party bar or button strip** — only `dialogue`'s `hidesHud` does
  that, unchanged.
- `npm run gate` exits 0. The existing 17-row regress baseline is unaffected (see inspection); if
  a frame does move, it is flagged, not auto-accepted.

## Acceptance criteria

1. `src/ui/window.test.js` (vitest, pure): golden clamp cases — a window dragged so its computed
   `x` would go negative clamps to the margin; dragged past the right edge clamps so `x + w`
   never exceeds `buffer.w - margin`; resized below a panel's declared minimum clamps to that
   minimum; resized past the buffer clamps to fit. All against literal expected numbers.
2. `src/ui/selftest.js`: the extended `buffers` array (adding the two halved sizes) still passes
   `fit()`'s existing clamp assertion unmodified, proving `uiScale: 2`'s smallest produced buffer
   is still a valid target for every authored panel size.
3. A new Playwright case in `tests/flows/hud-windows.spec.js` (from 015): open `party`, read its
   window box from `screen.regions()`, `pointer(page, {type:'down', x: titleBarX, y: titleBarY})`
   → `move(dx, dy)` → `up()`, then re-read the box and assert it moved by `(dx, dy)` (clamped).
   Reload the page (still `?seed=1337`), reopen `party`, assert the box is at the moved position
   — proving the save round-trip, not just the in-memory move.
4. Same file: resize via the grip, reload, assert the size persisted.
5. A vitest or flow case: `config.set({uiScale: 2})` then read the UI's reported buffer size
   (`ui._screen.width/height` or equivalent) is exactly half the un-scaled buffer for the same
   viewport, and a captured screenshot's HUD glyph height (via `tools/shots/png.js` helpers, or a
   simpler pixel-count assertion) is double — reusing `png.js`'s existing pixel-reading helpers
   rather than inventing new ones.
6. A flow case: open `shop` (a `full` panel) and assert `ui.snapshot()` (or the equivalent state
   the tester chooses) shows the party bar and wallet box are non-null while `shop` is open —
   proving the `full`/`bars` split, the concrete bug 017 depends on this slice fixing.
7. Every one of the five panels' stale `full` comment is gone or corrected — checked by the
   reviewer reading the diff, not by an automated test.

## Tests required

Unit: `src/ui/window.test.js`. Selftest: extended buffer/clamp cases in `src/ui/selftest.js`.
Flow: extensions to `tests/flows/hud-windows.spec.js` (drag-move, resize, reload-persistence,
uiScale, full-panel-keeps-hud-visible).

## Verification in the real application

`npm run dev`, then at `/?seed=1337`:
- Open Party, drag its title bar, release; drag the bottom-right corner to resize.
- Reload the page: the window reopens (`KeyP`) at the same position and size.
- `/?seed=1337&uiScale=2` — the HUD is visibly larger and still crisp (no blur) at every panel.
- Open Shop or Boxes — the wallet, clock and party bar (once 017 lands) stay visible around the
  window, unlike today.
- `npm run shot -- --out shots/out/party.png --tod 11` and look at the chrome (title bar affordance,
  resize grip) directly, since composition is what `regress` cannot see.
- Console: zero `error`.

## Docs to touch

`ARCHITECTURE.md` §5.12 — `ui`'s save slice row and the corrected meaning of `full`.
ARCHITECTURE.md §10 — new save-slice table row for `ui`, ordered like `travel`'s self-registered
row. `docs/DECISIONS.md` — a new entry (next number after 015's) recording the `full`/`bars`
split and why (`hidesHud` alone now gates HUD visibility; `full` is sizing only), and the
`uiScale` mechanism (a config key, not a save-slice field, and why: URL-overridable per
CLAUDE.md's rule that every `DEFAULTS` key is a URL param).

## Out of scope

Drag-to-reorder anything (party slots, automation priority lists, box contents) — 015 built the
mechanism, this slice only uses it for window chrome. The inventory and trainer panels (018,
019) and the party bar's own content (017) — this slice only makes the window shell draggable/
resizable/scalable/persistent; it does not add any new panel.

## Result

Filled in when done.

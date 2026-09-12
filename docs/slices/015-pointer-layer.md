# 015 — A pointer layer: drag, drop, wheel-scroll, and a clip primitive

Status: proposed          Branch / commit: hud/window-system / …

## Why

Every popup in `src/ui/` closes on a click anywhere over it, including its own paper, because
`windowFrame` registers exactly one full-buffer hit region tagged `scrim` and nothing else
before drawing the window's content (`src/ui/panels/common.js:51`; the same shape is repeated by
hand in `src/ui/panels/menu.js:56` and `src/ui/panels/offline.js:67`). `screen.js`'s `pick()`
(`src/ui/screen.js:120-124`) returns the **last** region registered whose box contains the point,
and the scrim is the *first* thing every panel registers — so the moment a panel's own draw code
also registers a hit region over some of that same area (a row, a button), that later region wins
there and the scrim wins everywhere else, including over the panel's own inert paper. That is
"click anywhere on the popup closes it, except where there happens to be a button" — the bug the
user reported.

The user separately asked for the whole HUD to become "completely interactive, draggable,
resizable" as infrastructure for future work, not as one panel's feature — reordering an
automation's priority list by dragging (docs/DECISIONS.md #77(a) rejected drag only on the
grounds that `screen.js` has no pointer capture or gesture state that survives a repaint),
dragging a Pokémon between the party and a box (slice 020), and windows a player can move and
resize (slice 016). All three need one thing `screen.js` does not have: a gesture state that
outlives the `regions = []` reset every `paint()` does (`src/ui/screen.js:288`), keyed by what was
picked up rather than by the rectangle it was drawn in (a rectangle is meaningless the instant the
next frame moves it).

And no view in `src/ui/` can scroll. The single scrolling primitive, `list()`
(`src/ui/panels/common.js:108-137`), draws only whole rows and moves its `top` offset solely from
keyboard cursor keys in each panel's own `key()` handler (e.g. `src/ui/panels/shop.js:195-196`,
`src/ui/panels/boxes.js:111`); there is no `wheel` listener anywhere in `src/` (confirmed by grep);
and anything that is not a row list is simply truncated with a hard `y` budget
(`src/ui/panels/boxes.js:202-216`, `src/ui/panels/shop.js:172-179`, `src/ui/panels/automation.js:266`)
— which is the second bug reported ("não é possivel dar scroll... não é possivel ler").

This slice builds the shared mechanism both bugs and both future features need: a gesture layer
in `screen.js` (drag, drop, wheel), a clip primitive (`g.clip`), and a `scrollArea` widget in
`common.js`, then fixes the two reported bugs with it. It does not build movable/resizable
windows (016) or touch `automation.js`'s content (021-023) — only the shared primitive and the
scrim-closes-everything fix, which is visible today in every existing panel.

## Inspected before writing this slice

- `src/ui/screen.js` (full, 297 lines). `makeScreen({root, view, log})` returns
  `{canvas, painter, width, height, resize, clearTints, markDirty, regions, dirty, imagesSettled,
  paint, dispose}` (`:127-296`). Painter `g` is built at `:191-260`: `fill, text, textRight,
  textCentre, sprite, scrim, hit, hovered, image, measure` — **no `save`/`restore`/`clip`
  anywhere in the file, nor in any of `src/` (`grep -rn 'ctx\.save\|\.clip(' src/` → nothing)**.
  `regions` is a closure array (`:119`), reset to `[]` at the top of every `paint()` (`:288`) and
  pushed to only by `hit(box, on, tag)` (`:243`, `{...box, on, tag}` — no drag/drop/scroll
  fields). `pick(p)` (`:120-124`) walks `regions` **backwards** ("last registered wins" — the
  comment at `:242` says so and matches paint order: whatever is drawn later is registered
  later and sits visually on top). Listeners: `pointerdown` (`:173-181`, capture phase `true`,
  calls `r.on(r,p)` in a try/catch that logs `warn` on throw) and `pointermove` (`:182-189`, hover
  tag only — sets `document.documentElement.style.cursor`). **No `pointerup`, `pointercancel`,
  or `wheel` listener; no `setPointerCapture` anywhere.** `toUi(ev)` (`:home area ~155-160`)
  converts a client point to buffer coordinates via `canvas.getBoundingClientRect()` — reused
  as-is for the new listeners, since drag/drop/scroll all need the same conversion.
- `src/ui/panels/common.js` (full, 167 lines). `windowFrame(g, opts)` (`:42-90`): draws the
  dimmed scrim over the whole buffer and registers `g.hit({x:0,y:0,w:g.width,h:g.height},
  opts.onClose, 'scrim')` at `:51` **before** `panel(g, box, …)` and the header/close-cross are
  drawn — so every widget a caller draws inside `box` afterward registers its own hit region
  strictly later in `regions`, and by the "last wins" rule in `screen.js` those later regions
  already win over the scrim wherever they overlap it. The close cross itself is `:59-61` (a
  14×13 box at the header's top-right, registered after the scrim, working today for the same
  reason). **The gap is the panel's plain paper — every pixel of `box` that is not already
  covered by a button, row, or the close cross — which registers nothing, so a click there falls
  through to the scrim and closes the window.** `list()` (`:108-137`) is the only scrolling
  primitive: draws `Math.floor(box.h / rowH)` whole rows starting at `opts.top`, registers one hit
  region per row (`:129-131`), and draws a 3px scrollbar track+thumb when `total > rows`
  (`:133-137`) — but the thumb is **not** a drag target (no `onPick`/hit region on it), it is
  read-only decoration; `top` is owned by each panel's own closure variable and only ever changed
  by that panel's `key()` handler. `fit(g,w,h)` (`:29-32`) and `margin(g)` (`:18`) are pure and
  unaffected by this slice.
- `src/ui/panels/menu.js:56` and `src/ui/panels/offline.js:67` — both hand-roll the identical
  `g.hit({x:0,y:0,w:g.width,h:g.height}, () => app.close(), 'scrim')` call, independently of
  `common.js`'s `windowFrame`, with the same ordering bug (registered before their own content).
  `menu.js` draws no `panel()` scrim fill first (its column has its own `panel()` call at a
  later line) but the hit-region gap is identical.
- `src/ui/panels/battle.js` and `src/ui/panels/dialogue.js` register **no** scrim at all
  (confirmed: `grep -n scrim src/ui/panels/battle.js src/ui/panels/dialogue.js` → nothing) — they
  are out of scope for the close-on-background fix because they have no such background to
  begin with; not touched by this slice.
- `src/ui/index.js:407-417` — the panel draw call site or the single call site for
  `screen.paint(draw)` (`:422-449` is `frame()`; the drawing sequence itself is inside a closure
  `draw(g)` used by `paint`). Confirmed the sequence is: HUD elements (if not `full`/hidden), then
  `if (state.panel) state.panel.draw(g, app)`, then toasts/callouts. A drag ghost must be drawn
  **after** the panel, i.e. appended at the end of that same `draw(g)` closure, reading
  `screen.drag()` (new).
- `src/ui/panels/travel.js`, `shop.js`, `boxes.js`, `dex.js`, `party.js`, `automation.js` — every
  one of these calls `list()` for its scrolling content and none has a `wheel` path. This slice
  adds wheel support **to `list()` itself** (registers a scroll target over the list's own box,
  routed through the new `scroll` field on `g.hit`) so all six panels gain wheel-scroll with no
  change to their own call sites — verified each call site passes only `{items, rowH, top,
  selected, onPick, draw, tag, dark}`, none of which collides with an added optional `onScroll`.
- `src/ui/selftest.js` (full, 266 lines) — Node-only, imports `ui/panels/common.js` (`fit`,
  `margin`) and `ui/theme.js` but not `ui/screen.js` (`makeScreen` needs `document`). The new
  pure logic this slice adds (a gesture reducer, a scroll-offset clamp) must live in functions
  importable under plain Node — so they are extracted into a new file
  `src/ui/gesture.js` (pure, no DOM) that both `screen.js` and `selftest.js` import, following the
  precedent of `battle.js`'s pure `lineFor`/`STATUS_NAME` already being imported by
  `ui/selftest.js` (ARCHITECTURE §5.12 lists this).
- `docs/DECISIONS.md` #77 (full entry, `docs/DECISIONS.md:499-550`). Part (a) is the one this
  slice answers: *"there is no pointer capture, no drag state, and nothing that survives a
  repaint mid-gesture… building that for lists that ship at most nine rows… would be a subsystem
  in service of a flourish."* This slice does not contradict the conclusion reached for the
  automation panel specifically (still fine with `^`/`v`, kept in slice 022) — it removes the
  *mechanism* objection for every future feature that needs it, and a new DECISIONS entry (this
  slice) says so and points forward, per the archive's own convention ("entries correct each
  other forward", `docs/DECISIONS-ARCHIVE.md` header) — #77's own text is not edited.
- `tools/seams/run.js` rule 3 (`module-shape`) and rule 1 (`no-math-random`) — `gesture.js` is a
  plain file under `src/ui/`, not a module descriptor, so rule 3 does not apply to it (it is not
  `src/<module>/index.js`); it must not call `Math.random()` anywhere (it doesn't need to — no
  randomness in a gesture reducer).
- `tests/flows/harness.js` (full, 96 lines) — `key(page, code, down)` dispatches a real
  `KeyboardEvent` on `window`; there is no equivalent pointer helper yet. This slice adds one:
  `pointer(page, {type, x, y})` dispatching a real `PointerEvent` at buffer coordinates translated
  through the canvas's `getBoundingClientRect()` the same way `toUi()` does, so the new flow spec
  drives the exact code path a real user's mouse does.

## Files / modules affected

New: `src/ui/gesture.js` (pure — drag/drop/scroll reducer and the scroll-offset clamp),
`src/ui/gesture.test.js` (vitest), `tests/flows/hud-windows.spec.js`.

Edited: `src/ui/screen.js` (pointer listeners for drag/drop/wheel, `g.hit` overload, `g.clip`,
`screen.drag()` getter), `src/ui/panels/common.js` (`windowFrame`'s scrim ordering fix,
`scrollArea()`, `list()` gains wheel), `src/ui/panels/menu.js` and `src/ui/panels/offline.js`
(same scrim-ordering fix, since they hand-roll the pattern instead of using `windowFrame`),
`src/ui/index.js` (draws the drag ghost last), `src/ui/selftest.js` (new pure checks),
`tests/flows/harness.js` (`pointer()` helper).

## Expected behaviour

- Clicking anywhere on a panel's own paper (not a button, not the close cross, not outside the
  window) does nothing and the panel stays open.
- Clicking the close cross (`✗`) closes the panel — unchanged from today.
- Clicking outside the window, on the dimmed scrim, closes the panel — unchanged from today.
- The mouse wheel, with the pointer over a `list()` or `scrollArea()`, moves its visible window
  by whole rows / by a pixel delta respectively; content that overflows a `scrollArea` becomes
  reachable rather than truncated.
- `g.hit(box, {on, drag, drop, scroll, swallow}, tag)` is a valid call: a region with `drag`
  becomes pickable-and-held across a full drag gesture (the state that survives is `{tag,
  payload}`, not the rectangle); a region with `drop` receives the payload and the drop point
  when a held drag is released over it and `drop.accepts(payload)` is true; a region with
  `scroll` receives wheel deltas while the pointer is over it; a region with `swallow: true`
  consumes a `pointerdown` without calling anything (used for the window-body catcher).
- `screen.regions()` reports `swallow`/`drag`/`drop`/`scroll` alongside the existing `tag`/`box`,
  so a test can assert a control exists in one of these new modes without executing it.
- `npm run gate` exits 0. `list()`'s existing keyboard-driven `top` behaviour, its per-row hit
  regions, and its scrollbar rendering are all unchanged for every existing caller — this slice
  only *adds* a wheel path onto the same box.

## Acceptance criteria

1. `src/ui/gesture.test.js` (vitest, pure, no canvas): a golden reducer test —
   `startDrag(payload, tag) → move(dx,dy) → drop(target)` returns the expected sequence of
   `{phase, tag, payload, x, y}` states, against **literal** expected values (DECISIONS #35 — not
   a second live call). A `pointerup` with no drop target under it returns to `null` (cancelled).
   A `pointercancel` at any point returns to `null` regardless of accumulated motion.
2. `src/ui/gesture.test.js`: `clampScroll(offset, contentH, viewH)` — golden cases: negative
   offset clamps to 0; an offset beyond `contentH - viewH` clamps to that max; `contentH <= viewH`
   always clamps to 0 (nothing to scroll).
3. `src/ui/selftest.js` gains a case importing `gesture.js` under plain Node (no DOM) and asserting
   the same clamp/reducer behaviour runs there — proving the module has no browser dependency,
   the same guarantee `battle.js`'s pure exports already have.
4. `tests/flows/hud-windows.spec.js` (Playwright, new): boot at `?seed=1337`, open `party` (or any
   panel using `windowFrame`), read `screen.regions()` via `__CTX__`/a new `ui._screen.regions()`
   hook, `pointer(page, {type:'down', x, y})` at a coordinate inside the panel's own box but
   **not** inside any registered non-scrim region → `ui.openPanel()` is still `'party'`. Then a
   `pointerdown` at the close-cross box → `openPanel()` is `null`. Reopen, then a `pointerdown`
   well outside the window box (still inside the buffer) → `openPanel()` is `null`. Every
   step-until is bounded with a message per CLAUDE.md's testing rule.
5. Same spec: open `shop` (has a `list()`), wheel-scroll over the list's box, assert the panel's
   exposed cursor/top moved by asserting on which rows are drawn — reuse the existing pattern of
   exposing a non-contract read method for testing without pixels (`src/ui/panels/travel.js`'s
   `rows()`, cited in ARCHITECTURE's testing section) rather than reading pixels.
6. Regression check: every existing `tests/flows/*.spec.js` and `src/ui/selftest.js` still passes
   unmodified in behaviour (only additive checks were appended) — run by the tester independently.

## Tests required

Unit: `src/ui/gesture.test.js`. Selftest: new case(s) in `src/ui/selftest.js`. Flow:
`tests/flows/hud-windows.spec.js`.

## Verification in the real application

`npm run dev`, then at `/?seed=1337`:
- Open Party (`KeyP`), click the middle of the window's paper (not on a stat row or button) —
  stays open. Click `✗` — closes. Reopen, click outside the window — closes.
- Open Shop (`KeyB`), scroll the mouse wheel over the shelf list — the visible items scroll.
- `screen.regions()` (via `window.__CTX__.get('ui')._screen.regions()`) lists at least one region
  with `swallow: true` covering the window body and no region still reachable at the scrim's own
  z-order over the panel's paper.
- `npm run shot -- --out shots/out/party.png --tod 11` and look — no visual change expected from
  this slice (the fix is purely to hit-region ordering, not to drawing), so `regress` should show
  **0 moved** frames; if it does not, that is a finding, not something to `--accept` past.

## Docs to touch

`docs/DECISIONS.md` — new entry (next number after #83) recording that the pointer layer now
exists, revising #77(a) forward without editing its text, and citing where the gesture state
lives (`src/ui/gesture.js`) and why it survives a repaint (keyed on identity, not on the
rectangle). `ARCHITECTURE.md` §5.12 (`ui`'s API surface — note `_screen` internals used by tests
if any new ones are exposed) if `screen.regions()`'s shape changes in a way the doc already
describes.

## Out of scope

Movable/resizable windows, UI scale, and save-slice persistence for either (slice 016). Any
change to `automation.js`'s content or the four other panels beyond the shared scrim-ordering fix
and gaining wheel-scroll through the unmodified `list()` API. Drag-to-reorder anywhere (016+;
this slice only builds the mechanism and proves it with a unit test, not a shipped drag feature).

## Result

Filled in when done.

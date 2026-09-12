# 018 — An inventory panel: everything held, in a grid

Status: proposed          Branch / commit: hud/window-system / …

## Why

There is no screen that shows what the player is carrying. `economy.bag()`/`stash()`
(`src/economy/index.js:534-535`) already return exactly the rows a grid needs — every held item
with its category, tier, count, unit/total sell value and lock state — and the shop panel's own
comment says so out loud: *"The bag has no screen of its own yet, and this column was a third
empty under five stat lines"* (`src/ui/panels/shop.js:256-258`), where it crams five raw
`{id, n}` pairs from `economy.inventory()` into a corner of the item-detail pane. This slice gives
the bag (and the treasure-only stash) the panel it is missing, built on the window/pointer
primitives 015/016 landed: a real grid, scrollable, with category/tier filters and a sell-lock
toggle — the one write action this panel needs.

## Inspected before writing this slice

- `src/economy/index.js:513-670` — the item-facing API block. `inventory()` (`:518`) → raw
  `{id: n}`; `count(id)` (`:566`); `item(id)` (`:570`) → the frozen catalogue entry; `items(filter)`
  (`:571`); `bag()`/`stash()` (`:534-535`) → `rows((d) => !isStashItem(d))` /
  `rows((d) => isStashItem(d))`, where `rows(keep)` (`:283-308`, quoted below) is the shared row
  builder both use:
  ```
  out.push({ id, name, category, tier, n, cap, price, unitSell, totalSell, locked, desc });
  ```
  sorted tier-ascending then value-descending (`:307`). `sellLocked(id)` (`:544`),
  `setSellLock(id, on=true)` (`:546`) — the only write this panel performs. `onChange(fn)` (`:659`)
  — a local subscriber set (`subscribers.add(fn)`), **not** a bus event: confirmed by grep, there
  is no `economy:changed`-style emit for a bare item count change (`economy:changed` is
  currency-only, `index.js:103-108`), so this panel must subscribe via `onChange`, not `bus.on`.
- `src/economy/items.js` — `STASH_CATEGORIES = new Set(['treasure'])` (`:313`), `isStashItem(def)`
  (`:314`) — confirms Bag/Stash is a filter over one catalogue, not two separate stores, matching
  ARCHITECTURE's description. Seven live categories total: `ball, medicine, candy, evolution,
  lure, held, treasure` (counted from `ITEMS`, `:74-276`). No `key` category is populated despite
  appearing in the typedef.
- `src/economy/index.js:137-141` — the fresh-save starting kit: `20 pokeball, 10 potion,
  3 superpotion, 2 revive, 3 ether` — the exact acceptance-test literal for "a new save's grid".
- **No item icon assets exist anywhere in the repository** (confirmed again for this slice:
  `find assets public -iname '*item*' -o -iname '*ball*.png' -o -iname '*potion*'` under the
  runtime asset roots turns up nothing but screenshot evidence under `docs/progress/`, which is
  not a runtime asset). The established placeholder precedent is `pokeball(g, x, y, {red, white,
  band})` (`src/ui/theme.js:296-312`) — a hand-authored 7×7 row-string bitmap mark, drawn with
  `g.fill`, no image load. This slice adds one more such mark per category (seven total) in the
  same file, tinted by `def.tier` (a simple lightness ramp already present in `theme.js`'s dark
  recess ramp `C.deepDeep…C.deepFaint`), explicitly a placeholder per the user's own direction —
  not final art, and noted as an `open` STATUS entry.
- `src/ui/panels/shop.js:255-279` (quoted above) — the pattern this slice supersedes for "what you
  hold": reads raw `inventory()` rather than the richer `bag()`/`stash()` rows, shows at most
  `bagRoom` (a handful) items with no filter, no icon, no lock toggle. Left as-is by this slice
  (out of scope to also rewire the shop's detail pane), but the inventory panel is now the correct
  place to look, and the shop's own comment about the gap becomes stale — corrected in this
  slice's commit to point at the new panel instead of describing an absence.
- `src/ui/theme.js:284-294` (`meter(g, box, t, {fill, back, light})`) — reused as-is for a stack
  fill bar per cell (`n / cap`).
- `src/ui/panels/common.js` — `windowFrame`, `section`, `list`/`scrollArea` (015/016), `tabs`
  (`:146-156`, reused for the BAG/STASH switch and the category filter row), `action` (`:160-165`,
  reused for the sell-lock toggle button).
- `src/ui/index.js:148-159` (`PANELS`), `src/ui/input.js:61-69` (`PANEL_IDS`, `PANEL_KEYS`) — the
  registration points. Confirmed `KeyI` and `Digit7` are unbound today (grep of `PANEL_KEYS`'s
  existing codes: `KeyT, KeyP, KeyB, KeyC, KeyM, KeyU, Digit1-6`). `ui/index.js:469-475`
  (`selfTest()`) fails the whole test suite (which `console.error`s, failing every capture per the
  perf budget) if a panel is in one list and not the other — both must be edited together.
- `src/ui/index.js:281-313` (`drawStrip`) — the bottom-strip chip row; a new `INVENTORY` chip is
  added following the existing chips' pattern (icon/label + `app.open(id)` + the correct key hint).
- `docs/STATUS.json` — this slice adds an `open` entry for the placeholder item icons (module
  `ui`), since the user's own direction ("caso seja item use um placeholder") makes the gap
  deliberate but still worth tracking until real art exists.

**Amended during implementation** (re-inspection before editing, as the process requires):

- `src/ui/panels/common.js` (015/016, already landed) — `windowFrame(g, opts)` now **requires**
  both `windowId` and `reserved: app.hudReserved()` in every call's `opts`, and `full` is inert
  data, not a sizing hint (both true when this slice's own "Inspected" section above was
  written, but worth restating since every other panel's call site — `shop.js`, `party.js` — was
  re-read before writing `inventory.js`'s own `windowFrame` call, which follows the identical
  shape). No contradiction found, just confirmed.
- `src/automation/index.js:1074-1078` (`preview(id)`) — acceptance criterion 4's own framing
  ("once research is granted... a subsequent `automation.preview('sell')`... excludes the locked
  item") reads as if `preview()` only reflects a sell-lock once the automation is unlocked.
  Reality: `preview(id)` calls `planSell()`/`planRelease()`/`planRestock()` directly with no
  `engine.isActive(id)` gate at all — only `run(id)` checks that. `planSell()`'s sell-lock check
  (`economy.sellLocked?.(id)`, `automation/index.js:610`) runs regardless of unlock/enable state,
  so `preview('sell')` would have excluded a locked item even with `research: 0` and `sell`
  never unlocked. The flow test still grants research and calls `unlock('sell')` — it is a more
  realistic rehearsal of the actual player path and costs nothing to keep — but the gate it
  proves past is `economy.setSellLock`, not `automation`'s own unlock state.

## Files / modules affected

New: `src/ui/panels/inventory.js`, `src/ui/panels/inventory.test.js`.

Edited: `src/ui/theme.js` (seven category marks, placeholder), `src/ui/index.js` (`PANELS` entry,
strip chip), `src/ui/input.js` (`PANEL_IDS`, `KeyI`/`Digit7`), `src/ui/panels/shop.js` (the stale
"no screen of its own yet" comment corrected to point at the new panel), `docs/STATUS.json` (new
`open` entry for placeholder icons).

## Expected behaviour

- `KeyI` (or `Digit7`, or the new strip chip) opens a grid of every held item, split into BAG /
  STASH tabs matching `economy.bag()`/`stash()` exactly.
- Each cell: category mark (placeholder), count, a stack-fill meter against `cap`. Selecting a
  cell shows detail: name, `desc`, unit/total sell value, and — the panel's one write control — a
  sell-lock toggle calling `economy.setSellLock(id, !locked)`.
- A category filter row and a tier/value sort are available; the grid scrolls (015's primitive)
  when the held set overflows the window.
- The grid updates without reopening the panel when a purchase, a drop, or a sell changes a count
  — driven by `economy.onChange(fn)` marking the panel dirty, since no bus event exists for item
  changes.
- `npm run gate` exits 0.

## Acceptance criteria

1. `src/ui/panels/inventory.test.js` (vitest, the `travel.test.js` pattern — a model function
   exposed without a canvas): with a fake `economy` returning a fixed `bag()`/`stash()`, the
   panel's row-building function filters by the active tab and category exactly like the source
   arrays, with no re-sorting beyond what `economy` already provides.
2. A flow spec: fresh save, open the inventory, assert the BAG tab lists exactly `pokeball ×20,
   potion ×10, superpotion ×3, revive ×2, ether ×3` (the literal starting kit) with no STASH items.
3. A flow spec: buy an item in the shop, then open (or, if already open, observe) the inventory —
   its count reflects the purchase without the panel having been reopened (proving the `onChange`
   wiring, not just a fresh read on `open()`).
4. A flow spec: toggle a sell-lock in the panel, assert `economy.sellLocked(id)` flips and that a
   subsequent `automation.preview('sell')` (once research is granted, following the plan's own
   showcase-grant workaround for `research-unmintable`) excludes the locked item — proving the
   toggle actually reaches the ledger, not just a local checkbox.
5. `src/ui/selftest.js`: every string the panel can draw (category names, `desc` text for at least
   one item per category) passes the font's existing character-coverage check.

## Tests required

Unit: `src/ui/panels/inventory.test.js`. Flow: a new `tests/flows/inventory.spec.js` covering 2-4
above.

## Verification in the real application

`npm run dev`, `/?seed=1337`: `KeyI` opens the grid on a fresh save showing the exact starting
kit; buy a Potion in the shop, switch to the inventory, see the count update; toggle a sell-lock;
scroll the grid with the wheel (015) if the held set is large enough to overflow.
`npm run shot -- --out shots/out/inventory.png` and look at the placeholder marks directly.
Console: zero `error`.

## Docs to touch

`docs/STATUS.json` — new `open` entry, module `ui`: placeholder item icons need real art.
`ARCHITECTURE.md` §5.12 (`ui`'s panel id list gains `inventory`).

## Out of scope

Real item art (tracked as the STATUS entry above). Rewiring the shop panel's own "in your bag"
corner to use the richer `bag()` rows — left as today's five-item text list; only its stale
comment is corrected. The trainer panel (019).

## Result

**Starting `npm run gate:fast`** (before any edit, matching the working tree at `9a6a8e8`):

```
  lint       ok       2.5s
  typecheck  ok       0.5s
  seams      ok       1.6s
  unit       ok       0.9s
  build      skipped
  coldboot   skipped
  boot       skipped
  flows      skipped
  parity     skipped
  regress    skipped
  total               5.5s
✓ gate: every stage passed
```
(70 passed, 1 expected fail — `unit`'s pre-existing `STATUS:research-unmintable` pin.)

**What shipped.** `src/ui/panels/inventory.js` (new): `makeInventory(app)`, a panel following the
`windowFrame({windowId, reserved: app.hudReserved(), ...fit(g, w, h)})` shape every other panel
uses post-016 — BAG/STASH tabs, a category filter row built from whatever categories the active
tab's own rows actually carry (never a dead tab), a `dark:true` recessed item grid (`list()`,
015's scrollbar/wheel primitive) with a placeholder category mark + count + stack-fill meter per
row, and a detail pane with the one write control (the sell-lock toggle,
`economy.setSellLock(id, !locked)`). `filterRows(app, tab, category)` is the row-building
function, exported standalone and also exposed as `panel.rows(tab, category)` (the `travel.js`
precedent) so `inventory.test.js` drives it with a fake `economy` and no canvas. The panel
subscribes to `economy.onChange(fn)` on `open()` (unsubscribing on `close()`) since `economy` has
no bus event for a bare item-count change.
`src/ui/theme.js`: seven placeholder category marks (`itemMark(g, x, y, category, tier, opts)`,
one 7×7 bitmap per category — ball/medicine/candy/evolution/lure/held/treasure — tinted by tier
off the four-tone dark side of the recess ramp, `pokeball()`'s own no-image-load style).
`src/ui/index.js`: `inventory: makeInventory(app)` in `PANELS`, a `BAG` strip chip.
`src/ui/input.js`: `PANEL_IDS` gains `inventory`; `KeyI` and `Digit7` open it.
`src/ui/panels/shop.js`: the stale "no screen of its own yet" comment corrected to point at the
new panel instead of describing an absence that no longer exists.
`src/ui/selftest.js`: a character-coverage check over every string `inventory.js` can draw
(the seven category labels plus one real `desc` per category, literal per seam rule 2 — no
cross-module import of `economy/items.js`); the pre-existing "authored panel size" clamp check
gained `inventory`'s `480×264` and, found while extending it, `automation.js`'s own `600×300`,
which had been missing from that list since `automation.js` shipped (a latent gap, not something
this slice's own change caused, fixed here because it sits in the same array for the same
reason).
`docs/STATUS.json`: new `open` entry `item-icon-placeholders` (module `ui`); `no-manual-sell`'s
`what` corrected — `economy.stash()`/`bag()` now have a caller in `src/ui`, but that caller's one
write action is the sell-lock, not a sell button, so the entry's substance (no player-facing sell
path) still stands.
`ARCHITECTURE.md` §5.12: the panel id list gains `inventory`; the key list gains `KeyI`/`Digit7`;
the `full` panel count corrected 5→6; a new paragraph describing the panel and `itemMark`.
Tests: `src/ui/panels/inventory.test.js` (vitest, 7 cases — the row filter, both tabs, a category
filter, a category absent from the active tab, a quarantined `economy`, the panel's own exposed
`rows()`, every category has a label) and `tests/flows/inventory.spec.js` (Playwright, 3 cases —
acceptance criteria 2, 3, 4: the fresh-save starting kit exactly, a real `economy.buy()` call
updating the open panel's count with `screen.dirty` proving the `onChange`→`markDirty` wiring
fired (not a fresh read on reopen), and a real click on the panel's own `sell-lock` region
flipping `economy.sellLocked()` and excluding the item from a subsequent
`automation.preview('sell')`).

**Verification in the real application.** Screenshotted directly (Playwright script against a
manually-started `vite --port 48173`, not committed): a fresh save's BAG tab shows Poké Ball
×20, Potion ×10, Ether ×3, Super Potion ×3, Revive ×2 with the ALL/BALL/MEDICINE category tabs
and a visible stack-fill meter per row; giving the trainer one item of every category and
re-opening shows all seven category tabs and seven distinct marks; the STASH tab (after
`economy.give('nugget', …)`) shows the `L` lock glyph on a locked row and the UNLOCK/LOCK detail
button flips as expected. One artifact noticed and *ruled out* as unrelated to this slice: a
"READY" callout with a progress bar bleeds through on top of **every** panel in this build,
`inventory` included — confirmed by opening the pre-existing `shop` panel in the identical scene
and seeing the identical bleed-through at the identical pixel position. Cause: `ui/index.js`'s
`draw()` calls `callouts.draw(g, project)` *after* `state.panel.draw(g, app)` unconditionally, so
a world callout always paints over whatever panel is open — an existing ordering this slice did
not touch and is out of its "Files / modules affected" list.

**Final `npm run gate`** (`GATE_PORT=48173`, no other process bound to that port or its `+1`
checked first via `ps`/`lsof`):

```
  lint       ok       2.5s
  typecheck  ok       0.5s
  seams      ok       1.6s
  unit       ok       0.9s
  build      ok       3.7s
  coldboot   ok       3.9s
  boot       ok       91.5s
  flows      ok       76.8s
  parity     ok       37.2s
  regress    ok       70.1s
  total               288.7s
✓ gate: every stage passed
```
`boot`: 24/24 entry points (18 showcases + 6 scenes) still draw a real frame — `inventory` is a
panel inside `ui`, not a registered module, so it adds no new showcase entry point of its own.
`flows`: 35/35, including the 3 new `tests/flows/inventory.spec.js` cases.
`regress`: **0 improved, 0 regressed, 0 moved, across 18 frames** — none of the 18 fixed regress
captures open the inventory panel, so no baseline re-accept is needed and none was done.

**Post-review** (reviewer + tester ran in parallel per `CLAUDE.md`; both independently re-ran
every unit/flow test from a fresh save and the full gate — no blocking findings from either).
Both hit the same transient `flows` failure from an unrelated concurrent `npm run gate` process
sharing this worktree and writing to the same `shots/out/flows` directory; both traced it to
contention (re-running the single failing test alone passed cleanly) rather than a defect in
this slice, matching this repo's own multi-agent-worktree hazard note.

One non-blocking observation applied anyway, for defence in depth: `inventory.js`'s `open()`
assigned `offChange` unconditionally, so a second `open()` with no intervening `close()` would
leak one `economy.onChange` subscriber per call — unreachable through any shipped input path
today (`ui/index.js` never calls a panel's `open()` twice without a `close()` in between while
it is already the open panel, and every shortcut into this panel is blocked while any panel is
up), but cheap to close first regardless. Fixed; `npm run gate:fast` and a full `npm run gate`
(`GATE_PORT=5511`) both re-ran clean afterward, all 10 stages green, regress still 0 moved.

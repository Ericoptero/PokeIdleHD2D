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

Filled in when done.

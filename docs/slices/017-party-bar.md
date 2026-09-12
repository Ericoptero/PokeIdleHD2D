# 017 — The party bar: all six, in use order, the one on the field marked, draggable to reorder

Status: proposed          Branch / commit: hud/window-system / …

## Why

The user asked for all six current party members to always be on screen, in the order they are
used, with the one currently active in the field or in battle marked, clicking one opening the
party detail with that member selected, and the ability to reorder by dragging.

Today's party bar (`src/ui/hud.js:143-174`, `drawParty`) is not that: it draws one 108×44 box with
the **lead's** portrait and name, then six poké-ball *pips* — filled for "a member exists in this
slot", hollow for "bench slot empty" — with no per-member sprite, no HP, no name, no click target,
and no notion of who is active mid-fight. It is also suppressed the instant any `full` panel is
open (`src/ui/index.js:352-368`, fixed by slice 016), which is why this slice depends on 016
landing first.

"Order of use" already has a precise, existing meaning in this codebase, not something to invent:
`pokemon.party()`'s array order **is** the order `simulation` walks (`src/simulation/index.js:196-217`,
`party[0]` is the one on the overworld), the order `pokemon.conscious()` returns, and the order
`encounter`'s `nextAlly` falls back to when automation is off (`src/encounter/index.js:941-944`,
comment: *"Party order for now"*). So "use order" is simply `pokemon.party()`, unmodified — the
bar does not compute or infer an order, it reads one that already exists and is already load-bearing
elsewhere.

"Who is active" is genuinely two different facts depending on context, and the codebase already
resolved which one wins when: `src/ui/panels/battle.js:130-170` (quoted below) reads the live duel's
`state.a` for as long as `active.duel?.engine` exists at all — **not** gated on `battle.win`, a
correction to this slice's own first draft, below — and falls back to `pokemon.lead()` only once
no duel object exists, because HP/PP is only written back to the `pokemon` instance when the
fight ends (DECISIONS #72). This slice's party bar applies the identical rule rather than inventing
a third source of truth — it is a second reader of a decision the battle card already made, not a
new one. **Correction, found by this slice's own review pass, after this section was first
written:** the implementation's first draft gated the party bar's own read on
`active.battle.win === null` (mid-fight only) — narrower than the rule just described — so for
several real seconds after a fight that included a mid-fight swap (the encounter object stays
alive while the player decides whether to throw a ball, per `encounter/index.js`'s own comment),
the battle card kept correctly showing the finisher while the party bar reverted to the original,
possibly-fainted lead. Fixed in `src/ui/hud.js` to drop the `win` gate and match `battle.js`
exactly; neither this slice's own flow test nor the independent tester's caught it, since both
asserted only the strictly-mid-fight (`win === null`) window — the reviewer found it live.

## Inspected before writing this slice

- `src/ui/hud.js` (full, 208 lines). `read()` (`:37-80`) already builds `s.party` as
  `{name, display, level, shiny, url}` per member off `pokemon.party()` (`:56-64`) — this slice
  extends that mapping with `instanceId, hp, maxHp, status` (all already on a `pokemon` instance,
  ARCHITECTURE §5.5's shape) so the painter never has to read another module directly (`read()`'s
  own stated contract, `:12-14`: "the painter never calls into another module while it is
  drawing"). `drawParty(g, s, {x, bottom})` (`:143-174`) is replaced; `drawIcon(g, entry, x, y,
  size, scale)` (`:181-205`) is reused as-is — it already resolves a whole-ratio NEAREST scale
  off the sprite sheet and is called the same way by `party.js`/`boxes.js` today.
- `src/ui/index.js:367-368` — `const partyBox = hud.drawParty(...); state.partyBox = partyBox;`
  is the only call site; the new bar keeps this exact call shape (same return contract: a box, or
  `null` when the party is empty) so nothing else in `index.js` needs to change beyond what 016
  already does (the `!full` gate removed).
- `src/pokemon/index.js:223-238` — `party: () => party.slice()` (a defensive copy — safe to hold
  across a frame), `lead: () => party[0] ?? null`, `setLead(i)` (splice+unshift, **emits**
  `party:leadChanged {instanceId, species}`), `addToParty` (emits only when the party was empty),
  **`swap(i,j)` emits nothing** (`:238`, one line, a bare index swap). This slice adds
  `reorder(from, to)` beside `swap`, implemented as a splice-move (remove at `from`, insert at
  `to`, matching `setLead`'s own splice idiom at `:226-227` rather than introducing a different
  algorithm) — and it **must** emit `party:leadChanged` exactly when the result's slot 0 differs
  from before the move (checked by comparing `party[0]` before/after), because `simulation`
  (`src/simulation/index.js:668`, listens for this to re-read the walking sprite),
  `ui` (`src/ui/index.js:214`, dirties the frame) and `idle` all key their own repaint/rebuild off
  this one event, and a silent slot-0 change (like today's `swap`) would desync the walker from
  the bar exactly as the plan's own risk note says.
- `src/pokemon/instance.js:51-70` — the instance shape confirms every field the bar needs already
  exists per member: `instanceId, level, shiny, hp, maxHp, status`. No new pokemon-side data.
- `src/ui/panels/battle.js:130-170` (quoted in full below since this slice's central design
  decision rests on it):
  ```
  const st = active.duel?.engine ? active.duel.run?.state : null;
  const fighting = active.battle.win === null;
  const side = st?.a ?? null;
  …
  ally: side ? { …, hp: side.hp, maxHp: side.maxHp, status: side.status, … }
       : (lead ? { …lead fields… } : null),
  ```
  `st.a` (the ally combatant, `src/battle/engine.js:54-63` `makeCombatant`) carries `instanceId`
  verbatim from whichever party member was sent in — confirmed at `engine.js:61`:
  `instanceId, species: name, display, level, shiny, …, maxHp: stats.hp, hp: hp ?? stats.hp`.
  So the exact rule this slice's bar applies is: `const active = encounter.active(); const midFight
  = active?.battle?.win === null; const activeId = midFight ? active.duel?.run?.state?.a?.instanceId
  : pokemon.party()[0]?.instanceId;` — read through `ctx.get('encounter')`, guarded `isLive`, the
  same pattern every other panel already uses (e.g. `src/ui/panels/party.js:15`, `boxes.js:23`).
  `encounter`'s `active()` accessor is a plain getter (`src/encounter/index.js:1497`) already
  exposed on its public API and already read this deeply by `battle.js`, so this is a second,
  identical consumer of an existing surface, not a new cross-module reach.
- `src/ui/panels/party.js:18, 205-208` — the panel's descriptor: `id: 'party', full: true, open(opts)
  { cursor = 0; view = opts?.view === 'moves' ? 'moves' : 'stats'; … }`. This slice adds `opts.select`
  handling: `cursor = Number.isInteger(opts?.select) ? opts.select : 0` (falls back to today's
  default of slot 0 when no `select` is given, so every existing caller — the keyboard shortcut,
  the menu — is unaffected).
- `src/ui/index.js:148-159` — `open(id, opts)` already forwards `opts` verbatim to
  `PANELS[id].open(opts)` (`:113-128`, quoted in the earlier exploration), so `ui.open('party',
  {select: i})` needs no change to `open()` itself, only to `party.js`'s own `open(opts)`.
- Slice 015's `g.hit(box, {drag, ...}, tag)` overload and 016's `windowFrame`/`window.js` drag
  mechanics — this slice's drag-to-reorder on the bar itself uses 015's primitive directly (a
  `drag` region per slot reporting `{kind:'party-slot', index: i}`, a `drop` region on every other
  slot accepting that kind and calling `pokemon.reorder(from, to)`); it does not touch `window.js`
  at all, since the bar is not a window (it has no title bar, no resize grip, `full: false`/no
  panel wrapper).
- `docs/baseline.json` (`hudRows: 60`, `tools/shots/regress.js:80-100`) — the party bar sits at
  the buffer's bottom edge, well outside the top 60 rows `hudRows` excludes from every regress
  frame's luminance/saturation stats. Confirmed by reading every one of the 17 baseline row
  names (`hunts/*`, `city/*`, `tiles`, `boot`, `environment/*`, `encounter/*`, `pokecenter`) —
  none crops only the top of the frame, so a taller, richer party bar **will** move some or all
  of these rows' scalar stats. `node tools/shots/regress.js --accept` is required in this slice's
  own commit, with the moved frames named, per CLAUDE.md's own rule for a deliberate visual change.
- `src/ui/font.js:37` (`GLYPHS`) — the new bar draws a status glyph (poison/paralysis/etc.) if
  space allows; checked which status symbols the font already ships by grepping
  `STATUS_NAME`/`lineFor` in `src/ui/panels/battle.js` (pure, imported by `selftest.js`) — the
  existing battle card already prints status names as short strings (`PSN`, `PAR`, …), not glyphs,
  so this slice reuses that same short-string convention rather than adding new glyphs.

## Files / modules affected

Edited: `src/ui/hud.js` (`read()` extended, `drawParty` rewritten to six real slots), `src/ui/index.js`
(no structural change beyond what 016 already makes — `partyBox` publication unchanged), `src/ui/panels/party.js`
(`opts.select`), `src/pokemon/index.js` (`reorder(from, to)`, emitting `party:leadChanged`
conditionally), `ARCHITECTURE.md` §5.5 (new API line), `docs/baseline.json` (re-accepted).

New: `src/pokemon/reorder.test.js` (or appended to an existing pokemon test file if one already
exists for party ops — checked at implementation time; none does today per the earlier
exploration, so likely new).

## Expected behaviour

- All six slots draw on every scene (city, every hunt biome, the Pokémon Center), each showing:
  sprite (south-facing walk frame via `drawIcon`), short name, level, an HP bar (`hp/maxHp`), a
  status abbreviation when non-null, and an empty-slot placeholder (today's hollow-ring drawing)
  for any bench slot beyond the party's actual size.
- The slot matching the rule above (mid-fight: the live combatant's `instanceId`; otherwise
  `party[0]`) is visually marked distinctly (a highlighted border/glow), and the mark moves the
  instant a mid-fight swap changes who is out, without waiting for the encounter to resolve.
- Clicking a filled slot calls `ui.open('party', {select: i})`, opening the party panel with that
  member's detail already selected.
- Dragging a filled slot onto another filled slot calls `pokemon.reorder(from, to)`; if the result
  changes who is at index 0, `party:leadChanged` fires and the overworld sprite (and the
  highlighted slot, if not mid-fight) updates in the same frame.
- `npm run gate` exits 0; the regress baseline is re-accepted in this slice's own commit with the
  moved frames named in the commit message, per CLAUDE.md.

## Acceptance criteria

1. `src/pokemon/reorder.test.js` (vitest, `init(stubCtx)` on the real module): `reorder(2, 0)`
   moves the third member to the front and **emits** `party:leadChanged` with the moved member's
   `instanceId`; `reorder(1, 3)` — a move that does not touch slot 0 — emits nothing. A move with
   an out-of-range index is a no-op (mirrors `setLead`'s and `swap`'s own guard style).
2. `src/pokemon/selftest.js` gains an invariant sweep (many seeds, per CLAUDE.md's own testing
   rule of "golden values from seed 1337, invariants swept over many runs"): after any sequence of
   `reorder` calls, the party is a permutation of its original members (no member created,
   destroyed, or duplicated) and `party:leadChanged` fired if and only if slot 0 changed.
3. A new or extended `tests/flows/*.spec.js`: force a mid-fight ally swap (fell the lead, let
   `nextAlly` send the next member — the existing `hunt.spec.js`/`hunt-recovers.spec.js` pattern
   for driving a real fight), and assert (via `ui.snapshot()` or an equivalent read the tester
   picks that is not a pixel) that the bar's marked slot is the live combatant's `instanceId`, not
   `party[0]`'s — the concrete case DECISIONS documents as the reason two sources of truth exist.
4. A flow case: click a bench slot (`pointer()` from slice 015's harness helper, at the slot's box
   from `screen.regions()`) → `ui.openPanel() === 'party'` and the panel's own selected index
   (exposed the way `party.js` already exposes non-contract state for testing, per
   `travel.js`'s `rows()` precedent) equals the clicked slot.
5. A flow case: drag slot 3 onto slot 1 → `pokemon.party()` reflects the new order and, since slot
   0 did not move in this example, no `party:leadChanged` fires (assert via the flow harness's
   `installEventLog`, already wired in `tests/flows/harness.js`); a second case drags slot 1 (a
   non-lead) onto slot 0 and asserts the event **does** fire and the overworld's walked sprite
   changes (`simulation.follower()`'s `instanceId`).
6. `node tools/shots/regress.js --accept` run once the new bar is drawing, with every moved frame
   named in the slice's Result section and in the commit message — not silently absorbed.

## Tests required

Unit: `src/pokemon/reorder.test.js`. Selftest: extended sweep in `src/pokemon/selftest.js`. Flow:
extension(s) to an existing hunt/battle spec plus a new bar-interaction spec.

## Verification in the real application

`npm run dev`, `/?seed=1337`:
- City: all six (or fewer, for a smaller party) party slots draw at the bottom of the screen with
  sprite, level, HP.
- `travel.go('hunt-meadow')`, let a fight start and the lead faint mid-fight so a bench member is
  sent in — the marked slot changes to the new active member without the encounter having resolved.
- Click a bench slot → the party panel opens on that member.
- Drag a bench slot onto the front slot → the overworld sprite changes to that Pokémon.
- `npm run shot -- --out shots/out/hud.png --tod 11` and look at the new bar directly.
- Console: zero `error`.

## Docs to touch

`ARCHITECTURE.md` §5.5 (`pokemon`'s API list — `reorder(from, to)` added beside `swap`, its
event-emission rule stated the way `setLead`'s already is). `docs/baseline.json` (re-accepted, as
above). No DECISIONS entry — this slice applies an existing rule (battle.js's mid-fight-authority
choice) to a second consumer; it does not establish a new one.

## Out of scope

The inventory and trainer panels (018, 019). Any change to `src/encounter/` or `src/battle/` —
this slice only reads `encounter.active()`, exactly as `battle.js` already does; it adds no new
event and no new field to either module's public shape. Party↔box transfers (020) — this slice's
drag only reorders within the six on-screen slots, never moving a member out of the party.

## Result

Implemented as designed, with one refactor beyond the slice's own file list: the HP colour
ramp (`hpInk`, local to `src/ui/panels/battle.js`) was extracted to `src/ui/theme.js` as
`hpRamp` so the party bar could share it rather than duplicate it a second time —
`battle.js` now imports it back.

**Starting `npm run gate:fast`**: clean (lint/typecheck/seams/unit all `ok`).

**What the six slots do, exactly as specified**: sprite, level badge, short name, an HP bar
using the shared `hpRamp`, a status abbreviation (`battle.js`'s own `STATUS_NAME`, imported
rather than re-declared), and a hollow-ring empty plate for a bench slot beyond the party's
actual size. The active slot — mid-fight the live combatant, otherwise `party[0]` — gets a
glow-ring border; a round-1 draft painted the active slot's background in the same blue
`hpRamp` spends on a healthy bar, and a full bar on the active slot blended invisibly into it,
fixed by leaving every slot's plate the same paper and reserving the accent colour for the
ring alone.

**One hit region does both a click and a drag**, resolving the ambiguity precisely: every
`pointerdown` on a slot starts a drag (`gesture.js`); a `pointerup` back on the *same* slot
(`payload.index === i`) reads as a plain click and opens the party panel already selected on
it; a `pointerup` on a *different* slot reorders. No second competing hit region, no separate
click-vs-drag-distance threshold to get wrong.

**`pokemon.reorder(from, to)`** — a splice-move beside `swap` (which still emits nothing and is
untouched), emitting `party:leadChanged` iff slot 0 actually changes (checked by comparing
`party[0]` before/after, never inferred from `from`/`to`, since a move that never names slot 0
can still evict it — e.g. moving slot 1 to the end shifts slot 2 into slot 0).

**Acceptance criteria**:
1. `src/pokemon/reorder.test.js` (vitest, `init(stubCtx)` on the real module): golden
   `reorder(2,0)` case, a same-slot-0 no-emit case, and an out-of-range no-op case. 3/3 pass.
2. `src/pokemon/selftest.js` checks 36-39: the same golden case as a Node literal (independent
   of vitest ever running), then an invariant sweep — 40 seeds × 20 random moves each — checked
   against two properties with nothing to do with any one move's arithmetic: the party stays a
   permutation of itself, and `party:leadChanged` fires iff and only iff slot 0 actually moved.
   `node src/pokemon/selftest.js`: 67/67 checks pass.
3. `tests/flows/party-bar.spec.js`, test 4: forces the lead to a sliver of HP in a real
   `hunt-meadow` fight, steps the sim until `encounter.active().duel.run.state.a.instanceId`
   differs from the original lead **while the fight is still unresolved** (`win === null`,
   bounded by `stepUntilTrue` — never a bare timeout), then asserts `ui.snapshot().activeId`
   matches the live combatant, not `party()[0]`.
4. Test 1: a real `pointerdown`+`pointerup` on party-bar slot 1's own region (read from
   `screen.regions()`, not assumed) opens the party panel with `cursor() === 1`.
5. Tests 2 and 3: a same-slot-3→slot-1 drag reorders with no `party:leadChanged`; a
   slot-1→slot-0 drag fires it, and `simulation.follower().instanceId` (the sprite actually
   walking) updates to match — proving the bar's reorder reaches the overworld, not just the
   party array.
6. `node tools/shots/regress.js --accept` run: **1 row moved** — `boot/12`'s `over200Pct`
   luminance statistic, `3.661 → 5.332` (classified `IMPROVED` by `tools/shots/regress.js`'s own
   direction convention, so the gate's `regress` stage passed even before accepting; accepted
   anyway per CLAUDE.md so the diff does not linger in every future run). A taller, higher-contrast
   party bar with six real HP bars is exactly the kind of deliberate visual change this metric is
   built to notice. Re-verified `0 improved, 0 regressed, 0 moved` on a fresh compare after
   accepting.

**Final `npm run gate` (`GATE_PORT=5411`, full run):**

```
  lint       ok       2.5s
  typecheck  ok       0.5s
  seams      ok       1.7s
  unit       ok       0.9s
  build      ok       3.7s
  coldboot   ok       4.6s
  boot       ok       108.2s
  flows      ok       78.6s
  parity     ok       40.0s
  regress    ok       76.0s
  total               316.7s
✓ gate: every stage passed
```
`unit`: includes the 3 new `reorder.test.js` cases. `flows`: includes the 4 new
`party-bar.spec.js` tests. `parity`: unaffected (party bar is HUD, not world geometry).

**Process note**: the implementer that built this slice was interrupted mid-verification by a
model rate limit (its work was otherwise complete and uncommitted). The orchestrating session
verified the diff line-by-line, re-ran every unit/selftest/flow check independently, ran the
full gate, accepted the regress baseline, and committed this slice on its behalf (`456818e`).

**Post-review fix** (reviewer + tester ran in parallel per `CLAUDE.md`, both independently found
the same real bug — the reviewer by re-deriving `battle.js`'s own rule and reproducing the
divergence live, the tester by writing an independent flow test for the identical scenario):

`src/ui/hud.js`'s `activeId` computation added a gate `panels/battle.js`'s own rule does not
have — `active?.battle?.win === null &&` — narrower than "for as long as a duel object exists at
all." The consequence: for the several real seconds between a fight resolving
(`active.battle.win` flips from `null`) and `encounter.resolve()` running `pokemon.setLead()` for
a swapped-in finisher (the player's own "should I throw a ball" window, `encounter/index.js`'s
own comment), the party bar reverted to the **original, possibly-fainted lead** while the battle
card correctly kept showing the finisher — the exact two-sources-of-truth split this slice was
built to prevent, in the one window neither this slice's own flow test nor the independent
tester's first draft checked (both asserted only the strictly-mid-fight, `win === null` window).

Fixed by dropping the `win` gate in `src/ui/hud.js`, matching `battle.js`'s condition exactly
(`active.duel?.engine` alone). A new case in `tests/flows/party-bar.spec.js` (extending the
mid-fight-swap test) steps past fight resolution and asserts the bar keeps marking the finisher
through the post-resolution window; the tester independently wrote and ran the identical scenario
in an isolated worktree pinned to the pre-fix commit, confirmed it failed there for the stated
reason, and confirmed it passes against the fix. This slice's own "Why"/"Inspected" sections are
corrected in the same commit — the original characterization of `battle.js`'s rule as gated on
`win === null` was itself wrong, not just the code that copied it.

`npm run gate:fast` clean after the fix (a stray lint failure — an unused test-callback
parameter — fixed in the same pass). Full gate re-run **twice** (`GATE_PORT=5461`, then
`GATE_PORT=5481`) — the first run's `boot` stage failed transiently under load from an unrelated
concurrent session's own dev server/browser processes on the same machine (`boot` alone, and the
full gate re-run afterward, both passed clean — matching `docs/STATUS.json`'s already-documented
`boot-probe-no-retry` flakiness, not a regression from this fix):

```
  lint       ok       4.8s
  typecheck  ok       0.6s
  seams      ok       2.3s
  unit       ok       1.2s
  build      ok       4.5s
  coldboot   ok       4.6s
  boot       ok       143.6s
  flows      ok       92.3s
  parity     ok       54.3s
  regress    ok       100.3s
  total               408.7s
✓ gate: every stage passed
```
`regress`: 0 improved, 0 regressed, 0 moved — the accepted baseline from the original commit
still holds; this fix touched only `activeId`'s logic, not the bar's drawing.

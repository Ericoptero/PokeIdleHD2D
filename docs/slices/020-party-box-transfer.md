# 020 — Party ↔ Box, without turning the Pokémon into a different one

Status: proposed          Branch / commit: hud/window-system / …

## Why

The user asked for a "move to party" / "move to box" button on both the party and box detail
panes. No function anywhere moves a Pokémon between the two today (confirmed by grep for
`removeFromParty|withdraw|toParty|toBox` across `src/**/*.js` — nothing). The reason it does not
already exist casually is real: a party member (`src/pokemon/instance.js:51-70`) and a box entry
(`src/collection/index.js:112-138`, `makeEntry`) are two different shapes on purpose — the party
instance carries live `moves` with spent PP, `hp`, `status`; the box entry carries `ivs`,
`ordinal`, `biome`, `ball`, `nickname`, `favourite`, none of which a party instance tracks, and
none of the reverse. A naive "read the party fields, deposit a box entry" loses PP, HP and status
on the way in; a naive "read the box fields, `createInstance`" **re-rolls IVs and resets
everything** on the way out, because `pokemon.createInstance({species, level, shiny, seed, ivs})`
(`src/pokemon/index.js:239-245`) forks a fresh RNG stream unless `ivs` is passed and always
starts full HP, no status, default moveset — it manufactures a new individual, it does not
restore one. This slice's whole job is closing that gap without inventing a new save format:
carry the box entry's `ivs`/`level`/`shiny` (already there) plus, from this slice on, the party
instance's exact serialized form (`instance.js:284-296`'s `serialize()`), so a round trip returns
the same individual, not a same-species stand-in.

## Inspected before writing this slice

- `src/pokemon/instance.js:284-296` (`serialize(inst)`) — the exact plain-object shape a party
  instance already reduces to for the save: `{instanceId, species: name, level, shiny, exp, ivs,
  hp, moves:[{id,pp}], priority, status}`. This is precisely what a box entry needs to carry to
  make a withdraw lossless, and it is **already** how `pokemon`'s own save slice stores a party
  member — this slice does not invent a shape, it reuses this one as a box entry's extra field.
  `deserialize(slice, lookup, battle)` (`:298-325`) is the inverse: **derived state (stats, maxHp,
  the move list itself) is rebuilt from species+level+ivs, never trusted from the file** — only
  `hp`, spent `pp` per move id, and `status` are carried over, clamped against the freshly
  computed `maxHp`/`maxPp`. This slice's withdraw path gets this exact same rebuild for free by
  routing through the same function, rather than re-implementing a weaker version of it.
- `src/pokemon/index.js:223-246` — `party()`, `lead()`, `setLead`, `addToParty` (`:232-236`, caps
  at 6, emits `party:leadChanged` only when the party was empty), `swap` (`:238`, silent),
  `createInstance` (`:239-246`, quoted above). **No `removeFromParty` exists.** `SAVE_VERSION = 1`
  (`:18`); `saveState()` (`:428`) is `party.map(INST.serialize)` verbatim — confirming `serialize`
  is already the party's own save shape, not something new this slice invents.
- `src/collection/index.js:112-138` (`makeEntry`, quoted in full above) — an entry has no field
  for moves/PP/HP/status today; `spec.instanceId ?? \`${key}-${ord}\`` (`:117`) means an entry
  built without an explicit `instanceId` invents a synthetic one, which is wrong for a party
  transfer (the whole point is keeping the *same* `instanceId` so `automation`'s `partyUids()`
  check (`src/automation/index.js:499-502`, cited in the earlier exploration) and anything else
  keying off it keeps working across the move).
- `src/collection/index.js:170-192` (`intake(spec, {announce=true})`, quoted in full above) —
  the one path a Pokémon enters storage through: `makeEntry` → `boxes.deposit` → `dex.add` →
  `collection:added` (if `announce`) → a toast keyed on `!stored` (boxes full), `entry.shiny`
  (unconditional — **not** gated on `isNewSpecies`), or `isNewSpecies`. **A party→box move must
  not fire the shiny-caught or new-species toasts** — the Pokémon was not just caught, it was
  reorganised — so `intake` gains a third option, `toast = true`, defaulting to today's behaviour
  for every existing caller and set to `false` only by this slice's new `storeFromParty` path;
  `announce` (the `collection:added` bus emit, one of the seven save-dirtying events, ARCHITECTURE
  §4/§10) stays **true**, because the box's contents genuinely changed and `automation`
  (box-pressure facts), `idle` and `offline` (the save-dirty signal) all need to hear about it —
  suppressing the toast text is not the same as suppressing the event.
- `src/collection/index.js:548-561` (`saveState`) — `stored` is a **positional array**, 15 fields
  ending in `favourite`. Confirmed by reading `loadState`'s matching destructure (`:586`,
  quoted in full above): a fixed-position array-destructure, so **appending a 16th element is
  read by nothing on the old code path and ignored by nothing on the new one** — the safe
  direction the earlier exploration already flagged. `SAVE_VERSION = 1` (`:51`) for the module.
  This slice bumps it to `2` (a genuine shape change: the 16th field), with `loadState` tolerant
  of a `v: 1` document (row length 15, no `inst`) per ARCHITECTURE's rule that a slice "tolerates
  an older slice… refuses a newer one at `log.warn`" — the destructure simply reads `undefined`
  for the 16th slot on an old row, and this slice's withdraw path treats a missing `inst` as "no
  exact record, reconstruct from species/level/shiny/ivs" (a documented, honest degrade for saves
  made before this slice, not a silent data loss going forward).
- `src/automation/fields.js:47` — `ORIGINS = ['wild', 'gift', 'restore', 'trade']`, the enum a
  rule's `origin` condition field offers (`:132`). A box entry created by this slice's
  `storeFromParty` is truthfully none of those, so `'party'` is added to the list — the one
  cross-module vocabulary touch this slice makes outside `pokemon`/`collection`/`ui`.
- `src/collection/index.js` §5.10's `needs: ['pokemon']` (ARCHITECTURE) — `collection` already
  depends on `pokemon`, so both new orchestration functions live on `collection`'s own API and
  reach into `pokemon` via the `ctx.get('pokemon')` handle the module already holds, rather than
  asking `ui` to sequence two separate calls. No `needs` list changes.
- `src/ui/panels/party.js:420-430` and `src/ui/panels/boxes.js:229-249` — the existing detail-pane
  action button layout (`evolve`/`set-lead` in party; `favourite`/`release` with a confirm step in
  boxes) is the placement pattern the new `MOVE TO BOX` / `MOVE TO PARTY` buttons follow —
  same `action(g, box, label, {onPick, tag})` widget, same confirm-step idiom for the box's release
  (this slice's moves are reversible, so neither gets a confirm step, only a disabled state with
  the refusal reason shown as the button's own label or an adjacent line).
- `docs/DECISIONS.md` — no existing entry covers a box entry carrying full battle state; this
  slice adds one (the "why serialize/deserialize instead of re-rolling" reasoning above, cited
  from `collection/index.js` at the new field).

## Files / modules affected

Edited: `src/pokemon/index.js` (`removeFromParty(instanceId)`), `src/collection/index.js`
(`intake`'s new `toast` option, `storeFromParty(instanceId)`, `withdrawToParty(ref)`,
`SAVE_VERSION` → 2, `saveState`/`loadState`/`makeEntry` carry the 16th `inst` field),
`src/automation/fields.js` (`ORIGINS` gains `'party'`), `src/ui/panels/party.js` (MOVE TO BOX
button), `src/ui/panels/boxes.js` (MOVE TO PARTY button), `ARCHITECTURE.md` §5.5, §5.10, §10,
`docs/DECISIONS.md` (new entry).

New: `src/collection/transfer.test.js` (vitest, round-trip literals).

## Expected behaviour

- `pokemon.removeFromParty(instanceId)` removes and returns the member's **serialized** form
  (the same shape `saveState` already produces) when doing so leaves at least one conscious member
  in the party and the party has more than one member; otherwise returns `{ok:false, why}` and
  changes nothing.
- `collection.storeFromParty(instanceId)` calls the above, builds a box entry carrying the
  serialized instance verbatim (`entry.inst`), deposits it silently (no shiny/new-species toast,
  `collection:added` still fires), and returns the entry or `{ok:false, why}` (forwarded from
  `removeFromParty`, or "boxes are full").
- `collection.withdrawToParty(ref)` resolves the entry, reconstructs a live instance via
  `pokemon.deserialize`-equivalent when `entry.inst` exists (exact HP, spent PP, status, moveset
  recomputed from level — identical to a save reload) or via `pokemon.createInstance` with the
  entry's `species/level/shiny/ivs` when it does not (a pre-this-slice save; full HP, default
  moveset, honestly a reconstruction not a restoration), adds it to the party, removes the entry
  from storage, and returns `{ok:true}` or `{ok:false, why}` ("party is full") **without** removing
  the box entry on failure.
- Both party and box detail panes show a MOVE button; disabled with the refusal reason visible
  when the move is not currently possible (last conscious member; party full; boxes full).
- `npm run gate` exits 0. A save from before this slice loads normally and a Pokémon deposited
  before this slice can still be withdrawn (degraded path).

## Acceptance criteria

1. `src/collection/transfer.test.js` (vitest, `init(stubCtx)` wiring the real `pokemon` and
   `collection` modules together — the `travel-realwiring.test.js` pattern, not a hand-authored
   fixture, since this is exactly the "two halves disagreeing" risk that test exists to catch):
   `storeFromParty` → `withdrawToParty` round-trips `instanceId`, `level`, `exp`, `ivs`, a
   moveslot's spent `pp`, `hp`, and `status` **exactly** — golden literals after a scripted
   sequence (deal damage, spend PP, poison, then move out and back).
2. Same file: `removeFromParty` on the sole conscious member of a party of one is refused; on the
   sole conscious member of a party of three (two fainted) is refused; on a conscious member with
   another conscious member present succeeds.
3. Same file: `withdrawToParty` with the party already at 6 is refused and the entry is still in
   the box afterward (not silently consumed).
4. Same file: a `stored` row built by hand in the **old 15-field shape** (no `inst`) still
   `withdrawToParty`s successfully via the degraded path (fresh moveset, full HP) — proving the
   `v:1` save is not stranded.
5. A flow spec: deposit a shiny party member via the UI's MOVE TO BOX button and assert (via the
   event log `tests/flows/harness.js` already installs) that no `ui:toast` with shiny/new-species
   text fired, while `collection:added` **did**.
6. `src/collection/selftest.js` gains a case asserting the `v: 2` slice round-trips
   `serialize→restore→serialize` byte-identical (mirroring `automation/selftest.js`'s own check
   #12, the established pattern for this exact guarantee) and that a `v: 1` document still loads.

## Tests required

Unit: `src/collection/transfer.test.js`. Selftest: extended case in `src/collection/selftest.js`.
Flow: extension covering criterion 5.

## Verification in the real application

`npm run dev`, `/?seed=1337`: damage and poison the lead, spend a move's PP, MOVE TO BOX it,
confirm no "caught" toast; MOVE TO PARTY it back; open its detail and confirm HP, status and PP
are exactly as before the move. Try moving out the only conscious member — the button is disabled
with a reason. Console: zero `error`.

## Docs to touch

`ARCHITECTURE.md` §5.5 (`pokemon.removeFromParty`), §5.10 (`collection.storeFromParty`/
`withdrawToParty`, the `v: 2` slice shape), §10 (the save-format table row for `collection`).
`docs/DECISIONS.md` — new entry: a box entry carries the party instance's exact serialized form
so a withdraw is a restoration, not a re-roll, and why `intake` needed a `toast` option rather
than a second, parallel intake path.

## Out of scope

Drag-and-drop between an open party panel and an open box panel (015's mechanism supports it;
wiring two simultaneously-open panels together is additional UI work this slice does not include
— the MOVE buttons are the whole of this slice's UI surface). The inventory and trainer panels.

## Result

Filled in when done.

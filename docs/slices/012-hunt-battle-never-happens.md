# 012 — In the hunt the battle never happens: a wiped party could not get back up

Status: done          Branch / commit: `hunt-battle-never-happens`

## Why

Reported from play: "in the hunt the battle never happens" — the party walks the circuit past
living wild Pokémon, no battle card, no fight — from the city through the travel panel, on an
existing save. `tests/flows/hunt.spec.js` asserts that exact flow and is green, so this was never a
missing feature. It is a party with no conscious member, which is a closed loop: `slotNear`
refuses one, so no encounter starts, so no `resolve()` runs, so `wipe()` — the only caller of
`pokemon.reviveAll()` in the game — is unreachable. `wipe()` then had a latch above its own revive.
Answers DECISIONS #81; touches STATUS `travel-mid-encounter-silent` (the route in, still open).

## Inspected before writing this slice

- `src/encounter/index.js:769` — `slotNear` returns `null` when `!pokemon.firstConscious()`, silently.
- `src/encounter/index.js:1336-1346` — `wipe()` opened `if (faintedWarned) return;` **above** the
  toll, `reviveAll()` and the `party:wiped` emit.
- `src/encounter/index.js:1286` — `faintedWarned` cleared only on a resolve with a survivor.
- `src/encounter/index.js:1622-1627` — `cancel()` clears `active`, ends the scene, unpauses; it
  touches the party not at all. `src/travel/index.js:130-132` is its only caller.
- `src/pokemon/index.js:393,408` — `heal` refuses a fainted member without `{revive:true}`;
  `reviveAll()` had exactly one caller in `src/`.
- `src/hunts/index.js:184-204` — the lap rest's header names this bug ("a wiped party walks its
  circuit forever meeting nothing") and its heal call omits `revive`.
- `src/terrain/index.js:69-73` — `handle()` returns `{ id, … }`, so the comment at
  `src/offline/slices.js:153` claiming `restorePlayer` always bails is **stale**; measured, the
  restore fires and is harmless (probe B below).
- `src/ui/theme.js:170-176` — the five toast kinds; `good` exists.

## Files / modules affected

`src/encounter/index.js`, `src/hunts/index.js`, `src/city/index.js`,
`tests/flows/hunt-recovers.spec.js` (new), `ARCHITECTURE.md` §4/§5.6/§5.13, `docs/DECISIONS.md` #81.

## Expected behaviour

- Every `wipe()` charges `WIPE_PENALTY`, calls `reviveAll()` and emits `party:wiped` — not only
  the first in a streak.
- A completed lap revives a fainted member to `config.lapHealFraction` of max.
- `city.enter()` heals a hurt or fainted party and toasts `good`, silently when nobody needed it
  and never under `config.showcase`.
- A fainted party walking a slot logs one `warn` and toasts once per streak instead of nothing.

## Acceptance criteria

- `npx playwright test tests/flows/hunt-recovers.spec.js` — four cases green.
- The three recovery cases each fail on the pre-change tree, for their own reason (proved: the
  second wipe emits no `party:wiped`; a lap does not revive; the city does not heal).
- `npm run gate` green, `regress` unmoved.

## Tests required

`tests/flows/hunt-recovers.spec.js`: *a wiped party is revived every time, not only the first* ·
*a lap of the circuit brings a fainted party back and the hunt resumes* · *the city heals, so a
party fainted outside a resolve is never stranded* · *a hunt entered the way a player enters it
produces a battle* (the control `hunt.spec.js` never covers, since `?scene=` bypasses `travel.go`).

## Verification in the real application

Diagnostic probes run before the fix, at seed 1337, driving `__HOOKS__`:

| probe | result |
| --- | --- |
| A — fresh save, city → travel → meadow | fights after 7 tiles. Not broken |
| B — saved in the hunt, reloaded | fights; identical walk to A. `restorePlayer` is harmless |
| C — all-fainted party | **89 tiles entered, 79 distinct, past a full 78-cell lap, no fight** |
| F — two forced wipes | #1 `party:wiped`, revived, ₽100,000 → ₽90,016. #2 **no event, no toll, party left 0/21 0/19 0/22, `firstConscious()` null** |

In the browser: `/`, travel to the meadow, and lose twice. Before, the second wipe stranded the
save for good; after, both revive.

## Docs to touch

ARCHITECTURE §4 (`ui:toast` emitters gain `city`), §5.6 (a wipe always revives), §5.13 (`city`
emits `ui:toast`, `enter()` heals). DECISIONS #81. STATUS: no entry closes.

**The adversary pass found a fourth loop and one out-of-scope gap.**

- **Closed here.** A save whose `hp` is not a number deserialized to `NaN`, which is neither
  conscious nor hurt — the one combination all three nets decline. Measured in a browser: a full
  lap and a round trip to the city with the party still `[NaN, NaN, NaN]`, 0 encounters, 0 errors,
  one nag. `src/pokemon/instance.js` `deserialize` now reads `level`, `exp` and `hp` through a
  finite check, pinned by `src/pokemon/instance-save.test.js` (7 cases). Writing that guard first
  broke `hp: null`, which must still mean "absent, so full" — the test caught it.
- **Filed, not fixed.** `idle-exp-lost-on-fainted-party`: a hidden tab hands `gains.exp` to
  `grantPartyExp`, which filters conscious members, so a party that enters a hidden gap
  unconscious banks nothing while `totals()`, the digest and the away card all report the full
  amount (measured: 66,739 exp over 57 encounters, party exp unchanged). The sibling of
  `closed-tab-exp-discarded`, and `idle`'s to fix.
- **Also worth knowing, not filed.** `src/offline/save.js` validates the checksum only
  `if (typeof parsed.h === 'string'`, so a save with no `h` skips it entirely; every write stamps
  one, so that branch has no legitimate producer. And `hunts.loop()` defaults to `'forest'` when
  called outside a hunt, which makes `lapBound`'s failure message misleading there.

**What could not be broken:** the four flow cases at seeds 1, 42, 99, 20260911 (16/16, and the
seeds do move the world — species and loop length both change); the `battle:ended` → `resolve()`
window is a constant 70 ticks at all five seeds, fourteen times the spec's chunk, so `forceWipe`
cannot miss it by alignment; fourteen `?break=` quarantines heal with zero console errors, and the
redundancy pays for itself — `?break=encounter` costs the lap net and the city covers, `?break=city`
and `?break=hunts` each lose one and the other covers; twelve showcases leave `pokeidle.save`
byte-identical, and `city.enter()` under `?showcase=city` on a damaged party leaves it damaged;
`?scene=hunt-forest|coast|cave` all revive on their lap.

## Out of scope

`encounter.cancel()` running the wipe — rejected in #81 for the `travel.go` re-entrancy; the city
heal makes that path recoverable instead. `travel-mid-encounter-silent`'s prompt is its own slice.
The stale comment at `src/offline/slices.js:153` is corrected but `restorePlayer` is left alone —
measured harmless. The user's wider spec (move priority, the money rule, a sell screen, visible
combat) is the ranked list in the plan, one slice each.

## Result

`npm run gate` — **every stage passed, 187.2 s**: lint 2.1 · typecheck 0.4 · seams 1.4 · unit 0.6 ·
build 3.5 · coldboot 4.1 · boot 75.2 · flows 12.4 · parity 31.0 · regress 56.5.

**`regress`: 0 improved, 0 regressed, 0 moved, across 17 frames** — no baseline re-accept. Both new
toasts are structurally unreachable in the MATRIX, and that is reasoned, not lucky:

- the **city** toast — `heal()` returns first under `config.showcase`, which covers the three
  `city/*` rows; `boot/12` is a plain `/` boot where it does run, but a fresh party is undamaged
  (`status` defaults to `null`, `src/pokemon/instance.js:68`) so `hurt` is empty and it never emits;
- the **fainted-party** toast — it fires from `slotNear`, which needs `armed`, and `armed` is false
  in every other module's showcase (`src/encounter/index.js:215`). The seven `hunts/*` rows and the
  three `encounter/*` rows therefore cannot reach it, and `boot/12` is the city, which has no slots.

Nothing was left out. The three recovery cases were each run against the pre-change tree first —
`git worktree` at `0d9dfb2` — and each failed for its own reason: the second wipe emitted no
`party:wiped`; a lap did not revive; the city did not heal. The fourth (city → travel → a battle)
passed on both trees, which is correct: that path was never broken. Re-run after the review changes
below, still 3 failed / 1 passed.

**Review found seven things worth changing, all applied:**

- a lap revive now clears status (`src/hunts/index.js`). A faint cures nothing — the engine never
  nulls `status` on a KO and writeBack copies it back — so a member revived by a lap came back at
  34 % still poisoned and took residual chip on turn one, back towards the wipe the rest prevents.
  Every other revive in the game clears it.
- `src/pokemon/instance.js`'s header said `revive: true` had exactly one legal caller, the Pokémon
  Center. This commit adds the second and third; the header now names all three and what each
  clears. DECISIONS #81 quoted the old sentence as corroboration and no longer does.
- `ARCHITECTURE.md` §5.14 said the lap heals "each conscious member" — corrected; §5.6's
  `slotsNear` line now records the warn and toast.
- DECISIONS #81 was cited from no code at all, against CLAUDE.md. `city` and `encounter` now cite
  it where the three overlapping nets are, saying the redundancy is the decision.
- #81 described `instance.js`'s numeric branch as setting rather than adding. It adds; it lands on
  the lap fraction only because the member is at 0. Corrected, and #81 now names #67 as amended.
- "an outflow, so the money rule is untouched" was false reasoning for a true conclusion — the heal
  is free, so it is neither. Restated: the rule constrains income and this mints nothing.
- the flow spec marked positions with `events().length`, which filters `perf:sample` *before*
  measuring while `at` is stamped from the unfiltered log — a drift of one per wall-clock second
  that could make an `after:` mark admit an earlier event and go vacuous on a slow machine. It now
  reads `__EVLOG__.length` directly. One over-claiming comment about the save was corrected too.

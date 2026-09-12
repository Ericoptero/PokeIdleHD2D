# 018 — a tail on the balloon, the move coloured by type, damage that floats

Status: done                 Branch / commit: Ericoptero/hunt-battle

## Why
The user asked that speech/attack balloons carry an arrow pointing at the speaker, that the
attack's own name be coloured by its type (explicitly not the whole balloon), and that damage
appear over the monsters MMORPG-style. No STATUS entry; new direction from the user, decided in
this session, building on the type/shape fields slice 017 added to `battle:strike` for exactly
this reason.

## Inspected before writing this slice
- `src/ui/callout.js` (whole file, pre-slice) — the existing balloon: one per side, a fixed
  `LIFT = 3.1`, a lean for separation, `panel()` for the box, one `text` call.
- `src/ui/index.js:198-214` (pre-slice) — the `battle:strike` listener: `at` resolved from
  `sim.player()` for side 'a' (the trainer) and `enc.scene()?.at` for 'b'.
- `src/battle/types.js` — `TYPES`, `CHART`, `effectiveness`; no colour anywhere. Four
  independent type-colour copies found by grep: `encounter/strikes.js`'s `ELEMENT`,
  `ui/panels/dex.js`'s `TYPE_COLOUR`, `idle/panel.js`'s `TYPE_COLOURS`,
  `collection/showcase.js`'s `TYPE_COLOUR`.
- `src/encounter/strikes.js:126-145` — `ELEMENT`'s `{C, E}` hexes, the ones `TYPE_INK`'s
  `core`/`edge` are copied from verbatim; confirmed this file is the target of the *next* slice
  (a shader VFX rewrite) and left untouched rather than refactored twice.
- `src/ui/theme.js:93-103` — the `EMISSIVE` set and `applyLight`'s mechanism; confirmed
  `TYPE_INK` living in `battle/types.js` is never touched by it (the plan's assumption that it
  would need adding here was wrong — see Result).
- `src/ui/screen.js:201-222` — `text()`'s exact draw loop, the basis `textScaled` copies.
- `src/ui/plates.js` (post-016/017) — `POKEMON_LIFT`/`TRAINER_LIFT`, the constants this slice
  exports and reuses so a balloon/floater anchors above the plate rather than through it.
- `src/simulation/index.js:487-500` — `follower()`'s exact fields (the ally's own Pokémon
  position, distinct from `player()`, the trainer's).
- `src/ui/panels/battle.js:42-58` — `STATUS_NAME`, exported; reused by the status floater.
- `public/generated/moves.json` — checked accuracy across the meadow/forest learnsets, not just
  the opening trio (see Out of scope for what this actually found and why no live miss/immune
  flow test was attempted anyway).

## Files / modules affected
New: `src/ui/floaters.js`, `src/ui/floaters.test.js`, `src/ui/callout.test.js`,
`tests/flows/balloons-and-damage.spec.js`, `tests/flows/balloon-effects-real-fight.spec.js`.
Changed: `src/battle/types.js`, `src/battle/index.js`, `src/battle/selftest.js`,
`src/ui/callout.js`, `src/ui/index.js`, `src/ui/screen.js`, `src/ui/plates.js` (exports),
`src/ui/panels/dex.js` (its own `TYPE_COLOUR` copy replaced by `battle.typeColour`, found
missing by review — see Result), `ARCHITECTURE.md`, `docs/DECISIONS.md`.

## Expected behaviour
- A balloon carries a small tail pointing at its speaker's true projected position, even when
  the box itself leans aside for separation from the other side's balloon.
- Only the move's name inside a balloon is coloured by its type; the balloon's own paper is
  unchanged. A struggle (no real type) prints in the ordinary ink.
- A real fight drops a floater over the *target*: `-N` for damage (tinted by effectiveness,
  doubled in size on a crit), `MISS`/`IMMUNE` for either, a status abbreviation for a pure
  status hit.
- The ally's balloon still hangs over the trainer (unchanged from before); the ally's *floater*
  hangs over the ally's own Pokémon, since that is what is actually hit.

## Acceptance criteria
- `npm run gate` exits 0.
- `node src/battle/selftest.js` green, 61–66 passing: eighteen colour triples, core brighter
  than edge, every `ink` clears 4.5:1 against `C.wallLight`, the fallback and identity checks.
- `npx vitest run` green, including the two new pure suites.
- `tests/flows/balloons-and-damage.spec.js` passes: a real damaging strike's balloon `ink`
  matches `battle.typeColour(type).ink`, and a matching `-N` floater exists on the target.
- Screenshots looked at: a balloon's tail is visible and points at the speaker; a grass move's
  name reads visibly green against the balloon's cream paper; a damage number sits clear of the
  target's plate, not printed across its HP bar.

## Tests required
- `src/battle/selftest.js` #61–66 — `TYPE_INK`'s pure contract.
- `src/ui/floaters.test.js` (new, 11 cases) — lifecycle, rising, crit scale via `textScaled`,
  clamping, off-screen skip.
- `src/ui/callout.test.js` (new, 8 cases) — replacement, two-tone text, the tail's position
  under a lean, a struggle's fallback ink.
- `tests/flows/balloons-and-damage.spec.js` (new) — the real-fight property both of the above
  cannot reach: that a genuine `battle:strike` actually arrives at both files with the right
  content.
- `tests/flows/balloon-effects-real-fight.spec.js` (new, from the tester's independent pass) —
  what the above still missed because it only ever grabs the *first* damaging strike, which on
  this seed is deterministically side `'a'`, non-crit, neutral: the `attacker === 'b'` branch of
  the position split (wild's balloon on itself, its floater on `sim.follower()`, never the
  trainer), a real crit's 2× floater scale, and effectiveness-tinted floater colour, all driven
  through a genuine `battle:strike` rather than a direct `floaters.push()`.

## Verification in the real application
`?scene=hunt-meadow&seed=1337`, stepped into a fight: a screenshot at the first damaging strike
showed `-8` in red above `Oshawott Lv 5`'s plate (a first cut printed it directly across the HP
bar instead — fixed by raising the floater's spawn point by the same clearance the balloon
uses), and `Oddish: Absorb!` with `Absorb!` in a visible grass-green distinct from `Oddish:`'s
ordinary ink, a small tail connecting the balloon to Oddish.

## Docs to touch
ARCHITECTURE §5.12 (balloons/floaters paragraph), §5.17 (`typeColour`), DECISIONS #90.

## Out of scope
The VFX rebuild (019) — `encounter/strikes.js`'s own palette is untouched, on purpose (see
Inspected). No live flow test for a miss or an immune hit: the roster is *not* uniformly 100%
accurate (`mudshot` 95, `rollout`/`wrap` 90, the powder moves 75, `hypnosis` 60, `sing`/
`supersonic` 55 — real learnset entries in this band), but `battle.choose()`'s expected-damage
ranking, not a fixed script, decides which move a given matchup throws, so pinning a guaranteed
miss would mean scripting a specific species/level/move triple and accepting either a real
(if small) chance the RNG hits anyway or a step budget spent hunting for a miss that might not
land in time — judged not worth this slice's scope. That branch of `ui/index.js`'s listener is
covered by `floaters.test.js`'s direct push of the same text and by inspection instead.

## Result
`npm run gate` green in 430s pre-review (lint 2.5s, typecheck 0.4s, seams 1.5s, unit 0.9s,
build 3.7s, coldboot 3.8s, boot 104.1s, flows 108.3s — 27/27 including
`balloons-and-damage.spec.js` — parity 87.3s, regress 118.0s: 2 improved (`boot/12`, carried
over unchanged from slice 017, unrelated to this one), 0 regressed, 0 moved across 18 frames —
no `--accept` needed. Re-run green after the review fixes below (367.8s, tester's own run with
the two new flow tests added: 29/29 flows, same regress result). `node src/battle/selftest.js`
67/67. `npx vitest run` green including the 19 new pure cases (`floaters.test.js` ×11,
`callout.test.js` ×8).

Two real bugs found and fixed during implementation, both logged in DECISIONS #90: the tail was
first drawn before the panel's own drop-shadow and got overwritten by it; the floater's spawn
lift matched the plate's own, so a damage number rendered directly across the target's HP bar
until `BALLOON_CLEARANCE` was added to its lift too.

**Review found three documentation bugs, all fixed in this commit:**
1. ARCHITECTURE §5.17 claimed a floater's *crit tint* reads `typeColour` — it does not; a
   floater's colour is by effectiveness only (`C.roofShadow`/`C.shadowInk`/`C.ink`), never by
   type. Corrected.
2. DECISIONS #90 claimed `dex.js` already read the canonical `TYPE_INK` table — it had not been
   touched. Since `dex.js` is a live, reachable panel (`Digit4`), not a showcase surface, this
   was a real miss rather than a defensible scope cut: fixed for real, not just in the doc —
   `dex.js`'s own `TYPE_COLOUR` copy (a fourth independent table) is deleted, its type-completion
   bar now reads `battle.typeColour(t).edge` through the same undeclared `isLive`-guarded access
   `ui/index.js` already uses for `battle`.
3. Both DECISIONS #90 and this slice's own "Out of scope" claimed every move the meadow/forest
   roster can throw is 100% accurate — false on its face (`mudshot` 95, `rollout`/`wrap` 90, the
   powder moves 75, `hypnosis` 60, `sing`/`supersonic` 55 are all real learnset entries in this
   band). The conclusion (no live miss/immune flow test) still holds, but for the real reason:
   `battle.choose()`'s expected-damage ranking, not a fixed script, decides which move a given
   matchup throws, so pinning a guaranteed miss needs a scripted species/level/move triple this
   slice didn't build — not a uniformly-accurate roster. Both documents corrected.

**Tester found three real gaps in real-fight coverage**, all from the same root cause: the
implementer's own `balloons-and-damage.spec.js` grabs only the *first* damaging strike, which on
`seed=1337`/`hunt-meadow` is deterministically side `'a'`, non-crit, neutral — so the `'b'`-side
position split, a real crit's 2× floater scale, and effectiveness-tinted floater colour were
exercised by no real fight, only by fake-painter unit tests that never go through
`ui/index.js`'s actual listener. Confirmed by mutation (each of the three bugs the tester
injected — swapping the target position source, forcing `scale: 1`, swapping the two
effectiveness colours — passed the existing suite and failed the new one, then were reverted).
Fixed by keeping the tester's new `tests/flows/balloon-effects-real-fight.spec.js` (2 tests) as
permanent coverage rather than a throwaway. The struggle-fallback and floater-clamping
acceptance criteria were checked and judged adequately covered by the existing unit tests alone
— neither is reachable in a bounded real fight (a struggle needs every move's PP exhausted; a
floater near a screen edge needs a contrived camera position), so no test was added for either.

Final full gate green after all fixes (dex.js, both doc corrections, the promoted test file):
376.3s, lint/typecheck/seams/unit/build/coldboot/boot/flows/parity/regress all `ok`, 29/29
flows, same 2 improved/0 regressed/0 moved regress result.

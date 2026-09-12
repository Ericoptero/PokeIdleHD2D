# 017 — one action at a time

Status: done          Branch / commit: Ericoptero/hunt-battle

## Why
The user asked that a battle have a delay between actions in the correct order, and that the
enemy and the trainer's Pokémon never use attacks at the same time. `docs/STATUS.json`'s
`turnsteps-dead` entry names the exact mechanism that made this true: `stepDuel` called
`run.step()` once every 24 sim steps and emitted every strike the turn produced in the same
tick, so two `battle:strike`s in a turn where both sides acted always landed together.

## Inspected before writing this slice
- `src/encounter/index.js:459-506` (pre-slice) — `stepDuel`: one `run.step()` per `T.TURN`
  (24), then a `for` loop emitting every strike from that call in the same tick; `hold` summed
  `T.ITEM`/`reviveSteps()` across every item strike into one number for the whole turn.
- `src/battle/engine.js:11-25,309-351` — `turn()`'s draw-order contract (priority, then speed,
  then a coin, drawn first and always) and that it already returns both sides' events, in that
  order, from one call — nothing here needed to change.
- `src/battle/strike.js` (whole file) — `strikesOf`'s `Strike[]` is already in engine order;
  `move`/`name`/`cause`/`use` are exactly the fields a beat needs to time itself.
- `src/core/config.js:183-192` — `turnSteps: 24`, documented and unread (STATUS
  `turnsteps-dead`); no other key references it.
- `src/ui/index.js:194-210` — the `battle:strike` listener: one balloon per `side`, replacing
  rather than stacking. Confirmed it needs no change — sequencing the emission is sufficient to
  stop both balloons popping together; `CALLOUT_STEPS` (22) outliving one `actionSteps` (18)
  beat means they can still overlap briefly near the handoff, which is expected and left to 018.
- `docs/STATUS.json` `turnsteps-dead` — the entry this slice closes.

## Files / modules affected
New: `src/encounter/beats.js`, `tests/flows/action-pacing.spec.js`. Changed:
`src/encounter/index.js`, `src/encounter/selftest.js`, `src/core/config.js`, `ARCHITECTURE.md`,
`docs/DECISIONS.md`, `docs/STATUS.json`.

## Expected behaviour
- In a real fight, two strikes belonging to the same turn are emitted on different sim ticks,
  `config.actionSteps` (18) apart for an ordinary blow, `T.ITEM`/`reviveSteps()` for an item.
- Every `battle:strike` carries `type` and `shape` — the move's element and delivery, `null`
  for a strike with no move (residual, swap).
- Each strike that carries a move gets its own VFX window; a strike with none clears whatever
  the previous one armed.
- The fold (`idle`/`offline` via `encounter.pure()`) is untouched: it never read `T`/`config`
  for pacing and does not start now.

## Acceptance criteria
- `npm run gate` exits 0.
- `node src/encounter/selftest.js` green, with the new #24 section (`planBeats`) passing:
  order preserved, `at` strictly increasing, an item/revive beat differs from an ordinary one,
  an empty turn plans to nothing, no mutation of the input.
- `grep -n "turnSteps\|T\.TURN\b" src/encounter/index.js src/core/config.js` → no hits.
- `tests/flows/action-pacing.spec.js` passes: a real fight's two-strike turn measured with a
  gap ≥ `actionSteps - CHUNK` sim ticks, tracked by counted stepping rather than the bus log's
  own array index.
- `tests/flows/hunt.spec.js`, `field-encounter.spec.js`, `hunt-recovers.spec.js` unaffected —
  no tick-budget increase needed (checked; the common case is a one-strike turn).

## Tests required
- `src/encounter/selftest.js` #24 — `planBeats`'s pure contract: order preserved, `at` strictly
  increasing, item/revive vs. an ordinary beat, an empty turn, no mutation of the input, and
  (added on review) a non-`'revive'` `use` still gets `itemSteps` and a zero/negative
  `actionSteps` from a URL override still produces a positive, strictly-increasing timeline.
- `tests/flows/action-pacing.spec.js` (new) — the property end to end, in real sim ticks, for
  the first two-strike turn a real fight produces.
- `tests/flows/action-pacing-deep.spec.js` (new) — the properties the file above stops short
  of: every consecutive pair across a *whole* fight, not just the first pair; a real
  `automation` auto-heal item use measured against `T.ITEM`, not `actionSteps`; a forced
  three-strike turn (lead dropped to 1 HP so a hit both faints and swaps in the same
  `run.step()`) with every pair in it checked, not only the first.

## Verification in the real application
`?scene=hunt-meadow&seed=1337`, stepped with `__HOOKS__.step()` into a fight where both sides
act: `encounter.scene().vfx` and the battle card's own transcript line up one blow at a time,
never two in the same frame. Confirmed live via a temporary instrumented capture (not checked
in): a two-strike turn's strikes landed 18 ticks apart, each carrying its own `type`/`shape`
(`{attacker:'a', move:'Tackle', type:'normal', shape:'contact'}` then the wild's own).

## Docs to touch
ARCHITECTURE §2.6 (`actionSteps` replaces `turnSteps`), §5.6 (the stepping description, the
`battle:strike` payload gains `type`/`shape`), DECISIONS #89, STATUS (`turnsteps-dead` closed).

## Out of scope
The VFX themselves (019) and the balloon/damage-number redesign (018) — this slice only changes
*when* a strike reaches the bus, not what is drawn for it. The brief momentary overlap between
two balloons near a beat handoff (`CALLOUT_STEPS` 22 vs `actionSteps` 18) is left for 018, which
redesigns the balloon anyway.

## Result
Round 1 landed the module (`beats.js`, `tickDuel`/`emitStrike`, `actionSteps`) and passed a full
`npm run gate` at 261 s, 23 flow specs, regress unchanged (the one `boot/12` move is identical
to the previous two slices' and unrelated to this one — nothing here touches a captured frame).

`reviewer` and `tester` were dispatched in parallel as usual, and **both were killed mid-review
by a session-wide rate limit** (`HTTP 429`, reset at a fixed time) — a platform condition, not a
finding about this diff. Neither filed a report; re-dispatching immediately risked the same
limit, so the highest-risk items from both agents' own briefs were checked directly instead:

- **Mid-drain cancellation.** `cancel()` nulls `active` and `scene` without ever copying the
  in-progress `active.battle.transcript` into `last` (which `api.transcript()` actually reads).
  So a `cancel()` fired while a turn's plan is half-drained does leave some of that turn's
  `battle:strike` events un-emitted — but the object holding them is discarded in the same call
  and nothing published anywhere ever reads it again. Considered and left alone: unlike slice
  016's `cancel-races-spawn-actor` (a leaked, *observable* sprite), this has no observable
  consequence for anyone to hit — filing a STATUS entry for a discarded object with no reader
  would be noise, not a bug report.
- **`endFight`'s four call sites** (all inside `tickDuel`) are each idempotent
  (`endFight` itself guards on `Number.isFinite(s.fightEndsAt)`) and the `run.over`-before-any-
  plan check is the same defensive fallback the old `stepDuel` already had, preserved rather
  than added.
- **`planBeats` edge cases** — a non-`'revive'` `use` (`undefined`, `null`, `'heal'`) correctly
  falls to `itemSteps`; `actionSteps: 0` and `actionSteps: -5` both still produce a positive,
  strictly-increasing timeline (`Math.max(1, …)` per beat). Added to selftest #24.
- **The item/revive strike shape** (`strike.cause`, `strike.use`) is unchanged by this slice —
  `battle/selftest.js` checks 49–52 already pin `applyAction`'s `kind`/`use` fields, which
  `strikesOf` reads verbatim, so the wiring `planBeats` depends on was already load-bearing and
  already tested before this diff touched anything.
- **Stability**: `tests/flows/hunt-recovers.spec.js` (three fights per run, the scenario most
  likely to compound a pacing slowdown) run three more times, 15 test executions, all green.
  `action-pacing.spec.js` run 9 times total (once by `tester` before the rate limit, 4 more here,
  4 more once promoted alongside `action-pacing-deep.spec.js`), all green.
- **A genuinely deeper spec `tester` had already written and partly run before being cut off**
  (`tests/flows/_tmp-deep-pacing.spec.js`, left in the worktree, its own header marked
  throwaway) covered exactly the gaps `action-pacing.spec.js` leaves — whole-fight consistency,
  a real item beat, a real 3-strike turn. Run to completion: 2 of 3 passed immediately, the
  third (the item-beat check) failed because it only compared strikes *within the same turn*,
  and an item is often the only strike its own `between()`-driven turn produces — fixed to
  compare against the next strike in overall order, whichever turn it lands in, and promoted to
  `tests/flows/action-pacing-deep.spec.js` rather than deleted, since it closes real coverage
  this slice would otherwise have shipped without.

Final `npm run gate`, clean tree, with both promoted tests in the `flows` stage: **every stage
passed (303 s)** — lint 2.5s, typecheck 0.5s, seams 1.5s (167 files), unit 0.9s, build 3.6s,
coldboot 4.0s, boot 93.7s (24/24), flows 80.9s (**26 specs**), parity 36.4s, regress 78.8s (**2
improved, 0 regressed, 0 moved**, across 18 frames — identical to slices 015/016's own
`boot/12` move, unrelated to this slice).
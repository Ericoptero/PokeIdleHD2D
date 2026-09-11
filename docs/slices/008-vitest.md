# 008 — Vitest and the `unit` gate stage, with the deadlock as the first test

Status: done          Branch / commit: workflow-harness

## Why
The `selftest.js` files are the correctness layer and stay under the seams, but they are
hand-rolled (four assertion shapes, two exit conventions) and have no diffs, fixtures or watch
mode. New fine-grained tests need a runner. The first test states the audit's headline finding
behaviourally so it cannot be argued with: a fresh save cannot mint the currency every
automation costs.

## Inspected before writing this slice
- `src/idle/accrual.js:432-534` — `simulate(state, elapsedS, seed)` returns `research`, `wins`,
  `wholeEncounters`, `flags`; `:369` `if (!prod.flags.battle) win = false`.
- `src/idle/selftest.js:22-36` — the state shape `simulate` wants (party with `species.baseStats`,
  biome, unlocks, tables, balls, progress).
- `src/idle/index.js:257-259` — research is paid out as `tokens`; `src/economy/currencies.js:60-63`
  aliases it. A static grep for `add('research'` would miss it, hence a behavioural test.
- `tools/seams/run.js:47-62` — rule 2 walks every `.js` under `src/`, tests included.
- vitest 5's `engines` is `^22.12 || ^24`; this repo is Node 20.19.3 → `vitest@^4`.

## Files / modules affected
`vitest.config.js` (new), `src/idle/unlock.test.js`, `src/automation/pricing.test.js`,
`src/economy/currencies.test.js` (new), `tools/gate.js` (stage `unit`), `package.json`.

## Expected behaviour
`npx vitest run` runs the three files: 7 pass, 1 expected-fail (`it.fails`, token
`STATUS:research-unmintable`). The gate runs `unit` after `seams`; `gate:fast` includes it.

## Acceptance criteria
- `npx vitest run` exits 0 with "1 expected fail"; the failing body, run outside `it.fails`,
  fails on `research` being `0` (recorded below), not on a TypeError.
- A plain failing test exits 1 (probed with a temporary `src/_probe.test.js`: exit 1).
- `npm ls vite` shows one deduped 8.2.2; `npm run seams` still passes (tests obey rule 2).
- `npm run gate:fast` = lint, seams, unit — green.

## Tests required
The three files above.

## Verification in the real application
Not applicable until P1; the flow that would show it (`economy.spec.js`) can only time out
today and is written red-first in that slice.

## Docs to touch
STATUS.json gains the `research-unmintable` open entry with `id` and `test` (slice 9 adds the
rule that enforces the pairing; slice 3 rewrites the file).

## Out of scope
Migrating selftests; a shared assertion helper.

## Result
The first draft was one file importing `automation/automations.js` and `economy/currencies.js`
from `src/idle/` — and the seams refused it (rule 2), exactly as they should: a test in one
module may not reach into another's internals either. Split into three files, one per module,
each stating its half of the loop. Measured: a fresh save folds 94 encounters in an hour and
wins 0, research 0; with `auto-battler` the same seed wins 70 and mints 43.65 research.
gate:fast: lint 2.2 s, seams 1.4 s, unit 0.6 s.

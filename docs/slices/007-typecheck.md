# 007 — Typecheck: opt-in `// @ts-check` over JSDoc, zero errors always

Status: done          Branch / commit: workflow-harness

## Why
No type checking existed; the audit's feasibility probe counted 467 JSDoc tags, 0 `@ts-check`
pragmas, and predicted "dozens to low hundreds" of errors non-strict and thousands strict. An
opt-in ratchet gets the value without a mass-annotation project: a file that is checked stays
checked, and the bar is zero errors.

## Inspected before writing this slice
- `three@0.185.1` ships no `.d.ts`; `@types/three@0.185.4` matches.
- `vitest@5` needs Node 22 (slice 8); `typescript@7.0.2` (the native port) installed and
  `tsc -p` runs the config in 0.4 s.
- `src/main.js:511,537,650` — the window globals the harness relies on, for `types/globals.d.ts`.

## Files / modules affected
`tsconfig.json`, `types/globals.d.ts` (new); `// @ts-check` added to `src/core/*.js` (8 files),
`src/battle/*.js` (6), `src/offline/migrations.js`, `src/economy/currencies.js`; JSDoc-only
corrections in `core/bus.js`, `core/registry.js`, `battle/engine.js`, `battle/strike.js`,
`economy/currencies.js`; `tools/gate.js` (stage `typecheck`), `package.json`.

## Expected behaviour
`npx tsc -p tsconfig.json` exits 0; the gate runs it second; `gate:fast` includes it.

## Acceptance criteria
- Zero errors on the tree (was 55 across 6 of the 16 opted-in files on first run).
- A JSDoc/usage mismatch appended to `src/core/rng.js` makes it exit 1 (probed: exit 1).
- lint, seams, unit unaffected; `npm run gate:fast` = lint, typecheck, seams, unit — green.

## Tests required
None new; the stage is the check.

## Verification in the real application
Not applicable (no behaviour change; `economy.currency()` was rewritten to an equivalent form
so `Map.get` is not called with `''`, and `economy/selftest.js` + `currencies.test.js` pass).

## Docs to touch
CLAUDE.md Testing section (slice 11): "opt a file in with `// @ts-check`; never opt one out".

## Out of scope
`strict`, `noImplicitAny`, converting anything to `.ts`, opting in modules beyond these.

## Result
First run: 55 errors, all in JSDoc that described the code imprecisely — `@param {object}` where
a shape was meant, `= {}` defaults inferred as empty types, a `CurrencyId` union returned as
`string`, a `[number, string]` table typed as `(string|number)[]`, an `onError` meta missing
`throws`, and `stepper()`'s `@param` list skipping `seed` and `index` so `opts` bound to the
wrong position. Fixed with a `ModuleDescriptor` typedef (registry), a `BattleState` typedef
(engine), and per-site annotations. One finding the checker surfaced that the audit had only as
a single-agent report: the registry calls `desc.dispose()` with no arguments — the typedef now
says so. Timing: typecheck 0.4 s.

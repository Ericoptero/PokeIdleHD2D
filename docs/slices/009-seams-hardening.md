# 009 — Seams hardening: no vacuous green, events agree, expected failures are tracked

Status: done          Branch / commit: workflow-harness

## Why
`node src/collection/selftest.js` exited 0 having run nothing and the seams counted it green.
Failure text printed with indentation never reached the seams report. A listener for an event
nobody emits compiles and never fires. And an `it.fails` with no owner is how a bug becomes a
permanent expectation.

## Inspected before writing this slice
- `tools/seams/run.js:171-180` (pre-change) — rule 6 spawned each selftest and read only the exit
  code; `:176` harvested `✗` with `startsWith`, so `hunts/selftest.js:763`'s indented `  ✗` was
  invisible.
- `src/collection/selftest.js` — exports `runSelfTest(api, ctx)`, no main guard; `index.js:622`
  is its only caller (the browser showcase).
- What every selftest prints (surveyed): all print ≥ 1 `✓/✗` line or an `N/M` / `all N checks`
  summary — the vacuous-green test flags none of them.
- `src/hunts/palette.js:177` — a JSDoc `{import('../terrain/draft.js').MapDraft}` type
  reference, which a naive dynamic-import rule would flag.

## Files / modules affected
`tools/seams/run.js` (rule 2 dynamic imports + comment stripping; rule 6 vacuous-green +
`trimStart`; new rules 8 and 9), `src/collection/selftest.js` (Node main guard),
`docs/STATUS.json` (the `research-unmintable` entry with `id` and `test`).

## Expected behaviour
See acceptance criteria — each is a probe that was run.

## Acceptance criteria
- `node src/collection/selftest.js` prints its checks and exits by result: **26/26**.
- An empty `src/tiles/selftest.js` fails seams: "exited 0 but printed no ✓/✗ line…" ✓
- `bus.on('encounter:startedd')` fails rule 8: "listens for … and nothing in src/ emits it" ✓
- Removing the STATUS entry while `it.fails` stays fails rule 9 ✓; removing `.fails` while the
  entry stays fails rule 9 the other way ✓ (a leftover token comment does not count).
- The real tree passes: 152 files, 17 modules, all contracts hold; lint clean; gate:fast green.

## Tests required
The probes above (run by hand, recorded here); the rules are their own tests thereafter.

## Verification in the real application
Not applicable.

## Docs to touch
STATUS.json (this slice adds one entry; slice 3 rewrites the file). CLAUDE.md's Testing section
gains the `it.fails` + `STATUS:<id>` convention in slice 11.

## Out of scope
Scanning `tools/` and `src/main.js` for rule 1; a `ctx.get` vs `needs` rule (every module would
fail it today — an app change, not a check change).

## Result
Rule 2's first dynamic-import version flagged the JSDoc type import in `hunts/palette.js`; the
rule now strips comments before scanning, which is also what rule 1 does in spirit. Rule 9's
first version accepted a token left in a comment above a passing test; it now requires a live
`it.fails`/`test.fail` behind every STATUS entry that names a test.

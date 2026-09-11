# 003 — STATUS.json rewritten from what is reproducible today

Status: done          Branch / commit: workflow-harness

## Why
The old `now` was an ~11-sentence run-on that asserted the automations and move VFX were done
and, in its last clause, that they "are not started"; the `baseline` block was a byte-copy of
the archive's 2026-09-08 row; `updatedMs` predated ten commits; `openIssues` was an integer
where §12 showed a list; one `open` entry was history. And it did not mention the bugs the
audit verified, which are the ones an agent picking up work most needs.

## Inspected before writing this slice
Every `open` entry below carries a `repro` (a command or a grep) that was run on this tree;
the line numbers were re-checked after the lint slice moved some (encounter/index.js:1260,
offline/index.js:278, encounter/index.js:264, economy/items.js:251, idle/index.js:107,
core/config.js:193, encounter/index.js:116, :58, economy/index.js:335,
tools/assets/build-tiles.js:25, travel/index.js:40,105,125,132, battle/stats.js:42-43).

## Files / modules affected
`docs/STATUS.json`.

## Expected behaviour
`now` is one sentence; `gate` records the last full run (stage seconds) and points at the live
baseline; `open[]` entries carry `id`, `module`, `what`, `repro`, and `test` where a test pins
them; `modules[]` lists open ids and whether a selftest exists. Seams rule 9 reads `open[].id`
and `open[].test`.

## Acceptance criteria
- Valid JSON; seams green (rule 9 finds `research-unmintable` ↔ `src/idle/unlock.test.js`).
- 15 open entries: 6 carried over (all still reproducible; the environment history entry
  dropped), 9 new from the audit — each with a repro that was run.

## Tests required
None; rule 9 is the check.

## Verification in the real application
Not applicable.

## Docs to touch
ARCHITECTURE §12 describes the new shape (slice 4).

## Out of scope
Fixing any entry. `watched-win-mints-money` needs a decision, not a patch.

## Result
Seams green. The shape change (`gate` replacing `baseline`, `updated` replacing `updatedMs`,
`openIssues` as ids) is documented in ARCHITECTURE §12 in slice 4; nothing in `src/` or
`tools/` reads STATUS.json except seams rule 9, which reads only `open[].id` and `open[].test`.

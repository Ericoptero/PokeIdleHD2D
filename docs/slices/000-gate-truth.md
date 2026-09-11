# 000 — Run the full gate on HEAD and record the truth

Status: done          Branch / commit: workflow-harness

## Why
The audit found `dist/` predating the runtime-asset plugin commit (`a313f39`), so the build stage
had not run on this checkout for twelve commits, and `shots/out/parity` had never been written.
Whether the gate was green was unknown. Everything after this slice assumes a known starting point.

## Inspected before writing this slice
- `tools/gate.js:8` — header says "Five stages" over a six-entry `STAGES` array.
- `tools/gate.js:34-36` — only `--skip` is parsed; no `--only`, no `--list`, no timing.
- `dist/` mtime 2026-09-10 14:55 < `a313f39` 15:26; `dist/assets/overworld` absent.

## Files / modules affected
`tools/gate.js`, `docs/slices/TEMPLATE.md`, this file.

## Expected behaviour
`npm run gate` on `c392dfe` runs every stage; `--list` prints the stages; `--only a,b` runs
exactly those; a stage name that does not exist is refused (exit 2); the summary prints seconds
per stage and a total.

## Acceptance criteria
- Full gate output recorded below; `git status` clean afterwards; `dist/assets/overworld` exists.
- `node tools/gate.js --list` prints six names; `--only nope` and `--bogus` exit 2 with a message.
- `node tools/gate.js --only seams` runs seams only and prints the timing table.

## Tests required
None new — this slice changes the gate's CLI, and the gate is exercised directly above.

## Verification in the real application
Not applicable (tooling only).

## Docs to touch
CLAUDE.md now says `node tools/gate.js --list` instead of restating the stages (slice 1a).

## Out of scope
New stages (lint, typecheck, unit, flows) — slices 6–10.

## Result
Full gate on `c392dfe`, 2026-09-11, real Chrome, GPU: **every stage passed**, 2 min 55 s
wall-clock. So the "likely not green" guess in the plan was wrong: the stale `dist/` meant the
build stage had not been *run*, not that it was broken.

```
seams      149 files, 17 modules, all contracts hold                     ~1.4 s
build      ✓ 146 modules; dist/assets/overworld 1254, trainer 3          ~2.1 s build
coldboot   ready in 0.6 s (budget 6 s), 221 draws
boot       22/22 entry points draw a real frame (17 showcases, 5 scenes)
parity     7 viewports; 32 px/unit, mag 2, k 1 everywhere; worst sprite delta 4 (≤ 8)
regress    0 improved, 0 regressed, 0 moved, across 17 frames
```

One thing the build log exposes and this slice records rather than fixes: `src/encounter/index.js:58`
imports `./selftest.js`, so an 18.7 kB `selftest-*.js` chunk (with `node:fs`, `node:path`,
`node:url` externalised — three rolldown warnings) ships in the production bundle. Filed as a
STATUS `open` entry in slice 3.

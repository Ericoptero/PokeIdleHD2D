# 011 — Gate finish: `--walk`, the pre-commit hook, the roles, and how work is done

Status: done          Branch / commit: workflow-harness

## Why
The stages exist (slices 6–10); this slice makes them the way work is done: the hook that runs
the fast half before every commit, the five role files, the slice template already in use, and
the CLAUDE.md section that replaces ARCHITECTURE §11's "one agent, no critic" rule with the
one the audit showed is needed.

## Inspected before writing this slice
- `tools/shots/parity.js:83,231-277` — `--walk` (two frames one sim step apart, whole-pixel
  translation) exists and `gate.js` never passed it.
- `tools/shots/shoot.js:158-169` — `--hidden` exists; no stage or flow consumes it.
- `.git/hooks` — no hooks; no `.husky`, no `.github`.
- `package.json` — `prepare` is the npm lifecycle script that runs on `npm install`.
- `src/{idle,encounter}/selftest.js` — the browser-safe main-guard idiom
  (`typeof process !== 'undefined'`), which slice 9's collection guard should have used.

## Files / modules affected
`tools/gate.js` (parity stage gains `--walk`), `.githooks/pre-commit`, `package.json`
(`prepare`), `.claude/agents/{implementer,reviewer,tester,integrator,adversary}.md`,
`CLAUDE.md` (stack line, gate paragraph, Testing, How work is done),
`src/collection/selftest.js` (browser-safe guard).

## Expected behaviour
`node tools/gate.js --list` prints ten stages; `git commit` runs `gate:fast` first; every
command an agent file names exists.

## Acceptance criteria
- `--list`: lint typecheck seams unit build coldboot boot flows parity regress ✓
- `ls .claude/agents/*.md | wc -l` = 5, each with `name:` and `description:` frontmatter ✓
- `git config core.hooksPath` = `.githooks`; this slice's own commit ran the hook.
- Full gate green with the ten stages (table below).
- `parity --walk`: "the frame translated by whole pixels and resampled nothing — offset (0, 4),
  96.95 % of 65120 px" ✓

## Tests required
None new.

## Verification in the real application
The full gate's boot, flows, parity and regress stages.

## Docs to touch
CLAUDE.md (this slice). ARCHITECTURE §11/§12 are rewritten in slice 4.

## Out of scope
`--hidden` — the backgrounded-tab path gets its own flow (`tests/flows/idle.spec.js`) in a
later slice; CI.

## Result
The first ten-stage run failed at `boot`: `?showcase=collection` quarantined the module with
"process is not defined" — slice 9's Node main guard read `process.argv` at module scope and
the browser showcase dynamically imports that file. `gate:fast` cannot see the browser; `boot`
can, and did. Fixed with the `typeof process` idiom the other selftests already use.

```
lint       ok        2.2s
typecheck  ok        0.4s
seams      ok        1.4s
unit       ok        0.6s
build      ok        3.4s
coldboot   ok        4.3s
boot       ok       78.3s   (22/22 after the fix; 77.5 s FAILED before it)
flows      ok        6.4s
parity     ok       31.8s   (with --walk)
regress    ok       57.2s   (0 moved across 17 frames)
total              ~186 s
```

# 006 — ESLint and the `lint` gate stage

Status: done          Branch / commit: workflow-harness

## Why
No linter existed; the audit's feasibility probe counted unused imports, an import cycle and a
`return true || …` by hand. Undefined names and dead bindings are the class of defect a
screenshot cannot see and a selftest only sees by accident.

## Inspected before writing this slice
- `tools/seams/run.js:31-62` — rules 1–2 (Math.random, deep imports) stay there; lint must not
  restate them.
- `tools/shots/shoot.js:145-149,182-184` — `page.evaluate` bodies use `window`, `document`,
  `requestAnimationFrame` inside a Node file, so `tools/shots/**` needs both global sets.
- `src/idle/worker.js` — a dedicated worker (`self.postMessage`).
- 49 `== null` sites, all the nullish idiom → `eqeqeq` with `null: 'ignore'`.
- `src/offline/save.js:102` — `const { h, ...rest } = obj` names `h` to exclude it →
  `ignoreRestSiblings`.

## Files / modules affected
`eslint.config.js` (new), `tools/gate.js` (stage `lint`), `package.json` (`lint`, `gate:fast`),
and 31 files with behaviour-neutral fixes (list in Result).

## Expected behaviour
`npx eslint .` exits 0; the gate runs it first; `npm run gate:fast` = `--only lint,seams` today.

## Acceptance criteria
- `npx eslint .` exits 0 on the tree.
- A file with one unused import exits 1 (probed with a temporary `src/_lintprobe.js`: exit 1).
- `npm run gate:fast` passes; `node tools/gate.js --only build,coldboot,boot` passes after the
  source edits (22/22 entry points).
- `npm run seams` still passes (rules 1–2 are not duplicated in ESLint).

## Tests required
None new; the stage is its own check.

## Verification in the real application
`--only build,coldboot,boot` above: every showcase and scene still draws a real frame.

## Docs to touch
CLAUDE.md "How work is done" (slice 11) names `gate:fast`.

## Out of scope
`no-unused-vars` at `warn`; Prettier; any rule that restates a seam.

## Result
First run: 47 errors, 1 warning — 43 `no-unused-vars`, 1 `no-unreachable`
(`pokemon/selftest.js` try/catch whose catch could never run), 1 `no-constant-binary-expression`
(`ui/callout.js tick()` returned `true || …`; now returns `true` with a comment saying why a live
callout is always a changed frame), 1 `no-useless-escape`, 1 unused disable directive, plus
`index.html` (not lintable; dropped from the file set). All fixed without changing behaviour:
unused imports and pure locals removed; unused parameters prefixed `_`; `encounter/selftest.js`
lost `s0`, a value the comment already said was retired and that nothing asserted; two
`loadScenario` calls in `offline/showcase.js` kept for their side effect with a note that their
results are not shown. Gate: lint 2.0 s, seams 1.4 s, build+coldboot+boot 87 s, all green.

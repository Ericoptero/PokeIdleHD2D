# 005 — Repo meta hygiene and the retired judge tooling

Status: done          Branch / commit: workflow-harness

## Why
The audit's repo-meta pass found stale prose and dead entries in the config files an agent reads
first, plus a retired tool (`tools/judge/`, the blind-A/B packet builder for a review loop that no
longer runs) and four reference stills nothing cites. The user chose deletion over archiving.

## Inspected before writing this slice
- `package.json:7` engines `>=20` looser than vite 8.2.2's `^20.19.0 || >=22.12.0`; `:13` `assets`
  never runs `build-structures.js`; `:17-18` `check` duplicates `gate`.
- `.gitignore:6-7,13-14` — `coverage/`, `out/`, `docs/progress/_regress|_parity` written by nothing.
- `.gitattributes:5-8` — "~3.4 GB across ~5000 screenshots"; `git ls-files docs/progress` = 251.
- `vite.config.js:14-15` — names `build-tiles.js` as the props/structures baker; it is
  `build-structures.js:1-20`.
- `index.html:12-14` — restates overscan with `pixelScale - 1`; `config.pixelScale` defaults to 0.
- `src/main.js:485-492` — claims MODULES order is load-bearing; `core/registry.js:87-98` sorts.
- `src/core/config.js:125` — cites `docs/judge/r1`, a gitignored directory.
- `docs/refs`: `01-forest-tilemap-frame`, `02`, `03`, `04` are cited from `src/`; `.gif`, `05`,
  `06`, `07` only from `tools/judge/plan.json` or nothing.

## Files / modules affected
`package.json`, `.gitignore`, `.gitattributes`, `vite.config.js`, `index.html`, `src/main.js`
(comment), `src/core/config.js` (comment), `src/hunts/biomes/{forest,cave,meadow,coast}.js`
(comments), deleted `tools/judge/` and four `docs/refs` files.

## Expected behaviour
No behaviour change. `npm run assets` now also rebuilds the `structures` and `props` packs.

## Acceptance criteria
- `npm run` lists no `check`; `node -e` on package.json parses; engines match vite's.
- `grep -rn 'tools/judge\|docs/judge' src tools *.md .gitignore` finds only the two "since
  deleted" comments.
- `npm run seams` green.

## Tests required
None (comments, config, deletions).

## Verification in the real application
Not applicable.

## Docs to touch
None here; ARCHITECTURE §7/§9 are rewritten in slice 4.

## Out of scope
`npm run assets` still depends on the PDSMS path hard-coded at `tools/assets/build-tiles.js:25`;
recorded in STATUS (slice 3), not fixed.

## Result
seams green. Deleted: `tools/judge/{build,plan.json,score}.js`, `docs/refs/01-forest-tilemap.gif`,
`05-interior-lab.png`, `06-interior-pokecenter.png`, `07-interior-market.png` (06 was cited only
by the judge plan, so it joined the uncited set the moment the plan went).

Post-hoc check (after the final gate run): the two builders `npm run assets` now chains —
`node tools/assets/build-structures.js` (structures: 4 models, 24 materials, 39 KB) and
`… --src assets/props --slug props` (props: 15 models, 15 materials, 103 KB) — were run on this
machine and `git status` stayed clean, so the committed packs are byte-identical to a rebuild.
`prepare` gained `|| true`: `npm install` from a tarball or a non-git checkout must not fail
because the hook cannot be pointed at.

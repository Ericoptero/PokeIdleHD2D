# 004 — ARCHITECTURE.md rewrite: ≤ 500 lines, true against the code

Status: review          Branch / commit: workflow-harness / (uncommitted)

## Why
`ARCHITECTURE.md` was 1365 lines of which roughly a fifth of the checkable claims were false
(139 confirmed corrections in the audit: stale API blocks, a wrong `module:failed` payload, a
five-stage gate list over a ten-stage gate, a save section that mis-describes v4, a catalog
sample no shipped pack matches). It is the document `CLAUDE.md` tells every agent to read before
touching a module boundary, so a wrong sentence there is acted on. Answers `docs/STATUS.json`
`open` indirectly: the rewrite names `research-unmintable`, `watched-win-mints-money` and
`closed-tab-exp-discarded` as the places the code deviates from §0 instead of restating the rule
as if the code obeyed it.

## Inspected before writing this slice
- `tools/gate.js:69-80` — `STAGES` = lint, typecheck, seams, unit, build, coldboot, boot, flows, parity, regress; `--list` prints it (`:82-85`); parity is passed `--walk` (`:78`); `--only`/`--skip` (`:54-55`); server started on the first `needsServer` stage (`:184`).
- `tools/gate.js:108-139` — `builtAssets()` asserts `dist/assets/<root>` non-empty for every `RUNTIME_ASSET_ROOTS` entry and every literal `/assets/<root>/` in `src/**/*.js` is a configured root.
- `tools/gate.js:152-166` — coldboot: `vite preview` on `PORT+1`, one shot of `/` at 1280x720, `readyBudget: 6000`.
- `tools/seams/run.js:35-45` rule 1 (Math.random, `seam-allow`), `:47-70` rule 2 (static and dynamic `../x/y.js` imports, comments stripped, index.js allowed), `:72-91` rule 3 (default export, `id`, `init`, `showcase`, `id === folder`), `:93-108` rule 4 (bw2-adastra pack.json/pack.bin, offsets fit, no `unknown` category), `:115-134` rule 5 (accrual ↔ pacing INCOME_MODEL), `:145-172` rule 7 (evolution ↔ drops MATERIAL_FAMILIES/FAMILY_BY_TYPE + real items), `:174-191` rule 8 (every listened event is emitted), `:193-227` rule 9 (`it.fails`/`test.fail` ↔ `STATUS:<id>` ↔ `open[].id`/`open[].test`), `:229-258` rule 6 (every `src/<m>/selftest.js` + core, 120 s, must print ✓/✗ or N/M).
- `src/main.js:36-47` — MODULES comment (corrected: registration order is not init order); `:66-89` ctx shape and `window.__CTX__`; `:98-101` showcase only-set `[id, ...showcaseNeeds, 'environment', 'ui']`; `:106` `?mode=`; `:114-125` `travel.go(travel.boot())` → `go('demo-city')` → `city.enter()`/`hunts.enter()`; `:164-197` frame loop and `boot:ready`/`__READY__`; `:58-65` `fatal()` sets `__READY__` and `__FATAL__`; `:202-270` `__HOOKS__` (15 members).
- `src/core/registry.js:30-45` — null object: every property a noop, `__missing` = id, warned once per key; `:63-83` `fail()` blocks only `status === 'registered'` dependents; `:87-114` Kahn sort, queue re-sorted alphabetically, cycle members each failed separately; `:116-146` `?break=` deliberate quarantine at warn, `skipped` status under `only`; `:188-193` `get()` of an unknown id warns once; `:198-208` showcase throw quarantines then rethrows (main.js logs it again); `:209-213` `status()` shape `{id, status, initMs, error}`.
- `src/core/bus.js:10-11, 45-49, 55-58, 70-75` — spy ring 256, throw limit 3, recursion depth 32, `off`/`types`/`clear`.
- `src/core/clock.js:8-11, 37-46, 52` — SIM_HZ 20, MAX_FRAME_DT 0.1, MAX_STEPS_PER_FRAME 8, accumulator dumped when > 8 steps behind, `forceSteps`.
- `src/core/config.js:7` DEFAULTS is a plain object; `:64` shadowExtent 56; `:63` shadowMapSize 2048; `:123, 139-140` latitude 36, sunAzimuthOffset 38, sunMaxElevation 46; `:182` slotEngageTiles 1; `:193` turnSteps (dead); `:260` settleFrames (dead); `:278` SESSION_ONLY; `:282-290` coerce accepts any finite number; `:292-303` localStorage then URL; `:310-318` `set()` live; `:320-328` `persist()`.
- `src/core/render.js:11-12` pipeline diagram; `:169` `PCFSoftShadowMap`; `:188` OrthographicCamera; `:191-198` HalfFloat sceneRT with depth renderbuffer only; `:100-127` composite: AgX, `uLift`/`uGain`, saturation, soft-toe contrast; `:294-300` even internal dims; `:381-395` bright pass + 3 blur mips + one composite; `:535` exponential focus smoothing; `:642-651` sun frustum from `shadowExtent`, texel-snapped.
- `src/environment/sky.js:23, 33-66` — DAY_OF_YEAR 96, true position from tod/latitude, shown azimuth += offset, elevation soft-capped `max·(1−e^(−alt/max))`; `src/environment/index.js:304` KEY_ELEVATION_FLOOR (3.4°), `:376-383` phaseOf boundaries 4.6/6.3/8.6/16.2/18.4/19.6, `:563` FogExp2, `:646-648` knobs passed, `:826` `tod:changed` on phase change; `src/environment/shadowFilter.js:349` sets `PCFShadowMap` and installs its own filter.
- `src/core/dir.js:3-10` — SOUTH 0 / WEST 1 / NORTH 2 / EAST 3, DIR_DX/DIR_DZ.
- `tools/assets/pdsts.js:117-150` — axis conversion at build; winding aligned per triangle to the stored normal.
- `src/tiles/instanced.js:122-130` Placement typedef (no `layer`); `:306` bucket key `${modelId}:${gi}`; `:315, 463` InstancedMesh per bucket + contact-shadow mesh; `src/tiles/index.js:530` `buildInstances(scene, slug, placements, opts)`; `src/pokemon/field.js:161, 190` two sprite InstancedMeshes.
- Events: `grep -rn "bus.emit("` over src (minus selftest/showcase/test) → 31 names with emitter lines (`registry.js:79` module:failed with `{id, phase, error, stack}`, `main.js:186, 194`, `terrain/index.js:29, 48`, `environment/index.js:826`, `pokemon/index.js:230, 235, 261, 361`, `simulation/index.js:292-293`, `travel/index.js:150`, `encounter/index.js:487, 547, 1055, 1093, 1190, 1198, 1302, 1315, 1347`, `economy/index.js:103, 237`, `collection/index.js:180`, `idle/index.js:304`, `offline/index.js:329`, `automation/index.js:106-107`, `hunts/index.js:205, 923`, `tiles/index.js:373`); listeners by the same grep over `bus.on|once`; `offline/index.js:348-350` `dirtyOn` loop (7 events).
- Undeclared `ctx.get` targets per module: script over `src/<m>/**` minus selftest/showcase/test, subtracting `needs` (output in Result). Guard style read at `economy/index.js:87-92, 170-176, 280-284`, `idle/index.js:98-106`, `tiles/index.js:556-562`, `environment/index.js:568-574`, `city/map.js:56-60`, `city/structures.js:85-89`, `hunts/index.js:378-383`, `simulation/surface.js:22-34`, `simulation/index.js:698-703`, `offline/index.js:142-166`, `collection/index.js:229-236`, `automation/index.js:125, 136-142, 168-172`, `pokemon/index.js:76-80`.
- Init order: `src/core/registry.js` run under Node against every module's real `needs` → battle, economy, environment, pokemon, collection, tiles, preview, terrain, city, encounter, automation, hunts, simulation, idle, offline, travel, ui.
- Descriptor hooks and selftests: grep per module (Result table); `src/*/*.test.js` = automation/pricing, economy/currencies, idle/unlock.
- Showcase modes: `src/simulation/showcase.js:277-292, 336`; `src/encounter/showcase.js:799-866, 886`; `src/pokemon/showcase.js:220-283`; `src/battle/showcase.js:34, 62, 178-182`; `src/economy/showcase.js:354-361`; `src/collection/showcase.js:42-43, 488-489`; `src/idle/showcase.js:88-89`; `src/offline/showcase.js:459`; `src/automation/showcase.js:248-251`; `src/ui/showcase.js:91-162`; `src/hunts/showcase.js:30-37`; `src/tiles/showcase.js:100-113`; `src/environment/showcase.js:186-192, 313-320` + `index.js` preset table (night 0.6 … evening 20.6); `src/city/layout.js:481-494` PRESETS + `index.js:182-189`; `src/preview/index.js:98-108`; `src/travel/index.js:275-281`.
- `src/hunts/biomes/{meadow,forest,coast,cave}.js` requiredLevel 0/5/12/20; `src/hunts/index.js:69-72` HUNT_FORMATION; `src/city/layout.js:475` FORMATION; `src/environment/presets.js:320-478, 611` preset and weather names.
- `tools/shots/shoot.js:97` timeFrozen=1 injected; `:171` last 64 events; `:200-225` checkBudgets; `tools/shots/boot.js:86-93` floors; `tools/shots/parity.js:45, 83, 157-158, 212-232` viewports, `--walk`, assertions; `tools/shots/regress.js:34-59` 17 rows, `:65-76` METRICS, `:79` 1280x720/hudRows 60; `tools/shots/chrome.js:11-31` CHROME_PATH and flags.
- `src/offline/migrations.js:17, 34-123` CURRENT_VERSION 4 and chain; `src/offline/save.js:17-19, 32, 93-103, 174-182` keys, probe, FNV-1a checksum, quarantine; `src/offline/index.js:47-68, 81-113` read-only under showcase, debounce 2000/15000, own slice order 0, discovery at init; `src/offline/slices.js:39, 82, 115, 142, 148, 186-215` orders 10/5/15/30/40, native default 50, `snapshot/restore` alias; `src/travel/index.js:255-265` order 45 self-registration; which modules ship `saveState` (battle, encounter, automation, collection, economy, pokemon, travel) and `idle` snapshot/restore.
- `docs/STATUS.json` — keys `updated, commit, seed, now, gate{at,result,seconds,baseline}, open[{id,module,test?,what,repro}], modules{<id>:{selftest,openIssues[]}}`.
- `tools/assets/classify.js:126-130` category set incl. ledge/cave/meta/unknown; shipped pack union over `public/generated/tiles/*/pack.json` (20 categories); `public/generated/tiles/bw2-adastra/catalog.json` keys; `structures/pack.json` extra model fields `door, walkable, emissiveMaterials`; `package.json:14` `npm run assets` runs build-tiles, build-structures ×2, build-species, build-battle-data; `tools/assets/build-tiles.js:25` PDSMS path; `tools/` has no `judge/`.
- `vite.config.js:15, 33-44`; `vitest.config.js:19-21`; `playwright.config.js:21-49`; `tsconfig.json`; `.githooks/pre-commit`; `tests/flows/harness.js:18-35` `__EVLOG__` via `addInitScript`.
- Section citations from code: `grep -rhoE "§[0-9]+(\.[0-9]+)?" src tools tests` — §2.1–§2.7, §3.1, §4, §5.1–§5.17, §6, §6.3 (20×), §7, §8, §8.1, §9, §9.1, §10, §11 — all must keep their meaning.

## Files / modules affected
- `ARCHITECTURE.md` (rewritten in place)
- `docs/slices/004-architecture-rewrite.md` (this file)

## Expected behaviour
`wc -l ARCHITECTURE.md` ≤ 500; every §5 API name is a key of the module's `init()` return (or a named export where marked); every section number cited from `src/`/`tools/` resolves to the same subject as before; `npm run gate:fast` green.

## Acceptance criteria
- `wc -l ARCHITECTURE.md` prints ≤ 500.
- The scratchpad API-name check exits 0 with every §5 name found.
- `grep -rhoE "§[0-9]+(\.[0-9]+)?" src tools tests | sort -u` — every number has a heading or numbered rule in the new document.
- `npm run gate:fast` exits 0.

## Tests required
None new — a document. The check script is throwaway (scratchpad), not committed.

## Verification in the real application
Not applicable; no runtime change.

## Docs to touch
- `ARCHITECTURE.md` — the whole document.
- `CLAUDE.md` — not edited in this slice; it already carries the rules the new §0/§11 point to.
- `docs/DECISIONS.md` — no entry: nothing here constrains future code.
- `docs/STATUS.json` — no change (its `open` ids are cited, not edited).

## Out of scope
- Code comments that cite stale section text: `tools/seams/run.js:3` (cites §2/§5, fine), `src/encounter/index.js:109` (claims `config.turnSteps` is read; STATUS `turnsteps-dead`), `src/battle/index.js:14-18` (claims a fetch failure quarantines battle), `src/economy/pricing.js:4-5` (speciesPrice "three jobs"), `src/automation/automations.js:202` ("lead is asked once"), `src/core/log.js:3` (harness reads `__LOG__`), `src/pokemon/sprites.js:23` (hero-only mirror pairing), `src/environment/index.js:20` (26° fov), `tools/assets/build-tiles.js:10` (quotes old §9 text "transform all in .obj files and classify them" verbatim; the subject — `obj/` is the artist-facing product, the pack is what loads — is in §9 bullet 3, the quotation is not).
- `CLAUDE.md` duplicates of §0 rules (the rules now live only there).
- The STATUS `open` entries themselves.

## Result
`wc -l ARCHITECTURE.md` → **500**. Sections: §0 What we are building · §1 Stack and layout · §2 Core (2.1 registry, 2.2 ctx, 2.3 bus, 2.4 clock, 2.5 rng, 2.6 config, 2.7 render) · §3 Units (3.1 PDSMS → world, 3.2 Time of day) · §4 Events (31 rows, † = offline dirties) · §5 Module contracts, 5.1 tiles, 5.2 terrain, 5.3 environment, 5.4 simulation, 5.5 pokemon, 5.6 encounter, 5.7 idle, 5.8 offline, 5.9 economy, 5.10 collection, 5.11 automation, 5.12 ui, 5.13 city, 5.14 hunts, 5.15 preview, 5.16 travel, 5.17 battle · §6 Showcase mode (**§6.1** only-set, **§6.2** `__READY__`, **§6.3** `timeFrozen=1`, 4. read-only) · §7 World data model and budgets · §8 The verification loop (8.1 selftest/test/spec) · §9 Assets (9.1 The catalog) · §10 Save format · §11 How work is done · §12 `docs/STATUS.json`.

`npm run gate:fast` on the final tree: lint ok 2.2 s · typecheck ok 0.4 s · seams ok 1.4 s · unit ok 0.6 s — `✓ gate: every stage passed`.

API-name check (`scratchpad/check-api-names.mjs`, throwaway, not committed — parses every `### 5.N` block, takes the backtick spans between `API:` and `Events:`, `init(stubCtx)`s the module and asserts each name is a key of the return; a module whose `init` needs the DOM falls back to a grep over the module folder):
```
✓ tiles        26 names via grep
✓ terrain      16 names via grep
✓ environment  23 names via grep
✓ pokemon      52 names via grep (init threw: document is not defined)
✓ simulation   32 names via init(stubCtx)
✓ travel        7 names via init(stubCtx)
✓ battle       34 names via init(stubCtx)
✓ encounter    46 names via grep (init threw: Cannot read properties of undefined (reading 'Group'))
✓ economy      61 names via init(stubCtx)
✓ collection   53 names via init(stubCtx)
✓ idle         37 names via init(stubCtx)
✓ offline      28 names via grep (init threw: document is not defined)
✓ automation   42 names via init(stubCtx)
✓ ui           20 names via grep (init threw: document is not defined)
✓ city          8 names via grep
✓ hunts        14 names via init(stubCtx)
✓ preview        5 names via grep

✓ every §5 API name resolves
```
8 of the 12 selftest modules were `init`-checked; `pokemon`, `encounter`, `offline`, `ui` need `document`/canvas at init and were grep-checked, then hand-confirmed at the definition: offline `src/offline/index.js:407-445` and `store` `src/offline/save.js:398-428`; ui `evolution.freeze/close/TOTAL/BEATS` `src/ui/evolution.js:210-218`, `input.press/release/setTouch` `src/ui/input.js:259-261`; pokemon `sprites.*` `src/pokemon/index.js:175-200`.

Undeclared `ctx.get` reach (in §5 as `Undeclared:`): tiles→environment; environment→terrain; simulation→ui, tiles; pokemon→battle, economy; encounter→simulation, battle, hunts, automation, collection, environment; idle→pokemon, terrain, environment (simulation declared, never called); offline→terrain, pokemon, encounter, economy, ui, simulation + every id via `discoverProviders`; economy→pokemon, collection, idle; collection→economy; automation→pokemon, idle, environment, terrain; ui→pokemon, economy, environment, simulation, offline, encounter, travel, automation, idle, battle, collection; city→simulation, pokemon, tiles; hunts→simulation, pokemon, tiles; travel→city, hunts, economy, encounter, simulation, ui, offline; terrain, battle→none.

Where the code overrode an input (code wins):
- Gate has ten stages, `tools/gate.js:69-80` — draft §8 said six.
- `parity` is passed `--walk`, `tools/gate.js:78` — draft and correction said the walk check never ran.
- `npm run assets` runs `build-structures` for structures and for props, `package.json:14` — draft said it was in no script.
- `regress` MATRIX has 17 rows, `tools/shots/regress.js:34-59` — audit keep-list said 18.
- 31 runtime event names, `grep -rn 'bus.emit('` over src minus selftest/showcase/test — brief and draft said 30.
- `simulation.autopilot()` returns `'route'|'wander'|'still'` only (`src/simulation/index.js:107, 446-464, 588-594`); `'tether'` is an NPC route kind (`src/simulation/route.js:102`) — module map's one-liner copied the union.
- `tools/judge/` no longer exists — draft §8 still described it.
- `docs/STATUS.json` shape is `updated, commit, seed, now, gate{…}, open[…], modules{…}` — draft §12 described the old keys.
- `src/collection/selftest.js:232` now has a Node main guard — the correction that said it ran on import is stale.
- `pokemon → battle, economy` and `collection → economy` undeclared reaches were missing from draft §3; `src/pokemon/index.js`, `src/collection/index.js` `ctx.get` calls.
- `preview` throws on an unknown slug, so §6.1 says "unknown modes never throw (`preview` excepted)".

Deliberately dropped as history/rationale (not carried): old §0 Gamma Emerald and blind-A/B paragraphs; §2.7 spring/LUT/depth+normals target; §5.4 autopilot essay and the "flash" claim; §5.5 narratives; §5.6 `battle()` history, `roll`/`stepRollAt`/`stepRate`, "reach was 2"; §5.7 fold-vs-product essay and `{ wallMs }`; §5.8 "catches materialised" claim; §5.9 `requirementMet`, "three jobs", the pity derivation; §5.11 four-automation list; §5.12 `panel(id)` and the drag prose; §5.13 NPC dialogue; §5.14 loop-search essay; §5.17 `moves()` / `expYield(defeated, winnerLevel)`; §6 15 s limit and `&preset=`; §7 draw-call arithmetic; §8 `docs/progress` path and the 256-event JSON; §9 `find({name})` example; §9.1 `grass-path`/`yMin` sample and roof/billboard categories; §10 DECISIONS #61 paragraph; §11 "one agent" rule; §12 one-sentence `now` rule.

Inputs not applied and why: draft §9 risks (out of scope per brief); module-map `undocumented` lists beyond caller dependencies (internal helpers, not contract); corrections that describe code defects rather than doc errors — heal-revives-at-level-up, `_refill` splice order, `oddsFor` status, `evolve` rollback, `?cols=0` NaN, `callout.tick`, AUTO chip 'A' — belong in STATUS `open`, not in the contract; old §2/§3/§7 sentences that restated rules already in `CLAUDE.md` (§0 points there instead).

### Review round 1 (three findings, all applied)
- §5.1 header: `showcaseNeeds: []` → "`showcaseNeeds` none declared (`main.js` treats a missing key as `[]`)". The descriptor at `src/tiles/index.js:347-350` has `id`, `needs: []`, `init`, `frame`, `showcase` and no `showcaseNeeds` key; `src/main.js:100` is the only consumer and reads it as `?? []`; `src/core/registry.js:17` types the key optional. The only descriptor of 17 without it.
- §5.4 `autopilot()`: "(a getter)" → "(reads the route's `kind`)". `src/simulation/index.js:594` is `autopilot: () => route.kind`, a plain function property; the kinds it can return are `route.js:48` ('route'), `:137` ('wander'), `:173` ('still').
- §9: the no-primitive rule and the obj/pack split are back, so `src/encounter/strikes.js:19`, `src/encounter/ball.js:5` and `tools/assets/build-tiles.js:10` cite a section that says what they lean on. Bullet 1 gained "An untextured box, a magenta placeholder or a flat-shaded primitive is a bug, not a milestone (`CLAUDE.md`)" — the list mirrors `CLAUDE.md:47-48` so the two documents cannot drift; "is the default and is loaded at `tiles` init" → "is the default, loaded at `tiles` init" (`src/tiles/index.js:566`, `await load('bw2-adastra')` inside `init`) keeps the bullet at four lines. Bullet 3 gained "`obj/` is the artist-facing product (Blender, review); the pack and `tex/` are what `tiles.load` fetches" (`src/tiles/index.js:72-77` fetches `pack.json`/`pack.bin`, `:144` fetches `tex/<image>` per material — matching §5.1's `{pack.json,pack.bin,tex/*}`; `obj/` is fetched by nothing in `src/`). The licence sentence is untouched: `assets/` holds `overworld, props, structures, trainer` and no DS set, so shortening it would have moved "in `assets/`" onto the DS sets.
- Line budget: bullet 3 is one line longer, paid for by joining the two-line "**Slices**, hydrated in `order` … else 50):" paragraph into one 125-character line (the file's existing prose maximum; no words changed). `wc -l` → **500**.
- Not accepted on the reviewer's word: each of the three was re-read at the cited lines above before editing.

`npm run gate:fast` after the round: lint ok 2.4 s · typecheck ok 0.4 s · seams ok 1.4 s · unit ok 0.6 s — `✓ gate: every stage passed`. `wc -l ARCHITECTURE.md` → 500.

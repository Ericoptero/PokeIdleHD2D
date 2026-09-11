# 002 — DECISIONS.md repaired against the code; the ARCHIVE preamble re-anchored

Status: done          Branch / commit: workflow-harness

## Why
`docs/DECISIONS.md` opened a code fence at line 18 and never closed it, so #71–#79 rendered as
one code block with no headings. Inside, it broke its own header rule (two measurement tables,
multi-line "Measured …" paragraphs, one baseline round report) and carried sentences an agent
would act on that the code contradicts: a config key nothing reads, the wrong asset build tool, a "nothing
else" with a second caller, a selftest credited with a sweep it does not run, a §5.17 fix that
was half done, a city-accrual change that did not happen, a #73(j) revert that #74 undid one
entry later, a kit priced ₽5,100 low, a fold "carry" that does not exist, glyphs and row counts
the panel does not draw, a settle in milliseconds that is counted in frames, and a bloom
threshold quoted from the wrong file and moving the wrong way. `docs/DECISIONS-ARCHIVE.md`'s
preamble pointed at three line numbers that had drifted and used an unanchored grep. Audit input:
`scratchpad/decisions-corrections.json` (25 findings) and the three `docs/DECISIONS*` entries of
`scratchpad/doc-audits.json`.

## Inspected before writing this slice
Every correction below was checked against the file it cites before the sentence was edited.

- `src/encounter/index.js:109` — comment says `TURN` is overridden by `config.turnSteps`; `:116`
  `TURN: 24` literal; `:458,:460,:473,:1069` read `T.TURN`; `grep -rn turnSteps src tools` finds
  no reader outside `core/config.js:193`.
- `src/encounter/index.js:506` — `reviveSteps = Math.round((config.reviveSeconds ?? 5) * 20)`;
  `src/core/config.js:211` `reviveSeconds: 5`; `src/core/clock.js:8` `SIM_HZ = 20`.
- `src/pokemon/instance.js:234-239` — `heal()` returns early on `hp <= 0 && !revive`; `:78`
  `refreshStats` sets `hp = Math.max(1, round(maxHp * fraction))`, called from the level-up at
  `:188`, `evolveTo` at `:218` and `fromSave` at `:319`.
- `src/pokemon/index.js:409` — `reviveAll` passes `revive: true`; `src/encounter/index.js:989`
  — post-fight writeback passes `revive: c.hp > 0 && inst.hp <= 0`.
- `src/economy/selftest.js:148-152` — check 28 tests only `ether` and `maxether` against
  `floor(price * 0.9)`; `src/economy/index.js:458` `selfTest()` with the every-item checks at
  `:472` and `:484` (browser-side; seams run only `selftest.js`).
- `src/travel/index.js:228-230` — `bus.on('party:wiped', …)` → `queueMicrotask(async …)`.
- `tools/assets/build-tiles.js:1-12` — converts DS Map Studio tilesets, never reads `assets/`;
  `tools/assets/build-structures.js:20,33` — default `src: 'assets/structures'`, and
  `--src assets/props --slug props`. `vite.config.js:13-14` already names the right tool.
- `ARCHITECTURE.md:1080-1081` at HEAD — still `moves()` and `// -> exactly 4`; the working tree's
  rewrite (the parallel slice) has `moveIds()` and `→ 1..4 slots` at `:314`; `src/battle/index.js:71`
  exports `moveIds`; `src/battle/moves.js:28,111-112` slices to at most `MOVE_SLOTS` (1–4).
- `src/encounter/rolls.js:103-110` — `stepRoll`/`stepValue` still exported from the file;
  `src/encounter/selftest.js:28-36` no longer imports them (only the retirement comment at
  `:368-372` names them) — so "uncalled" is true today and "deleted" is not.
- `src/encounter/rolls.js:128-129` — `rollAt` returns null on an empty table;
  `src/idle/accrual.js:67` `BASE_MONEY = 0`, `:98` city `exp: 0.55`, `:300-301` passive EXP,
  `:357-358` null species, `:389-391` per-event EXP. Reproduced: `simulate({biome:'city',
  tables:[], pure:null, …}, 300, 1337)` → `exp 2238.59, encounters 2.579, money 0`, first event
  `species: null, rewards.exp 3`.
- `src/hunts/biomes/*.js` — `grep -n 'walk:'` finds nothing; `src/hunts/index.js:447`
  `stageOnLoop`; `src/hunts/showcase.js:67` describes `biome.walk.route` as gone.
- `src/encounter/drops.js:16` — imports only `./rolls.js`; `:76-80` "Mirrored from
  `pokemon/evolution.js`, and policed by `tools/seams/run.js` rule 7"; `:87-101` its own
  `MATERIAL_FAMILIES`/`FAMILY_BY_TYPE`; `tools/seams/run.js:137-167` the `drop-mirror` rule 7.
- `src/encounter/selftest.js:270-286` — the drop sweep is 3,000 indices and asserts
  `|rate − DROP_CHANCE| < 0.04`; `src/encounter/drops.js:43,51` `DROP_CHANCE 0.46`, arithmetic
  `0.446`.
- `src/economy/items.js:79,154,156,166,177` — pokeball 200, potion 200, superpotion 700, revive
  2000, ether 1200; `src/economy/index.js:137-141` — 20/10/3/2/3; computed ₽15,700. The
  comment at `src/economy/index.js:134` still says ₽10,600.
- `src/idle/index.js:74` and `src/offline/index.js:83` — `carry` is `{ money, tokens }` only;
  `src/encounter/index.js:944-966` — `plan = auto.duel(…)`, the `between` wrapper calls
  `economy.take(act.item, 1, 'battle')` at `:957-958`; `:1008-1009` `resolveFight` → `openDuel`;
  `:1649` `pure().resolve` → `resolveFight`; `src/idle/accrual.js:370-371` the fold calls
  `pure.resolve`; `src/idle/index.js:126-131` hands `encounter.pure()` in.
- `src/encounter/index.js:889-917` — `nextAlly` asks `automation.duel({effectiveness, moveOf})
  .chooseLead(bench, …)` and falls back to `bench[0]`; `src/automation/duel.js:166`
  `slot.type ?? slot.t`; `src/automation/index.js:1036` `duel({ stock, itemOf, effectiveness,
  moveOf, party })`.
- `src/ui/panels/automation.js:242,244,284,286` — buttons labelled `'^'` and `'v'`; `:115-136`
  `key()` binds ArrowUp/Down/Left/Right, Enter, Z — nothing moves a rule; `src/ui/panels/common.js:160-165`
  `action()` registers only a pointer hit region. `src/automation/rules.js:48` `MAX_RULES = 64`;
  `src/automation/automations.js:331-342` nine `rel-*` builtins.
- `tools/shots/shoot.js:22,137,157` — `settle: 30` rAF frames, `spin(a.settle)` then `spin(60)`
  after `resetMetrics`; `tools/shots/regress.js:99` `settle: 40`; no `350` in `tools/shots` or
  `src/encounter/showcase.js`.
- `src/core/config.js:105` `bloomThreshold: 0.72`; `src/environment/index.js:776-784`
  `config.set({ bloomStrength: look.bloom, bloomThreshold: look.bloomThreshold, … })`;
  `src/environment/presets.js:225` key(12.0) `bloom 0.3, bloomThreshold 1.15`, `:307` key(20.6)
  `bloom 1.15, bloomThreshold 0.85`, `:151` key(0.0) `0.85`; `src/core/render.js:351` reads
  `config.bloomThreshold`; `src/encounter/showcase.js:896` pins `meadow`.
- `src/ui/panels/battle.js:18` — the header is titled "Why it reads a finished fight" and `:23`
  "this card is a readout of that record and not a live scoreboard"; the doc's quote was a
  paraphrase.
- `docs/DECISIONS-ARCHIVE.md` — `#34(c)` demoted at the line beginning "That kills DECISIONS
  #34(c)'s", `#41a` narrowed at "**(d) DECISIONS #41a is narrowed in place", `#52` withdrawn at
  "The standing coreRequest … is **wrong** and is withdrawn"; `### 22` sits between `### 15`
  and `### 16`. Line numbers below are post-edit (the preamble grew by one line).
- `grep -rn 'DECISIONS #' src tools | wc -l` → 427 on this tree; `CLAUDE.md:144` already says
  "Hundreds of comments".

## Files / modules affected
`docs/DECISIONS.md`; the preamble (lines 1–16) of `docs/DECISIONS-ARCHIVE.md`; this file.

## Expected behaviour
`docs/DECISIONS.md` renders with ten `###` headings and one closed template fence; every
sentence that names a value, a caller or a file agrees with `src/` and `tools/`; each entry that
a later entry reversed or superseded says so on its last line. The ARCHIVE preamble's three
anchors land on the sentences they name; its heading recipe returns one hit per entry and its
citation recipe finds every citation of an entry, lettered sub-entries included.

## Acceptance criteria
- `grep -c '^```' docs/DECISIONS.md` is even (4).
- `grep -c '^### ' docs/DECISIONS.md` is 10.
- `sed -n 5250p docs/DECISIONS-ARCHIVE.md` names #34(c); `3269p` names #41a; `4278,4279p` is
  #52's withdrawal; `grep -n '^### 22 '` → 288.
- `npm run gate:fast` exits 0.

## Tests required
None — no code changed. The seams (`npm run gate:fast`) are the regression check that the doc
edits touched nothing they read.

## Verification in the real application
Not applicable.

## Docs to touch
This slice is the docs change. Out-of-slice doc defects found on the way are listed under Result.

## Out of scope
Every code comment and ARCHITECTURE line the audit flagged (listed under Result); the `---`
separators the audit found missing in the archive; the archive entry bodies (frozen).

## Result
`npm run gate:fast` (2026-09-11, after review): lint, typecheck, seams and unit (7 passed, 1 expected
fail) all ok, ~5 s total; build/coldboot/boot/flows/parity/regress skipped by design.
`grep -c '^```' docs/DECISIONS.md` → 4; `grep -c '^### ' docs/DECISIONS.md` → 10. Applied as 28
exact-string replacements (each asserted to occur once) plus a rewrap of the touched paragraphs,
then four more after review (three findings and observation 6, below).

### Sentences changed in `docs/DECISIONS.md` (line — was → now — evidence)
Line numbers are the file's before the edit.

- 16-18 — "Format — the decision, then why, then what it costs:" + an unclosed fence swallowing
  #71–#79 → a closed template fence (decision / **Why** / **Cost**), `---`, and `### 71` as a
  heading — evidence: `grep -n '^```'` was 18/663/666, is 19/25/667/670.
- 22-29 — the four-row timing table and "between those columns" → "Measured 2026-09-09 against
  the dev server: 3.6–6.0 s warm, 7.5–15.0 s cold." and "between those runs" — header rule,
  lines 11-14.
- 56 — header quote "It is a readout of a *finished* fight." → "Why it reads a finished fight" —
  `src/ui/panels/battle.js:18`.
- 69 (after) — added "→ Superseded by #80: `nextAlly` asks `automation.chooseLead`; party order
  is only the fallback." — `src/encounter/index.js:889-917`.
- 71-72 — "serves a live `economy.take()` and an offline carry" → "serves the watched fight and
  the fold alike — both through `encounter`'s `economy.take()`, because the fold drains the same
  closure and carries no items of its own" — `src/idle/index.js:74`, `src/offline/index.js:83`,
  `src/encounter/index.js:957-958,1009,1649`.
- 94-95 — "`{ revive: true }` is the Pokemon Center's escape hatch and nothing else's" → passed
  by `pokemon.reviveAll` and by `encounter`'s post-fight writeback, and a level-up or evolution
  raises a fainted member to 1 HP via `refreshStats` — `src/pokemon/index.js:409`,
  `src/encounter/index.js:989`, `src/pokemon/instance.js:78,188,218`.
- 104 — "the no-arbitrage clamp `economy/selftest.js` holds every money-priced item to" → check
  28 pins the two ethers; the every-item sweep is `economy.selfTest()` in the browser —
  `src/economy/selftest.js:148-152`, `src/economy/index.js:458,472,484`.
- 106-107 — "`config.turnSteps` (24, so one exchange is 1.2 s) and `config.reviveSeconds` (5)
  are counted in sim steps" → "`T.TURN` in `encounter/index.js` (24 sim steps … `config.turnSteps`
  is declared but not read; wire it or delete it) and `config.reviveSeconds` (5 s, ×20 into 100
  sim steps) are spent in sim steps" — `src/encounter/index.js:116,506`, `src/core/config.js:193,211`.
- 139 — "hops on the next frame" → "hops from a queued microtask, once the synchronous emit has
  returned" — `src/travel/index.js:228-230`.
- 156 — "`tools/assets/build-tiles.js` bakes into `public/generated/`" →
  "`tools/assets/build-structures.js` (once per slug …) bakes into `public/generated/tiles/`" —
  `tools/assets/build-structures.js:20,33`, `tools/assets/build-tiles.js:1-12`.
- 172-174 — the three-line `watchedS 300.27` measurement → one line with the date — header rule.
- 183-185 — "four claims in it that were already wrong … (`turnNo`, `ppSpent`, exactly 4,
  `moves()`)" → two fixed (`turnNo`, `ppSpent`); "exactly 4" and `moves()` "outlived that rewrite"
  (#72's; anchored in time after review, because the working tree's ARCHITECTURE.md already has
  `moveIds()` and `1..4` at `:314`) — `ARCHITECTURE.md:1080-1081` at HEAD, `src/battle/index.js:71`,
  `src/battle/moves.js:111-112`.
- 249-253 — the "Measured, forest, three slots" paragraph and the gitignored
  `shots/out/contact.png` → one line with the date — header rule.
- 255 — "The tall-grass step roll is deleted everywhere" → "disconnected everywhere" —
  `src/encounter/rolls.js:103-110`.
- 260 (after) — added "`stepRoll`/`stepValue` still sit in `rolls.js`, uncalled, and go the next
  time that file is touched." — `src/encounter/rolls.js:103-110`, `src/encounter/selftest.js:28-36`.
- 268-269 — "A tab closed in the city now accrues nothing, which is a real behaviour change" →
  meets no species, but `idle/accrual.js` still pays passive and per-event EXP; money was already
  zero (`BASE_MONEY = 0`) — `src/encounter/rolls.js:129`, `src/idle/accrual.js:67,300-301,357-358,389-391`,
  and the `simulate()` reproduction above.
- 271-288 — #73(j) collapsed from three paragraphs to one (the corridor number and the "every
  judged frame" insight kept; the "deleting the second route … still has to happen" plan cut) and
  "→ Reversed by #74(b): the circuit was fixed and `biome.walk` deleted one entry later." added —
  `src/hunts/biomes/*.js` (no `walk:`), `src/hunts/index.js:447`, DECISIONS #74(b).
- 313-318 — the before/after table → "Measured 2026-09-10: the meadow ring went 50 cells … cave
  56 / 8." — header rule.
- 349-353 — "Baseline re-accepted, frames named: …" → one line naming the date, the seven rows
  and the cave verdict — CLAUDE.md puts the moved frames in the commit message.
- 361 — "the derivation reuses `pokemon/evolution.js`'s type → material map" → "mirrors … (a
  copy, held equal by seams rule 7 because `encounter` may not import it)" —
  `src/encounter/drops.js:16,76-80,87-101`, `tools/seams/run.js:137-167`.
- 377-378 — "lands back on 46 % (measured 45.2 % over 20,000 rolls, asserted in the selftest over
  a sweep …)" → "lands back near 46 % (the arithmetic says 44.6 %; the selftest sweeps 3,000 rolls
  and asserts within ±4 points …)" — `src/encounter/selftest.js:270-286`, `src/encounter/drops.js:51`.
- 419 — "₽10,600" → "₽15,700" — `src/economy/items.js:79,154,156,166,177`,
  `src/economy/index.js:137-141`.
- 443-446 — "`encounter` through `economy.take()`, the fold against its own carry" → "`encounter`'s
  `between` wrapper through `economy.take()`, on the watched fight and on the closed-tab fold
  alike, because the fold's `pure().resolve` builds the same closure and neither `idle` nor
  `offline` carries items" — `src/encounter/index.js:949-966,1009,1649`, `src/idle/index.js:74`,
  `src/offline/index.js:83`.
- 471 (after) — added "→ Superseded by #80: the offence term was inert until the move resolver
  was injected, so that lead change was decided by defence and health; the rule is also asked at
  every swap now." — `src/automation/duel.js:166`, `src/automation/index.js:1036`,
  `src/encounter/index.js:889-917`.
- 492-495 — the "Measured, forest, twelve encounters" paragraph → one line with the date — header
  rule.
- 507 — "`↑`/`↓` buttons" → "`^`/`v` buttons" — `src/ui/panels/automation.js:242,244,284,286`.
- 510 — "a list of at most eight rows" → "lists that ship at most nine rows (auto-release's; the
  engine caps any at `MAX_RULES` 64)" — `src/automation/automations.js:331-342` (release 9; hunt 2,
  catch 4, ball 4, sell 6, restock 3), `src/automation/rules.js:48`, `src/ui/panels/automation.js:224`
  (the panel lists the selected automation's rules).
- 511 — "are keyboard-reachable, work on touch, say what they do" → "work on pointer and touch and
  say what they do — no key moves a rule" — `src/ui/panels/automation.js:115-136`,
  `src/ui/panels/common.js:160-165`.
- 619 — "The 350 ms settle before the shutter" → "The settle before the shutter — `spin(settle)`,
  30 rAF frames by default and 40 from regress, then 60 more after the metrics reset" —
  `tools/shots/shoot.js:22,137,157`, `tools/shots/regress.js:99`.
- 625-626 — "because `bloomThreshold` is 0.72 at noon" → "is 1.15 at noon (the outdoor preset's
  value; `core/config.js`'s 0.72 is only the default `environment` overwrites)" —
  `src/environment/presets.js:225`, `src/environment/index.js:776-784`, `src/core/config.js:105`.
- 641-642 — "where `environment` lifts the bloom threshold" → "drops the bloom threshold to 0.85
  and raises the strength to 1.15" — `src/environment/presets.js:225,307`.

### `docs/DECISIONS-ARCHIVE.md` preamble (post-edit lines)
- 7 — "~290 comments" → "Hundreds of comments" — `grep -rn 'DECISIONS #' src tools | wc -l` → 427.
- 8 — `grep -n '^### 61 '` → `grep -n '^### N '`.
- 9-10 — added "#22 is filed at line 288, between #15 and #16 — navigate by grep, never
  sequentially." — `grep -n '^### 22 '` → 288 (`### 15` at 238, `### 16` at 329).
- 14-15 — `:5231` → `:5250`, `:3249` → `:3269`, `:4259` → `:4278` — each verified with `sed -n`.
- 15 — `grep -n '#<n>'` → `grep -nE '#N([a-f]?\b|$)'` — the unanchored form matched #10–#19 and
  hex colours for a single-digit n; the first replacement, `([^0-9a-f]|$)`, rejected every lettered
  sub-entry (`#41a`, `#26d`, `#53f` …) and was corrected after review. `N` matches line 8's
  placeholder.

### From the inputs, not applied, and why
- corrections `docs/DECISIONS.md:255` half-claim "`selftest.js:33/:119` still imports and calls
  `stepValue`" — the code has moved on: `src/encounter/selftest.js:28-36` does not import it, so
  the doc says "uncalled", which is what is true today.
- corrections `docs/DECISIONS.md:259-260` — the DECISIONS sentence is kept as the finding says;
  the fix it names is in `ARCHITECTURE.md:605-606,617`, not this file.
- corrections `docs/DECISIONS.md:54-56` — the six stale code comments it names are code
  (`src/ui/panels/battle.js:18-25`, `src/encounter/index.js:14,131-134,884-888,1694`,
  `src/ui/index.js:232-235`, `src/battle/engine.js:7`) and outside this slice; only the
  misquoted header was corrected here.
- corrections `docs/DECISIONS.md:63` (contested) — the doc sentence was right as of #72; it got a
  forward pointer to #80 rather than a rewrite. The stale docblock at `src/encounter/index.js:884-888`
  is code.
- #74(c)'s "216 detours in 2000 ticks" and #77(d)'s region-driven check were left in place: the
  audit's keep-list names the second, and the first is the diagnosis of the bug, not a report.
- Cross-doc and code fixes seen and not touched (other slices / other files; ARCHITECTURE line
  numbers are HEAD's — the parallel slice's rewrite renumbers it): `ARCHITECTURE.md:557`
  (revive), `:605-606,617` (dead API), `:629,1110` (turnSteps), `:647` (next frame), `:852`
  (missing `moveOf`), `:909` (eight rows, ↑/↓), `:1080-1081` (`moves()`, exactly 4);
  `src/economy/index.js:134` (₽10,600); `src/encounter/index.js:109` (turnSteps override);
  `src/encounter/strikes.js:36,121,122` (0.72; "lifts"); `tools/shots/regress.js:53-54` ("lifts");
  `src/ui/panels/automation.js:11,15` (↑/↓, eight rows). `vite.config.js:13-14` already names
  `build-structures.js`.
- The archive's missing `---` separators and its entry bodies: frozen, and the audit's disposition
  for both ranges is "keep".

### Reviewer findings (verdict fix-then-accept; 42 sentences checked) — all three applied
- `DECISIONS-ARCHIVE.md:15` — `([^0-9a-f]|$)` rejected lettered sub-entries: verified
  `grep -cE '#41([^0-9a-f]|$)'` → 0 against `#41a` cited on line 14 itself; the new
  `'#N([a-f]?\b|$)'` gives n=41 → 6, 26 → 4, 25 → 9 (drops only `#250`, an encounter index at
  `:1845`), 4 → 3 with `#4d4d5c` (`:2386`) excluded, 14 → 4 with `#14141c` (`:2381`) excluded.
  Line 15 is 87 chars; no rewrap, the three anchors and `### 22` → 288 unchanged.
- `DECISIONS.md:196-198` — "survived in §5.17's API block" was true at HEAD
  (`git show HEAD:ARCHITECTURE.md` :1080-1081) and false against the working tree (`:314`);
  now "outlived that rewrite", which names #72's own rewrite and needs no ARCHITECTURE state.
- `DECISIONS.md:509-510` — "a dozen rows at most" contradicted the `MAX_RULES` 64 in its own
  parenthetical; now "lists that ship at most nine rows (auto-release's; the engine caps any at
  `MAX_RULES` 64)" — `src/automation/automations.js:331-342`, `src/automation/rules.js:48`; "any"
  because `compileRuleset` slices each automation's own list (`rules.js:251`, from `engine.js:77`).
- Observation (6), placeholder spelling: unified on `N` (line 8's) rather than `<n>`, because
  `'^### <n> '` would push line 8 to 95 chars past the preamble's widest line (94).
- Observations (1)–(5), (7): read and left alone — (1) is a code fact the sentence states
  correctly (`refreshStats` is the mechanism; `grantPartyExp` filters `hp > 0` at
  `src/pokemon/index.js:281`, `evolve()` does not), (2) is the template's prescription, (3)–(5)
  and (7) name no false sentence.

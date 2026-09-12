# 015 — the wild fights where it was standing

Status: done          Branch / commit: Ericoptero/hunt-battle

## Why
An encounter is staged as a *cutscene* today: the creature that was walking the map is deleted
(`hunts.takeSlot` → `sim.removeNpc`), a second sprite bursts out of the grass over 20 sim steps
with a ring of leaves and a "!" balloon, and a toast announces `A wild X appeared!`. The brief for
this round is the opposite: the wild is already on the map, you walk up to it, and the fight starts
in the field — Tibia, not a JRPG transition. No STATUS entry; this is new direction from the user,
who also decided explicitly that the "!" balloon goes with the leaves and the toast.

## Inspected before writing this slice
- `src/hunts/index.js:366-373` — wilds are **already** wandering NPCs, `tether: {radius: 1}`, `solid: true`.
- `src/hunts/index.js:240-268` — the party already leaves the circuit for the slot and `holdNpc`s the target.
- `src/hunts/index.js:872-882` — `takeSlot` deletes the NPC and returns the slot's *authored* cell, not the
  cell the creature drifted to, and carries no level.
- `src/encounter/index.js:833-844` — "the species is the slot's; everything else is the index's": the level is
  rolled at engage, so a nameplate over a wandering creature would be a lie.
- `src/encounter/index.js:96-142` — `T.APPEAR` 20, `T.RUSTLE` 0.4; `:571-608` the whole appear beat;
  `:1101-1123` the scene record, `nextTurnAt: T.APPEAR + T.TURN`; `:1152-1157` the toast; `:1220` the queued
  throw floor; `:1630-1651` `advanceToStage`'s arithmetic.
- `src/encounter/ball.js:88-108,137-172,314-345,390-405,539-560,678-722` — the alert balloon and the leaves.
- `src/encounter/showcase.js:799-866` — every stop names `stage:'appear'`; `reveal` is the default mode.
- `src/encounter/rolls.js:80-90` + `src/encounter/index.js:1590` — `levelBand(top)` and `encounter.band()`.
- `src/simulation/index.js:542-564` — `removeNpc`, `holdNpc`; `:538-541` `npcs()` (no world position yet).
- `tests/flows/hunt.spec.js` — asserts events only; nothing asserts the appear beat.

## Files / modules affected
`src/hunts/index.js`, `src/encounter/index.js`, `src/encounter/ball.js`, `src/encounter/showcase.js`,
`src/encounter/selftest.js`, `tests/flows/hunt.spec.js`, `ARCHITECTURE.md`, `docs/DECISIONS.md`,
`docs/STATUS.json`, `docs/baseline.json`.

## Expected behaviour
- A slot's creature carries its own `level`, rolled when it walks onto the slot from the slot's own
  seeded stream, and `engage()` fights **that** level. `hunts.slots()[k].level` reports it.
- `takeSlot(k)` returns `{ species, shiny, level, cx, cz, k, npcId }` where `cx,cz` is where the
  creature actually **is**, and does not remove its sprite. `encounter` removes it the moment its own
  actor exists, so no frame has an empty patch of grass.
- The scene opens at `stage: 'meet'`, step 0, with the wild visible at scale 1 on its own cell. There is
  no rustle, no hop, no scale pop, no "!" balloon and no `A wild … appeared!` toast.
- `encounter.scene()` reports `headLift`, so the next slice can hang a plate off the measured head.

## Acceptance criteria
- `node src/encounter/selftest.js` and `node src/hunts/selftest.js` stay green, unchanged in count —
  both are pure-Node files built against a stub `ctx` (`get: () => ({ __missing: true })`), and the
  level roll / scene handover only exist inside `init(ctx)`'s live closures, reachable only with a real
  `simulation` + `pokemon` behind them. That reachability gap is why the properties below are proven as
  a Playwright flow instead of a selftest literal — **reality corrects the slice**: the plan asked for
  selftest checks named "a slot carries the level the encounter fights" and "a fresh scene opens at
  'meet', step 0"; `src/hunts/selftest.js`'s own header already states this exact boundary for the
  reason a stub tileset cannot prove a shipped map's framing, and the same reasoning applies here.
- `grep -n "APPEAR\|RUSTLE\|alertPhase\|rustle(\|\.alert(" src/encounter/*.js` → no hits.
- `grep -n "appeared" src/encounter/index.js` → no hits.
- `tests/flows/field-encounter.spec.js` (new) passes: the slot occupied the tick before
  `encounter:started` names the species, level and cell the fight actually uses, and no toast
  matching `/appeared/` fires.
- `tests/flows/hunt.spec.js` passes with the added assertion: no `ui:toast` anywhere in the flow matches
  `/appeared/`.
- `npm run gate` exits 0.

## Tests required
- `tests/flows/field-encounter.spec.js` (new) — watches two consecutive encounters: slot level ==
  `encounter:started.level` == `battle:started.level`; the fight's cell == the creature's **live**
  cell, sampled from `simulation.npcs()` (not `hunts.slots()`'s static authored anchor, which
  never moves and would pass the check identically whether or not the fix landed — a reviewer
  caught the first draft comparing against the anchor and proved it non-discriminating); and,
  because a single encounter can coincidentally land on its anchor, an explicit assertion that at
  least one of the two watched encounters actually drifted off it. No "appeared" toast, across
  the whole watch.
- `tests/flows/hunt.spec.js` — the no-toast assertion across the whole flow.
- `node src/encounter/selftest.js` / `node src/hunts/selftest.js` — unchanged, proving neither pure
  contract moved.

## Verification in the real application
`npm run shot -- --showcase encounter --mode meet --tod 12 --out shots/out/meet.png` — a Pokémon standing
in the grass facing the lead, no leaves, no bubble. And `?scene=hunt-meadow&seed=1337` walked with
`__HOOKS__.step()`: the creature that was wandering is the one that is fighting, on the same cell.

## Docs to touch
ARCHITECTURE §5.6 (stages, showcase modes, `alerting` gone, `scene()` gains `headLift`), §5.14
(`takeSlot`'s shape, `slots()` gains `level`), §4 (the appear toast row), DECISIONS #84, STATUS.

## Out of scope
Nameplates (016), action pacing (017), balloons and damage numbers (018), the VFX rebuild (019).

Also left untested here, found during review, real but not a regression: a **refilled** slot
(`hunts/index.js`'s `_refill`, generation ≥ 1, not the initial `spawnWild`) rolls its level with
the identical `levelForSlot(biome, k, gen)` call the initial spawn uses, so by construction it
carries the same guarantee — but nothing exercises the ~520-tick respawn window to prove it live,
and adding that wait to this slice's flow test would roughly double the gate's `flows` stage for
one more instance of a pattern the gen-0 path already proves. Left as a candidate for whichever
later slice next touches `hunts._refill`.

## Result
Two rounds. Round 1 landed the behaviour and re-accepted the two `encounter/vfx/*` regress rows
(the wild's idle-breathing phase no longer offsets by the deleted `T.APPEAR`) — `npm run gate`
green at 302 s. `reviewer` and `tester` then ran in parallel against that diff and both found
real issues, none of them in the game logic:

- **A documentation contradiction this same commit introduced.** ARCHITECTURE §5.6's rewritten
  "Events: emits" line dropped `ui:toast` from the list, but `encounter` still emits it for the
  fainted-party nag, an empty-ball warning, a drop found and a wipe — only the *appeared* toast
  is gone. Fixed to say exactly that.
- **The flow test's own position check was non-discriminating.** It compared the fight's cell
  against `hunts.slots()`'s `cx,cz`, which is the slot's *authored* anchor and never moves —
  so the assertion would have passed identically whether `engage()` used the creature's live,
  drifted cell or reverted to DECISIONS #84's bug (a teleport onto the anchor). Rewritten to
  read the creature's live position from `simulation.npcs()` instead, watch two consecutive
  encounters, and assert that at least one of them actually drifted off its anchor — proving the
  live-position check is evidence of something rather than a tautology.
- **A real bug in that rewrite, caught immediately by running it**: the rewritten test's own
  `battle:started` lookup had no lower bound, so on the *second* watched encounter it matched
  the *first* encounter's event (`Array.find` returns the earliest match) — a level off-by-one
  that looked like a game bug and was a test bug. Fixed by binding the search to the same
  `after` index `encounter:started` itself uses.
- **A stale comment** (`MAX_ADVANCE`'s doc citing the deleted `T.APPEAR`) and an **unreviewed
  behaviour change riding along with a rename** (`advanceToStage('ready', …)`'s target moved
  from a fixed `T.APPEAR` offset to `scene.fightEndsAt`, which is actually a latent-bug fix —
  a duel's length was never fixed, DECISIONS #72 — but has zero callers today; left corrected,
  with a comment explaining why, rather than reintroduced wrong).
- **A confirmed, pre-existing bug found while reading the handover code, not introduced by this
  slice**: `begin()`'s `showWild(...).then(id => { if (scene) {...} })` guards the write-back but
  not the spawn — `pokemon.sprites.spawn()` has already minted an actor by the time the callback
  runs, and a `cancel()` racing it (a travel out before the sprite sheet lands) leaks that actor.
  Reproduced independently by both `reviewer` and `tester`. Filed as `docs/STATUS.json`'s
  `cancel-races-spawn-actor` (module `encounter`, cross-referenced in `modules.encounter.openIssues`)
  rather than fixed here — it is a pre-existing gap this slice's own `retireNpc()` sits next to,
  not a regression, and fixing a promise-ordering bug in `begin()` is its own slice.

All five fixed or filed in this same commit. Final `npm run gate`, clean tree: **every stage
passed (294 s)** — lint 2.5s, typecheck 0.5s, seams 1.5s, unit 0.8s, build 3.7s, coldboot 4.0s,
boot 98.5s, flows 46.1s (21 specs), parity 47.8s, regress 88.7s (**0 improved, 0 regressed, 0
moved, across 18 frames** — the baseline accepted in round 1 held). `node src/encounter/selftest.js`
61/61, `node src/hunts/selftest.js` 365/365, both unchanged.

Out of scope items (016–019) untouched. `docs/slices/TEMPLATE.md`'s selftest-check ask could not
be met literally — `hunts/selftest.js` and `encounter/selftest.js` are pure-Node files against a
stub `ctx` and the level roll / handover only exist inside `init(ctx)`'s live closures — so the
acceptance criteria were revised in this same document to point at the Playwright flow instead,
which proves the property end to end: the slot occupied the tick before `encounter:started`
names the exact species, level and live cell the fight actually uses.

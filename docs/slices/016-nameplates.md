# 016 — name, level and HP above every head

Status: done          Branch / commit: Ericoptero/hunt-battle

## Why
The user asked for MMORPG-style nameplates: every trainer, NPC, Pokémon and wild Pokémon in the
hunts shows its nick and level above its head, plus an HP bar — and, on follow-up, that a
non-combat NPC (a city local, Nurse Joy) shows only its name, since it has no level or HP to
show honestly. No STATUS entry; this is new direction from the user, decided in this session.

## Inspected before writing this slice
- `src/ui/index.js:71-92` — `project(x,y,z)` already an exact world→HUD-pixel map, no depth
  divide; published at `:503` (now further down after this slice's edits).
- `src/ui/callout.js` (whole file) — the existing world-anchored balloon: sim-step lifetime,
  `project` handed in rather than imported, the pattern this file copies.
- `src/ui/hud.js:37-80` — `read()` pulls the world through `ctx.get` at paint time; the pattern
  `plates.js`'s own `read()` copies rather than inventing a push-based alternative.
- `src/ui/panels/battle.js:113-186` — the live-fight HP read (`active.duel.run.state`, not
  `pokemon.lead()`, because DECISIONS #72 only writes HP back to an instance when a duel ends).
  `:50-54` `hpInk`, local and unexported.
- `src/simulation/index.js:198-218` — `rebuildMembers()`: the walked "party" is the trainer plus
  **only the lead**, never the whole roster — the bench has no world presence at all.
- `src/simulation/index.js:353-392` — `poseWalker`/`renderPose`: the exact pose math `lineup()`
  already uses for `x,y,z`; `npcs()` (`:538-541`, pre-slice) did not.
- `src/city/layout.js:439-463` — `NPCS`: three person entries (`trainer`, no species), the rest
  species-named decorative Pokémon.
- `src/pokecenter/index.js:226-229` — Nurse Joy's `spawnNpc` call, `trainer: 'heroine'`, no
  human label anywhere in her record.
- `src/main.js:169-181` — the frame loop: `registry.frame` before `rig.update()`,
  `registry.lateFrame` after; `src/pokemon/index.js:456-461` already poses sprites in
  `lateFrame` for exactly the one-frame-of-camera-lag reason this slice reuses.
- `docs/slices/015-field-encounters.md` — `hunts.slots()` already carries `level`/`display`/
  `npcId` per occupied slot (this slice's own prior work); `encounter.scene()` already carries
  `headLift`, measured off the live actor.

## Files / modules affected
New: `src/ui/plates.js`, `src/ui/plates.test.js`, `tests/flows/plates.spec.js`. Changed:
`src/ui/index.js`, `src/ui/theme.js`, `src/ui/panels/battle.js`, `src/ui/panels/menu.js`,
`src/simulation/index.js`, `src/city/layout.js`, `src/city/npcs.js`, `src/pokecenter/index.js`,
`ARCHITECTURE.md`, `docs/DECISIONS.md`.

## Expected behaviour
- `?scene=hunt-meadow` (or any hunt): the trainer and the lead show name+level (the lead also an
  HP bar); every wild standing on an occupied slot shows species+level+a full bar; the wild
  currently being fought shows its live duel HP instead.
- `?scene=demo-city` / `?scene=pokecenter`: every city local and Nurse Joy show a name only, no
  level, no bar; every decorative Pokémon NPC shows its species name only, same rule.
- A plate never overlaps the party bar or the button strip; two plates close enough to collide
  stack instead of printing on top of each other; one that still cannot fit for the frame is
  dropped rather than drawn over another.
- Plates keep showing around the two panels that draw no scrim of their own — the battle card
  and the start menu — clipped to whichever one's own box, and are suppressed entirely under
  every other panel (`travel`, `offline`, and every `full`/`hidesHud` one), because those dim or
  replace the whole screen and a plate floating over that scrim would read as a lit sign in a
  blackout, not just as one overlapping a box. A first draft only protected `battle`'s box and
  missed that `travel`/`offline` scrim too; a reviewer caught it from a real screenshot with the
  menu and the travel panel open, not from any acceptance-criteria capture, which had not tried
  opening a panel at all.
- Another module's own showcase (`?showcase=<other>`) shows no plates — the same `minimal` rule
  that already holds callouts and detail rows to wallet/clock/toasts there.

## Acceptance criteria
- `npm run gate` exits 0.
- `npx eslint` clean on every file touched; `npx tsc -p tsconfig.json` clean (no file here opts
  into `@ts-check`, matching every sibling in `src/ui/`).
- `node src/hunts/selftest.js`, `node src/encounter/selftest.js` unchanged (no pure contract
  touched).
- Screenshots looked at, not just measured (`regress` sees ten scalars, not composition):
  `shots/out/plates-hunt5.png`-equivalent (a hunt, wide framing, mid-fight) shows every plate
  legible, none overlapping HUD chrome or the battle card; a city screenshot shows name-only
  plates on every NPC with the correct human labels (`Visitor`, `Doorman`, `Shopper`,
  `Nurse Joy`) and species names on the decorative Pokémon.
- Regress moves on most rows (every frame with an entity in it now carries plates) —
  re-accepted in this commit, frames named.

## Tests required
`src/ui/plates.test.js` (vitest, new) — the pure geometry `draw()` owns: two plates whose rects
would land on the same spot stack instead of overlapping; no two painted footprints ever
overlap, checked pairwise, across a four-plate cluster; a plate with nowhere left to go is
dropped rather than snapped back onto the one it could not clear; `bottomLimit` and `avoid`
(a panel's own box) are both honoured, including the case that draws normally once clear of
`avoid`; label content (`Lv N`, the shiny star, no level text when `level` is `null`, nothing
drawn for an empty list).

`tests/flows/plates.spec.js` (Playwright, new) — the half of the module the vitest suite cannot
reach: `read()`'s live `ctx.get` chain. A real hunt, walked to a real encounter, a few turns in:
the ally's plate HP matches `encounter.active().duel.run.state.a`, not `pokemon.lead()` (still
untouched, unwritten until the duel ends — DECISIONS #72), and the engaged wild's plate matches
`state.b` at its slot's level, identified by the world cell it is standing on rather than by
name (two wandering wilds can share a species). Forces one paint via `ui`'s own `_lateFrame()`
seam, because `__HOOKS__.step()` drives the sim only — plates are gathered at render rate and do
not move on a tick alone.

## Verification in the real application
`npm run shot -- --scene hunt-meadow --tod 11 --steps 60 --out shots/out/x.png` — a mid-fight
frame with live HP bars on both combatants and full bars on the wandering wildlife.
`npm run shot -- --scene demo-city --tod 12 --out shots/out/y.png` — name-only plates on every
NPC. `npm run shot -- --scene pokecenter --tod 12 --out shots/out/z.png` — "Nurse Joy".

## Docs to touch
ARCHITECTURE §5.4 (`npcs()`'s widened shape, `spawnNpc`'s `display`), §5.12 (`plates.js`, the
`lateFrame` hook, `hunts` joins the undeclared list), DECISIONS #88.

## Out of scope
Speech balloons with a tail and type-coloured golpe text (018) — this slice's own screenshot
shows the *existing* `callout.js` balloon partially overlapping the trainer's new plate
(`Oshawott: Tackle!` over `…er Lv 1`), which is expected and left alone: 018 redesigns that
balloon to anchor above the plate this slice adds, and fixing the interaction here would be
solving half a problem the next slice solves properly. Action pacing (017) and the VFX rebuild
(019) untouched.

Plates are suppressed under `?showcase=<other module>`, same as the party bar, the button strip
and the panels — the project's existing "minimal outside its own showcase and the game itself"
rule (`ui/index.js`'s header), not a new carve-out. A screenshot of plates has to name a real
scene (`?scene=hunt-meadow`, not `?showcase=hunts`), which is why `regress`'s matrix — every row
but `boot/12` shoots a module's own showcase — barely saw this slice at all.

## Result
Two rounds, the same shape as slice 015's. Round 1 landed the module and passed a full
`npm run gate` at 364 s, regress **2 improved, 0 regressed, 0 moved** across 18 frames (only
`boot/12` moved, both metrics in the improving direction — every other row shoots a module's own
showcase, where plates are suppressed). `reviewer` and `tester` then ran in parallel and both
independently reproduced every claim that mattered — and the reviewer found one real bug this
round, plus one documentation error:

- **A real overlap bug, confirmed and fixed.** The `avoid` box only ever protected the battle
  card. `travel` and `offline` are neither `full` nor `hidesHud` (the wallet is meant to stay up
  over them — `panels/offline.js`'s own comment) but both scrim the *entire* screen themselves
  (`windowFrame`'s `g.scrim`, or `offline.js`'s own copy of it), so a plate kept drawing over —
  or worse, *anywhere on* — a dimmed scene while either was open. Reproduced from a real,
  non-showcase scene with two screenshots (menu and travel both opened over a live hunt). Fixed
  by keying the exception on the two panels that draw no scrim at all — `battle` and `menu`,
  both now handing their own box back the same way — and suppressing plates entirely under
  every other panel, matching how the party bar and button strip already behave. `menu.js`
  gained the same `return box` `battle.js`'s card already had.
- **A wrong metric cited as evidence.** DECISIONS #88 first pointed at `regress`'s `p99`/
  `over200Pct` (pixel-*brightness* histogram stats) moving on `boot/12` as proof the `lateFrame`
  dirty-marking cost was "measured, not assumed." Neither metric is a timing number, and
  `regress`'s own matrix shoots a showcase for every other row — exactly where plates are
  suppressed — so it structurally cannot see this cost at all. Corrected to cite the metric that
  actually matters, `fps`/`p95ms` against a **real** scene: 60 fps mean, 16.7–16.8 ms p95 across
  `hunt-meadow`, `hunt-forest`, `hunt-cave`, `hunt-coast` and `demo-city`, all comfortably inside
  the `boot` stage's own 50 fps / 20 ms budget — the check that would actually fail first.
- **`sim.npcs()`/`hunts.slots()` were each read twice per paint** (once inside the wild-plate
  pass, once inside the NPC pass) — a real, if minor, waste flagged in passing; `read()` now
  fetches each once and shares them.
- **`read()` had zero automated coverage** — `plates.test.js`'s own header says so; both
  `reviewer` and `tester` independently wrote and ran a throwaway Playwright spec proving the
  live-duel-HP behaviour, then deleted it per their own instructions. Closed properly this time:
  `tests/flows/plates.spec.js` pins exactly that property, using `ui`'s own `_lateFrame()` seam
  (`__HOOKS__.step()` drives the sim only, never a render frame, so plates never update from
  stepping alone — the reason nothing had exercised `read()` before).

Everything else the two agents checked — the additive `npcs()` shape against every existing
caller, the `MAX_PLATE_TILES` cutoff and its boundary (measured exact: dist 14 included, 15
excluded), the party's exemption from it, city label fallback order, the `hunts.current()`
staleness after leaving a hunt (pre-existing, currently harmless by an incidental `npcs.find`
guard, not this slice's to fix), the moved `hpInk`'s byte-identical thresholds — came back
confirmed correct with exact values, not just "looks plausible."

One more real bug, caught by the vitest suite before either agent saw the diff: the collision
rects used for stacking were the *logical* `x,y,w,h`, one to two pixels smaller than the actual
painted footprint (`x-2,y-1,w+4,h+2`) — two plates whose logical boxes just cleared each other
still had their backgrounds touch by a pixel, which a screenshot (`plates-hunt.png` →
`plates-hunt5.png`, four iterations) had already shown as two names stitched into one label
before the padding was accounted for and the retry loop's "give up" branch was changed from
snapping back onto the collision to skipping the plate outright.

Final `npm run gate` after every fix, clean tree: **every stage passed (260 s)** — lint 2.6s,
typecheck 0.4s, seams 1.5s (166 files, 18 modules), unit 0.9s (10 files, 49 tests), build 3.5s,
coldboot 3.7s, boot 95.4s (24/24 entry points), flows 48.4s (**22 specs**, incl. the new
`plates.spec.js`), parity 36.0s, regress 67.4s (**2 improved, 0 regressed, 0 moved**, across 18
frames — unchanged from round 1, since none of the fixes touched a captured frame's pixels).

Out of scope items (017–019) untouched; the `callout.js`/plate overlap is deliberate (see Out of
scope) and left for 018.
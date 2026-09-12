# 019 — A trainer panel: the whole card, not a one-pixel chip

Status: proposed          Branch / commit: hud/window-system / …

## Why

`economy` already computes everything a trainer profile needs — level, wins-into-next,
lifetime totals, active buffs, upgrade tracks — and the HUD shows exactly one pixel of it: a
`TRAINER n` chip with a 1px progress bar (`src/ui/hud.js:122-133`, referenced from the earlier
exploration; the level and bar are the only trainer-facing numbers anywhere on screen). This
slice gives the rest of that data a real panel, built on 015/016's window/scroll primitives since
it is, by design, the panel most likely to overflow a single screen (five stacked sections).

## Inspected before writing this slice

- `src/economy/trainer.js` (full, 56 lines, quoted in the earlier exploration) — pure, no `ctx`.
  `STEP = 3`; `winsForLevel(n) = 3n(n-1)/2`; `levelFromWins` (closed-form inverse);
  `trainerFromWins(wins) → {level, wins, into, need, next}`. Exposed as `economy.trainer()` at
  `src/economy/index.js:584`: `trainer: () => trainerFromWins(progress().battlesWon)`.
- `src/economy/index.js:169-182` — `progress()`: `{dexCaught, totalEarned, shardsEarned,
  researchEarned, itemsBought, battlesWon, playSeconds, trainerLevel}`. `playSeconds` comes from
  `clock?.simTime` — **simulated** time, not wall time, so a captured/replayed session reports the
  same number, consistent with the rest of this codebase's determinism rule.
- `src/economy/index.js:651` — `stats: () => state.stats()` → (per `src/economy/state.js:71-77`,
  cited in the earlier exploration) `{earned:{}, spent:{}, itemsBought, itemsSold, itemsUsed,
  upgradesBought, battlesWon, ballsThrown, pokemonAppraised, sessionStartMs}`.
- `src/economy/index.js:639-640` — `multipliers: () => state.multipliers()`,
  `buffs: () => state.activeBuffs()`; `src/economy/state.js:237` —
  `.map((b) => ({ ...b, secondsLeft: Math.max(0, (b.until - t) / 1000) }))`, i.e. buffs already
  expire themselves out of the returned list (confirmed by reading `activeBuffs`'s filter above
  that line) — the panel does not need to hide an expired buff itself, it will simply not be in
  the array.
- `src/economy/index.js:605-621` (`upgrades()`, quoted in full above) — 11 tracks (confirmed by
  running `UPGRADES.length` — `payday, exp_share, expedition, capsule_lab, market_licence,
  apricorn_press, bag_upgrade, veteran_coach, daycare, dowsing_rig, shiny_lens`), each row:
  `{id, name, desc, currency, level, max, cost, effect, perLevel, mode, value, unlocked,
  affordable}`.
- `src/economy/index.js:534-535` — `bag()`/`stash()`, reused here only for a **held-item summary**
  line in the Bonuses section (items with `def.passive` — `held` category, e.g. Amulet Coin, Lucky
  Egg — are the ones worth surfacing on a trainer card; the full grid is 018's job, not this
  panel's).
- `src/collection/index.js:444-449` (`completion()`, cited in the earlier exploration) →
  `{total, seen, caught, owned, seenPct, caughtPct, livingPct, forms, byGen[], byType[]}` — the Dex
  block's source.
- `/assets/trainer/hero.png` — 32×768, 24 frames; south row `[11,12,13,21,22,23]`
  (ARCHITECTURE §5.5, confirmed by the earlier exploration's citation of `pokemon/sprites.js`).
  `pokemon.spriteUrl` only serves overworld species sheets, not the trainer sheet — the trainer
  portrait is loaded directly by URL through `g.image(url)`, the same loader every other panel
  uses, cropping frame 11 (first south-facing walk frame) the way `drawIcon` crops row 2 of an
  overworld sheet — this panel needs its own small crop helper since `drawIcon`'s 2×4 layout
  assumption does not fit the trainer sheet's single-column 24-frame layout.
  **Corrected at implementation** (this bullet assumed a live hero/heroine selection that does
  not exist): `src/simulation/index.js:99` — `trainerWho` is a private local that starts at
  `'hero'` and nothing in the module ever writes to it, and `formation()` (`:469`) returns
  `{head, input, autopilot, preferTags, label}` with no `trainer`/`who` field at all to read
  through `ctx.get` either. `city/layout.js`'s `heroine` entries (`centre-queue`, `shopper`) and
  `pokecenter/index.js`'s Nurse Joy are NPCs, not the player's own avatar. So there is no live
  "which trainer" to ask any module for yet, and the panel loads `/assets/trainer/hero.png`
  unconditionally, with no `simulation`/`pokemon` dependency for the portrait at all.
- `src/ui/panels/common.js` — `windowFrame`, `section`, `scrollArea` (015/016) for the five
  stacked blocks, `stat` (`:140-143`) for every label/value line.
- `src/ui/index.js:148-159`, `src/ui/input.js:61-69` — registration points, same constraint as
  018: both lists must agree or `ui.selfTest()` fails. `KeyR` and `Digit8` confirmed unbound.

## Files / modules affected

New: `src/ui/panels/trainer.js`, `src/ui/panels/trainer.test.js`.

Edited: `src/ui/index.js` (`PANELS` entry, strip chip, menu row), `src/ui/input.js` (`PANEL_IDS`,
`KeyR`/`Digit8`), `src/ui/panels/menu.js` (`ITEMS` gains a `TRAINER` row).

## Expected behaviour

- `KeyR` (or `Digit8`, the strip chip, or the menu) opens a panel with, top to bottom inside a
  scrolling area: portrait + level + `into/need` bar; the four currencies
  (`economy.currencies()`); **Progress** (dexCaught, battlesWon, itemsBought, ballsThrown,
  playSeconds — `stats()`+`progress()`); **Bonuses** (`multipliers()`, `buffs()` with
  `secondsLeft`, held-item passives from `bag()`); **Upgrades** (11 tracks: level/max/cost,
  greyed when unaffordable, exactly as `upgrades()` already reports); **Dex** (`completion()`
  summary); **Party** (a compact six-row summary — species, level, HP fraction — distinct from
  017's always-on bar, since this is inside a scrollable detail view, not a fixed overlay).
- The level and bar match `economy.trainer()` live; a buff whose `secondsLeft` reaches 0
  disappears from the list on the next repaint (it is simply absent from `buffs()`'s return, no
  special-casing needed in the panel).
- The whole content is reachable via 015's `scrollArea` at the smallest tested buffer
  (`320×180`, 016's own halved `uiScale:2` case).
- `npm run gate` exits 0.

## Acceptance criteria

1. `src/ui/panels/trainer.test.js` (vitest, no canvas): given a fake `economy` returning a fixed
   `trainer()`/`progress()`/`upgrades()`/`buffs()`, the panel's content-model function (exposed the
   `travel.js`/`rows()` way) produces the five sections in the stated order with the correct
   numbers, including a buff past its `secondsLeft` window being absent.
2. A flow spec: win a battle (existing hunt-flow pattern), reopen the trainer panel, assert the
   level/wins bar advanced by exactly what `trainerFromWins` predicts for the new win count
   (literal, per `trainer.js`'s own documented triangular formula — not a second live read).
3. A flow spec: buy one level of an upgrade in the shop, then read the trainer panel's Upgrades
   block — the level and cost shown match `economy.upgradeLevel(id)`/`economy.upgradeCost(id,1)`
   exactly.
4. A flow or selftest case: at the `320×180` buffer (016's smallest), scroll the panel to its
   bottom and assert the Party summary section is reachable (its content model, not pixels).

## Tests required

Unit: `src/ui/panels/trainer.test.js`. Flow: extension(s) covering 2-4.

## Verification in the real application

`npm run dev`, `/?seed=1337`: `KeyR` opens the card; win a fight, watch the level bar move; buy an
upgrade, see it reflected; shrink the window / use `?uiScale=2` and scroll to the bottom.
`npm run shot -- --out shots/out/trainer.png` and look. Console: zero `error`.

## Docs to touch

`ARCHITECTURE.md` §5.12 (`ui`'s panel id list gains `trainer`).

## Out of scope

The inventory grid (018, already separate). Any change to `economy`'s own API — this panel is a
pure consumer of what already exists.

## Result

**Starting point** — `npm run gate:fast` on a clean tree (stashed before touching anything,
restored after), `GATE_PORT=5533`:

```
  lint       ok       3.0s
  typecheck  ok       0.6s
  seams      ok       2.0s
  unit       ok       1.1s
  build      skipped
  coldboot   skipped
  boot       skipped
  flows      skipped
  parity     skipped
  regress    skipped
  total               6.7s
✓ gate: every stage passed
```
(13 test files, 77 passed | 1 expected fail, before this slice's own two new suites existed.)

**What was built.** `src/ui/panels/trainer.js`: `trainerModel(app)` (the five sections —
Progress, Bonuses, Upgrades, Dex, Party — plus the header fields, a free function of
`ctx.get`, the `travel.js`/`rows()` and `inventory.js`/`filterRows` precedent) and `layout(model)`
(block heights with no `g` at all, so the scrollable content's total height is a plain number).
The window is built on `scrollArea` — its first caller, per ARCHITECTURE §5.12's own note that
it was "built but not yet wired into a panel" before this slice; that sentence is now corrected
there. Registered in `src/ui/index.js` (`PANELS.trainer`, the `TRAINER`/`R` strip chip after
`PARTY`), `src/ui/input.js` (`PANEL_IDS`, `KeyR` and `Digit8` → `trainer`), `src/ui/panels/menu.js`
(a `TRAINER` row after `PARTY`).

**Reality corrected.** The slice's own Inspected section assumed the trainer portrait's sprite
(hero vs. heroine) came from a live read through `simulation.formation()` or similar — re-reading
`src/simulation/index.js` before writing the panel found no such thing: `trainerWho` (`:99`) is a
private local fixed at `'hero'` that nothing ever writes to, and `formation()` (`:469`) carries no
`trainer`/`who` field to read at all. The panel loads `/assets/trainer/hero.png` unconditionally,
with no `simulation`/`pokemon` dependency for the portrait. The slice's Inspected section is
amended in this commit to say so.

**Tests.**
- `src/ui/panels/trainer.test.js` (vitest, no canvas) — 10 cases: the five sections in the stated
  order with the header fields off a fixed `economy.trainer()`; Progress's numbers off
  `progress()`/`stats()`; Upgrades carrying every track's `id`/`level`/`max`/`cost` exactly as
  `upgrades()` reports, greyed when unaffordable/locked/maxed; Bonuses only listing a multiplier
  once it has moved off its own base, naming the held item behind a passive from `bag()`'s held
  rows, and a buff disappearing the instant `buffs()` stops returning it (acceptance criterion 1,
  including the "past its `secondsLeft` window" case); Dex's completion summary; Party's fixed six
  rows including a fainted (0 hp) member and empty-slot padding; graceful degradation to a
  minimal fake `economy` exposing only `trainer()`/`progress()`/`upgrades()`/`buffs()` (the
  criterion's own fixture); and `layout(model)` proving the Party section is the last block, all
  six rows counted, with the total exceeding a 320×180 buffer's body by construction (acceptance
  criterion 4 — a content-model assertion, not a pixel one).
- `tests/flows/trainer.spec.js` (Playwright, `?seed=1337`) — two flows: (1) an unattended meadow
  encounter loop (`resolveUnattended` credits `outcome:'win'` on `battle.win` with no ball thrown,
  `src/encounter/index.js:1262-1265` — found while writing this flow and used to keep it simple
  rather than reprising `hunt.spec.js`'s manual throw) run until one wins, then the trainer
  panel's live model (`ui._state.panel.model()`, `hud-windows.spec.js`/`party-bar.spec.js`'s own
  `_state` precedent) is asserted against `trainerFromWins` imported directly from
  `economy/trainer.js` — the literal formula, not a second live read (acceptance criterion 2);
  (2) `economy.buyUpgrade('payday', 1)` (the same call the shop's own UPGRADE TRACKS shelf makes)
  followed by reading the panel's Upgrades row for `payday` against `economy.upgradeLevel`/
  `upgradeCost` directly (acceptance criterion 3).

**Visual check.** `npm run shot`-equivalent capture (a one-off puppeteer script, not committed)
at `?seed=1337`, `KeyR`: real portrait crop (frame 11, south-facing), readable Progress/Bonuses/
Upgrades rows, scrollbar thumb visible once content overflows the box. At `?uiScale=2` (320×180
buffer) the window is correctly clamped between the wallet/clock and the party bar/strip
(`hudReserved`/`clampToSafeArea`, unchanged by this slice) and a scrollbar thumb confirms the
content is taller than the box, matching `layout()`'s own unit-tested claim. Zero console errors
in either capture. One transient artifact was chased and ruled out: a screenshot taken well under
a second after `__READY__` (any panel, including the pre-existing, untouched `party.js`) shows a
faint ghost of a "READY" label bleeding through; it is gone once the capture allows normal settle
time (`tools/shots/shoot.js`'s own `--settle` spin) and reproduces identically on `party.js`,
which this slice never touched — a pre-existing boot-timing artifact, not a regression this slice
introduced, and outside this slice's scope to chase further.

**Docs corrected.** `ARCHITECTURE.md` §5.12: the panel id list, the key list (`KeyR`, `Digit1–8`),
`scrollArea`'s "not yet wired into a panel" note, and a new paragraph for `panels/trainer.js`.

**Full gate**, `GATE_PORT=5535`:

```
  lint       ok       2.6s
  typecheck  ok       0.4s
  seams      ok       1.7s
  unit       ok       1.0s
  build      ok       3.7s
  coldboot   ok       4.2s
  boot       ok       93.6s
  flows      ok       85.7s
  parity     ok       39.9s
  regress    ok       86.4s
  total               319.1s
✓ gate: every stage passed
```

10/10 stages green. `unit`: 14 test files, 87 passed | 1 expected fail (the pre-existing
`STATUS`-pinned failure, untouched). `boot`: 24/24 entry points. `flows`: 37/37, including both
new `trainer.spec.js` cases. `regress`: **0 improved, 0 regressed, 0 moved, across 18 frames** —
no baseline re-acceptance needed; this slice adds a panel and a strip chip but moves nothing the
regress gate's ten scalars track.

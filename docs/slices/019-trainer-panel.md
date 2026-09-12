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
  portrait is loaded directly by URL (`/assets/trainer/hero.png` or `heroine.png`, whichever the
  current formation uses; `simulation.formation()` or an equivalent read decides which, checked at
  implementation time) through `g.image(url)`, the same loader every other panel uses, cropping
  frame 11 (first south-facing walk frame) the way `drawIcon` crops row 2 of an overworld sheet —
  this panel needs its own small crop helper since `drawIcon`'s 2×4 layout assumption does not fit
  the trainer sheet's single-column 24-frame layout.
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

Filled in when done.

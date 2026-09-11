# PokeIdleHD2D

A browser Pokémon idle game in the HD2D style: 3D voxel-ish geometry textured with DS-era
pixel art, a fixed 45° camera, and a hunt that walks a closed loop past fixed spawn slots
while the tab is backgrounded or closed. Plain ES modules, three.js, Vite. No `.ts` files (types
are JSDoc, checked per file), no bundler tricks. Vitest for unit tests, Playwright for flows,
ESLint, `tsc` — all behind one command.

## Done means the gate exits 0

```
npm run gate
```

`node tools/gate.js --list` prints the stages in order (derived from `tools/gate.js`, not
restated here, because a restated list drifted). `npm run gate:fast` is the browser-free
subset (lint, typecheck, seams, unit — seconds) and the pre-commit hook runs it. Nothing is
finished on the strength of having been written carefully. If a check is wrong, fix the check
in the same commit and say so — never loosen a budget to get a green run.

Two things the gate will not do for you:

- **It cannot see composition.** `regress` compares ten scalars per frame (fps, draw calls,
  console errors, luminance and saturation statistics), so a sprite in the wrong place or a
  panel drawn off-screen passes it. For anything visual, take the screenshot and look at it:
  `npm run shot -- --out shots/out/x.png --tod 11`.
- **A deliberate visual change is expected to move `regress` metrics.** That is not a
  failure. Re-accept the baseline (`node tools/shots/regress.js --accept`) in the same
  commit and name the frames that moved in the commit message.

## Rules that are not negotiable

- **Randomness comes from `ctx.rng`.** `Math.random()` fails the seams. Same seed + same
  inputs ⇒ same world, forever.
- **Cross-module access goes through `ctx.get(id)`**, and only at the other module's
  `index.js`. Reaching into a sibling's internals fails the seams.
- **Select tiles by category and tag (`tiles.find`), not by name.** A model is named after its
  dominant texture, so the name is a build artefact (DECISIONS #6). `tiles.byName` exists as the
  escape hatch for the authored `structures`/`props` sets, whose names are chosen, not derived.
- **A handled path logs `warn`. `error` means a real fault** — the perf budget is zero
  console errors, so an `error` on a path you already recovered from fails every capture
  (DECISIONS #15).
- **A showcase is read-only and deterministic.** It stages a frame; it never writes a save.
- **`pixelsPerUnit` is 16, 32 or 64 and nothing else.** Sprites carry 16 texels/unit and
  tiles carry 32; anything off that ladder resamples them differently on every screen
  (DECISIONS #60).
- **Compose from real geometry.** An untextured box, a magenta placeholder or a flat-shaded
  primitive is a bug, not a milestone.
- **Every scene needs a motivated light source.** Lamps, windows, torches, shafts through a
  canopy. Blind A/B judging against reference stills (`docs/STATUS-ARCHIVE.json` →
  `gate.blindJudging`) lost every flat-daylight frame.
- **Money is earned by selling, never accrued by the clock.** A backgrounded or closed tab
  mints experience, drops, catches and research — never money. Where the code currently
  deviates from this rule, `docs/STATUS.json` says so under `open`.

## Where the code lives

One folder per module under `src/`, each a default-exported descriptor with `id`, `needs`,
`init(ctx)` and `showcase`. `src/core/` is the only thing every module may import.

| module | owns |
| --- | --- |
| `core` | registry, event bus, clock, seeded rng, config, the render pipeline |
| `tiles` | tileset loading, materials, geometry, auto-tiling |
| `terrain` | maps, heightfield, collision |
| `environment` | sky, sun, weather, per-time-of-day grade |
| `simulation` | the grid walker and the tick everything is looked at through |
| `pokemon` | species data, party, instances, overworld sprites |
| `battle` | type chart, moves, the turn engine (`engine.js` is pure — no `ctx`; `index.js` takes `ctx`, fetches the move data and keeps a small save slice) |
| `encounter` | spawn tables, spawn slots, catching |
| `idle` / `offline` | accrual in a live tab / catch-up for a closed one, and the save format |
| `economy` | currency, items, shop, prices, the pity ledger, the trainer's level |
| `collection` | dex, boxes, organisation |
| `automation` | ten automations — hunt, catch, ball, heal, revive, ether, lead, release, sell, restock — and the rules they run on |
| `ui` | HUD, panels, dialogue — one 2-D canvas, zero draw calls |
| `city` / `hunts` | the lobby / the four biomes |
| `travel` | where the player is, and how they leave |
| `preview` | asset viewer; registered on every boot but inert until `?showcase=preview` |

Diagnostic URLs: `?showcase=<module>[&mode=<m>]` boots one module, what it needs, and
`environment` + `ui`; `?scene=<id>` boots a destination (and stands the trainer-level lock down
for that id); `?debug=1` draws the overlay; `?break=<a>,<b>` quarantines modules; `?seed=`,
`?tod=` and `?timeFrozen=1` pin what a capture sees. Every key in `src/core/config.js DEFAULTS`
is a URL param.

## Testing

Four kinds, each for what the others cannot see:

- **`src/<module>/selftest.js`** runs under plain Node and exits non-zero on failure. The seams
  discover them by existence and refuse one that prints nothing. Golden values from seed 1337,
  invariants swept over many runs. Compare against **literals**, not against a second live
  call: two calls reorder identically and agree while both are wrong (DECISIONS #35).
- **`src/<module>/*.test.js`** (vitest) for fine-grained behaviour with real diffs; import the
  real module and `init(stubCtx)` it. Tests obey the module boundaries like any other file.
- **`tests/flows/*.spec.js`** (Playwright) for user flows at `/`: drive through
  `window.__HOOKS__` (`step`, `key`, `pause`) and `__CTX__.get(id)`, assert on bus events and
  module state — never pixels, never DOM selectors (the UI is one canvas). Bound every
  step-until loop so it fails with a message, never by timeout. Seed the world with `?seed=`.
- **The screenshot stages** (boot, parity, regress) for what only a frame shows.

Logic only reachable in a browser and only worth a frame goes in a `selfTest()` on the module's
API (`reportSelfTest` in `core/log.js`), which `console.error`s on failure so the capture sees it.

**A known bug is pinned, not hidden.** `it.fails` / `test.fail` with `// STATUS:<id>` on the
line before it, where `<id>` is an `open` entry in `docs/STATUS.json` naming that test. The
seams refuse either half without the other, so the expected failure cannot outlive the fix.

**Type checking is opt-in per file** (`// @ts-check` at the top, JSDoc types) and zero errors
is the bar; a file never opts back out.

## How work is done

**The unit of work is a slice** — `docs/slices/NNN-<slug>.md`, from `TEMPLATE.md`, written
*after* inspecting the code it will touch and small enough to finish in one sitting. Never a
multi-phase plan: the twelve commits of one day that this workflow replaced were "phase A…D"
of a brief, and the gate's build stage did not run for any of them.

**Roles**, as `.claude/agents/*.md`: `implementer` (the only one that edits app code; re-reads
every file the slice names before editing), `reviewer` and `tester` (always, in parallel; they
run the checks themselves and read the diff — an implementer's summary is not evidence),
`integrator` (when `needs`, an event, the save format or ARCHITECTURE.md changes),
`adversary` (when `economy`, `idle`, `offline`, the save format or a flow is touched). Then
`npm run gate` green, then commit — the message names any regress frame that moved.

**Reality wins.** Before implementing, re-inspect the modules the slice names. If the code
disagrees with the slice, ARCHITECTURE.md, DECISIONS or STATUS, the code is right and the
document is corrected in the same commit. A generated summary is an input to inspection, not a
substitute for it.

**Parallel agents work in separate `git worktree`s with their own `GATE_PORT`**: two gates on
one port share a server the first one kills on exit.

## The other documents

- **`ARCHITECTURE.md`** — the contract: what each module exports, the events, the units, the
  save format. Read it before changing a module boundary, `src/core/`, an event, or the save
  shape. Where it and `src/` disagree, the code wins and the doc is a bug.
- **`docs/STATUS.json`** — what is true right now and what is still broken. Read it when
  picking up work.
- **`docs/DECISIONS.md`** — the live decision log, from #71. Add an entry when a choice
  constrains future code and the reason is not obvious from reading that code, and cite it
  from the code it constrains.
- **`docs/DECISIONS-ARCHIVE.md`** — entries #1–#70, frozen. Hundreds of comments in `src/` and
  `tools/` cite one by number; when you hit `DECISIONS #34`, jump straight to it
  (`grep -n '^### 34 ' docs/DECISIONS-ARCHIVE.md`) rather than reading from the top. Entries
  correct each other *forward*, so check for later ones that touch it before acting on what
  it says.

Everything else — what happened during a piece of work, what was measured, what moved —
goes in the commit message.

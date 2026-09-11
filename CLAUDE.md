# PokeIdleHD2D

A browser Pokémon idle game in the HD2D style: 3D voxel-ish geometry textured with DS-era
pixel art, a fixed 45° camera, and a hunt that walks a closed loop past fixed spawn slots
while the tab is backgrounded or closed. Plain ES modules, three.js, Vite. No TypeScript,
no test framework, no bundler tricks.

## Done means the gate exits 0

```
npm run gate
```

`node tools/gate.js --list` prints the stages in order (derived from `tools/gate.js`, not
restated here, because a restated list drifted). Nothing is finished on the strength of having
been written carefully. If a check is wrong, fix the check in the same commit and say so — never
loosen a budget to get a green run.

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

**`src/<module>/selftest.js` runs under plain Node and exits non-zero on failure.** The
seams discover them by existence — writing one starts enforcing it immediately, with nothing
to register. Write one for anything deterministic: a formula, a table, a state machine, a
save migration, a boot decision. Compare against **literals**, not against a second live
call: two calls reorder identically and agree with each other while both are wrong
(DECISIONS #35).

Logic only reachable in a browser goes in a `selfTest()` on the module's API instead. It
must `console.error` on failure, or a red invariant is invisible to the capture harness.

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

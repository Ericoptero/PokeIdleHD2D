# PokeIdleHD2D — Technical map

A browser Pokémon idle game with DS-era pixel art on 3D geometry, an orthographic camera,
a city and four hunt biomes. Plain JavaScript ES modules, three.js and Vite.

## Entry and runtime

- `index.html` hosts the scene and UI canvases and loads `src/main.js`.
- `main.js` builds config, bus, clock, seeded RNG, renderer and registry, then registers
  modules. `src/core/registry.js` derives initialization order from descriptor `needs`.
- Normal boot enters the saved destination through `travel`; showcase boot initializes
  the closure of the selected module, its `showcaseNeeds`, `environment` and `ui`.
- The frame loop runs fixed simulation ticks, `frame`, camera rig update, `lateFrame`,
  sun update and rendering. Camera-dependent projection belongs in `lateFrame`.
- `src/core/config.js` defines defaults, overlaid by saved config and URL parameters.
  `?showcase=<id>&mode=<mode>`, `?scene=<id>`, `?debug=1`, `?break=a,b`, `?seed=1337`,
  `?tod=12` and `?timeFrozen=1` are useful investigation entry points.
- `window.__CTX__` exposes module APIs; `__READY__` marks the first presented frame
  (or a fatal boot, reported in `__FATAL__`). `__HOOKS__` in `main.js` controls test stepping,
  input, presets and metrics; `types/globals.d.ts` describes the globals.

## Subsystems

Each module lives in `src/<id>/`; its `index.js` is the public entry and descriptor.

| Location | Responsibility / useful starting points |
| --- | --- |
| `src/core/` | Registry, bus, clock, RNG, config, logging, render pipeline and camera rig |
| `src/tiles/` | Pack loading, materials, instancing, auto-tiling; `materials.js`, `instanced.js` |
| `src/terrain/` | Maps, heightfield and collision; `draft.js` |
| `src/environment/` | Sky, sun, weather, grading, lamps and shadow filtering |
| `src/simulation/` | Grid walking, party cast, routes and simulation ticks |
| `src/pokemon/` | Species, instances, party, evolution and overworld sprites |
| `src/battle/` | Pure turn engine in `engine.js`, moves, types and stats; API/save adapter in `index.js` |
| `src/encounter/` | Spawn tables, catch rolls, battle staging, action beats and `vfx/` |
| `src/idle/` | Live/background accrual; pure folding in `accrual.js`, scheduling in `drain.js` |
| `src/offline/` | Closed-tab catch-up, persistence, migrations and save providers |
| `src/economy/` | Currency, inventory, shops, pricing, upgrades, pity and trainer level |
| `src/collection/` | Dex, boxes, storage and sorting |
| `src/automation/` | Hunt/catch/supply rules, unlock pricing and duel orchestration |
| `src/ui/` | Códice DOM screens/HUD (`dom/`, `screens/`, `css/`) plus the world-overlay canvas (plates, callouts, floaters) |
| `src/city/`, `src/hunts/` | City layout and four biome maps, hunt loops and spawn slots |
| `src/pokecenter/` | Interior, Nurse Joy interaction, healing and cooldown persistence |
| `src/travel/` | Destinations, trainer locks, transitions and saved scene |
| `src/preview/` | Asset viewer activated by `?showcase=preview` |

## Essential contracts

- Descriptors expose `id`, `init(ctx)` and `showcase(mode, ctx)`, with optional `needs`,
  `showcaseNeeds`, `tick`, `frame`, `lateFrame` and `dispose` hooks. `id` equals the folder name.
- Shared utilities come from `src/core/`. Cross-module runtime access uses `ctx.get(id)`
  through public APIs; deep imports into sibling internals are checked by `tools/seams/run.js`.
- Registry failures quarantine a module behind a null API. Check `api.__missing` before
  assuming it is live; handled recovery logs `warn`, real faults log `error`.
- Randomness uses `ctx.rng` and named forks so independent systems remain reproducible.
- Bus events are synchronous `namespace:verb` messages with plain payloads. Find emitters
  and listeners with `rg 'bus\.(emit|on|once)' src/<module>`; seams detect unproduced events.
- One cell is one world unit: +X east, +Y up, +Z south. Cell centers are `(cx+.5, y, cz+.5)`.
  `src/core/dir.js` fixes directions as south=0, west=1, north=2, east=3.
- Simulation deltas are seconds at 20 Hz; animation uses frame seconds; persistence and
  catch-up use wall milliseconds. `src/core/clock.js` defines limits and manual stepping.
- The orthographic pixel grid uses `pixelsPerUnit` 16/32/64. `pixelScale` controls integer
  upscaling; camera distance is standoff, not zoom. Sprites use 16 texels/world unit.
- The render pipeline in `src/core/render.js` renders at internal resolution, extracts bloom,
  then composites with nearest upscaling, grading, vignette and grain.
- Tile selection uses category and tags; derived texture names are unstable. Authored
  `structures` and `props` have chosen names and can use `tiles.byName`.
- Showcases are deterministic with frozen time and seeded input, and use read-only saves.
  `tools/shots/shoot.js` injects `timeFrozen=1` and applies presets through `__HOOKS__`.

## Persistence

- `src/offline/save.js` owns `localStorage['pokeidle.save']`: a versioned JSON document
  with timestamps, metadata, per-module `slices` and a checksum. Unknown slices survive.
- `src/offline/migrations.js` defines the document version and forward migrations.
  Modules version their own save payloads independently.
- `src/offline/slices.js` discovers native `saveState`/`loadState` or `snapshot`/`restore`
  providers and supplies adapters. Late-initialized modules such as `travel` and `ui`
  register themselves. Scene-dependent position restoration waits for the matching scene.
- Corrupt and future saves are parked separately; a failing provider is isolated.
  `src/offline/selftest.js` covers migration, repair and round-trip behavior.
- `src/idle/unlock.test.js` locally pins the known fresh-save research deadlock with `it.fails`.

## Assets and investigation tools

- `assets/` holds source art; `public/generated/` contains committed runtime packs and
  species/move catalogs. `vite.config.js` copies overworld/trainer art into production builds.
- `tools/assets/` converts tiles and authored structures; `src/pokemon/tools/` builds data.
  Pack/catalog shapes are defined by the builders and consumed by `src/tiles/index.js`.
- `tools/props/analyze.js` produces `tools/props/worklist.json`, an input to `adapt.py` in
  Blender. `tools/structures/` authors building geometry and textures.
- `.mcp.json` configures Blender with a local path. Tile source paths are also machine-specific
  in `tools/assets/build-tiles.js`; inspect them before rebuilding generated assets.
- `src/<module>/selftest.js` provides Node checks discovered by seams; `*.test.js` uses Vitest.
  Browser flows live in `tests/flows/` and use `harness.js`, `__HOOKS__` and module APIs.
- `tools/gate.js` combines optional checks and supports `--list`, `--only` and `--skip`.
  `tools/shots/` provides individual captures, matrices, boot, parity and regression checks.
  Capture budgets live in `shoot.js`; the baseline is `docs/baseline.json`, references in
  `docs/refs/`. Default generated reports and captures go to ignored `shots/out/`.

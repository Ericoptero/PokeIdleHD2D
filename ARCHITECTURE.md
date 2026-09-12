# PokeIdleHD2D — Architecture

> **The contract, reconstructed from the code on 2026-09-11.** What each module exports, the events, the units, the
> save format, the harness. Where it and `src/` disagree, the code wins and this file is a bug — fix it in the same
> commit. The rules of work live in `CLAUDE.md`; the reasons in `docs/DECISIONS.md`; what is broken in `docs/STATUS.json`.

## 0. What we are building

A browser Pokémon idle game in the HD2D style: real 3D geometry textured with DS-era pixel art, a fixed 45°
orthographic camera, four-way grid movement, a lobby city and four hunt biomes. A hunt is a closed loop the party walks
past fixed spawn slots; meeting an occupied slot starts a turn-by-turn battle, and a defeated wild is thrown at once. The
design rules (randomness, module boundaries, tiles by tag, `warn` vs `error`, showcases, the `pixelsPerUnit` ladder,
real geometry, motivated light, money by selling) are the non-negotiables in `CLAUDE.md`. Three are load-bearing below:

- **Money is earned by selling drops and releasing Pokémon, never accrued by the clock.** A backgrounded or closed tab
  mints experience, drops, catches and research.
- **Evolution is manual and paid for**: `pokemon.evolve()` from the party panel's EVOLVE button, costing a level and a
  bill of drop materials (plus the mainline stone on a stone route), spent through `economy.take`.
- **The trainer has a level**, derived from battles won (`economy.trainer()`), gating which destinations `travel.go()`
  accepts.

Where the code deviates from these rules today, `docs/STATUS.json` `open` says so: `watched-win-mints-money` (a watched
win credits money directly), `research-unmintable` (no path mints research from a fresh save),
`closed-tab-exp-discarded` (closed-tab experience is computed but never granted).

## 1. Stack and layout

| Concern | Choice |
| --- | --- |
| Renderer | three.js `^0.185.1`, WebGL2 |
| Bundler / dev server | Vite `^8.2.2`; dev `127.0.0.1:5173` `--strictPort`, preview `4173`; alias `@` → `/src`; a plugin copies `assets/{overworld,trainer}` → `dist/assets/` (`vite.config.js` `RUNTIME_ASSET_ROOTS`) |
| Language | Plain ES modules. No `.ts`; types are JSDoc, checked per file that opts in with `// @ts-check` (`tsc -p tsconfig.json`, `noEmit`) |
| Tests | vitest `^4` (`src/**/*.test.js`, `tools/**/*.test.js`, node environment); Playwright `^1.63` (`tests/flows/*.spec.js`, one worker, 1280×720); ESLint `^10` (`eslint.config.js`) |
| Capture | `puppeteer-core` driving real Chrome — `CHROME_PATH` or the macOS default in `tools/shots/chrome.js`, shared with Playwright |
| Node | `^20.19.0 \|\| >=22.12.0`; `tools/` and `src/*/selftest.js`, `src/pokemon/tools/*` are Node scripts |

`src/<module>/index.js` default-exports one descriptor (§2.1); `src/core/` is the only thing every module may import.
`assets/` holds source art (`overworld/`, `trainer/` shipped to the browser; `structures/`, `props/` baked by `tools/`);
`public/generated/` is committed build output (§9); `tools/` is Node-only and never imported by `src/`; `shots/out/`
holds every gate artifact and is ignored; `docs/progress/` holds kept screenshots and is tracked.

**Entry.** `index.html` has `#stage` (canvas host), `#ui` (overlay), `#boot`, `#fatal`, and loads `/src/main.js`, whose
`boot()` runs: (1) `makeConfig()` — `DEFAULTS` ← `localStorage['pokeidle.config']` ← URL (§2.6); (2) the `ctx` object
(§2.2), exposed as `window.__CTX__`; (3) `registry.add` × 18; (4) `registry.init` in the derived order below — under
`?showcase=<id>` only the closure of `[id, ...showcaseNeeds, 'environment', 'ui']`; (5) `registry.showcase(id, ?mode ??
'default')`, or at `/` `travel.go(travel.boot())`, falling back to `go('demo-city')` and then to `city.enter()` /
`hunts.enter()` when `travel` is quarantined; (6) the rAF loop `clock.beginFrame` → `registry.tick` × steps →
`registry.frame` → `rig.update` → `registry.lateFrame` → `sun.update` → `view.render`, `perf:sample` at 1 Hz; (7) the
first presented frame emits `boot:ready { ms }` and sets `window.__READY__ = true`. A boot failure logs `fatal`, sets
`__READY__ = true` and `window.__FATAL__` so the harness captures it.

**Init order is derived, not the array order in `main.js`.** `registry.init` is a Kahn sort over `needs` with the ready
queue re-sorted alphabetically after every dequeue: battle, economy, environment, pokemon, collection, tiles, preview,
terrain, city, encounter, automation, hunts, pokecenter, simulation, idle, offline, travel, ui. So `offline` discovers its save
providers before `travel` and `ui` exist (§10), and `battle`'s data fetch completes before `economy` starts.

**URL parameters.** Every key of `src/core/config.js` `DEFAULTS` (§2.6) plus `?mode=` (read by `main.js`). Read straight
from `location.search`, outside config: `?autowalk=0` and `?followerGapTiles` presence (`simulation`), some 25 `?env*`
diagnostics (`environment`), 16 tile knobs plus `?emissive`/`?variety`/`?contact`/`?kage` (`tiles`),
`?set/filter/cols/pad/focus` (`preview`), `?vfxType` (`encounter` showcase). `?preset=` is read by nothing in `src/`.
**Window globals.** `__READY__`, `__FATAL__`, `__CTX__`, `__HOOKS__` (§8), `__LOG__` (`core/log.js`), `__IDLE__`
(`idle`), `__ENVSHADOW__` (`environment`, always), `__ENVCASTERS__` (under `?envDumpCasters=1`).

## 2. Core (`src/core/`)

### 2.1 `registry.js` — descriptors, init order, failure isolation

```js
/** @typedef ModuleDescriptor { id, needs?, showcaseNeeds?, init(ctx), tick?(dt, ctx),
 *    frame?(dt, alpha, ctx), lateFrame?(dt, alpha, ctx), dispose?(), showcase?(mode, ctx) } */
```

`id` must equal the folder name and `init`/`showcase` must exist (seams rule 3). Statuses: `registered` → `ready` |
`failed` | `blocked` | `skipped` (not in a showcase closure).

- `init` awaits each module in the derived order (§1). A `needs` entry nothing provides is warned at resolve and blocks
  the module at init. A cycle is not fatal: every member is failed separately (`log.error` + `module:failed` each).
- Every `init`, `tick`, `frame`, `lateFrame` and `showcase` call is wrapped. A throw logs once with the id and stack, sets
  `status: 'failed'`, swaps the API for the **null object**, emits `module:failed { id, phase, error, stack }`, and never
  stops the frame loop. Dependents are marked `blocked` **only while still `registered`** — a runtime throw leaves
  already-ready dependents `ready`, running, and talking to the null object. A `showcase` throw is quarantined,
  rethrown, and logged a second time by `main.js`.
- The null object is a Proxy: every property is a no-op function (so `typeof x.f === 'function'` is true), `__missing`
  is the module id, each key is warned once. `ctx.get` of an unknown id returns a silent one and warns once.
  `isLive = (api) => !!api && api.__missing === undefined` is the only honest liveness test.
- `?break=a,b` fails those modules instead of initialising them, down the same path, at `warn` (a requested quarantine
  is a handled path; §7 budgets zero errors).
- `lateFrame` runs after `rig.update()` placed the camera and before `view.render()`; a `frame` hook reads last frame's
  `camera.matrixWorld`.
- `status()` → `[{ id, status, initMs, error }]`; `has(id)` is `status === 'ready'`; `descriptor(id)`, `closure(ids)`,
  `dispose()` (reverse init order, calls `desc.dispose`, never `api.dispose`).

### 2.2 The context object

Built inline in `src/main.js` (there is no `core/ctx.js`):
`ctx = { THREE, registry, bus, clock, rng, config, log, three: { renderer, scene, camera, view, rig, sun }, get(id) }`.
`three.view.grade` reaches the post-stack uniforms; `three.rig` is the camera rig; `three.sun` the casting light;
`get(id)` returns another module's API or the null object.

### 2.3 `bus.js`

`on(type, fn, {once}) → off`, `once`, `off`, `emit(type, payload)`, `spy()` (last 256, oldest first), `types()`,
`clear()`. Synchronous, snapshot iteration, a listener is dropped after 3 throws, recursion deeper than 32 is refused.
Names are `namespace:verb`; payloads are plain objects; every event is in §4.

### 2.4 `clock.js`

| Name | Unit | Source | Use |
| --- | --- | --- | --- |
| `frameDt` | s | rAF delta clamped to `[0, 0.1]` | animation, camera |
| `SIM_DT` | s | fixed `1/20` (`SIM_HZ` 20); at most 8 steps per frame, the accumulator is dropped when further behind | all gameplay |
| `wallMs()` | ms | `Date.now()` | idle accrual, catch-up, saves |

`clock.simTime` is the monotone simulated seconds gameplay may read; `pause()`/`resume()`; `forceSteps(n)` advances
`simTime` without rendering (`__HOOKS__.step`).

### 2.5 `rng.js`

`makeRng(seed, label)` — xoshiro128\*\* seeded from `splitmix32(hashString(label) ^ seed)`; `next`, `int`, `float`,
`bool`, `pick`, `weighted`, `shuffle`, `save`, `load`; `fork(childLabel)` derives an independent stream labelled
`<label>/<childLabel>`, so call order between modules cannot perturb results. Also `hashString(str, seed)`,
`noise2(x, y, seed)`. `Math.random()` fails seams rule 1; `seam-allow` on the line is the escape hatch.

### 2.6 `config.js`

`DEFAULTS` is a plain (unfrozen) object of 56 keys. `makeConfig()` overlays `localStorage['pokeidle.config']` (every key
except the session-only `break`, `showcase`, `scene`) and then the URL (`?key=value`; numbers coerced with the default as
fallback, booleans true for `''`/`1`/`true`; unknown keys ignored). API: `get(k)`, plain reads (`config.tod`), `all()`,
`set(patch)` (live, fires `onChange` — `environment.apply` writes grade keys on every call), `onChange(fn)`, `persist()`
(writes the non-default diff; called only by `environment.tune()`), `reset()`. Session tunables live here; balance
tables are module constants (`idle/accrual.js`, `economy/*.js`). `pixelsPerUnit` accepts any number — the 16/32/64
ladder is a rule, not a check. `turnSteps` and `settleFrames` are parsed and read by nothing.

### 2.7 `render.js` — the pipeline

```
scene ─▶ sceneRT (HalfFloat, W/pixelScale × H/pixelScale, colour + depth renderbuffer) ─┬─▶ bright threshold ─▶ 3 blur mips ─┐
                                                                                        └──── NEAREST upscale ────────────────┴─▶ one composite pass ─▶ canvas
```

The composite applies exposure, AgX, a `uLift`/`uGain` grade, saturation, soft-toe contrast, and vignette + grain
quantised per internal pixel (grain phase frozen unless `grainAnimate` and not `timeFrozen`). No LUT, no depth or
normal target; fog is three's forward `FogExp2`, set by `environment`.

- **`pixelsPerUnit` (32) is the pixel grid**: one world unit is that many internal pixels at every depth. `pixelScale`
  is the integer upscale; `0` derives `round(width / targetInternalWidth)` and bumps it until the buffer fits
  `maxInternalWidth`. Both internal dimensions are rounded up to even; the canvas overscans rather than letterboxes.
- Camera: `OrthographicCamera`, pitch `cameraPitch` 45°, yaw fixed, rotation set (not `lookAt`). The rig follows the
  trainer focus with frame-rate-independent exponential smoothing (`cameraDamping`) and snaps to whole internal pixels
  when `cameraSnap`; `cameraDistance` is near/far standoff only. `rig.PPU = { wide: 16, normal: 32, close: 64 }`;
  `rig.frame(cx, cz, y, { ppu })`, `rig.fitFraming(cellsWide, cellsDeep)`, `rig.setFocus(x, y, z, immediate)`.
- Shadows: one casting `DirectionalLight` (`three.sun`) with an ortho frustum of `shadowExtent` (56) world units,
  `shadowMapSize` 2048², snapped to shadow-map texels around the focus every frame. `render.js` asks for
  `PCFSoftShadowMap`; three substitutes `PCFShadowMap`, and `environment/shadowFilter.js` sets `PCFShadowMap` explicitly
  and installs its own PCSS-style filter by rewriting `THREE.ShaderChunk.shadowmap_pars_fragment`.
- `view.stats()` (draw calls, triangles, programs) feeds `__HOOKS__.metrics()`; `view.internalSize`, `view.displayRect`.

## 3. Units, axes, grid, time of day

One tile = one world unit; on screen `pixelsPerUnit` internal pixels, everywhere in the frame. Axes: **+X east, +Y up
(1.0 = one tile of elevation), +Z south** (toward the camera). A cell is `(cx, cz)`, integers, centre
`(cx + 0.5, y, cz + 0.5)`. Directions (`core/dir.js`, fixed forever): `SOUTH 0 (+z), WEST 1 (−x), NORTH 2 (−z),
EAST 3 (+x)`; `DIR_DX = [0,−1,0,1]`, `DIR_DZ = [1,0,−1,0]`, `opposite`, `turnRight`, `turnLeft`, `dirTo`.

### 3.1 PDSMS → world

PDSMS tile OBJs are Z-up, one unit per cell, origin at the tile's north-west corner. The exporter (`tools/assets/pdsts.js`)
applies `worldX = objX, worldY = objZ, worldZ = objY` once, at build time, and aligns each triangle's winding to its
stored normal. There is no runtime axis conversion; a placement's quarter-turn `rot` yaw is composed into the instance
matrix when the world is built (§7), and `tiles` rewinds downward faces at load.

### 3.2 Time of day

`tod` is hours in `[0, 24)`, `12` = solar noon, advanced by `environment` every sim step at `secondsPerGameHour` (60)
unless `timeFrozen`. The true sun is `solarPosition(tod, config.latitude 36°, DAY_OF_YEAR 96)`; what is drawn is bent by
`config.sunAzimuthOffset` (38°) and soft-capped at `config.sunMaxElevation` (46°), with a 3.4° elevation floor; at night
the key is the moon at the sun's antipode. Phases (`tod:changed` fires on a change): night < 4.6, dawn < 6.3,
morning < 8.6, day < 16.2, goldenHour < 18.4, dusk < 19.6, night.

## 4. Events

Every runtime `bus.emit` in `src/` (selftests and showcases excluded). `offline` marks its store dirty on the seven rows
flagged †. Seams rule 8 fails a listener for a name nothing emits.

| Event | Emitter | Payload | Listeners |
| --- | --- | --- | --- |
| `module:failed` | core registry | `{ id, phase, error, stack }` | — |
| `perf:sample` | main.js, 1 Hz | `{ fps, drawCalls, tris }` | — |
| `boot:ready` | main.js, first frame | `{ ms }` | economy (once → `announce`) |
| `tiles:loaded` | tiles | `{ slug, models }` | — |
| `world:loaded` † | terrain | `{ mapId, w, h, biome, placements, meshes }` | automation, encounter, idle, simulation, offline |
| `world:unloaded` | terrain | `{ mapId }` | city, hunts, idle, pokecenter |
| `tod:changed` | environment | `{ tod, phase }` | idle, ui |
| `party:leadChanged` † | pokemon | `{ instanceId, species }` | idle, simulation, ui, offline |
| `pokemon:levelled` | pokemon | `{ instanceId, from, to, learned }` | — |
| `pokemon:evolved` | pokemon | `{ instanceId, from, to, learned, spent, shiny }` | simulation, ui |
| `player:moved` | simulation | `{ cx, cz, dir }` — the trainer | — |
| `player:enteredTile` | simulation | `{ cx, cz, tags }` — the head of the queue | encounter, hunts, pokecenter |
| `scene:entered` | travel | `{ sceneId, mapId, biome, formation }` | offline |
| `battle:started` | encounter | `{ index, ally, wild, level, moves }` | — |
| `battle:strike` | encounter (not under `config.showcase`) | `{ index, turn, attacker, attackerSpecies, target, targetSpecies, move, name, struggle, damage, hits, effectiveness, crit, miss, immune, targetHp, targetMaxHp, status, fainted, cause, item, use }` | ui |
| `battle:ended` | encounter | `{ index, won, turns, hpFraction, allyHp, allyMaxHp, stalled }` | automation |
| `encounter:started` | encounter | `{ species, level, shiny, biome, index, tod, ivs, catchRate, slot }` | collection, ui |
| `catch:succeeded` † | encounter | `{ instanceId, species, shiny, level, ivs, ball, biome, index }` | collection, economy, idle, offline |
| `catch:failed` | encounter | `{ species, shiny, ball, odds, shakes, turn, index }` | — |
| `drop:collected` | encounter | `{ items: [{ id, n }], index }` | — |
| `encounter:resolved` † | encounter | `{ outcome: 'win'\|'flee'\|'fled', species, rewards, caught, ball, level, shiny, biome, index, turns }` | economy, ui, offline |
| `party:wiped` | encounter | `{ biome, index, moneyLost }` | travel |
| `economy:changed` † | economy | `{ currency, delta, total, reason }` | ui, offline |
| `collection:added` † | collection | `{ instanceId, isNewSpecies }` | automation, idle, ui, offline |
| `idle:tick` | idle | `{ elapsedS, gains: { money, exp, research, encounters, wins, catches, shinies, perSecond, biome, events } }` | automation, economy |
| `offline:applied` | offline | `{ awayS, gains, capped }` | automation, ui |
| `automation:changed` † | automation | the toggle map `{ <id>: boolean, autoHunt, … }` | offline |
| `automation:configured` | automation | `{ id, what }` | — |
| `hunt:lap` | hunts | `{ biome, length }` | — |
| `slot:respawned` | hunts | `{ biome, slot, species, shiny }` | — |
| `ui:toast` | automation, city, collection, economy, encounter, idle, pokemon, travel, ui | `{ text, kind }` | ui |

Adding an event: add the row here in the same commit, and a `docs/DECISIONS.md` entry if it constrains a listener.

## 5. Module contracts

`src/<id>/index.js` default-exports the descriptor; `init` returns the public API. Named exports beside it exist in
`encounter` (`THROWS_PER_FAINT`, `WIPE_PENALTY`) and `hunts` (`BIOMES`). Nothing else is importable across a module
boundary — seams rule 2 fails a static or dynamic import of a sibling's non-`index.js` file. A block below lists what
another module, a showcase or the harness may depend on; the module's own JSDoc is the authority on the rest.
**Undeclared** names the modules a block reaches through `ctx.get` without listing them in `needs`, and how the reach is
guarded: *isLive* (checks `__missing`) or *optional-chained* (degrades silently — the null object answers everything).

**The save seam.** A module opts in by exposing `saveState() → value` and `loadState(value) → boolean` (or the
`snapshot()`/`restore()` pair, which `offline` accepts as an alias). `loadState` is silent (no bus emits, no toasts),
tolerates an older slice, refuses a newer one at `log.warn` (`economy` and `idle` do not implement the refusal), and
rebuilds derived state. Discovery is one-shot inside `offline.init` among modules already `ready`, so a module that
initialises after `offline` self-registers through `offline.store.register` (`travel` does). §10.

### 5.1 `tiles` — `needs: []` · `showcaseNeeds` none declared (`main.js` treats a missing key as `[]`) · hooks `init, frame, showcase` · selftest **no**
API: `load(slug)` async → Tileset (fetches `/generated/tiles/<slug>/{pack.json,pack.bin,tex/*}`, memoised, emits `tiles:loaded`); `get(slug)`; `loaded()`; `models(slug)` → `TileModel[]` `{ id, name, category, subcategory, orientation, tags, biomes, collision, w, h, baseY, bounds, autotile, groups, globalUv, uvScale, tris }`; `find(slug, { category, subcategory, tags, biome, orientation, name, maxBaseY, maxCells, walkable, includeHidden })` (hides category `meta`, excludes tag `raised` unless asked, warns once per `name`); `byName(slug, name)`; `byId(slug, id)`; `pick(models, cx, cz, { salt, baseWeight })` position-hashed choice; `pickOne(models, rng)`; `variantsOf(slug, model)`; `footprint(model, rot)`;
  `autotile.sets(slug)`, `autotile.describe(slug, setId)`, `autotile.caseName(slug, sig)`, `autotile.covers(slug, setId, mask)`, `autotile.maskAt(slug, occ, w, h, x, z, outsideIsFilled)` (8-neighbour bitmask N=1 S=2 W=4 E=8 NW=16 NE=32 SW=64 SE=128), `autotile.solve(slug, setId, mask)` → model id or −1, `autotile.resolve(slug, setId, mask, { strict })`, `autotile.solveField(slug, setId, occupancy, w, h, opts)` → `Int32Array`, `autotile.solvePlacements(slug, setId, occupancy, w, h, { outsideIsFilled, strict, y0, underlay })` (preferred: carries each case's Y), `autotile.setFlipped(slug, flipped)`;
  `setEmissiveScale(k, slug?)` (scales every emissive material; one call latches off the module's own clock-following night ramp), `emissiveScale(slug?)`, `emissiveMaterials(slug)`; `buildInstances(scene, slug, placements, opts)` → `InstancedWorld` (throws if the slug is not loaded; §7); `InstancedWorld` class.
Events: emits `tiles:loaded` (no listener) · listens none. Showcase: `overview` (default and anything unmatched), any autotile set id (`set0`…`set10`) or set name, `catalog`, `rotate`/`rotation`, `variants`, `lamps`/`light`, `ground`, `trees`/`wood`.
Undeclared: `environment` (optional-chained; the night ramp reads `getTimeOfDay`). Night on a tileset is `tiles`' own ramp, not driven by `environment`.

### 5.2 `terrain` — `needs: ['tiles']` · `showcaseNeeds: ['tiles']` · hooks `init, showcase` · selftest **no**
API: `register(mapId, builder)` (a re-registration replaces at `warn`); `registered()`; `load(mapId, opts)` async → handle (unloads the previous map, builds a `MapDraft`, runs the builder, `tiles.load`, `tiles.buildInstances`, emits `world:loaded`; throws for an unregistered id); `unload()` (emits `world:unloaded`); `current()`; `draft()` → the live, mutable `MapDraft`; `world()` → `InstancedWorld`; `handle()` → `{ id, w, h, biome, tileset, spawn }` (the key is `id`, not `mapId`); `bounds()`; `inBounds(cx, cz)`; `height(cx, cz)` → the authored heightfield (0 unless a builder called `setHeight`; walkable tops are `simulation.surfaceAt`); `passable(cx, cz, fromDir)` (kinds `walk`/`stairs`/`shallow`/`door` pass; `ledge` only in its tagged direction); `tagsAt(cx, cz)` (the live array); `collisionAt(cx, cz)` (`'block'` by default); `MapDraft` class — `place`, `fill`, `autotile`, `scatter(rng, …)`, `mark`/`marker`/`markers`, `setHeight`, `setCollision`, `addTag`, `finalize` (only `place` refuses after finalize).
Events: emits `world:loaded`, `world:unloaded` · listens none. Showcase: the mode is ignored (one 40×40 meadow stage). Undeclared: none. Maps are data: a scene registers a builder and `load` runs it, which is what makes a map reproducible from a seed and disposable in one call.

### 5.3 `environment` — `needs: []` · `showcaseNeeds: ['tiles', 'terrain']` · hooks `init, tick, frame, showcase` · selftest **no**
API: `setTimeOfDay(t)`, `getTimeOfDay()`; `setBiomePreset(name)` → boolean (`meadow`, `city`, `forest`, `cave`, `coast`, `tundra`, `interior`), `presets()`, `biome()`; `setWeather(name, intensity = 0.7)` (`clear`, `rain`, `fog`, `snow`), `weather()`, `weathers()`; `sun()` → `{ azimuth, altitude, direction, colour, intensity, shadowLength }`; `phase()`; `look()`; `preset(name)` → boolean — tod framings `night 0.6, predawn 4.9, dawn 5.8, morning 7.6, day 9.4, noon 12, afternoon 15.4, golden 17.35, sunset 18.3, dusk 19.1, evening 20.6`; `tune(patch)` (look keys become in-memory overrides that do not survive a reload; other keys go to `config.set`; then `config.persist()`); `setEnclosure(v)`, `enclosure()` (≥ 0.5: the sun keeps lighting but stops casting); `shadow()`, `practicalShadow()`, `castShadows()`; `lamps.add(spec)`, `lamps.clear()`, `lamps.count()` — a lamp is one of 16 `THREE.PointLight` slots plus a glow quad and a pool decal; `skyUniforms`; `dispose()`.
Events: emits `tod:changed` on a phase change · listens none. Showcase: `default`, the eleven preset names, `weather:<name>`, `biome:<name>` (`cave`/`interior` build the enclosed stage). Undeclared: `terrain` (optional-chained; lamp ground height).
Owns the sky shader, sun/moon key + two non-casting fills, `FogExp2`, weather particles, the per-tod grade written into `config` on every `apply`, projected sprite shadows, and the shadow filter (§2.7). The per-frame `step(dt, focus)` is private.

### 5.4 `simulation` — `needs: ['terrain', 'pokemon']` · `showcaseNeeds: ['terrain', 'city']` · hooks `init, tick, frame, showcase` · selftest **yes**
API: `player()` → `{ cx, cz, dir, moving }` (the trainer); `moveIntent(dir)` → boolean (false when `formation.input` is false); `stop()`; `setFormation({ head, input, autopilot, route, strict, preferTags, label })` (installs STILL under `config.showcase`, `?autowalk=0` or `autopilot: 'none'`; `label` keys the wander's rng fork); `formation()`; `pause(on)`/`paused()` (stops the autopilot, keeps the route's place — a battle uses this); `halt()` (replaces the route with STILL, losing its place); `freeze(on)`/`frozen()` (stops everything incl. NPCs and idle animation — the screenshot tool); `follower()`; `followerCell()` (the head's cell); `spawnNpc(spec)` → `{ id, cx, cz, dir }` | null (32 cap; `solid: true` claims the cell in the party's collision map; `tether`, `route`, `wander`, `loop`); `npcs()`; `removeNpc(id)`; `holdNpc(id, on)`; `detour(dirs)`/`detouring()` (steps drained ahead of the autopilot); `placePlayer(cx, cz, dir)` and its alias `teleport` (seeds the starter party when `pokemon.party()` is empty, emits `player:moved` + `player:enteredTile`); `walk(spec, opts)`; `wander(opts)`; `autopilot()` → `'route'|'wander'|'still'` (reads the route's `kind`); `advanceSteps(n)`; `advanceTo(tiles, subTicks)` → `{ steps, t, moving }` (both step through a freeze — the harness path); `lineup()`; `trail()`; `gap()`; `frameOffset(dx, dz)`; `surfaceAt(cx, cz)`; `rebuildSurface()`; `debug()`; `dispose()`.
Events: emits `player:moved`, `player:enteredTile` on every landing · listens `party:leadChanged`, `pokemon:evolved` (restages the walker after `ui.evolution.TOTAL × 620` ms of wall clock — no flash is played), `world:loaded` (rebuilds the surface cache), `world:unloaded`. Showcase: `corner` (default and anything unmatched), `closeup`, `grass`, `south`, `wide`, `city`. Undeclared: `ui` (isLive), `tiles` (typeof-checked; the surface cache).
The queue is the trainer and the active Pokémon; which leads, whether keys move it and what walks it otherwise is the scene's formation (§5.13, §5.14). One cadence, `walkSecondsPerTile` 0.25; no diagonals; the camera follows the trainer.

### 5.5 `pokemon` — `needs: []` · `showcaseNeeds: ['terrain', 'battle', 'economy']` · hooks `init, lateFrame, showcase` · selftest **yes**
API: `species(idOrName)`, `all()`, `byGen(n)`, `byType(t)`, `count()`, `generations()`, `baseForms()`; `spriteUrl(species, { shiny })`, `spriteSheet(species, { shiny })`, `sprite(species, { shiny })` async, `trainers()` → `['hero', 'heroine']`; `sprites.prepare(requests)`, `sprites.spawn(spec)` → actorId (throws `TypeError` for an unknown species), `sprites.set(id, patch)`, `sprites.get(id)`, `sprites.remove(id)`, `sprites.clear()`, `sprites.count()`, `sprites.stats()`, `sprites.phaseFor(tiles)`, `sprites.field` (the `SpriteField`; `field.grid()` is what `__HOOKS__.grid` reports); `evolutionTiming()` → `{ ALTERNATE_S, TOTAL_S, swapsBy, frameAt }` (ui generates its keyframes from it); `SHEET`, `cycles`, `sheetLayout(kind, w, h)`; `party()`, `lead()`, `setLead(i)`, `addToParty(inst)` (max 6), `swap(i, j)`; `createInstance({ species, level, shiny, seed, ivs })`; `grantExp(instanceId, n, { source })` → report (never evolves; emits `pokemon:levelled`, toasts an affordable evolution once); `grantPartyExp(n, opts)` (conscious members only); `canEvolve(id)` → `{ to, display, type, level, have, materials: [{ id, n, have }], missing, ready }`; `evolutions(id)`; `evolve(id, { to })` → `{ ok: false, why }` | `{ ok: true, from, to, learned, spent }` (spends through `economy.take`, mutates the species in place, emits `pokemon:evolved`); `levelUp(id)`; `refreshMoves(id)`; `setPriority(id, moveIds)`; `heal(id|'all', { hp, status, revive })` (refuses a fainted Pokémon unless `revive`); `revive(id|'all', { fraction })`; `reviveAll()`; `restorePp(id, { moveId, amount })`; `damage(id, n)`; `firstConscious()`, `conscious()`, `instance(id)`; `saveState()` → `{ v: 1, ordinal, party }`, `loadState(v)`; `dispose()`.
Events: emits `party:leadChanged`, `pokemon:levelled`, `pokemon:evolved`, `ui:toast` · listens none. Showcase: `levelup`, `trainer`, `depth`, `dex`, `default`. Undeclared: `battle` (lazy, optional-chained — stats fall back to a flat table), `economy` (isLive).
Data: `/generated/species.json` at init (an 11-species `STARTERS` fallback at `warn`). An instance is `{ instanceId, species, level, shiny, exp, ivs, stats, maxHp, hp, moves: [{ id, pp, maxPp }], priority, status }`; `instanceId` is minted once. Sheets: `/assets/overworld/<name>/{normal,shiny}.png`, 2 columns × 4 rows, 64×128 (32 px frames) or 128×256 (64 px); rows north, west, south, east. Trainers `/assets/trainer/{hero,heroine}.png` 32×768, 24 frames: north `[0,7,8,9,10,20]`, south `[11,12,13,21,22,23]`, west `[1,2,3,14,15,16]`, east `[4,5,6,17,18,19]`. Sprites carry 16 texels per unit.

### 5.6 `encounter` — `needs: ['pokemon', 'terrain', 'economy']` · `showcaseNeeds: ['simulation', 'collection', 'battle']` · hooks `init, tick, frame, dispose, showcase` · selftest **yes**
API: `tablesFor(biome, tod)` → weight-expanded `string[]`; `rollAt(index, { biome, tod, band, rate })` → `{ index, species, level, shiny, ivs, ivTotal, catchRate, … }` (addressed by index, never a continued stream); `catchRollAt(index, turn)`; `slotsNear(cx, cz)` → slot | null (Chebyshev ≤ `config.slotEngageTiles` 1; null with no conscious member, and that refusal `log.warn`s and toasts once per streak — DECISIONS #81); `engage(slot)` (`hunts.takeSlot`, next index, `automation.duel().chooseLead` → `pokemon.setLead`, `begin`); `begin(enc)` (opens `battle.stepper`, `sim.pause(true)`, emits `battle:started`, `encounter:started`); `attempt(ball)` → boolean (one throw, only once `active().battle.win === true`; `economy.throwBall` then the catch coin; emits `catch:succeeded`/`catch:failed`, then `resolve()`); `flee()`; `autoResolve(enc, lead)`; `active()`, `last()`, `transcript()`, `scene()`, `alerting()`, `ready()`, `refit()`; `cancel()` (no `encounter:resolved`); `advance(n)`, `advanceToStage(stage, frac)`, `setProgress({ steps, encounters })`, `progress()`, `seed()`; `setBall(id)`, `ball()`, `bestBall(enc)`, `oddsFor(id, enc, turn)`, `ballContext(enc, turn)`; `dropsFor(index, { species, biome, catchRate, level, shiny })` → `[{ id, n }]` (pure, index-addressed), `dropTableFor(species, biome)`; `tables()`, `rows(biome, tod)`, `band()`, `shinyRate()`; `armed()` (only at `/` and in this module's own showcase), `freeze(on)`, `frozen()`; `pure()` → `{ rollAt, resolve, dropAt }` (injected into `idle`/`offline` state); `stageStrike(opts)`, `strikes()`; `THROWS_PER_FAINT` (1), `WIPE_PENALTY` (0.10); `saveState()` → `{ v: 1, steps, encounters, ball }`, `loadState(v)`; `selfTest()`; `dispose()`.
Events: emits `battle:started`, `battle:strike`, `battle:ended`, `encounter:started`, `encounter:resolved`, `catch:succeeded`, `catch:failed`, `drop:collected`, `party:wiped`, `ui:toast` · listens `player:enteredTile` (armed, not frozen, nothing active → `slotsNear` → `engage`), `world:loaded` (clears the table memo). Showcase: `reveal` (default and anything unmatched), `vfx-contact`, `vfx-projectile`, `vfx-field`, `walk`, `approach`, `throw`, `shake`, `caught`, `escaped`, `shiny`, `table`, `night`, `balls`. Undeclared: `simulation`, `battle`, `hunts`, `automation`, `collection`, `environment` (all isLive — a quarantined `battle` costs the game its combat, not its encounters).
The fight steps `battle.stepper` once per `T.TURN` = 24 sim steps (a literal; `config.turnSteps` is not read) and emits one `battle:strike` per blow; an unattended fight resolves itself with no ball spent. `resolve()` credits money (`economy.add('money', …, 'battle')` — STATUS `watched-win-mints-money`), grants exp through `pokemon.grantPartyExp`, hands loot to `economy.give(id, n, 'drop')`, and on a wipe takes `WIPE_PENALTY` of the wallet, `reviveAll`s and emits `party:wiped` (`travel` hops) — **every** wipe, not only the first (DECISIONS #81). The duel's `between` hook debits items through `economy.take`. Move VFX (`strikes.js`) are 18 elemental palettes × 3 deliveries derived from the move record.

### 5.7 `idle` — `needs: ['simulation', 'economy', 'encounter']` · `showcaseNeeds: ['city', 'terrain']` · hooks `init, frame, dispose, showcase` · selftest **yes**
API: `simulate(state, elapsedS, seed)` → gains (pure and chunk-additive: whole encounters are the integers in `(p0, p1]`; `gains.progress = { encounters, seconds }`; `offline` calls this once per closed-tab gap); `rate()`; `pending()`; `flush(capS)`; `state()` (500 ms TTL); `production()`; `totals()`; `history()`; `trace()`; `progress()`; `lastCatchup()`; `formatDuration(s)`; `catalog()`; `unlocks()`, `has(id)`, `grant(id)`, `revoke(id)`; `upgrades()`, `setUpgrade(id, n)`; `setBiome(b)` (a loaded map's biome wins), `setLuck(n)`, `setEfficiency(n)`; `snapshot()` → `{ v: 1, progress, totals, carry, unlocks, upgrades, lastSeenMs }`, `restore(s)` (also how `offline` hands back consumed progress); `lastSeenMs()`; `heartbeat()`; `driver()` → `'idle'` | `'encounter'`; `diagnostics()`; `digest(gains)`; `debug.advanceWallMs(ms)`, `debug.setHidden(on)`, `debug.pump(opts)`, `debug.reconcile(reason)`, `debug.now()`, `debug.lastGap()`, `debug.lastCatchupGap()`, `debug.state()`.
Events: emits `idle:tick`, `ui:toast` · listens `world:loaded`, `world:unloaded`, `party:leadChanged`, `collection:added`, `catch:succeeded`, `tod:changed`, and DOM `visibilitychange`/`pagehide`. Showcase: `default` (3 h gap), `long` (12 h), `quick`. Undeclared: `pokemon`, `terrain`, `environment` (optional-chained); `simulation` is declared and never called.
Accrues **only while `document.hidden`** (`driver() === 'idle'`; visible seconds are counted and discarded — `encounter` runs the watched hunt). A Web Worker (`idle/worker.js`, `setInterval(config.idleHeartbeatMs)`, timer/frame fallbacks) beats; each gap drains through `drain.js` in slices widening from 1 s to 300 s under a per-frame budget; the encounter functions arrive in `state` from `encounter.pure()`. Banking credits money/tokens in whole units with a carried remainder, exp via `pokemon.grantPartyExp(…, { source: 'idle' })`, loot via `economy.give`, balls via `economy.take`; a win needs `flags.battle`, which only the `hunt` automation grants (STATUS `research-unmintable`). Balance constants in `accrual.js` are mirrored by `economy/pacing.js` under seams rule 5.

### 5.8 `offline` — `needs: ['idle']` · `showcaseNeeds: ['city', 'terrain']` · hooks `init, showcase` · selftest **yes**
API: `summary()` / `dismissSummary()` (the away-card payload: `reason`, `awayS`, `capped`, `gains`, `applied`, `pending`, …); `decision()`; `preview(awayS, nowMs)` (grants nothing); `awayS()`; `lastSeenMs()`; `curve()`; `efficiencyAt(t)`; `effectiveSeconds(T)`; `persist(reason)`; `save()`; `info()`; `keys` → `{ save, broken, future }`; `version` (4); `migrations()`; `store.load()`, `store.hydrate()`, `store.register(id, { capture, restore, source, order })`, `store.flush(reason)`, `store.markDirty(why)`, `store.get(id)`, `store.set(id, v)`, `store.patch(id, obj)`, `store.providers()`, `store.info()`, `store.export()`, `store.import(text)`, `store.clear()`; `dispose()`.
Events: emits `offline:applied` · listens `scene:entered` (restores the saved player cell once per session when the map matches), the seven † events of §4 (dirty), and DOM `visibilitychange`/`freeze`/`pagehide` (flush). Showcase: `card`; anything else draws the full layout. Under `config.showcase` the store is an in-memory copy of the three keys and `pokeidle.save` is never written. Undeclared: `terrain`, `pokemon`, `encounter`, `economy`, `ui`, `simulation` (optional-chained) and every registry id through `discoverProviders` (isLive).
At init: load/migrate/hydrate (§10), then one decision — reason `first-launch`, `no-anchor`, `clock-rewound`, `too-short` (< `offlineMinS` 60), `implausible` (> `offlineMaxPlausibleS`), `ok` or `error` — capped at `offlineCapS` (43200 s), discounted on the time axis by a curve with grace `offlineGraceS` 1800, half-life `offlineHalfLifeS` 3600 and floor `offlineEfficiency` 0.55, then one `idle.simulate` call. Money/tokens are paid with carry; exp, encounters and catches land in `pending` (STATUS `closed-tab-exp-discarded`); away catches are materialised by `automation.absorb` on `offline:applied`, not here; the biome comes from `terrain.handle()`, which is null at init (STATUS `catchup-biome-always-meadow`).

### 5.9 `economy` — `needs: []` · `showcaseNeeds: ['city', 'terrain']` · hooks `init, showcase` · selftest **yes**
API: `balance(c)`, `exact(c)`, `wallet()`, `currencies()`, `format(c, n)`, `canAfford(c, n)`; `add(c, n, reason | { reason, raw, earned })` (income reasons are multiplied by upgrades; `research` never); `spend(c, n, reason)`; `inventory()`, `count(id)`, `give(id, n, reason)`, `take(id, n, reason)`, `capacity(id)`, `item(id)`, `items(filter)`, `useItem(id, target)`; `bag()`, `stash()` (two views of one Map, split on `category === 'treasure'`); `purchaseClass(id)`, `purchaseOrder()`; `sellLocked(id)`, `sellLocks()`, `setSellLock(id, on)` (an *auto*-sell lock); `buy(id, n, { shopId })`; `sell(id, n)` (ignores the lock; its only caller is `automation`); `sellValue(id)`; `prices()`; `deal()`; `source(id)`; `shops()`; `stock(shopId)`; `throwBall(ballId, context, { catchRate, hpFraction, status })` → `{ thrown, ball, multiplier, odds, p0, pity, spent, price }` (spends the ball, credits pity, never rolls); `recommendBall(context, { owned })`; `catchMultiplier(ballId, context)`; `catchOdds(opts)`; `oddsWithPity(opts, species)`; `applyPity(p0, species)`; `pity(species)` → `{ sum, price, ratio, t }`; `speciesPrice(nameOrSpecies, { shiny })` (the pity threshold — the release value is `appraise`); `appraise(inst)` → `{ money, shards }`; `release(inst)`; `upgrades()`, `upgradeLevel(id)`, `upgradeCost(id, n)`, `buyUpgrade(id, n)`; `multipliers()`; `buffs()`; `vouchers()`, `buyVoucher()`; `trainer()` → `{ level, wins, into, need, next }` (derived from `progress().battlesWon`, never granted); `progress()` → `{ dexCaught, totalEarned, shardsEarned, researchEarned, itemsBought, battlesWon, playSeconds, trainerLevel }` (the snapshot every unlock gate reads); `stats()`; `sinks()`; `curve(id, points)`; `project(opts)`; `incomeModel()`; `announce(reason)`; `onChange(fn)`; `selfTest()`; `saveState()` → `{ v: 2, wallet, bag, sellLock, upgrades, stats, buffs, vouchers, pity }`, `loadState(v)` (migrates v1; accepts any newer slice).
Events: emits `economy:changed`, `ui:toast` · listens `idle:tick` (0.25 BP per win, shards per catch), `encounter:resolved`, `boot:ready` (once: `announce('sync')`), `catch:succeeded`. Showcase: `default`, `shop`, `balls`, `upgrades`, `pacing`. Undeclared: `pokemon` (isLive), `collection`, `idle` (optional-chained).
Pity: `odds = p0 + (1 − p0) · t`, `t` ramping from 0 at 90 % of `speciesPrice` to 1 at 125 %, credited inside `throwBall`, reset on `catch:succeeded`, persisted in the slice. `config.fieldStartMoney` (100000) is credited `earned: false` so `totalEarned` gates ignore it. Daily shop limits are in-memory only. Drops are `encounter`'s; this module only receives `give(id, n, 'drop')`.

### 5.10 `collection` — `needs: ['pokemon']` · `showcaseNeeds: ['city', 'terrain', 'economy']` · hooks `init, dispose, showcase` · selftest **yes**
API: `dex()`; `records()`, `record(key)`, `seen(name)`, `caught(name)`, `owned(name)` (keyed by lower-cased species **name**, not dex number), `completion()`; `boxes()`, `box(i)`, `at(b, s)`, `entry(ref)` (uid, instanceId or an object carrying either), `entries()`; `move(ref, box, slot)`; `swap(b1, s1, b2, s2)`; `sort(mode, { desc, box })`, `sorted(mode, opts)`, `sortModes()`, `keepRules()`; `deposit(spec)`; `sight(species, { shiny })`; `release(ref, { credit })` (credits `economy.release`); `releaseMany(refs, opts)`; `planRelease(rule)` (pure; party members protected); `releaseDuplicates(rule)`; `duplicates(min)`, `duplicatesOf(species)`; `bestIv(key)`, `bestIvs(limit)`; `favourite(ref, on)`, `nickname(ref, name)`; `stats()` (`economy` gates shelves on `.caught`); `capacity()`, `boxCount()`, `totalSlots()`, `count()`, `free()`, `isFull()`, `layout()`; `rename(i, name)`, `setWallpaper(i, w)`, `addBox()`, `wallpapers()`; `ivTotal(ivs)`, `ivPct(total)`, `ivGrade(total)`, `IV_TOTAL_MAX`; `importBatch(specs, { announce })`, `setQuiet(on)`, `overflowCount()`, `ordinal()`; `saveState()` → `{ v: 1, ordinal, overflow, dex, boxes, stored }`, `loadState(v)`; `selfTest()`.
Events: emits `collection:added`, `ui:toast` · listens `encounter:started` (a sighting), `catch:succeeded` (intake; IVs from the payload, else `rng.fork('collection/iv/<species>/<ordinal>')`). Showcase: `default`, `boxes`, `dex`, `duplicates`, `sort`. Undeclared: `economy` (isLive). Storage: 32 boxes × 30 slots (max 64 boxes); uid `<species>#<ordinal>`.

### 5.11 `automation` — `needs: ['encounter', 'economy', 'collection']` · `showcaseNeeds: ['city', 'terrain', 'idle']` · hooks `init, tick, dispose, showcase` · selftest **yes**
Ten automations (`automations.js`): `hunt`, `catch`, `ball`, `heal`, `revive`, `ether`, `lead`, `release`, `sell`, `restock` — every one locked and disabled by default, unlocked with research against a gate on `economy.progress()` counters.
API: `list()`, `get(id)`, `unlock(id)` → `{ ok, why }`, `enable(id, on)`, `toggle(id)`, `isActive(id)`, `unlocked()` → `string[]`, `configure(id, patch)`, `settings(id)`, `progress()`; `schema()`, `fields(kind: 'wild'|'stored'|'item')`, `operators()`; `addRule(id, rule, at)` → ruleId, `updateRule(id, ruleId, patch)`, `removeRule(id, ruleId)`, `moveRule(id, ruleId, to)`, `setRules(id, list)`, `resetRules(id)`, `validate(id, rule)`, `describeRule(id, rule)`, `errors()`; `explain(id, subject)`, `evaluate(id, subject)`, `facts(id, subject)`, `world()`; `chooseBall(subject, tier)`, `ballTable(subject)`, `ballLog()`; `duel({ stock, itemOf, effectiveness, moveOf, party })` → `{ between, chooseLead, settings }` — pure; `between` is `null` unless `heal`/`revive`/`ether` is active; `chooseLead` is asked at engagement **and** from `battle.stepper`'s `nextAlly`; the caller debits the item; `preview(id)`, `run(id)`, `history(n, id)`, `totals()`, `stats(id)`, `diagnostics()`, `reset()`; `rules(id?)` and `set(patch)` (the legacy toggle map the `offline` adapter reads); `saveState()` → `{ v: 1, catchOrdinal, totals, engine }`, `loadState(v)` (refuses v > 1; saved rules are merged with the builtins); `selfTest()`; `dispose()`.
Events: emits `automation:changed`, `automation:configured`, `ui:toast` · listens `idle:tick`, `offline:applied` (`absorb`: away catches deposited through `collection`), `battle:ended` (auto-catch → `encounter.attempt`), `world:loaded`, `collection:added`. Showcase: `default`, `rules`, `balls`, `release`, `hunt`. Undeclared: `pokemon`, `idle`, `environment`, `terrain` (optional-chained). Only `release` (15 s), `sell` (20 s) and `restock` (30 s) run on the tick, one pass per tick round-robin; the rest act inside a fight or on an event. `planSell` skips a sell-locked id before its rules run.

### 5.12 `ui` — `needs: []` · `showcaseNeeds: ['city', 'economy', 'collection', 'offline', 'idle', 'automation', 'hunts', 'travel', 'battle', 'encounter']` · hooks `init, tick, frame, dispose, showcase` · selftest **yes**
API: `toast(text, kind)`; `open(id, opts)` (one panel at a time; ids `menu`, `travel`, `offline`, `shop`, `boxes`, `dex`, `automation`, `party`, `battle`, `dialogue`); `close()`; `isOpen()`; `openPanel()` → id | null; `say(text, opts)`; `showReport()`; `snapshot()`; `metrics()`; `project(x, y, z)` → `{ x, y }` | null; `evolution.play(spec)`, `evolution.freeze(spec, t)`, `evolution.close()`, `evolution.TOTAL`, `evolution.BEATS`; `input.press(dir)`, `input.release(dir)`, `input.setTouch(on)`; `selfTest()`; `dispose()`.
Events: emits `ui:toast` · listens `ui:toast`, `battle:strike`, `encounter:started` (opens the battle card, never over a panel the player opened, never in another module's showcase), `encounter:resolved` (closes it), `economy:changed`, `collection:added`, `party:leadChanged`, `pokemon:evolved` (the DOM cutscene; never under `config.showcase`), `tod:changed`, `offline:applied` (opens the away card). Showcase: `default`/`hud`/`font`, `menu`, `shop`, `boxes`, `dex`, `party`, `moves`, `travel`, `battle`, `evolution`, `evolution-burst`, `evolution-reveal`, `evolve`, `offline`, `toasts`, `dialogue`, `input`. Undeclared: `pokemon`, `economy`, `environment`, `simulation`, `offline`, `encounter`, `travel`, `automation`, `idle`, `battle`, `collection` (all isLive).
One 2-D canvas at the renderer's internal resolution, zero draw calls; the evolution cutscene is the one DOM/CSS piece. Keys (`input.js`): arrows/WASD move when `simulation.formation().input`; KeyT travel, KeyP party, KeyB shop, KeyC boxes, KeyM menu, KeyU automation, Digit1–6; Escape/X close. `PANEL_IDS` lives in `input.js` and `selfTest()` checks it against the live `PANELS`. The battle card throws (Z/Enter/Space) and runs (R) only once `win === true`; `screen.regions()` publishes the hit boxes of the last paint.

### 5.13 `city` — `needs: ['terrain', 'environment']` · `showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation']` · hooks `init, showcase` · selftest **no**
API: `enter()` async → terrain handle (biome preset `city`, weather clear, `terrain.load('demo-city', { w: 64, h: 64, tileset: 'bw2-adastra' })`, dressing, `setFormation` + `placePlayer`, NPCs); `preset(name)` → boolean (a `PRESETS` key, a `cx,cz` literal or a draft marker; teleports the trainer); `presets()`; `formation()` → `{ head: 'trainer', input: true, autopilot: 'none' }`; `markers()`; `marker(name)`; `stats()`; `dispose()`.
Events: emits `ui:toast` · listens `world:unloaded` (teardown). Showcase: `default`, `plaza`, `centre`, `pokecenter`, `mart`, `high-street`, `south-gate`, `pond`, `wood-yard`, `garden`, any `cx,cz`, any marker (`pokecenter-door`, `mart-door`, …). Undeclared: `simulation`, `pokemon` (isLive), `tiles` (unguarded). Tilesets: `bw2-adastra`, `pt-overworld-7` (plaza paving), `structures`, `props`. `env.lamps.clear()` in `enter()` wipes every module's lamps. **`enter()` heals the party** — `pokemon.reviveAll()` when any member is hurt or fainted, toasted unless `config.showcase`: the lobby is the Pokémon Center, and it is the escape hatch for a party that fainted on a path that never resolved (DECISIONS #81).

### 5.14 `hunts` — `needs: ['terrain', 'encounter', 'environment']` · `showcaseNeeds: ['tiles', 'simulation', 'pokemon']` · hooks `init, tick, showcase` · selftest **yes**
Biomes (`biomes/*.js`): `meadow` (requiredLevel 0), `forest` (5), `coast` (12), `cave` (20); formation `{ head: 'pokemon', input: false, autopilot: 'route', strict: true }`. API: `list()` → `[{ id, name, preset, tileset, w, h, presets, formation, requiredLevel, loop | null, slots: count }]`; `biome(id)`; `current()`; `enter(id)` async → handle (environment preset + weather, `terrain.load('hunt-<id>')`, extras worlds, lamps, the wild cast, `setFormation` with the route rotated by `config.followerGapTiles`, `teleport(loop.start)`, `audit()`); `preset(name)` (a biome preset or `cx,cz`); `loop(id)` → `{ start, route, w, h, corners, length, cells }`; `slots(id)` → `[{ k, cx, cz, dir, from, step, approach, occupied, species, shiny, npcId }]`; `takeSlot(k)` → `{ species, shiny, cx, cz, k }` | null (removes the NPC, refills after `respawnSeconds` 26 s from `encounter.tablesFor` with a 1/512 shiny roll); `wild()`; `stats(id)`; `markers()`; `audit(id)` → `{ ok, checked, fails }`; `respawnSeconds`; named export `BIOMES`.
Events: emits `hunt:lap` (every full lap each member below full heals `config.lapHealFraction` 0.34 of maxHp — a fainted one is revived to it with its status cleared, a conscious one is topped up and keeps its status (DECISIONS #81)), `slot:respawned` · listens `player:enteredTile` (a detour onto an occupied slot: `holdNpc` then `sim.detour([step, back])`, once per lap per slot), `world:unloaded`. Showcase: `forest` (default and unknown, at `warn`), `meadow`, `cave`, `coast`. Undeclared: `simulation`, `pokemon` (isLive), `tiles` (unguarded). No save slice: occupancy and refills reset on every `enter()`.
The loop is found on the built draft (`compose.findLoop`: `config.loopCorners` 12, `loopDepth` 3, a margin of 11 cells from the edge, opening on a straight at least `followerGapTiles + 2` long); slots sit at Chebyshev distance 2 from the path; `audit()` walks the loop on the real draft at every `enter()` and warns per failure.

### 5.15 `preview` — `needs: ['tiles']` · `showcaseNeeds: ['tiles']` · hooks `init, showcase` · selftest **no**
API: `show(slug, { filter, cols, pad })` async → `{ models, cols, rows, floorW, floorH }` (throws when nothing matches); `focusModel(name)`; `preset(name)` (alias); `staged()`; `clear()`. Events: none. Showcase: any tileset slug under `public/generated/tiles/`; `default` → `?set=` → `bw2-adastra`; `?filter=`, `?cols=`, `?pad=`, `?focus=`. Registered on every boot, inert until `?showcase=preview`; never part of the game.

### 5.16 `travel` — `needs: ['terrain']` · `showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation', 'city', 'hunts', 'pokecenter']` · hooks `init, showcase` · selftest **yes**
API: `destinations()` → `[{ id, name, kind, module, arg, formation, hidden?, requiredLevel?, locked?, why? }]` (rebuilt per call: `demo-city`, then `pokecenter` with `hidden: true` — door-only entry, `ui/panels/travel.js` filters it out of the T panel but `go()` accepts it exactly like any other id — then `hunt-<biome>` from `hunts.list()`; `locked` when `economy.trainer().level < requiredLevel`, fails open when `economy` is quarantined); `current()`; `busy()`; `go(id)` async → boolean (false, never throws: busy, unknown, locked — unless `config.showcase` or `id === config.scene` — or the owner not live; otherwise `encounter.cancel()`, `sim.halt()`, `owner.enter(arg)`, emits `scene:entered` and an arrival toast); `boot()` → id (`?scene=` > the saved `sceneId` if unlocked > `demo-city`); `saveState()` → `{ v: 1, sceneId }`, `loadState(v)`.
Events: emits `scene:entered`, `ui:toast` · listens `party:wiped` (a microtask later: `go('demo-city')` then `teleport` to the `pokecenter-door` marker; skipped under showcase). Showcase: any destination id, else `demo-city`; then opens the travel panel. Undeclared: `city`, `hunts`, `pokecenter`, `economy`, `encounter`, `simulation`, `ui`, `offline` (all isLive; the slice is self-registered at order 45 because `travel` inits after `offline`). The door-to-door hop in and out of the Center is `pokecenter`'s own `player:enteredTile` listener (§5.18), not this module's.

### 5.17 `battle` — `needs: []` · `showcaseNeeds: ['pokemon']` · hooks `init, showcase` · selftest **yes**
`engine.js` is pure — two combatant records in, a transcript out, no `ctx`, no clock, no DOM. `index.js` fetches `/generated/moves.json` and `learnsets.json`; a fetch failure logs `warn` and leaves `ready() === false` (`movesFor` answers Struggle) — the module is **not** quarantined.
API: `ready()`; `move(id)`, `moveIds()`, `moveCount()`, `learnset(species)`; `types()`, `effectiveness(atkType, defTypes)` → `0|0.25|0.5|1|2|4`, `effectivenessText(mult)`, `STAB` (1.5); `movesFor(species, level, { priority, instanceId })` → 1..4 slots `{ id, pp, maxPp }`; `stats(baseStats, ivs, level)` (no EVs, no natures); `stageMultiplier(stage)`; `expToLevel(growthRate, level)`, `expToNextLevel(growthRate, level)`, `levelForExp(growthRate, exp)`, `expYield(baseExp, defeatedLevel)`; `makeCombatant({ species, level, ivs, shiny, moves, hp, status, instanceId, priority })`; `begin(a, b)`; `turn(state, seed, index)` (one pure turn on stream `root/battle/<index>/<turn>`; draws are taken unconditionally and discarded when unused); `stepper(a, b, seed, index, { maxTurns, between, nextAlly })` → `{ state, over, sent, capped, step() }` — **the** implementation, driven by `encounter`; `between` runs before each turn and again after an ally faint; `applyAction(state, action)`, `MAX_BETWEEN` (4); `resolve(a, b, seed, index, opts)` → `{ winner, turns, a, b, hpFraction, stalled, sent, betweenCapped, transcript }` — a drain of the stepper, used by `idle`/`offline` through `encounter.pure()` (`winner: 'b'` means the party ran out); `strikesOf(events, names)`, `describeStrike(strike)`; `damageOf(atk, def, move, opts)`; `choose(self, foe)` (best expected damage with PP left; no per-turn menu); `streamFor(seed, index, turn)`, `STREAM_ROOT`; `priority(instanceId)`, `setPriority(instanceId, moveIds)`; `saveState()` → `{ v: 1, priority }`, `loadState(v)`; `selfTest()`.
Events: none. Showcase: `default`, `fight`, `types`, `moves`, `status`. Undeclared: none. Transcript event kinds (21): `flinch, frozen, asleep, paralysed, confused-hit, move, miss, boost, status, confused, immune, damage, drain, recoil, residual, woke, thawed, unconfused, faint, item, swap`, each `{ turn, actor, kind, species, … }`; `battle:strike` is `strikesOf` applied per blow.

### 5.18 `pokecenter` — `needs: ['terrain', 'environment']` · `showcaseNeeds: ['tiles', 'terrain', 'environment', 'pokemon', 'simulation']` · hooks `init, showcase` · selftest **yes**
The Pokemon Center's interior — one room, entered and left through a door tile rather than a panel (§5.16's `hidden`). `layout.js` carries the numbers, `map.js` paints the base tileset (`pt-house-indoor`: floor, three walls, the counter), `dress.js` builds the window (`hgss-newbark-houses`) and the two benches (`bw2-adastra`) as their own `InstancedWorld`s and registers the one practical light (the window's daylight shaft).
API: `enter()` async → terrain handle (biome preset `interior`, weather clear, `terrain.load('pokecenter', { w: 13, h: 10, tileset: 'pt-house-indoor', biome: 'city' })` — `biome: 'city'` on purpose: `'interior'` is not in `encounter`'s `BIOMES` and would fall back to the **meadow** spawn table, where `'city'` already resolves to `TABLES.city = []` — dressing, `setFormation` + `placePlayer` at the room's own spawn, facing the counter); `preset(name)` → boolean (a `PRESETS` key, a `cx,cz` literal or a draft marker; teleports the trainer); `presets()`; `formation()` → `{ head: 'trainer', input: true, autopilot: 'none' }`; `markers()`; `marker(name)`; `stats()`; `dispose()`. No save slice: nothing in the room has state yet (Nurse Joy and a cure cooldown are a later slice).
Events: listens `world:unloaded` (teardown), `player:enteredTile` — the door, both ways: `tags.includes('door:pokecenter')` while `travel.current().id === 'demo-city'` calls `travel.go('pokecenter')`; the room's own exit tag while `current().id === 'pokecenter'` calls `travel.go('demo-city')` and re-teleports onto the city's `pokecenter-door` marker, facing south (a wiped party's teleport, §5.16, faces north instead — that is a fainted party arriving to be healed, this is a player who already saw the counter). Showcase: `default`, `counter`. Undeclared: `simulation`, `travel` (isLive), `tiles` (unguarded). Tilesets: `pt-house-indoor`, `hgss-newbark-houses`, `bw2-adastra`. `env.lamps.clear()` in `enter()` wipes every module's lamps. Three walls only — south is collision without geometry, so the fixed camera can see into the room; DECISIONS #82 is why the west and east walls barely read as solid either way. **No healing here** — `city.enter()` still cures the party on arrival unchanged (DECISIONS #81); this module does not touch it.

## 6. Showcase mode

`/?showcase=<id>[&mode=<m>]` runs `registry.init` over the closure of `[<id>, ...showcaseNeeds, 'environment', 'ui']`
(every other module is `skipped` behind a silent null object) and then `registry.showcase(id, mode ?? 'default', ctx)`.
`&preset=` is not a URL parameter; presets arrive through `__HOOKS__.setPreset` (§8). Modes per module: §5.

1. **§6.1** Every module has `showcase(mode, ctx)` (seams rule 3). An unknown mode falls back to the module's default
   (`preview` excepted: an unknown slug throws); a throw quarantines the module.
2. **§6.2** A showcase must reach `window.__READY__ = true`; the harness waits `--timeout` (30 s default). No other time
   limit exists.
3. **§6.3** Same URL ⇒ same pixels — **only with `timeFrozen=1`**, which `tools/shots/shoot.js` injects into every URL
   unless the caller passes it; nothing in `src/` freezes the clock under `config.showcase`. Randomness from
   `ctx.rng.fork(…)`, walkers advanced a fixed step count and then `sim.freeze(true)`, no wall clock in anything drawn.
4. A showcase is read-only: `offline` runs on an in-memory copy of the save under `config.showcase` and never writes
   `pokeidle.save`; what a showcase mutates through other modules' APIs (bags, parties, boxes) is in memory only.

## 7. World data model and budgets

The world is cells → placements → instances. `Placement = { modelId, cx, cz, y?, rot?: 0|1|2|3, tint? }`
(`src/tiles/instanced.js`; producers also carry a `layer` sort key the instancer never reads).
`tiles.buildInstances(scene, slug, placements, opts)` buckets by `(modelId, material group)` and emits one
`THREE.InstancedMesh` per bucket — one `BufferGeometry` per model, one material per tileset texture (nearest filtering,
alpha-tested foliage, the pack's alpha / both-face / vertex-colour flags), per-instance `instanceColor` for tint, the
placement's quarter-turn yaw composed into the instance matrix — plus one unlit contact-shadow `InstancedMesh` under
tall models. Sprites (`src/pokemon/field.js`) are two more `InstancedMesh`es over a runtime-built atlas: the billboards
and their contact-shadow blobs. No chunking, no culling.

Budgets, asserted by `checkBudgets` in `tools/shots/shoot.js` on every capture made by `shot`, `boot`, `coldboot` and
`gauntlet` (`regress` asserts only its own metrics, §8):

| Metric | Budget |
| --- | --- |
| Console errors | **0** — and no `__FATAL__`, no harness error |
| Frame rate | mean **≥ 50 fps**, p95 frame **≤ 20 ms** (`boot` at 1920×1080; `coldboot` at 1280×720) |
| Draw calls | ≤ 1500 |
| Triangles | ≤ 900 000 |
| Programs | ≤ 60 |
| Modules | none `failed` or `blocked` |
| Time to `__READY__` | ≤ 6 s — asserted only when `readyBudget` is passed, which only `coldboot` does, against the production build on `vite preview` |

## 8. The verification loop

`npm run gate` runs `tools/gate.js`; `node tools/gate.js --list` prints the stages, `--only a,b` and `--skip a,b` select
them, `GATE_PORT` moves the one dev server the browser stages share, every artifact lands in `shots/out/`, and a failed
stage does not stop the ones after it. `npm run gate:fast` is `--only lint,typecheck,seams,unit` and the pre-commit hook.

| Stage | Runs | Proves | Cannot see |
| --- | --- | --- | --- |
| `lint` | `eslint .` | undefined names, unused bindings, `==` | the project's contracts (those are seams) |
| `typecheck` | `tsc -p tsconfig.json` | zero errors in every `// @ts-check` file | files that have not opted in |
| `seams` | `tools/seams/run.js` | rules 1–9 below | runtime behaviour, composition |
| `unit` | `vitest run` | `src/**/*.test.js`, `tools/**/*.test.js` | anything needing a browser |
| `build` | `vite build` + `builtAssets()` | the bundle builds; `dist/assets/<root>` is non-empty for every `RUNTIME_ASSET_ROOTS` entry and every literal `/assets/<root>/` in `src/` is a copied root | whether the bundle renders |
| `coldboot` | `vite preview` on `GATE_PORT + 1`, one shot of `/` at 1280×720 | `__READY__` ≤ 6 s on the production build, plus §7 | any route but `/` |
| `boot` | `tools/shots/boot.js` | every registry id as `?showcase=` and every `__HOOKS__.destinations()` id as `?scene=` (locked ones too) draws ≥ 20 draw calls — `battle` ≥ 400 chars of UI text — and meets §7 | whether it is the right frame |
| `flows` | `playwright test` (`tests/flows/*.spec.js`) | user flows at `/` driven through `__HOOKS__` and `__CTX__.get(id)`, asserted on bus events and module state | pixels |
| `parity` | `tools/shots/parity.js --walk` | at 7 viewports (390×844 … 2560×1080) `unitsPerPixel === 1/32`, sprite magnification 2, even internal dims, zero console errors; the trainer crop within delta 8 of the FullHD reference; FullHD byte-identical to itself; a walk step is a whole-pixel translation | any scene but `?showcase=simulation&mode=corner` |
| `regress` | `tools/shots/regress.js` | 17 fixed rows (hunts ×7, city ×3, tiles, environment ×2, encounter ×3, `/`) at 1280×720, seed 1337, compared to `docs/baseline.json` on fps, drawCalls, consoleErrors, mean, p99, max, belowL8Pct, pureBlackPct, over200Pct, saturation with per-metric tolerance and direction; only `REGRESSED` fails; `--accept` rewrites the baseline | composition |

**The page contract.** `window.__READY__` (true once the first frame is presented, or once boot has failed with
`window.__FATAL__` set), `window.__CTX__`, and `window.__HOOKS__`: `setPreset(name)` (the current scene's `preset`, then
`environment.preset`), `setTimeOfDay(tod)`, `setSeed(n)` (writes `config.seed` only; does not reseed `ctx.rng`),
`setConfig(patch)`, `step(n = 1)` (n fixed sim ticks — `simulation.advanceSteps` when frozen, else `registry.tick`; then
`clock.forceSteps`; nothing is rendered), `focus(cx, cz, y)`, `key(code, down)` (dispatches a real `KeyboardEvent` on
`window`), `grid()` (`pokemon.sprites.field.grid()` + `internal`, `displayRect`, `pixelScale`, `viewport`), `metrics()`,
`resetMetrics()`, `events()` (last 256), `modules()` (`registry.status()`), `destinations()` → `[{ id, locked }]`,
`pause()`, `resume()`. `tools/shots/shoot.js` loads `<--base>/?…&timeFrozen=1&debug=0`, waits for `__READY__`, applies
`--preset`/`--tod` through the hooks, settles `--settle` frames (30), writes `--out <png>` and a sibling `.json` (`url,
size, tod, ok, readyMs, fatal?, grid, destinations, uiChars, fps{mean, p95ms, samples}, drawCalls, triangles, programs,
seed, modules, consoleErrors, consoleWarnings (≤ 40), events (last 64), scene, ms`). `tools/shots/gauntlet.js` shoots
one module's modes × presets × tods × ppu into `docs/progress/<module>/<round>/` and is not a gate stage. Flows install
their own `__EVLOG__` by wrapping `bus.emit` before boot (`tests/flows/harness.js`).

**Seams rules** (`tools/seams/run.js`, derived from the tree, nothing to register): **1** no `Math.random(` in `src/`
(`seam-allow` exempts a line); **2** no static or dynamic import of a sibling module's non-`index.js` file (comments
stripped first); **3** every `src/<m>/index.js` default-exports a descriptor with `init`, `showcase` and `id: '<m>'`;
**4** the `bw2-adastra` pack exists, `pack.json` offsets fit `pack.bin`, no model is unnamed or `unknown`; **5**
`idle/accrual.js` constants equal `economy/pacing.js` `INCOME_MODEL`; **6** every `src/<m>/selftest.js` (+
`src/core/selftest.js`) exits 0 under Node within 120 s and prints a ✓/✗ or `N/M` line; **7** `pokemon/evolution.js` and
`encounter/drops.js` agree on `MATERIAL_FAMILIES` and `FAMILY_BY_TYPE` and every id is a real item; **8** every
`bus.on`/`once` name is emitted somewhere in `src/`; **9** every `it.fails`/`test.fail` carries `STATUS:<id>` on the
line before it naming a `docs/STATUS.json` `open` entry, and every `open` entry with a `test` still has that token there.

### 8.1 `selftest.js`, `*.test.js`, `*.spec.js`

`src/<module>/selftest.js` runs under plain Node, is discovered by existence (rule 6), and pins goldens from seed 1337
and invariants against **literals**, never against a second live call (DECISIONS #35). Present: automation, battle,
collection, core, economy, encounter, hunts, idle, offline, pokemon, simulation, travel, ui; absent: tiles, terrain,
environment, city, preview. Browser-only invariants go on the API as `selfTest()` reported through `reportSelfTest`
(`core/log.js`), which `log.error`s a failure so the capture fails (§7). `*.test.js` (vitest) `init(stubCtx)` the real
module; a known bug is pinned with `it.fails` + `// STATUS:<id>` (rule 9). `tests/flows/*.spec.js` (Playwright) drive
`/`. The conventions for all three are in `CLAUDE.md` "Testing".

## 9. Assets

- Tiles come from Pokémon DS Map Studio tilesets; `bw2-adastra` is the default, loaded at `tiles` init. Other sets are
  drawn on only when AdAstra lacks the piece, adapted to its silhouette, texel density and palette first (Blender via
  `.mcp.json`). An untextured box, a magenta placeholder or a flat-shaded primitive is a bug, not a milestone (`CLAUDE.md`).
  Licence: CC0 / procedural plus the vendored DS sets and the sprite sets in `assets/`; a non-commercial fan project.
- `npm run assets` = `tools/assets/build-tiles.js` (every PDSMS set found at the path hard-coded in that file — elsewhere
  every set is skipped and `tiles/index.json` is rewritten with no sets; STATUS `assets-machine-specific`) →
  `tools/assets/build-structures.js` (`assets/structures` → `structures`) → the same with `--src assets/props --slug
  props` → `src/pokemon/tools/build-species.js` (`assets/overworld/` folder list + Showdown/PokeAPI data cached in
  `node_modules/.cache` → `public/generated/species.json`) → `src/pokemon/tools/build-battle-data.js` (→ `moves.json`,
  `learnsets.json`). One script, not a pure stage list; `public/generated/` is committed so a clone needs no rebuild.
- Per tileset `public/generated/tiles/<slug>/{catalog.json, pack.json, pack.bin, obj/, tex/}`: `obj/` is the
  artist-facing product (Blender, review); the pack and `tex/` are what `tiles.load` fetches. `tiles/index.json` is
  written by the builders and read by nothing in `src/`. Fifteen slugs are committed; game code loads `bw2-adastra`,
  `bw2-cave`, `pt-overworld-7`, `structures`, `props`; the rest are reachable through `preview`.
- Authored art: `assets/structures/<name>/` (`<name>.obj` + `.mtl` + `*.png` + `meta.json`, generated by
  `tools/structures/build.js` and `textures.js`) and `assets/props/<slug>__<name>/` (the chain `tools/props/analyze.js`
  → `worklist.json` → `adapt.py` inside Blender). Their packs carry fields PDSMS packs never have: material `emissive`,
  model `door`, `walkable`, `emissiveMaterials`. Names there are chosen, so `tiles.byName('structures', …)` is the
  honest handle; PDSMS names are build artefacts and are selected by category and tag (`CLAUDE.md`).

### 9.1 The catalog

`catalog.json`: `{ tileset, source, unitsPerCell, axis: 'y-up, +x east, +z south', materials, autotileSets, models }`;
a material `{ id, image, name, alpha, translucent, bothFaces, vertexColors, fog, tilingU, tilingV, uniformNormals }`; a
model `{ id, name, obj, source, category, subcategory, orientation, tags, biomes, collision, w, h, baseY, globalUv,
uvScale, bounds, materials, autotile: { set, slot, name } | null, signature, groups, tris }` (an empty slot is `{ id,
empty: true, source }`); an autotile set `{ id: 'set<n>', index, grid, slots, name, bySignature }`. `pack.json` is the
runtime subset plus `stride` and per-group `offset`/`count` into `pack.bin`. `category` ∈ `ground | path | cliff | wall |
water | shore | tree | plant | fence | building | prop | light | stairs | bridge | ledge | cave | interior | decal | meta`
(`tools/assets/classify.js`; `unknown` is a classifier bug that eight non-AdAstra packs still ship; `roof`, `window`,
`door`, `billboard` are tags). `collision` ∈ `walk | stairs | ledge | water | block | door | none`. Romaji in the source
texture names is decoded, not discarded (`ki` tree, `kusa` grass, `michi` path, `gake` cliff, `mizu` water, `hana`
flower, `saku` fence, `hashi` bridge, `kaidan` stairs, `dansa` ledge, `isu` bench, `slamp` lamp, `kage` shadow).

## 10. Save format

`localStorage['pokeidle.save']`, one JSON document, `CURRENT_VERSION = 4` (`src/offline/migrations.js`):
`{ v, createdMs, lastSeenMs, savedAtMs, meta: { sessions, playSeconds, seed, build }, slices: { <id>: … }, h }` — `h` is
an FNV-1a checksum over the stable-stringified document. Migrations run one step at a time and are never skipped:
`v1→v2` a flat `totals` bag becomes per-module `slices` + `createdMs`; `v2→v3` adds `meta` and a separate `savedAtMs`;
`v3→v4` rewrites `slices.pokemon` to the native shape and drops the adapter's `hp`. A slice versions itself (`v` inside
it); the document version moves only for a change that crosses slices. Adding a version: bump `CURRENT_VERSION`, append
a `MIGRATIONS` entry, extend `freshSave`, add a selftest case.

**Load** (`save.js`): unreadable, not an object, no `v`, checksum mismatch or a throwing migration → the raw text is
moved to `pokeidle.save.broken` and the game starts fresh (a `warn` and a toast); `v > 4` → parked intact at
`pokeidle.save.future`; a sound document is then field-repaired in place (`repair()`); `__pokeidle_probe__` is written
and removed to detect storage. **Write**: debounced `saveDebounceMs` 2000 with a `saveMaxDebounceMs` 15000 ceiling;
dirtied by the seven † events of §4; flushed on boot, `visibilitychange` (hidden), `freeze`, `pagehide`, a
`offlineHeartbeatMs` 60 s heartbeat, and dispose; every provider is captured, `h` recomputed, `setItem`. A throwing
`restore` loses only its slice.

**Slices**, hydrated in `order` (`src/offline/slices.js`; a native seam takes the adapter's order where one exists, else 50):

| order | slice | seam |
| --- | --- | --- |
| 0 | `offline` | own: `{ progress: { encounters, seconds }, carry: { money, tokens }, lifetime }` |
| 5 | `pokemon` | native `saveState`/`loadState` `{ v: 1, ordinal, party }` |
| 10 | `economy` | native `{ v: 2, wallet, bag, sellLock, upgrades, stats, buffs, vouchers, pity }` |
| 15 | `idle` | native `snapshot`/`restore` `{ v: 1, progress, totals, carry, unlocks, upgrades, lastSeenMs }` |
| 30 | `automation` | native `{ v: 1, catchOrdinal, totals, engine }` |
| 40 | `simulation` | adapter `{ mapId, cx, cz, dir }` — restored on the first matching `scene:entered`, not at hydrate |
| 45 | `travel` | native `{ v: 1, sceneId }`, self-registered (inits after `offline`) |
| 50 | `battle`, `collection`, `encounter` | native: `{ v: 1, priority }`, `{ v: 1, ordinal, overflow, dex, boxes, stored }`, `{ v: 1, steps, encounters, ball }` |

`hunts` has no slice (slot occupancy is runtime-only); `ui` has `snapshot()` without `restore()` and so is not a
provider. Under `config.showcase` the store is read-only (§6).

## 11. How work is done

`CLAUDE.md` "How work is done": the unit of work is a slice in `docs/slices/NNN-<slug>.md` from `TEMPLATE.md`, written
after inspecting the code; the roles are `.claude/agents/*.md`; the code wins over every document and the document is
corrected in the same commit; done means `npm run gate` exits 0.

## 12. `docs/STATUS.json`

What is true right now and what is still broken — nothing else.

```json
{ "updated": "2026-09-11", "commit": "…", "seed": 1337, "now": "…",
  "gate": { "at": "…", "result": "…", "seconds": { "<stage>": 0 }, "baseline": "…" },
  "open": [ { "id": "kebab-id", "module": "…", "test": "src/x/y.test.js", "what": "…", "repro": "…" } ],
  "modules": { "<id>": { "selftest": true, "openIssues": [ "kebab-id" ] } } }
```

An `open` entry earns its place by being reproducible on the current tree (`repro` is the command); history lives in
`docs/STATUS-ARCHIVE.json`. Seams rule 9 reads `open[].id` and `open[].test`: an entry that names a test must have an
`it.fails`/`test.fail` there tagged `STATUS:<id>`, and the tag cannot outlive the entry. `modules.<id>.openIssues` lists
the ids.

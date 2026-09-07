# PokeIdleHD2D — Architecture

> Authoritative contract. Builder agents implement against this document; they do not
> renegotiate it. Changes to anything in §2 (Core), §3 (Units), §4 (Events) or §5 (Module
> API) go through the **integrator** only — see §12.

---

## 0. What we are building

A browser Pokémon **idle / progression** game rendered in the **HD2D** style of
*Pokémon Gamma Emerald*'s 3D mode: real 3D voxel-ish geometry textured with DS-era pixel
art, a physically plausible sun, long soft shadows, atmospheric fog and depth, a fixed
45°-pitch camera behind the player, and 4-way grid movement in the Black & White idiom.

The player's **active Pokémon leads**; the **trainer follows** it. The city is the lobby
(Pokémon Center, Mart, plaza, NPCs, night lighting). Hunts happen in distinct biomes.
Progress accrues while the tab is backgrounded and while the game is closed.

**Never programmer art.** Anything that would ship as an untextured box, a magenta
placeholder, or a flat-shaded primitive is a bug, not a milestone.

---

## 1. Stack and repository layout

| Concern | Choice |
| --- | --- |
| Renderer | three.js `^0.185.1`, WebGL2 |
| Bundler / dev server | Vite `^8.2.2`, port **5173**, `--strictPort` |
| Language | **Plain ES modules**. No TypeScript, no JSX, no build-time codegen in `src/`. Types are documented with JSDoc where they earn it. |
| Headless capture | `puppeteer-core` driving the system Google Chrome |
| Node | ≥ 20 (tools only; never imported by `src/`) |

```
/
├── ARCHITECTURE.md          this file
├── DECISIONS.md             numbered, dated, append-only decision log
├── index.html               single entry; ?showcase=<module> selects a showcase scene
├── vite.config.js
├── assets/                  INPUT — read-only, never written by code
│   ├── overworld/<species>/{normal,shiny}.png    1253 species, 64×128, 8 frames
│   └── trainer/{hero,heroine}.png                32×768, 24 frames
├── public/
│   └── generated/           OUTPUT of tools/assets — served verbatim, committed
│       ├── tiles/<tileset>/…    obj + textures + catalog + runtime pack
│       └── sprites/…            atlases + manifests
├── src/
│   ├── core/                §2 — INTEGRATOR ONLY
│   ├── tiles/               §5.1  tile system + auto-tiling
│   ├── terrain/             §5.2  heightfield, map authoring, collision
│   ├── environment/         §5.3  sky, sun, weather, post-processing
│   ├── simulation/          §5.4  the tick loop and world state
│   ├── pokemon/             §5.5  species data, party, sprites, followers
│   ├── encounter/           §5.6  spawn tables, catch, battle resolution
│   ├── idle/                §5.7  background accrual
│   ├── offline/             §5.8  closed-tab catch-up
│   ├── economy/             §5.9  currency, items, shop
│   ├── collection/          §5.10 dex, boxes, organisation
│   ├── automation/          §5.11 auto-hunt, auto-catch, auto-sell
│   ├── ui/                  §5.12 HUD, panels, dialogue
│   ├── city/                §5.13 demo city (lobby)
│   ├── hunts/               §5.14 demo hunt biomes
│   └── preview/             §5.15 asset viewer — INTEGRATOR ONLY
├── tools/
│   ├── assets/              .pdsts → obj → catalog → runtime pack
│   ├── shots/               headless screenshot + metrics harness
│   └── seams/               cross-module contract tests
└── docs/
    ├── refs/                Gamma Emerald reference stills (read-only)
    ├── progress/            agent screenshots, per module, per round
    └── STATUS.json          §13 — the resume file
```

**Folder ownership is absolute.** A builder agent owns exactly one `src/<module>/` folder
plus its slice of `docs/progress/<module>/`. It may *read* anything. It may *write*
nowhere else. Requests for core changes go in `docs/STATUS.json → coreRequests[]`.

---

## 2. Core (`src/core/`) — integrator only

Core is deliberately small. It is the only thing every module may import, and the only
thing no builder may edit.

### 2.1 `core/registry.js` — module registry with failure isolation

Every subsystem registers itself as a **module descriptor**:

```js
/** @typedef {Object} ModuleDescriptor
 *  @property {string}   id            'terrain' | 'pokemon' | …  (folder name)
 *  @property {string[]} needs         ids that must be ready first
 *  @property {(ctx: Ctx) => Promise<any>|any} init    build and return the public API
 *  @property {(dt: number, ctx: Ctx) => void} [tick]  fixed-step simulation, seconds
 *  @property {(dt: number, alpha: number, ctx: Ctx) => void} [frame]  render-rate update
 *  @property {() => void} [dispose]
 *  @property {(mode: string, ctx: Ctx) => Promise<void>} [showcase]  §6
 */
```

Guarantees:

- `init` runs in topological order of `needs`. A cycle is a fatal startup error, reported
  once, and the app still boots with the offending modules disabled.
- **Every** `init`, `tick`, `frame` and `showcase` call is wrapped. A throw:
  1. is logged once with the module id and the full stack,
  2. **quarantines** that module (`status: 'failed'`) so it is never ticked again,
  3. marks its dependents `status: 'blocked'`,
  4. emits `module:failed`,
  5. **does not** stop the frame loop. The rest of the game keeps rendering.
- A quarantined module's API object is replaced by a **null-object proxy**: every property
  is a no-op function returning `undefined`, so callers that forgot to check do not
  cascade. Reading an unknown property logs once at `warn`.
- `registry.status()` returns `{ id, status, error, initMs }[]`, surfaced in the debug
  overlay and in every screenshot's JSON log.

> **The load-bearing rule:** one broken module must never take the game down. The dev
> server stays up and `/` stays screenshottable at all times, because other agents are
> looking at it.

### 2.2 `core/ctx.js` — the context object

The single argument passed to every module. Read-mostly.

```js
ctx = {
  registry,                 // §2.1
  bus,                      // §2.3 event bus
  clock,                    // §2.4
  rng,                      // §2.5  seeded root RNG
  config,                   // §2.6  frozen tunables + URL overrides
  three: { renderer, scene, camera, composer },   // §2.7 owned by environment/render
  get(id)                   // -> another module's public API (or the null-object)
}
```

### 2.3 `core/bus.js` — event bus

`on(type, fn) -> off`, `once`, `emit(type, payload)`. Synchronous, ordered, and
**isolated**: a throwing listener is caught, logged, and removed after 3 throws. Event
names are `namespace:verb` (see §4). Payloads are plain, structured-cloneable objects.
`bus.spy()` returns the last 256 events — the screenshot harness dumps it on failure.

### 2.4 `core/clock.js` — time

Three distinct times, never conflated:

| Name | Unit | Source | Use |
| --- | --- | --- | --- |
| `frameDt` | s | rAF delta, clamped to `[0, 0.1]` | animation, camera |
| `simDt` | s | fixed **1/20 s** accumulator | all gameplay |
| `wallMs` | ms | `Date.now()` | idle accrual, offline catch-up, save |

`clock.simTime` is a monotonically increasing float in seconds of *simulated* time. It is
the only clock gameplay may read. Background tabs: see §5.7.

### 2.5 `core/rng.js` — determinism

`xoshiro128**`. `rng.fork(label)` derives a child stream from `hash(seed, label)` so
modules never share a stream and call order between modules cannot perturb results.

**`Math.random()` is banned in `src/`.** `tools/seams/no-math-random.test.js` fails the
build if it appears. Same seed + same input event log ⇒ identical world, identical spawns,
identical loot, forever.

### 2.6 `core/config.js`

Frozen defaults, overridable per-session by query string (`?pixelScale=3&tod=19.5`) and by
`localStorage['pokeidle.config']`. Every tunable a critic might ask to change lives here,
not in a module constant.

### 2.7 `core/render.js` — the render pipeline

Owned by core, **tuned** by `environment`. The HD2D look is produced here and nowhere else.

```
scene ──▶ [ low-res HDR target  W/pixelScale × H/pixelScale ]      ← all 3D, nearest textures
              │                                                       depth+normals for fog
              ├─▶ bloom (threshold on the low-res target, 3 mips)
              ▼
        [ upscale to full res, NEAREST ]                            ← this is what makes it "pixel"
              │
              ├─▶ composite bloom (full res, smooth)
              ├─▶ tonemap (AgX) + colour grade LUT (per time-of-day)
              ├─▶ vignette + subtle grain
              ▼
            canvas
```

- `config.pixelScale` default **3** at 1080p (internal 640×360). Integer only.
- Geometry pixels stay chunky; light and bloom stay smooth. This is exactly the split seen
  in `docs/refs/03-forest-voxel-night.png` and `04-cave-golden-hour.png`.
- Camera: **perspective**, `fov 26°`, pitch **45°** below horizontal, yaw fixed, no roll.
  It follows the trainer with a critically damped spring. Never rotates. See §3.
- Shadows: one `DirectionalLight` (the sun/moon) with a **tight ortho frustum snapped to
  texel grid** around the camera focus (default 48×48 world units, 2048² map,
  `PCFSoftShadowMap`). Texel snapping is mandatory — unsnapped shadow maps shimmer, and
  shimmering reads as "programmer art" instantly.

---

## 3. Units, axes, and the grid

**One tile = one world unit.** No exceptions, no scale factors in module code.

| Axis | Direction | Notes |
| --- | --- | --- |
| **+X** | grid **east** | |
| **+Y** | **up** | 1.0 = one tile of elevation |
| **+Z** | grid **south** | screen-down-and-toward-camera |

A cell is addressed `(cx, cz)` with integer coordinates; its centre in world space is
`(cx + 0.5, height(cx,cz), cz + 0.5)`.

**Direction enum** (`core/dir.js`), fixed forever:

```
0 SOUTH (+Z, "down")   1 WEST (−X, "left")   2 NORTH (−Z, "up")   3 EAST (+X, "right")
```

### 3.1 PDSMS → world transform

PDSMS tile OBJs are **Z-up**, one unit per cell, origin at the tile's north-west corner:
`objX ∈ [0,w]` east, `objY ∈ [0,h]` **south**, `objZ` up. Verified empirically against
`Tileset_2_BW2_AdAstra.pdsts` (a flat ground quad is `(0,0,z)…(1,1,z)` with normal
`(0,0,1)`).

The exporter applies, once, at build time:

```
worldX = objX          worldY = objZ          worldZ = objY
```

and flips triangle winding to keep front faces CCW. No runtime rotation, ever.

### 3.2 Time of day

`tod` is hours in `[0, 24)`. `12.0` = solar noon. The sun's declination and azimuth are
computed from `tod` plus a fixed fictional latitude (`config.latitude`, default 36°) so
shadow directions and lengths are *physically plausible*, not hand-waved. Screenshots are
requested by `tod`, so `tod` must be fully deterministic from the query string.

---

## 4. Events

Modules communicate by event, not by reaching into each other. The bus is the seam the
integrator polices.

| Event | Payload | Emitted by |
| --- | --- | --- |
| `boot:ready` | `{ ms }` | core |
| `module:failed` | `{ id, error }` | core |
| `world:loaded` | `{ mapId, w, h, biome }` | terrain |
| `world:unloaded` | `{ mapId }` | terrain |
| `player:moved` | `{ cx, cz, dir, running }` | simulation |
| `player:enteredTile` | `{ cx, cz, tags }` | simulation |
| `party:leadChanged` | `{ instanceId, species }` | pokemon |
| `encounter:started` | `{ species, level, shiny, biome }` | encounter |
| `encounter:resolved` | `{ outcome, species, rewards }` | encounter |
| `catch:succeeded` | `{ instanceId, species, shiny }` | encounter |
| `idle:tick` | `{ elapsedS, gains }` | idle |
| `offline:applied` | `{ awayS, gains, capped }` | offline |
| `economy:changed` | `{ currency, delta, total }` | economy |
| `collection:added` | `{ instanceId, isNewSpecies }` | collection |
| `ui:toast` | `{ text, kind }` | any |
| `tod:changed` | `{ tod, phase }` | environment |
| `perf:sample` | `{ fps, drawCalls, tris, ms }` | core (1 Hz) |

Adding an event is a core change (§12).

---

## 5. Module contracts

Every module exports **exactly one** thing from `src/<id>/index.js`:

```js
export default /** @type {ModuleDescriptor} */ ({ id, needs, init, tick, frame, showcase });
```

`init` returns the module's **public API**. Nothing else is importable across module
boundaries — no deep imports of `src/other/internal.js`. `tools/seams/no-deep-imports.test.js`
enforces this.

### 5.1 `tiles` — tile system + auto-tiling
`needs: []`

```js
{
  async loadTileset(name),          // -> Tileset (from public/generated/tiles/<name>)
  getTileset(name),
  models(tilesetName),              // -> TileModel[]  { id, name, category, tags, w, h, yMin, yMax, materials[] }
  find(tilesetName, query),         // { category, tags, biome } -> TileModel[]
  autotile: {
    solve(setId, mask),             // 8-neighbour bitmask -> tile model id  (13-case blob)
    solveField(setId, occupancy, w, h) // -> Int32Array of model ids, one per cell
  },
  buildInstances(scene, placements) // -> InstancedWorld  §7
}
```

Auto-tiling reuses PDSMS's own **SmartGrid** data (5×3, 13 meaningful slots) shipped in the
catalog, so a grass/path or land/water border resolves exactly as it does in Map Studio.

### 5.2 `terrain` — maps, heightfield, collision
`needs: ['tiles']`

```js
{
  async load(mapId),                // -> MapHandle; emits world:loaded
  unload(),
  height(cx, cz),                   // -> number (world Y of the walkable surface)
  passable(cx, cz, fromDir),        // -> boolean
  tagsAt(cx, cz),                   // -> string[]  ('tallgrass','water','stairs','door:pokecenter'…)
  bounds(),                         // -> { w, h }
  authoring: { paint, fill, stamp } // used by city/hunts to compose maps deterministically
}
```

Maps are **data**, produced by `city`/`hunts` through `authoring`, never hand-placed meshes.

### 5.3 `environment` — sky, sun, weather, grade
`needs: []`

```js
{
  setTimeOfDay(tod),                // 0..24, emits tod:changed
  getTimeOfDay(),
  setBiomePreset(name),             // 'city' | 'forest' | 'cave' | 'coast' | 'meadow' | …
  setWeather(name, intensity),      // 'clear' | 'rain' | 'fog' | 'snow'
  sun(),                            // -> { azimuth, altitude, colour, intensity }
  tune(patch)                       // live-tune post stack; persisted to config
}
```

Owns: sky dome/gradient, sun+moon, ambient/hemisphere fill, height fog, volumetric shafts,
bloom threshold, per-`tod` colour grade, city window/lamp emissives at night.

### 5.4 `simulation` — the world tick
`needs: ['terrain', 'pokemon']`

Owns the player entity, grid movement (one cell per step, no diagonals, BW timing:
walk 0.25 s/tile, run 0.15 s/tile), the **lead-Pokémon-first / trainer-follows** conga
line, NPC pathing, and the fixed-step loop that drives `encounter`.

```js
{
  player(),                         // -> { cx, cz, dir, moving, running }
  moveIntent(dir, running),
  follower(),                       // -> lead pokemon entity
  spawnNpc(spec), npcs(),
  teleport(cx, cz, dir)
}
```

### 5.5 `pokemon` — species data, party, sprites
`needs: []`

Gen 1–9 compatible. Species data is a **committed snapshot** (`public/generated/species.json`);
nothing is fetched at runtime.

```js
{
  species(idOrName),                // -> { id, name, types, baseStats, gen, evolves, … }
  all(), byGen(n), byType(t),
  sprite(species, { shiny }),       // -> { atlas, frames: {south,west,north,east}[], size }
  party(), lead(), setLead(i), addToParty(inst), swap(i, j),
  createInstance({ species, level, shiny, seed })
}
```

**Sprite sheet contracts (verified against the shipped assets):**

- Pokémon `assets/overworld/<species>/{normal,shiny}.png` — 64×128, 32×32 frames,
  2 columns × 4 rows. Rows are `[north(back), west, south(front), east]`; row 1 and row 3
  are exact horizontal mirrors (verified: 1024/1024 pixels). Columns are the 2-frame walk
  cycle.
- Trainer `assets/trainer/{hero,heroine}.png` — 32×768, 24 frames, single column.
  Direction grouping verified by back-view detection and mirror analysis:
  `north: [0,7,8,9,10,20]`, `south: [11,12,13,21,22,23]`,
  `sideA: [1,2,3,14,15,16]`, `sideB: [4,5,6,17,18,19]` (sideA/sideB are exact mirrors:
  1↔6, 2↔4, 3↔5, 14↔17, 15↔19, 16↔18). **Which of sideA/sideB is west is an open item —
  the `pokemon` builder must confirm it on screen by walking left and looking, and record
  the answer in DECISIONS.md.** The within-group walk-cycle order is likewise
  screenshot-verified, not guessed.

### 5.6 `encounter` — spawns, catching, battles
`needs: ['pokemon', 'terrain', 'economy']`

```js
{
  tablesFor(biome, tod),            // -> weighted species table
  roll(biome, tod, luck),           // seeded; -> encounter | null
  begin(enc), attempt(ballId), flee(),
  autoResolve(enc, partyPower)      // idle path — no UI, pure function of state+seed
}
```

Battles are **resolved**, not turn-by-turn: a deterministic power comparison with a seeded
variance band, plus a short readable animation when the tab is visible.

### 5.7 `idle` — accrual while the tab lives
`needs: ['simulation', 'economy', 'encounter']`

The tab may be backgrounded; `requestAnimationFrame` stops and `setTimeout` is throttled to
~1 Hz. Therefore:

- A **Web Worker** (`idle/worker.js`) owns a `setInterval(1000)` heartbeat that survives
  throttling far better than the main thread, and posts `{ wallMs }` ticks.
- The main thread reconciles with `Date.now()` on every tick and on `visibilitychange`,
  and **simulates the gap in fixed 1-second steps** (capped per frame so a 3-hour gap does
  not freeze the page — it drains over a few frames with a progress toast).
- Accrual is a **pure function** `(state, elapsedS, seed) -> gains`, shared verbatim with
  `offline`. There is exactly one implementation of "what happens per second".

```js
{ rate(), simulate(state, elapsedS, seed), pending(), flush() }
```

### 5.8 `offline` — closed-tab catch-up
`needs: ['idle']`

Reads `lastSeenMs` from the save, clamps `awayS` to `config.offlineCapS` (default 12 h),
applies `idle.simulate` with a reduced efficiency curve, and presents a "while you were
away" summary. Save format is versioned with forward migrations; a corrupt save is
quarantined to `pokeidle.save.broken` and the game starts fresh rather than white-screening.

### 5.9 `economy` — currency, items, shop
`needs: []` — `{ balance(c), add(c, n, reason), spend(c, n, reason), inventory(), buy(id, n), sell(id, n), prices() }`

### 5.10 `collection` — dex, boxes, organisation
`needs: ['pokemon']` — `{ dex(), boxes(), move(inst, box, slot), sort(mode), release(inst), stats() }`

### 5.11 `automation` — the idle layer's agency
`needs: ['encounter', 'economy', 'collection']` — auto-hunt, auto-ball-select, auto-release
by rule, auto-sell. Every automation is a rule the player unlocks and configures; none are
on by default.

### 5.12 `ui` — HUD, panels, dialogue
`needs: []` (reads others through `ctx.get`)

DOM overlay (not WebGL) at full resolution, styled to sit next to a pixel scene without
fighting it. Owns: HUD, party bar, dex/box screens, shop, dialogue boxes, the "while you
were away" modal, and the **debug overlay** (`?debug=1`: fps, draw calls, tris, module
status, tod, seed).

### 5.13 `city` — the lobby
`needs: ['terrain', 'simulation', 'ui']`

A hand-authored (in code, deterministically) town: Pokémon Center with the red roof and
lit interior glow, a Mart, a plaza with a landmark, street lamps that come on at dusk, lit
windows, and NPCs on scripted routes with dialogue. This is the scene most screenshots are
taken of, and the one judged against `docs/refs/03` and `06`.

### 5.15 `preview` — asset viewer (integrator only)
`needs: ['tiles']`

`/?showcase=preview&mode=<tileset>[&filter=<category|tag>][&focus=<model>]` lays every model
of a generated tileset out on a checkerboard floor at a fixed pitch. It exists so an artist
working on a building does not have to wait for a gameplay scene to place it, and so a
critic can judge raw art with nothing else in frame. It is never part of the game.

### 5.14 `hunts` — the biomes
`needs: ['terrain', 'encounter', 'environment']`

At minimum: **forest**, **cave**, **coast**, **meadow**. Each is a believable, composed
map, not noise: readable paths, cliff walls with correct auto-tiled edges, water with a
shoreline, props with purpose. Each ships a showcase.

---

## 6. Showcase mode — every module proves itself

`index.html?showcase=<id>[&tod=..&preset=..]` boots core plus only what `<id>` needs, then
calls that module's `showcase(mode, ctx)`, which stages a scene that shows the module at
its best and its edges (all auto-tile cases, all sprite directions, all weather states…).

Rules:
1. Every module implements `showcase`. A module without one cannot pass its gauntlet.
2. A showcase must reach `window.__READY__ = true` (see §8) within 15 s.
3. A showcase must be **deterministic**: same URL ⇒ same pixels.

---

## 7. World data model — instanced and shared

The world is **cells → placements**, and placements → **instances**.

```js
/** @typedef Placement { modelId:int, cx:int, cz:int, y:float, rot:0|1|2|3, tint:int, layer:int } */
```

`tiles.buildInstances(scene, placements)` groups placements by `(modelId, materialSlot)` and
emits one `THREE.InstancedMesh` per group, sharing:

- **one `BufferGeometry` per tile model** (uploaded once, reused by every instance),
- **one `Material` per tileset texture** (nearest filtering, `RepeatWrapping`, alpha-tested
  for foliage; the tileset's own alpha/both-face/vertex-colour flags are honoured),
- a per-instance `instanceColor` used for tint (season, damage, night dimming).

Budget arithmetic: a 96×96 map uses ~80–140 distinct models × ~1.4 material slots ⇒
**~110–200 draw calls** for the whole world, resident, no per-chunk splitting, no
per-instance culling needed (a 96×96 map is ~120 k triangles, trivially inside budget).
Creature and NPC sprites are one further InstancedMesh over a runtime-built atlas.

**Performance budget (hard, measured by the harness, §8):**

| Metric | Budget |
| --- | --- |
| Frame rate @ 1920×1080 | **≥ 50 fps** sustained (p95 frame ≤ 20 ms) |
| Draw calls | **≤ 1500** |
| Triangles | ≤ 900 k |
| Programs | ≤ 60 |
| Console errors | **0** |
| Time to `__READY__` | ≤ 6 s cold |

---

## 8. The verification loop — built before the game

`tools/shots/shoot.js` — headless Chrome via `puppeteer-core` against the running dev
server. It:

1. loads `http://localhost:5173/?<params>`,
2. waits for `window.__READY__ === true` (and fails loudly on timeout),
3. sets camera preset and time of day through `window.__HOOKS__`,
4. waits `settleFrames` (default 30) so springs, streaming and lights settle,
5. writes `docs/progress/<module>/<round>/<name>.png`,
6. writes the sibling `<name>.json`:

```json
{ "url":"…", "preset":"…", "tod":18.5, "ok":true,
  "fps":{"mean":58.2,"p95ms":19.4}, "drawCalls":143, "triangles":118204, "programs":31,
  "consoleErrors":[], "consoleWarnings":[], "modules":[{"id":"terrain","status":"ready"}],
  "events":[…last 256…], "ms":4210 }
```

The page must expose:

```js
window.__READY__            // boolean
window.__HOOKS__ = {
  setPreset(name),          // named camera framings, per module
  setTimeOfDay(tod),
  setSeed(n),
  step(frames),             // advance N deterministic frames
  metrics()                 // -> the perf block above
}
```

`tools/shots/gauntlet.js` runs a matrix (presets × times of day × zoom levels) for a module
and writes a contact sheet. **No agent may claim a module works, looks good, or is
finished without a screenshot it has actually looked at.** Assertions without a PNG are
rejected by the critic on sight.

---

## 9. Assets policy

- **Licence:** CC0 / procedural only, plus the DS tilesets vendored in
  *Pokémon DS Map Studio* and the sprite sets already in `assets/`. This is a
  **non-commercial fan project**; no asset is redistributed for sale.
- **Tiles come from PDSMS, and `Black_-_White_2/Tileset_2_-_Overworld_(by_AdAstra)` is the
  default for everything.** It is the only set whose props are real 3-D geometry plus
  proper billboards rather than 45°-skewed sprites with unconnected seams.
- Other tilesets may be drawn on **only** when AdAstra lacks the piece, and then the piece
  must be adapted (via Blender, `.mcp.json` exposes a Blender MCP) to AdAstra's silhouette
  language, texel density and palette before use. A skewed-sprite prop dropped in raw is a
  gauntlet failure.
- **No generated "programmer art" stand-ins.** If a prop does not exist, compose it from
  AdAstra parts or model it; do not ship a coloured box.
- Pipeline: `.pdsts` → per-tile `.obj` + `.mtl` + textures → **classified catalog** →
  compact runtime pack. Stages are pure and re-runnable; `public/generated/` is a build
  product that is nevertheless committed so a clone runs with no extra steps.
- **Buildings we author ourselves** (DECISIONS #3 — no PDSMS tileset has a Pokémon Center)
  live in `assets/structures/<name>/` as `<name>.obj` + `.mtl` + textures + `meta.json`, and
  `tools/assets/build-structures.js` emits them as a tileset named `structures` in exactly
  the pack shape a `.pdsts` produces. A map author therefore places a Pokémon Center with
  the same call that places a tree:
  `tiles.find('structures', { category: 'building', name: 'pokemon_center' })`.

### 9.1 The tile catalog

`public/generated/tiles/<tileset>/catalog.json`:

```json
{ "tileset":"bw2-adastra", "unitsPerCell":1, "axis":"y-up",
  "materials":[{ "id":0,"image":"grass01ax.png","alpha":31,"bothFaces":false,
                 "vertexColors":false,"tilingU":1,"tilingV":1 }],
  "models":[{ "id":42,"obj":"ground/grass_path_corner_nw.obj","source":"grass_path_corner.obj",
              "category":"ground","subcategory":"grass-path-edge",
              "tags":["grass","path","edge","corner","outdoor"],
              "w":1,"h":1,"yMin":0.07,"yMax":0.07,
              "materials":[28],"autotile":{"set":"grass-path","slot":4},
              "collision":"walk","biomes":["meadow","city","forest"] }],
  "autotileSets":[{ "id":"grass-path","grid":[[0,8,16],[1,9,17],[2,10,18],[6,14,-1],[7,15,-1]] }] }
```

`category` ∈ `ground | path | cliff | wall | water | shore | tree | plant | fence | building |
roof | prop | light | stairs | bridge | interior | billboard | decal`. Names are
**human-meaningful** — `cliff_rock_corner_outer_ne`, not `ts_5_wl1`. The romaji in the
source material names is real signal and must be decoded, not discarded
(`ki`=tree, `kusa`/`grass`=grass, `michi`=path, `gake`/`yamagake`=cliff, `mizu`/`sea`/`ike`/`river`=water,
`hana`=flower, `saku`=fence, `hashi`=bridge, `kaidan`=stairs, `dansa`=step, `isu`=bench,
`slamp`=street lamp, `mori`=forest, `doukutu`=cave, `shore`=shoreline, `ue_grass`=tall grass,
`kage`=shadow, `zanami`=surf, `asase`=shallows).

---

## 10. Save format

`localStorage['pokeidle.save']`, one JSON object, `{ v: <int>, … }`. Migrations are
functions `v(n) -> v(n+1)`, applied in order, never skipped. Writes are debounced (2 s) and
also fired on `visibilitychange` and `pagehide`. A save that fails to parse or migrate is
moved aside, not repaired in place.

---

## 11. Quality bar and scoring

Modules are scored 0–10 against real HD2D reference stills in `docs/refs/`:

| Score | Meaning |
| --- | --- |
| **10** | Indistinguishable from Gamma Emerald |
| **8.5** | AAA with nits — **pass** |
| **7** | Good indie |
| **5** | Programmer art |

A pass requires **≥ 8.5 and zero console errors and every §7 budget met**. Below that the
builder receives the critic's ranked issue list and goes again, up to **4 rounds**. Scores
are recorded honestly in `docs/STATUS.json`, including failures and what is still missing.
Inflating a score is the one unrecoverable process error.

---

## 12. Process

**Waves** (each wave's builders run in parallel; the integrator runs between waves):

1. **Foundations** — `tiles` (+ auto-tiling), `idle`, `offline`
2. **World** — `terrain`, `environment`
3. **Simulation** — `pokemon`, `encounter`, `simulation`
4. **Progression** — `economy`, `collection`
5. **Experience** — `ui`, `hunts`
6. **Content** — `city`, tools polish

**The integrator** is the only agent that may touch `src/core/`, `index.html`,
`vite.config.js`, `package.json` and `ARCHITECTURE.md`. Between waves it drains
`docs/STATUS.json → coreRequests[]`, applies what is justified, rejects what is a module's
own job, fixes the seams, and re-runs `tools/seams/`.

**The critic** writes no code. It takes its own screenshots at several times of day and
zoom levels, reads the JSON logs, checks the API contract against §5, and scores.

---

## 13. `docs/STATUS.json` — resume state

```json
{ "updatedMs": 0, "wave": 2, "seed": 1337,
  "modules": {
    "tiles": { "round": 2, "score": 8.7, "status": "passed", "errors": 0,
               "openIssues": [], "lastShots": ["docs/progress/tiles/r2/autotile-noon.png"] }
  },
  "coreRequests": [ { "from":"terrain", "want":"bus event world:chunkLoaded", "why":"…", "state":"open" } ],
  "gate": { "wholeGame": null, "blindJudges": [] } }
```

Every loop iteration reads this file first and resumes from the **weakest** module, never
from scratch.

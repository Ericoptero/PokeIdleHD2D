# PokeIdleHD2D — Architecture

> **Authoritative contract.** This document says what each module exports and what it may
> not do. Implement against it; where it and `src/` disagree, the code wins and this file is
> a bug — fix it in the same commit. §2 (Core), §3 (Units), §4 (Events) and §5 (Module API)
> are the load-bearing sections: changing one changes every module, so record the change as
> a `docs/DECISIONS.md` entry rather than editing quietly.

---

## 0. What we are building

A browser Pokémon **idle / progression** game rendered in the **HD2D** style of
*Pokémon Gamma Emerald*'s 3D mode: real 3D voxel-ish geometry textured with DS-era pixel
art, a physically plausible sun, long soft shadows, atmospheric fog and depth, a fixed
45°-pitch camera behind the player, and 4-way grid movement in the Black & White idiom.

**How the party walks is a property of the place, not of the game** (DECISIONS #58). In a
hunt the player's **active Pokémon leads** and the **trainer follows** it, the keyboard does
not move them and a **closed loop path** does; in a walkable map like the city the **trainer
leads**, the active Pokémon walks behind it, and the player drives with WASD. Exactly one
Pokémon is ever in the field. The city is the lobby (Pokémon Center, Mart, plaza, NPCs, night
lighting); hunts happen in distinct biomes; a travel panel connects them. Progress accrues
while the tab is backgrounded and while the game is closed.

**The hunt is the game** (DECISIONS #61). A hunt is a closed circuit the party walks forever
past **fixed spawn slots**; coming within a tile of an occupied slot starts a battle that is
entered in real time and **resolved turn by turn** — four moves with PP, a type chart, statuses
and stat stages. A defeated wild is thrown at, with a per-species **pity** counter that floors
the odds once enough has been spent on it. Three rules fall out and are load-bearing everywhere
below:

- **Money is earned, never accrued.** Nothing in the game grows with the clock. Money comes
  from selling drops at the Mart and from releasing Pokémon, and from nowhere else. What
  accrues in a backgrounded or closed tab is experience, drops and catches.
- **Evolution is manual, and it is paid for.** Nothing evolves by itself: a Pokémon that
  reaches its level is *offered* an evolution and waits until the player presses **EVOLVE**
  in the party panel. The price is a level **and a pile of materials**, and every material is
  a drop — so the hunt gate moved from *where the player is standing* to *what they had to
  grind for*, which is a stronger version of the same rule (DECISIONS #62).
- **The trainer has a level**, earned by winning battles, and it gates which maps travel will
  take the party to.

**Never programmer art.** Anything that would ship as an untextured box, a magenta
placeholder, or a flat-shaded primitive is a bug, not a milestone.

**Every scene needs a motivated light source.** Four rounds of blind A/B against commercial
reference stills said the same thing every round: the frames we won — the city at night, the
cave by torchlight — had a practical light in shot, and the frames we lost were flat daylight
that judges called "a uniform tint with no light source anywhere". Lamps, windows, torches,
shafts through a canopy: compose the light, do not just set the time of day.

---

## 1. Stack and layout

| Concern | Choice |
| --- | --- |
| Renderer | three.js `^0.185.1`, WebGL2 |
| Bundler / dev server | Vite `^8.2.2`, port **5173**, `--strictPort` |
| Language | **Plain ES modules**. No TypeScript, no JSX, no build-time codegen in `src/`. Types are documented with JSDoc where they earn it. |
| Headless capture | `puppeteer-core` driving the system Google Chrome |
| Node | ≥ 20 (tools only; never imported by `src/`) |

`src/<module>/` is the unit of ownership: one folder, one `index.js` default export, one
entry in §5. `assets/` is read-only input; `public/generated/` is committed build output
that `npm run assets` reproduces; `tools/` is Node-only and is never imported by `src/`.
Everything else the filesystem will tell you faster than this page can.

**A module reaches another module only through `ctx.get(id)`, and only at its `index.js`.**
Reaching into a sibling's internals is a seam failure (`tools/seams/run.js`), because it
makes the §5 contract unenforceable — the whole point of the folder boundary.

---

## 2. Core (`src/core/`)

Core is deliberately small. It is the only thing every module may import, so a change here
reaches everything — measure it, and pin it in `src/core/selftest.js`.

### 2.1 `core/registry.js` — module registry with failure isolation

Every subsystem registers itself as a **module descriptor**:

```js
/** @typedef {Object} ModuleDescriptor
 *  @property {string}   id            'terrain' | 'pokemon' | …  (folder name)
 *  @property {string[]} needs         ids that must be ready first
 *  @property {string[]} [showcaseNeeds] extra ids `showcase()` needs on top of `needs` (§6)
 *  @property {(ctx: Ctx) => Promise<any>|any} init    build and return the public API
 *  @property {(dt: number, ctx: Ctx) => void} [tick]  fixed-step simulation, seconds
 *  @property {(dt: number, alpha: number, ctx: Ctx) => void} [frame]  render-rate update
 *  @property {(dt: number, alpha: number, ctx: Ctx) => void} [lateFrame]  after the camera moves
 *  @property {() => void} [dispose]
 *  @property {(mode: string, ctx: Ctx) => Promise<void>} [showcase]  §6
 */
```

Guarantees:

- `init` runs in topological order of `needs`. A cycle is a fatal startup error, reported
  once, and the app still boots with the offending modules disabled.
- `lateFrame` runs after `makeCameraRig.update()` has placed the camera for this frame and
  before anything is drawn. `frame` cannot: the camera's focus is set from inside a `frame`
  hook (`simulation`), so the rig can only move once `frame` is done — and a module that reads
  `camera.matrixWorld` from `frame` therefore gets the *previous* frame's camera. `pokemon`
  lands its sprites on the internal pixel grid, so it is on `lateFrame`; DECISIONS #59.
- **Every** `init`, `tick`, `frame`, `lateFrame` and `showcase` call is wrapped. A throw:
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
- **`?break=<id>[,<id>]` quarantines a module on purpose**, before its `init` runs, down the
  same path a real throw takes — dependents block, the null object stands in, the frame loop
  keeps going. Reported at `warn`, not `error`, because a quarantine the URL asked for is a
  handled path and §7 budgets zero console errors. It exists so the rule below can be
  *photographed* rather than only asserted (DECISIONS #70).

> **The load-bearing rule:** one broken module must never take the game down. The dev
> server stays up and `/` stays screenshottable at all times, because other agents are
> looking at it.

### 2.2 The context object

The single argument passed to every module. Read-mostly. **There is no `core/ctx.js`** — it is
built inline in `src/main.js`, which is therefore the only place that can add to it.

```js
ctx = {
  THREE,                    // the three.js namespace, so modules do not import it twice
  registry,                 // §2.1
  bus,                      // §2.3 event bus
  clock,                    // §2.4
  rng,                      // §2.5  seeded root RNG
  config,                   // §2.6  frozen tunables + URL overrides
  log,                      // the console wrapper; §7 counts what goes through it
  three: { renderer, scene, camera, view, rig, sun },   // §2.7 owned by core, tuned by environment
  get(id)                   // -> another module's public API (or the null-object)
}
```

There is no `composer`: the post stack is hand-written in `core/render.js` and reached
through `three.view.grade`.

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

**`Math.random()` is banned in `src/`.** `tools/seams/run.js` fails the build if it
appears (`seam-allow` on the line is the escape hatch, for tools-facing code only). Same seed + same input event log ⇒ identical world, identical spawns,
identical loot, forever.

### 2.6 `core/config.js`

Frozen defaults, overridable per-session by query string (`?pixelScale=3&tod=19.5`) and by
`localStorage['pokeidle.config']`. **Every tunable lives here, not in a module constant** — that is what lets a
screenshot be requested at an exact time of day, seed and pixel scale.

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

- **`config.pixelsPerUnit` = 32 is the pixel grid, and it is the primitive** (DECISIONS #60).
  One world unit is 32 internal pixels, at every depth, on every device. Everything else about
  the camera is derived from it. It takes **16, 32 or 64 and nothing else**: sprites carry 16
  texels/unit so `ppu/16` must be whole, tiles carry 32 so `ppu/32` must be whole or an exact
  half, and 48 satisfies the first and not the second.
- `config.pixelScale` is the *upscale*, not the zoom: how many output pixels one internal pixel
  becomes. **0 derives it from the viewport** (`round(width / targetInternalWidth)`, bumped
  until the buffer fits `maxInternalWidth`), so a phone gets a buffer it can actually draw a
  street into and a 4K monitor gets a bigger pixel rather than a wider world. Integer only, and
  the canvas **overscans** rather than letterboxing. Both internal dimensions are rounded up to
  **even**, so the world and the sprites round onto the same grid with no half-pixel phase.
- Geometry pixels stay chunky; light and bloom stay smooth. This is exactly the split seen
  in `docs/refs/03-forest-voxel-night.png` and `04-cave-golden-hour.png`.
- Camera: **orthographic**, pitch **45°** below horizontal, yaw fixed, no roll, rotation set
  rather than aimed (`lookAt` does not hit `cameraPitch` and the 3.9% error reached the
  sprites, DECISIONS #60). Frustum = internal buffer ÷ `pixelsPerUnit`. It follows the trainer
  with a critically damped spring and snaps to whole internal pixels; under orthographic that
  one snap grids the **entire frame**, because there is no depth divide to make other planes
  disagree with it. `cameraDistance` is a standoff for near/far headroom, **not** a zoom. See §3.
- The cross-device claim is gated: `node tools/shots/parity.js` asserts one density, one sprite
  size and one grid across phone, tablet, laptop, HD, FullHD and ultrawide, and `--walk` asserts
  a walk is a whole-pixel translation.
- Shadows: one `DirectionalLight` (the sun/moon) with a **tight ortho frustum snapped to
  texel grid** around the camera focus (default 48×48 world units, 2048² map,
  `PCFShadowMap`). Texel snapping is mandatory — unsnapped shadow maps shimmer, and
  shimmering reads as "programmer art" instantly.

---

## 3. Units, axes, and the grid

**One tile = one world unit.** No exceptions, no scale factors in module code. On screen a
world unit is `config.pixelsPerUnit` internal pixels — 32 — everywhere in the frame, because
the camera is orthographic (§2.7). Zoom is that number and nothing else: there is no camera
distance to solve for, and a showcase asks for a rung with `rig.frame(cx, cz, y, { ppu })` or
lets `rig.fitFraming(cellsWide, cellsDeep)` pick one.

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
`no-deep-imports` rule protects: if two modules need to talk and neither is willing to
publish an event, one of them is in the wrong folder.

| Event | Payload | Emitted by |
| --- | --- | --- |
| `boot:ready` | `{ ms }` | core |
| `module:failed` | `{ id, error }` | core |
| `world:loaded` | `{ mapId, w, h, biome }` | terrain |
| `world:unloaded` | `{ mapId }` | terrain |
| `player:moved` | `{ cx, cz, dir }` — always the **trainer** | simulation |
| `player:enteredTile` | `{ cx, cz, tags }` — the **head** of the queue, whichever it is | simulation |
| `scene:entered` | `{ sceneId, mapId, biome, formation }` | travel |
| `party:leadChanged` | `{ instanceId, species }` | pokemon |
| `encounter:started` | `{ species, level, shiny, biome }` | encounter |
| `encounter:resolved` | `{ outcome, species, rewards }` | encounter |
| `catch:succeeded` | `{ instanceId, species, shiny }` | encounter |
| `catch:failed` | `{ species, shiny, ball, odds, shakes, turn, index }` | encounter |
| `slot:respawned` | `{ biome, slot, species, shiny }` | hunts |
| `hunt:lap` | `{ biome, length }` | hunts |
| `drop:collected` | `{ items: [{ id, n }], index }` | encounter |
| `battle:started` | `{ index, ally, wild, moves }` | battle |
| `battle:ended` | `{ index, won, turns, hpFraction }` | battle |
| `pokemon:levelled` | `{ instanceId, from, to, learned }` | pokemon |
| `pokemon:evolved` | `{ instanceId, from, to }` | pokemon |
| `idle:tick` | `{ elapsedS, gains }` | idle |
| `offline:applied` | `{ awayS, gains, capped }` | offline |
| `economy:changed` | `{ currency, delta, total }` | economy |
| `collection:added` | `{ instanceId, isNewSpecies }` | collection |
| `ui:toast` | `{ text, kind }` | any |
| `tod:changed` | `{ tod, phase }` | environment |
| `perf:sample` | `{ fps, drawCalls, tris }` | core (1 Hz) |

Adding an event changes every module that might listen for it — record it in
`docs/DECISIONS.md` and add the row above in the same commit. An event named here and
emitted nowhere is worse than no event: it is a contract a listener can wait on forever.

Three events are emitted and deliberately off-contract — `tiles:loaded`,
`automation:changed`, `automation:configured`. They are internal to their own module's
showcase and debug surface; promote one to the table above only when something outside that
module needs to listen for it.

---

## 5. Module contracts

Every module exports **exactly one** thing from `src/<id>/index.js`:

```js
export default /** @type {ModuleDescriptor} */ ({ id, needs, init, tick, frame, showcase });
```

`init` returns the module's **public API**. Nothing else is importable across module
boundaries — no deep imports of `src/other/internal.js`. `tools/seams/run.js`
enforces this.

**§5 is the cross-module contract, not the full surface.** What is listed here is what
another module, a showcase or the harness may depend on; a module's own JSDoc is the
authority on everything else it exports. Adding a member is free — removing or renaming one
listed here breaks a caller, so it goes in `docs/DECISIONS.md`.

**The optional save seam.** Any module may expose two more methods on its API:

```js
saveState()        // -> a JSON-serialisable value, this module's slice of the save
loadState(value)   // <- the value a previous saveState() returned; returns true on success
```

`offline` discovers them by probe and persists whatever it finds, so a module opts in simply
by having them and needs no entry anywhere. Three rules make the seam safe:

- `loadState` must be **silent**. Replaying a collection through the normal intake path would
  re-fire `collection:added` and toast the player once per Pokémon they already own.
- `loadState` must tolerate a slice from an older version, and must refuse a newer one rather
  than guess at it. A refusal is a `log.warn`, never a `log.error` — §7 counts errors, and a
  handled path must not cost the budget.
- Derived state is rebuilt, never trusted from the file. Counts that can be recomputed from
  what was just restored cannot then desync from it.

`idle` predates this and ships `snapshot()` / `restore(value)` instead; `offline` accepts
that pair as an alias. New modules use `saveState`/`loadState`.

### 5.1 `tiles` — tile system + auto-tiling
`needs: []`

**Every call takes the tileset `slug` first.** More than one pack is loaded at a time
(`bw2-adastra`, `structures`, `props`), a model id is only unique within its pack, and a
`structures` id resolved against an AdAstra pack silently draws an unrelated model.

```js
{
  async load(slug),                 // -> Tileset (from public/generated/tiles/<slug>)
  get(slug), loaded(),              // -> Tileset | null,  string[]
  models(slug),                     // -> TileModel[]  { id, name, category, subcategory, tags, w, h, baseY, yMin, yMax, materials[] }
  find(slug, query),                // { category, subcategory, tags, biome, orientation, maxBaseY, maxCells, walkable } -> TileModel[]
  byName(slug, name), byId(slug, id),
  pick(models, cx, cz, opts),       // deterministic per-cell choice; pickOne(models, rng)
  variantsOf(slug, model), footprint,
  autotile: {
    sets(slug), describe(slug, setId), caseName(slug, sig), covers(slug, setId, mask),
    maskAt(slug, occ, w, h, x, z, outside),   // -> 8-neighbour bitmask
    solve(slug, setId, mask),                 // -> tile model id (13-case blob)
    resolve(slug, setId, mask, opts),
    solveField(slug, setId, occupancy, w, h, opts),      // -> Int32Array, one id per cell
    solvePlacements(slug, setId, occupancy, w, h, opts), // preferred: carries each case's Y
    setFlipped(slug, flipped)
  },
  setEmissiveScale(k, slug),        // the night seam — see below
  emissiveScale(slug), emissiveMaterials(slug),
  buildInstances(scene, slug, placements, opts),  // -> InstancedWorld  §7
  InstancedWorld
}
```

Auto-tiling reuses PDSMS's own **SmartGrid** data (5×3, 13 meaningful slots) shipped in the
catalog, so a grass/path or land/water border resolves exactly as it does in Map Studio.
Prefer `solvePlacements` over `solveField`: it carries the Y a case needs, so a plateau
interior lands on top of its own banks rather than at their feet.

**`setEmissiveScale(k, slug)` is how night happens to a tileset.** Lamp, window and sign
materials are authored dark and lit by scaling their emissive; `environment` drives `k` from
time of day. A tileset whose emissives are never scaled has lamps that are painted-on at
midnight. Selecting a tile by `name` still works and is warned once per name — the
classifier names a model after its dominant texture, so the name is a build artefact and
**category + tags are the stable handle**.

### 5.2 `terrain` — maps, heightfield, collision
`needs: ['tiles']`

```js
{
  register(mapId, builder),         // a scene registers its author function once, at init
  registered(),                     // -> string[]
  async load(mapId, opts),          // runs the builder; emits world:loaded
  async unload(),                   // emits world:unloaded
  current(), draft(), world(),      // -> mapId | null, MapDraft | null, InstancedWorld | null
  handle(),
  height(cx, cz),                   // -> number (world Y of the walkable surface)
  passable(cx, cz, fromDir),        // -> boolean
  collisionAt(cx, cz),              // -> 'walk' | 'block' | …
  tagsAt(cx, cz),                   // -> string[]  ('tallgrass','water','stairs','door:pokecenter'…)
  bounds(), inBounds(cx, cz),       // -> { w, h },  boolean
  MapDraft
}
```

Maps are **data**. A scene does not place meshes: it `register`s a builder that fills a
`MapDraft`, and `load(mapId)` runs it. That is what makes a map reproducible from a seed and
disposable in one call — `load` unloads the previous map first, and both scenes take
themselves down on `world:unloaded`.

### 5.3 `environment` — sky, sun, weather, grade
`needs: []`

```js
{
  setTimeOfDay(tod), getTimeOfDay(),   // 0..24, emits tod:changed
  setBiomePreset(name), presets(),     // 'city' | 'forest' | 'cave' | 'coast' | 'meadow' | …
  setWeather(name, intensity), weather(), weathers(),  // 'clear' | 'rain' | 'fog' | 'snow'
  sun(),                               // -> { azimuth, altitude, colour, intensity }
  biome(), phase(), look(),
  preset(name),                        // named tod framings for the harness: 'noon', 'golden', 'dusk'…
  tune(patch),                         // live-tune the post stack; persisted to config
  setEnclosure(v), enclosure(),        // a sealed interior: the sun must not reach inside
  shadow(), practicalShadow(), castShadows(),
  lamps: { add(spec), clear(), count() },
  skyUniforms,
  step(dt, focus)
}
```

Owns: sky dome/gradient, sun+moon, ambient/hemisphere fill, height fog, volumetric shafts,
bloom threshold, per-`tod` colour grade, city window/lamp emissives at night.

**A scene registers its practical lights through `lamps.add()`.** A lamp is a painted ground
pool plus an emissive scale on the tileset (`tiles.setEmissiveScale`), not a point light —
and it is the single strongest thing in this renderer: across four rounds of blind judging,
every frame that beat its commercial reference had a **motivated light source** in it, and
every frame that lost was flat daylight with no practical in shot. `setEnclosure(true)` seals
an interior so the sun cannot light it from outside.

### 5.4 `simulation` — the world tick
`needs: ['terrain', 'pokemon']`

Owns the player entity, grid movement (one cell per step, no diagonals, BW timing: **one
cadence, 0.25 s/tile — there is no run**), the two-walker queue, NPC pathing, and the
fixed-step loop that drives `encounter`.

**The queue is the trainer and the active Pokémon, and nothing else.** Which of the two is
at the head, whether the keyboard moves them and what walks them otherwise is handed in by
the scene through `setFormation` before it places the player (§5.13, §5.14). The camera
always follows the trainer.

**`autopilot` takes three values and a hunt uses the third.** `'none'` stands still,
`'wander'` strolls from a seeded stream, and `'route'` walks the `route` spec the scene hands
in, forever, because `makeScriptedRoute` loops by default. A `'route'` formation is `strict`
unless it says otherwise: a blocked step **stalls and warns once** rather than being silently
skipped, because a route that quietly drifts off its own path is a defect three separate places
in `hunts` have already had to document (DECISIONS #61(a)).

**A scene reacts to `pokemon:evolved`, and it is not optional.** `pokemon.evolve()` swaps the
species *in place* on the instance, so the party bar updates on its own — but `members` holds
the species object captured at the last `rebuildMembers`, and the sprite key is derived from
that. Without the listener the game showed an evolved Pokémon in the HUD and the **old sprite
still walking in front of the trainer**, indefinitely, with nothing throwing. The listener
plays the flash on the actor that is standing there and then restages; the restage runs even
when the flash cannot, because that half is the bug fix.

**Three ways to stop, and they are not interchangeable.** `halt()` *replaces* the route with
`STILL` and so loses a scripted route's position in its loop; `pause(on)` stops the party and
keeps that position, which is what a battle needs; `freeze(on)` is the screenshot tool and also
stops every NPC and the idle animation (§6).

```js
{
  player(),                         // -> { cx, cz, dir, moving }   the TRAINER
  moveIntent(dir),                  // -> boolean; false where the scene forbids input
  setFormation({ head, input, autopilot, route, strict, preferTags }),
  formation(),                      // -> the record in force
  follower(),                       // -> the active pokemon, whichever end it walks at
  followerCell(),                   // -> the HEAD's cell: where an encounter rolls
  spawnNpc(spec), npcs(), removeNpc(id),  // spec.tether: { cx, cz, radius } keeps a wild by its slot
  pause(on), paused(),              // stop without losing the route's place in its loop
  halt(), freeze(on), frozen(),     // halt() restarts the lap; pause() does not
  walk(route, opts), wander(opts), autopilot(mode, opts),
  advanceSteps(n), advanceTo(cx, cz),     // deterministic stepping, for the harness
  frameOffset(), lineup(), trail(), gap(),
  surfaceAt(cx, cz), rebuildSurface(),
  teleport(cx, cz, dir)             // same map only; `travel` changes maps
}
```

### 5.5 `pokemon` — species data, party, instances, sprites
`needs: []`

Gen 1–9 compatible. Species data is a **committed snapshot** (`public/generated/species.json`);
nothing is fetched at runtime. Besides types and base stats it carries `catchRate`,
`growthRate`, `baseExp` and `evo` — the evolution requirement **inverted onto the parent**,
because Showdown records it on the child and the game asks the opposite question
(DECISIONS #61).

```js
{
  species(idOrName),                // -> { id, name, types, baseStats, catchRate, evo, … }
  all(), byGen(n), byType(t), count(), generations(), baseForms(),
  sprite(species, { shiny }),       // -> { atlas, frames: {south,west,north,east}[], size }
  spriteUrl(species, { shiny }), spriteSheet(species), trainers(),
  party(), lead(), setLead(i), addToParty(inst), swap(i, j),
  createInstance({ species, level, shiny, seed, ivs }),

  grantExp(instanceId, n, { source }),   // -> { levelled, learned, pending }; NEVER evolves
  grantPartyExp(n, { source }), levelUp(instanceId),
  firstConscious(),                      // the lead that can still fight (§5.6)
  instance(instanceId),
  canEvolve(instanceId),                 // -> the bill: { to, level, have, materials, missing, ready }
  evolutions(instanceId),                // -> every route this species has, each priced
  evolve(instanceId, { to }),            // -> { ok, why } — only ever called by a button
  refreshMoves(instanceId), setPriority(instanceId, moveIds),
  heal(instanceId, { hp, status }), damage(instanceId, n),
  sprites.playEvolution({ actorId, from, to, shiny }),   // -> Promise; the flash
  saveState(), loadState(v)
}
```

**An instance is a real Pokémon now**, not a label: `{ instanceId, species, level, shiny, exp,
ivs, stats, maxHp, hp, moves: [{ id, pp, maxPp }] × 4, priority, status }`. Two rules:

- **`instanceId` is minted once and never recomputed.** It used to be built from the level,
  which changes the moment a Pokémon levels — and `collection` keys its bus intake off it.
- **`grantExp` never evolves anything.** It reports `pending` — what the Pokémon would
  become, the level it needs, the materials it needs, how many of each the bag holds, and
  whether the button can be pressed. `evolve()` is the only path into an evolution and it is
  only ever called by the player (DECISIONS #62).
- **An evolution costs a level and materials.** The bill is derived in
  `pokemon/evolution.js` from the child's base-stat total and capture rate, and paid in
  `category: 'treasure'` items — the twelve drops `economy` has shipped with no way to obtain
  them since it was written. `evolve()` spends them through `economy.take()`; this module owns
  the creature and the ledger owns the bag.
- **A refusal says which of the three reasons it is** — no route, too low, or short of
  materials — because a greyed-out button that does not say why is the defect the party panel
  exists to avoid.
- **An evolution is a cutscene, and it lives in `ui` (§5.12).** `pokemon` publishes the
  timing (`evolutionTiming()`); the picture is a full-resolution DOM overlay, because the
  overworld sprite mesh has no per-instance colour and the white-out that *is* an evolution
  is one CSS filter there and impossible in the mesh. `simulation`'s only job on
  `pokemon:evolved` is to restage the walking sprite (§5.4).

The save seam here is **native and mandatory**: `offline`'s adapter rebuilds a party through
`createInstance` and would silently drop moves, PP and HP.

**Sprite sheet contracts (verified against the shipped assets):**

- Pokémon `assets/overworld/<species>/{normal,shiny}.png` — 64×128, 32×32 frames,
  2 columns × 4 rows. Rows are `[north(back), west, south(front), east]`; row 1 and row 3
  are exact horizontal mirrors (verified: 1024/1024 pixels). Columns are the 2-frame walk
  cycle.
- Trainer `assets/trainer/{hero,heroine}.png` — 32×768, 24 frames, single column.
  Direction grouping verified by back-view detection and mirror analysis:
  `north: [0,7,8,9,10,20]`, `south: [11,12,13,21,22,23]`,
  `sideA: [1,2,3,14,15,16]`, `sideB: [4,5,6,17,18,19]` (sideA/sideB are exact mirrors:
  1↔6, 2↔4, 3↔5, 14↔17, 15↔19, 16↔18). **Which of sideA/sideB is west is confirmed on
  screen by walking left and looking, never inferred from the sheet.** The within-group walk-cycle order is likewise
  screenshot-verified, not guessed.

### 5.6 `encounter` — spawn tables, spawn slots, catching
`needs: ['pokemon', 'terrain', 'economy']` — **`battle` is reached through `ctx.get`, not
declared.** A quarantined engine has to cost the game its *combat*, not its *encounters*: with
`battle` in `needs` a failure there would block this module, and blocking this module blocks the
hunt. Without it the wild still appears, the exchange degrades to a level comparison, and the
animation and catch flow are untouched.

```js
{
  tablesFor(biome, tod),            // -> weight-expanded species table (a string[]; #35(b))
  rollAt(index, opts),              // seeded by INDEX, never by a continued stream
  roll(biome, tod, luck),           // the walkable-map path: a tall-grass step roll
  stepRollAt(index, biome), catchRollAt(index, turn),
  slotsNear(cx, cz), engage(slot),  // -> occupied slot near the head of the queue
  begin(enc), attempt(ballId), flee(), autoResolve(enc, lead),
  active(), last(),                 // -> the live encounter, and the one just finished
  transcript(),                     // -> the finished fight's turns, a copy
  cancel(),                         // abandon the live one — travel calls this on a hop
  advance(), advanceToStage(s), setProgress(t),   // drive the encounter cutscene
  scene(), alerting(), refit(), ready(), dispose(),
  setBall(id), ball(), bestBall(enc), oddsFor(id, enc, turn), ballContext(),
  dropsFor(index),                  // -> [{ id, n }]  pure, index-addressed
  tables(), rows(biome, tod), band(), stepRate(biome), shinyRate(), progress(), seed(),
  armed(), freeze(on), frozen(),
  pure()                            // -> { rollAt, dropAt, resolve } for idle/offline injection
}
```

There is no `battle()` accessor: the live encounter is `active()`, the one that just ended is
`last()`, and its turns are `transcript()`. Asking for a fight and asking for the encounter
that contains it are different questions and were the same call for too long.

**Battles are entered in real time and resolved turn by turn** (DECISIONS #61). `encounter`
owns none of the combat maths; `battle` (§5.17) does, and the same `resolve()` drives the
visible fight one turn at a time and the offline replay in a loop.

**How an encounter starts depends on the place, the way the formation does (§0).** A scene the
player *drives* rolls on a tall-grass step, as it always has. A scene walking a **loop path**
engages when the head of the queue comes within `config.slotEngageTiles` of an occupied **spawn
slot**.

That distance is **2, because that is where a slot is** — `hunts` authors every one at Chebyshev
2 from the circuit (§5.14). The tether's ±1 drift is what makes the meeting read as a creature
noticing the party; it is not extra reach, and counting it as reach silences the trigger
entirely.

`hunts.takeSlot(k)` hands the creature over **and takes its sprite off the map**, so the wild
that walks out to fight is the one that was standing there rather than a second copy beside it,
and the slot is scheduled to refill — which is what makes it a respawn point rather than
scenery. The species is the slot's; the level, the shiny roll and the six IVs are still
`rollAt(index)`'s, so a hunt replayed offline meets the same creature it met live.

**The walk stops for a fight and keeps its place.** `simulation.pause(true)` on `begin`,
`pause(false)` on `resolve` — never `halt()`, which would restart the lap (§5.4).

**A party with nothing conscious does not start fights**, and a fainted lead steps aside for
one that can. Without that guard a single loss ends the session — every later encounter is
entered by a fainted lead and lost in one turn.

**`attempt(ballId)` refuses until the wild is beaten**, and still returns a plain boolean
(#35(f) — anything object-shaped reads as a catch every single time). `economy` still owns the
ball and still does not roll it (#35(d)); the pity floor is `economy`'s too (§5.9). What this
module supplies is unchanged: the capture rate, the HP left after the battle, and the coin.

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
{
  rate(), simulate(state, elapsedS, seed), pending(), flush(capS),
  production(), totals(), history(), trace(), progress(), lastCatchup(),
  catalog(), unlocks(), has(id), grant(id), revoke(id),
  upgrades(), setUpgrade(id, n), setBiome(b), setLuck(n), setEfficiency(n),
  heartbeat(), lastSeenMs(), diagnostics(),
  snapshot(), restore(v)               // the legacy save-seam spelling; both are accepted
}
```

**What accrues is the hunt loop, and money is not part of it** (§0, DECISIONS #61). A second of
idling walks the loop, engages slots, resolves real battles through `battle`, and yields
experience, drops and catches. No currency is ever minted here; the player comes back to a bag
to sell.

**`simulate` is a fold, not a product.** The old contract — chunked drain equals one offline
call, exactly — held only because nothing carried between encounters. The loop carries: the
pity sum moves the odds, balls deplete, experience changes stats, party HP persists. So
`gains.progress` carries the whole running state (`index`, `hp`, `exp`, `pity`, `balls`,
`drops`, `caught[]`) and the additivity claim is restated over it: **whole encounters are still
the integers in `(p0, p1]`**, so a chunk boundary can never add, drop or renumber one, and a
fold with exact carry composes. The claim is *stronger* than it was, because the continuous
per-second half and its floating-point summation caveat are gone with the faucet.

**The encounter functions are injected, not imported.** `accrual.js` may not reach into
`encounter` (§5, no deep imports), so `encounter.pure()` — `{ rollAt, resolve, dropAt }` — is
handed in through `state` the way `state.tables` already is, and `offline` back-fills the same
bundle because functions do not survive JSON. There is now **one index space**, live and
offline, and the *same turn engine* resolves a closed-tab battle as a watched one (with the HP
writeback and the bus emits off, because a replay must not hospitalise a party that is not
there). A quarantined `encounter` hands over nothing and `accrual.js` falls back to its own
model, which is a visible degradation rather than a silent disagreement about what encounter
400 was.

### 5.8 `offline` — closed-tab catch-up
`needs: ['idle']`

Reads `lastSeenMs` from the save, clamps `awayS` to `config.offlineCapS` (default 12 h),
applies `idle.simulate` **once** with the elapsed time discounted, and presents a "while you
were away" summary.

Catches made while away are **materialised** — species, level, IVs and the ball — and handed to
`collection`, rather than reported as a count nobody can open.

The discount is a curve, not a scalar: full rate for `config.offlineGraceS` (30 min), then
decay with half-life `config.offlineHalfLifeS` (1 h) towards a floor of
`config.offlineEfficiency` (0.55), integrated in closed form — 12 h away is worth about 62 %
of 12 h played. It is applied **to the time axis**, not to `idle`'s own `state.efficiency`
scalar, so it holds whatever `idle` decides a second is worth, including its index-addressed
encounters (DECISIONS #15). Save format is versioned with forward migrations; a corrupt save is
quarantined to `pokeidle.save.broken` and the game starts fresh rather than white-screening.

### 5.9 `economy` — currency, items, shop, prices, pity, the trainer
`needs: []`

```js
{
  balance(c), wallet(), currencies(), capacity(c),
  add(c, n, reason), spend(c, n, reason), canAfford(c, n),
  inventory(), item(id), stock(id),
  buy(id, n), sell(id, n), sellValue(id), prices(),
  upgrades(), upgradeLevel(id), upgradeCost(id), buyUpgrade(id),
  multipliers(), catchMultiplier(), buffs(), sinks(),
  progress(), requirementMet(r),   // the single snapshot every unlock gate reads
  project(opts), incomeModel(),
  onChange(fn), selfTest()
}
```

Plus, since DECISIONS #61:

```js
{
  speciesPrice(nameOrSpecies, { shiny }),  // derived from catchRate, BST, evo stage, shiny
  pity(species),                           // -> { sum, price, ratio, t }   the meter ui draws
  applyPity(p0, species),                  // -> { odds, p0, t }   never lowers p0
  oddsWithPity(opts, species), catchOdds(opts),
  trainer(),                               // -> { level, wins, … }  DERIVED, never granted
}
```

**The trainer's level is derived, not granted.** `trainer()` is
`trainerFromWins(progress().battlesWon)` — no new state, no save slice, no migration, and a
level that disagrees with the battle count is not expressible. There is deliberately no
`grantTrainerExp`: winning a battle is the only way the number moves.

**The pity is a lerp over the finished probability, not `catchOdds`'s `bonus`.** `bonus`
multiplies `a` *inside* the Gen 3/4 formula, where `p → 1` only at `a ≥ 255` — so the
multiplier that would reach certainty depends on the capture rate, the HP, the ball and the
status all at once, and no fixed value can mean "maximum at 125 % of the price".
`catchOdds` therefore stays pure and untouched, and the floor wraps it:
`odds = p0 + (1 − p0) · t`, with `t` ramping from 0 at 90 % of the species price to 1 at 125 %.
Every ball counts at its `price` (BP shelves at `BP_MONEY_EQUIVALENT`); the counter resets on a
catch and lives in the save. `economy` credits the ledger inside `throwBall` and still never
rolls (#35(d)).

**`speciesPrice` is derived and does three jobs at once** — the sell value, the pity threshold,
and therefore how many balls a species is expected to cost. Capture rate does most of the work,
base-stat total a little, final forms a touch; the anchor is the ball line itself, so an
ordinary common is seven Poké Balls to a guaranteed catch and nothing exceeds `PRICE_CEILING`
(188 balls). A grind has to end.

**Drops are `encounter`'s** (`encounter/drops.js`), not `economy`'s: they are authored like a
spawn table and must be a pure `(seed, index) → [{id, n}]` so `offline` replays a hunt's loot
and gets that hunt's loot. `economy` only receives `give(id, n, 'drop')`. They are the **only**
source of the twelve `category: 'treasure'` items, which have shipped with sell prices and no
way to obtain them since this module was written — and they are what an evolution is paid for
with (§5.5), which is what ties the hunt to the collection.

**The trainer's level lives here**, because `progress()` is already the single snapshot every
unlock gate is evaluated against and `requirementMet` already gates shelves, shops, upgrade
tracks and automations. `progress()` keeps its shape and gains `trainerLevel`.

### 5.10 `collection` — dex, boxes, organisation
`needs: ['pokemon']`

```js
{
  dex(), boxes(), entries(opts), box(i), at(i, slot), entry(uid),
  move(inst, box, slot), swap(a, b), sort(mode), sorted(mode), sortModes(),
  deposit(inst), release(inst), releaseMany(list), planRelease(rules),
  seen(id), caught(id), owned(id), completion(), count(), free(), isFull(),
  boxCount(), totalSlots(), capacity(), ordinal(), layout(),
  importBatch(specs, { announce }),
  favourite(uid, on), nickname(uid, name), stats(),
  saveState(), loadState(v), selfTest()
}
```

The save seam here is **native and live**. `release(inst)` is one of the only two ways money
enters the game (§0); the other is selling drops.

### 5.11 `automation` — the idle layer's agency
`needs: ['encounter', 'economy', 'collection']` — auto-hunt, auto-ball-select, auto-release
by rule, auto-sell. Every automation is a rule the player unlocks and configures; none are
on by default.

```js
{
  list(), get(id), enable(id, on), toggle(id), isActive(id), unlocked(id),
  configure(id, patch), settings(id), schema(id), fields(id), operators(),
  addRule(r), updateRule(i, r), removeRule(i), moveRule(from, to),
  setRules(list), resetRules(), validate(r), describeRule(r), errors(),
  evaluate(r, facts), explain(id), facts(), preview(id),
  chooseBall(enc), ballTable(), ballLog(), history(), totals(), stats(),
  diagnostics(), reset(), saveState(), loadState(v), selfTest()
}
```

**Auto-catch triggers on `battle:ended`, not `encounter:started`.** It used to call
`attempt()` synchronously from inside the `encounter:started` emit (#35(f)); now that a ball
is illegal until the wild is beaten, that subscription would return `false` forever and
auto-catch would die with no console error at all (DECISIONS #61(j)).

### 5.12 `ui` — HUD, panels, dialogue
`needs: []` (reads others through `ctx.get`)

```js
{
  open(id), close(id), isOpen(id), openPanel(id), panel(id),
  toast(spec), say(lines), showReport(r),
  snapshot(), metrics(), dispose()
}
```

One **2-D canvas at the renderer's own internal resolution**, upscaled with the scene, costing
zero draw calls (DECISIONS #34a). Owns: HUD, party bar, dex/box screens, shop,
dialogue boxes, the "while you were away" modal, the **battle panel** (both HP bars, the move,
its PP, status and the effectiveness line), the **EVOLVE button and its bill** in the party
panel, the **evolution cutscene**, the **pity meter**, the trainer's level, the per-Pokémon
move-priority list, and the **debug overlay** (`?debug=1`: fps, draw calls, tris,
module status, tod, seed).

**`ui` is what throws the ball.** Until DECISIONS #61 nothing in the game called
`encounter.attempt(ballId)` and a player could not catch anything by hand.

**The battle panel is a docked card, not a window.** Every other panel is `full: true` and is
opened because the player asked for it; a fight is started by the world and, in a hunt, starts
every few seconds. So `panels/battle.js` draws with no scrim above the party bar, the HUD and
the button strip stay up, and it is auto-opened on **`encounter:started`** — not
`battle:started`, which fires from inside `fight()` before `encounter` has assembled the record
the card reads. It still lives in `PANELS`, and it **never opens over a panel the player
opened**, never opens in another module's showcase, and closes on `encounter:resolved`, which
is the moment `active` is cleared and there is nothing left to read.

It is a readout of a *finished* fight: `encounter.begin()` resolves the whole battle
synchronously and keeps the transcript, and the ball-throw scene that follows is the animation
of an outcome that already exists. Both HP bars, the status, the verdict, the last few
transcript lines, and the **pity meter** for the species being fought — with the catch
percentage shown only on a win, because `attempt()` refuses to throw at a fight that was lost.

**The evolution cutscene is the one thing here that is DOM and CSS rather than the canvas**
(`ui/evolution.js`, DECISIONS #64), and the reason is concrete: a white silhouette is one
`filter: brightness(0) invert(1)` in CSS and is *impossible* on the overworld sprite mesh,
which carries no per-instance colour. It is a full-resolution overlay inside `#ui`, above the
pixel canvas, and it takes no input and dismisses itself — it is not a panel, because the
button that starts it is *inside* a panel.

It stays reproducible the way §6.3 requires: it never plays under `config.showcase`, and
`ui.evolution.freeze(spec, t)` holds the whole thing at an exact moment with a negative
`animation-delay` and `animation-play-state: paused` — the browser's own timeline sampled,
rather than a second implementation of it. Its swap keyframes are **generated** from
`pokemon.evolutionTiming()` so the alternation cannot drift from the module that defines it.

### 5.13 `city` — the lobby
`needs: ['terrain', 'environment']` — `simulation`, `pokemon` and `ui` are reached through
`ctx.get` on purpose, so a broken walker costs the lobby its NPCs rather than costing the game
its lobby

A hand-authored (in code, deterministically) town: Pokémon Center with the red roof and
lit interior glow, a Mart, a plaza with a landmark, street lamps that come on at dusk, lit
windows, and NPCs on scripted routes with dialogue. This is the scene most screenshots are
taken of, and the one judged against `docs/refs/03` and `06`.

### 5.15 `preview` — asset viewer
`needs: ['tiles']`

`/?showcase=preview&mode=<tileset>[&filter=<category|tag>][&focus=<model>]` lays every model
of a generated tileset out on a checkerboard floor at a fixed pitch. It exists so an artist
working on a building does not have to wait for a gameplay scene to place it, and so raw art
can be judged with nothing else in frame. It is never part of the game.

### 5.14 `hunts` — the biomes
`needs: ['terrain', 'encounter', 'environment']`

At minimum: **forest**, **cave**, **coast**, **meadow**. Each is a believable, composed
map, not noise: readable paths, cliff walls with correct auto-tiled edges, water with a
shoreline, props with purpose. Each ships a showcase. Each declares the formation it is
played under (§5.4) and applies it inside `enter()`, before it places the player.

**A hunt is played on a closed loop, and the loop is FOUND, not authored.**

```js
{
  list(),      // each entry: { id, name, …, requiredLevel, loop: {route, w, h}|null, slots }
  loop(id),    // -> { start, route, cells, w, h } | null
  slots(id),   // -> [{ k, cx, cz, dir }]
  audit(id),   // asserts every framing, that the loop CLOSES on the shipped draft,
               //   and that every slot is exactly two cells off it
}
```

- **The circuit is derived from the draft that was built** (`compose.findLoop`), not written
  as a route string. A route is a list of relative directions with no idea where it is,
  `makeScriptedRoute` skips a blocked step, and a route authored against a map stays correct
  only until the composition changes — which it does every round.
- **It has as many corners as it is asked for, and the rectangle is the floor.** The search
  guarantees a passable rectangle perimeter — closed by construction, checkable in one pass —
  and then *bends* it: each **bump** displaces a straight run one to three cells sideways,
  which adds four corners and **cannot open the ring**, because it replaces a path between two
  cells with another path between the same two cells. Terrain with no room for a bend keeps the
  straight it had, so the shape degrades to the rectangle rather than failing.
  `config.loopCorners` (default 12, `?loopCorners=` to sweep) and `config.loopDepth` set it; a
  biome overrides either with a `loop: { corners, depth, preferTags }` field of its own, and
  `loop: { corners: 4 }` asks for the plain rectangle back.
- **Bends prefer the composed trail.** Among the bumps that fit, the one that puts the most
  `path`/`tallgrass` cells under the party wins — so a circuit drifts onto the road the biome
  laid instead of ignoring it.
- **The ring opens on a straight at least as long as the walker queue** (`straightLead`,
  `config.followerGapTiles + 2`), because `enter()` places the trainer on `cells[0]` and the
  head lands `gap` cells ahead of it — on a bent ring, a start one cell before a turn puts the
  route-walker off its own path.
- **It must stay a camera-width clear of every edge** (`margin`, 11 cells). The camera follows
  the trainer and the trainer is *on* the loop, so a circuit near a border walks the frame off
  the end of the world.
- **`audit()` walks it on the real draft, on every `enter()`**, and fails if any step is
  blocked or if it does not come home. **The Node selftest cannot check this** — it builds a
  different map from a different stream against a stub tileset, so it can go green over a
  broken framing. What it *can* pin is `findLoop` and `slotsForLoop` themselves, on a
  hand-built room; the shipped draft is `audit()`'s job, at `enter()`.
- **Slots sit at Chebyshev distance exactly 2 from the path.** A tethered wild moves ±1 tile
  and the trigger reaches 1 tile, so 2 is contact — no closer, or the party is permanently in
  a battle, and no further, or a lap never meets anything.
- **The route is rotated by `config.followerGapTiles` before it is handed over.**
  `placePlayer` places the *trainer* and lays the lead Pokémon `gap` cells ahead — and in a
  hunt the Pokémon is the head, so starting the trainer on the loop's first cell puts the
  walker that follows the route two cells past the corner, off the circuit.
- `requiredLevel` is authored **here**, not in `travel`: what a destination *is* stays with the
  scene that owns it. Meadow 0, forest 5, coast 12, cave 20.

### 5.16 `travel` — where the player is
`needs: ['terrain']`

The only thing that changes which map is loaded. It carries the destination table — the city
plus every biome `hunts.list()` reports, each with the formation its own scene declared —
serialises travel behind a `busy` flag, and saves the current scene so a reload comes back to
it. It reaches `city`, `hunts`, `simulation` and `encounter` through `ctx.get`, so a
quarantined `travel` costs the game travel rather than its lobby.

```js
{
  destinations(),                   // -> [{ id, name, kind, module, formation,
                                    //       requiredLevel, locked, why }]
  current(), busy(),
  go(id),                           // -> Promise<boolean>; tears down, enters, emits scene:entered
  boot()                            // -> where a fresh page should go: ?scene= > save > city
}
```

**`go(id)` refuses a destination the trainer is too low for**, returning `false` with a toast
rather than throwing. It reads the level from `economy.trainer()` through `ctx.get` and
**fails open**: a quarantined `economy` unlocks every destination rather than locking the
player out of the game, because one broken module must cost a feature and never the game.

The refusal **stands down under `?showcase=`**. The gate is a rule of progression, not a
property of a scene, and the harness boots a fresh save — so a gate that applied to a showcase
would make `?showcase=travel&mode=hunt-cave` photograph an empty screen instead of the cave.
`destinations()` is untouched, so the row is still drawn locked; only the refusal steps aside.

**Registered after `simulation` and before `offline`** in `src/main.js`, and it also hands
its save seam to `offline` directly if `offline` came up first — the registry's topological
order decides which, and both orders have to work.

### 5.17 `battle` — the turn engine
`needs: []`

Everything about a fight that is arithmetic. It holds no `pokemon` instance, touches no
`three`, reads no clock and has no DOM: it takes two plain **combatant records** and returns a
transcript, which is what lets `idle` and `offline` replay a battle headlessly and what lets
its selftest run under plain Node.

```js
{
  move(id), moves(), learnset(species),
  movesFor(species, level, { priority }),   // -> exactly 4 { id, pp, maxPp }
  effectiveness(atkType, defTypes),         // -> 0 | 0.25 | 0.5 | 1 | 2 | 4
  stats(baseStats, ivs, level),             // no EVs, no natures

  makeCombatant({ species, level, ivs, shiny, moves, hp, status }),
  turn(state, seed, index, turnNo),         // ONE turn, pure
  resolve(a, b, seed, index, { maxTurns }), // -> { winner, turns, a, b, hpFraction,
                                            //      transcript[], ppSpent }
  choose(self, foe, { priority }),          // best expected damage; respects PP and status

  expYield(defeated, winnerLevel), expToLevel(growthRate, level),
  ready(), selfTest()
}
```

**Depth is fixed and finite.** Damage, the 18×18 type chart, STAB, criticals, accuracy,
priority, PP, stat stages, the six major statuses, and recoil / drain / multi-hit / flinch /
high-crit. **Every other move is plain damage at its correct power, type and PP.** The chart is
authored source, not fetched data — it has not moved since Gen 6.

**Move choice is automatic**: the highest expected damage the Pokémon can still pay the PP for,
reordered by an optional per-Pokémon priority list the player controls. There is no per-turn
menu; a hunt is watched, not steered (§0).

**`turn()` and `resolve()` are the same code.** The visible fight calls `turn()` once every
few sim steps so it can be animated and screenshotted; `offline` calls `resolve()` in a loop.
One implementation of what a turn is, for the same reason §5.7 keeps one implementation of what
a second is.

**Determinism.** Every roll is addressed by `(seed, encounterIndex, turn)` on
`root/battle/<i>/<turn>` — never a continued stream. The draw order inside a turn is a
contract, new draws go on the end, and **a draw is taken unconditionally and discarded when
unused**, because a conditional draw makes the stream position depend on state (DECISIONS
#61(g), and #35(a) for the rule it inherits).

**Data.** `public/generated/moves.json` and `learnsets.json`, committed snapshots fetched by
this module's own `init` — deliberately not by `pokemon`, which already awaits
`species.json` on the boot critical path against the §7 cold-start budget. A failure here
quarantines `battle` and leaves the overworld its sprites.

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
| Time to `__READY__` | ≤ 6 s cold, measured against the **production build** on `vite preview` — never against the dev server, which compiles unbundled modules on demand and times the bundler rather than the game (DECISIONS #71) |

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
  setTimeOfDay(tod), setSeed(n), setConfig(patch),
  step(frames),             // advance N deterministic frames
  focus(cx, cz, y),         // aim the rig at a cell
  key(code, down),          // drive the player without a real keyboard
  grid(),                   // -> what is under the camera, for framing assertions
  destinations(),           // -> travel destination ids, so the boot matrix is derived
  resetMetrics(), metrics(), // -> the perf block above
  events(),                 // -> last 256 bus events
  modules(),                // -> registry.status()
  pause(), resume()
}
```

`tools/shots/boot.js` is the matrix that matters most: it asks the running tree for every
showcase and every `travel` destination, boots each one, and fails if it does not draw a real
frame. Every entry point can fail the same silent way — the page loads, `__READY__` goes true,
nothing is logged, and the frame is an empty void at nine draw calls — and a draw-call
*ceiling* cannot see that. It derives its list rather than carrying one, so a biome added
tomorrow is covered tomorrow. Showcases that prove themselves with evidence rather than a
frame (`battle` prints transcripts) are held to a text floor instead, which is tighter.

`tools/shots/gauntlet.js` runs a matrix (presets × times of day × zoom levels) for a module
and writes a contact sheet. **A visual claim needs a screenshot someone actually looked at.**
The gate cannot see composition — `regress.js` compares luminance and saturation histograms,
so a sprite in the wrong place or a panel drawn off-screen passes it cleanly.

### 8.1 `selftest.js` — the checks a screenshot cannot make

**`src/<module>/selftest.js` runs under plain Node and exits non-zero on failure.**
`tools/seams/run.js` discovers them *by existence*, so writing one starts enforcing it
immediately — there is no list to register in. This is the correctness layer of the project:
golden values recorded from seed 1337, landmark tables, and invariants swept over many runs.

Write one for anything deterministic: a formula, a table, a state machine, a save migration,
a boot decision. Compare against **literals**, not against a second live call — two calls
reorder identically and agree with each other while both being wrong (DECISIONS #35).

A module whose logic is only reachable in a browser exposes a `selfTest()` on its API
instead. It must `console.error` on failure, because §7 budgets zero console errors and that
is what turns a red invariant into a failed capture rather than red text in a screenshot
nobody reads.

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
functions `v(n) -> v(n+1)`, applied in order, never skipped. DECISIONS #61 adds one: `pokemon`
gains a native slice (stats, HP, moves, PP), `economy` gains the pity ledger and the trainer's
experience, and `encounter` gains slot occupancy — without the migration every existing save is
quarantined and the player starts over. Writes are debounced (2 s) and
also fired on `visibilitychange` and `pagehide`. A save that fails to parse or migrate is
moved aside, not repaired in place.

---

---

## 11. How work is done

**One agent takes a task end to end.** There are no waves, no builder/critic split and no
integrator to route a request through. The agent that changes `src/core/` is the agent that
noticed it needed changing; the check on that is §2's rule — a core change reaches every
module, so measure it and pin it in `src/core/selftest.js`.

**`npm run gate` exiting 0 is what "done" means.** It runs the seams (which run every
`selftest.js`), a production build, the boot matrix, `parity` and `regress`. Nothing is
finished on the strength of having been written carefully. If a check is wrong, fix the
check in the same commit and say so — never loosen a budget to get a green run.

**The gate cannot see composition.** For anything visual, take the screenshot and look at
it. `docs/progress/<module>/` is where a shot worth keeping goes; everything the gate itself
writes goes to `shots/out/`, which is ignored, so a gate run never dirties the tree.

**A deliberate visual change will move `regress` metrics, and that is not a failure.**
Re-accept the baseline (`node tools/shots/regress.js --accept`) in the same commit and name
the frames that moved in the commit message. An unexplained baseline re-accept is how a
regression gets laundered into the record.

**Record the reasoning where it will be found again.** A choice that constrains future code
goes in `docs/DECISIONS.md` and is cited from the code it constrains. What happened during
the work — what was measured, what was tried, what moved — goes in the commit message.

---

## 12. `docs/STATUS.json` — resume state

Small on purpose. It answers one question: *what is true right now, and what is still
broken?*

```json
{ "updatedMs": 0, "seed": 1337,
  "now": "one sentence on where the project stands",
  "baseline": { "at": "…", "size": "1920x1080", "fps": 60, "drawCalls": 0, "consoleErrors": 0 },
  "open": [ { "module": "tiles", "what": "one line, reproducible on the current tree" } ],
  "modules": { "tiles": { "status": "…", "openIssues": [] } } }
```

**An entry earns its place by being reproducible today.** An issue nobody can trigger on the
current tree is history, and history lives in `docs/STATUS-ARCHIVE.json` with the four rounds
of blind judging, the wave notes and the old score table. Do not reintroduce scores or round
counters here: they described a review loop that no longer runs, and a stale score reads as a
fact.

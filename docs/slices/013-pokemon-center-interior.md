# 013 — A Pokémon Center interior you walk into through the city door

Status: done          Branch / commit: pokemon-center-interior / (uncommitted)

## Why

The user asked for a Pokémon Center room, entered by walking through the building's door in
the city, where Nurse Joy — and only Nurse Joy, in this one room — cures the party by hand on a
60 s cooldown, while a wipe still teleports the party in already cured. Today "the lobby is the
Pokémon Center": `city.enter()` calls `pokemon.reviveAll()` free and unconditionally
(`src/city/index.js:99-141`), and `travel`'s `party:wiped` listener teleports to the
`pokecenter-door` **marker on the outside pavement** (`src/travel/index.js:220-241`). This slice
gives the Center a real interior and a door; the next slice (014) moves the cure inside it,
gates it behind Nurse Joy and a cooldown, and removes the free lobby heal. This slice by itself
changes **no healing behaviour** — the city still heals on arrival — so it can land and gate
green on its own before 014 touches DECISIONS #81's redundancy net.

Full plan: `/Users/ericnantes/.claude/plans/create-a-location-for-mutable-pumpkin.md`.

## Inspected before writing this slice

- `src/city/index.js:1-231` (full) — `enter()` sequence: `env.setBiomePreset('city')` →
  `env.setWeather('clear',0)` → `terrain.load('demo-city', {...})` → `dressCity(ctx)` →
  `sim.setFormation(...)` (before `placePlayer`, lays the queue out against `head`) →
  `sim.placePlayer(...)` → `rig.setFocus(...)` → `populateCity(ctx)` → `heal()`. A
  `bus.on('world:unloaded', ...)` at `:58-64` tears down `cast`/`dressing` — required or the
  next map inherits this scene's NPCs and instanced worlds.
- `src/city/layout.js:38` — `PLOTS` includes `{ id:'pokecenter', kind:'pokemon_center', x:22,
  z:34 }`; `:485` `pokecenter: { cx:26, cz:42 }` camera preset.
- `src/city/map.js:166-193` — doors are minted per plot: `draft.setCollision(door.cx,door.cz,
  'door')`, `draft.addTag(door.cx,door.cz, 'door:pokecenter')`,
  `draft.mark('pokecenter-door', door.cx, door.cz+1, {kind:'door', plot:'pokecenter',
  cell:{cx,cz}})` — the marker sits **one cell south of** the door cell itself, so the arrival
  tile carries no `door:` tag (no re-entry loop).
- `src/city/structures.js:1-322` (full) — a second tileset is a second `InstancedWorld`
  (`buildInstances` resolves model ids against exactly one tileset, header `:1-17`); the lamp
  bulb/filament pairing at `:237-296` (`env.lamps.add`, `point:false,pool:false` for the
  filament) is the pattern to copy for the window shaft; `unshadowRoofs` at `:65-75` is a
  workaround this room does not need (a hipped roof) but the render-budget comment at `:1-9`
  (four worlds ≈ two dozen draw calls against 1500) is the number to stay under.
- `src/city/npcs.js` (full) — `spawnNpc` is batched behind one `pokemon.sprites.prepare(...)`
  call (`:68-76`), then three `setTimeout(0)` turns (`:92`) so a screenshot never catches half
  a cast; `STAGE_STEPS=47` (`:29`) for `stageCityForShot`.
- `src/travel/index.js:1-282` (full) — `destinations()` (`:67-93`) is two hardcoded/table-driven
  branches, no `hidden` flag exists yet; `go(id)` (`:104-169`) dispatches on `ctx.get(dest.module)`
  and calls `owner.enter(dest.arg ?? undefined)`; `boot()` (`:181-196`); the save seam
  self-registers with `offline.store.register('travel', {..., order:45})` at `:263-271` because
  `travel` inits after `offline` in the derived Kahn order — any new module with its own save
  slice must check the same thing.
- `src/terrain/draft.js` (full) — `MapDraft` API: `place`, `fill`, `autotile`, `scatter`, `mark`,
  `setHeight`/`heightAt`, `setCollision`/`collisionAt`, `addTag`/`tagsAt`, `passable`.
  `COLLISION_PASSABLE = new Set(['walk','stairs','shallow','door'])` at `:10`.
- `src/terrain/index.js:32-73` — `register(mapId, builder)`, `load(mapId, opts)` (unloads first,
  builds the draft, runs the builder, `tiles.load`, `tiles.buildInstances`, emits
  `world:loaded`), `unload()` (emits `world:unloaded`), `handle()` → `{id,w,h,biome,tileset,
  spawn}` (key is `id`, not `mapId`).
- `src/environment/index.js:780-912` — `apply()` reads `overrides.enclosed ?? look.enclosed ?? 0`
  to decide `wantsShadow`; `setBiomePreset('interior')` alone sets `look.enclosed = 1` for the
  `interior` preset (`presets.js:478-492` — verified, `enclosed:1`). **No module in the tree
  calls `setEnclosure` explicitly** — `hunts`' cave biome relies on the preset alone
  (`grep setEnclosure src/hunts` — zero hits) — so this slice follows the same idiom and does
  not call `setEnclosure` unless a screenshot shows the preset's default is wrong for this room.
- `src/environment/lamps.js:344` — `lamps.add(spec)` signature verified: `{x,y,z,color,
  intensity,radius,size,point,pool,groundY}`; `groundY` overrides the terrain lookup for the
  ground pool decal, needed here because the indoor floor sits at **y −0.125**.
- `public/generated/tiles/pt-house-indoor/catalog.json` — 79 models, confirmed by direct read:
  floors (`category:'interior'`, `collision:'walk'`, y −0.125) including 10 `wooden_floor`
  variants, 10 `wooden_floor_slash` variants, `floor_2`/`floor_2_v2`, and a 2×2
  `modern_floor_light`; two complete carpet autotile sets `set0` (`carpet`) and `set1`
  (`carpet_rombo`), all 13 slots present; walls (`collision:'block'`, y −0.125 → 2.875):
  `house_wall`/`house_wall_v2/v3` (north-facing slab, z 0→0.375), `house_wall_side`/`_v2` (east
  face at x=1 / west face at x=0), `house_wall_c_w`/`_c_e` (+v2/v3) corners,
  `house_wall_sw`/`_se` (+v2/v3) corner returns, `wall_top_n`/`wall_top_s`/`wall_n` caps at
  y=2.875, and a `modern_wall_*` clinic family (`modern_wall_s/w/e`, `modern_wall_b_w/_b_e`,
  `modern_wall_b_l2j/_r2j`) on `labo_01`/`labo_02` materials — closer to a clinic look than the
  cottage `house_wall` family. One furniture piece: `table` (id 70, `category:'unknown'`,
  `subcategory:'table'`, tags `['multicell']`, 3×1, `collision:'block'`, counter-textured
  `counter_h01/h02_mat`) — reachable only by `tiles.find(slug,{subcategory:'table'})` or
  `tiles.byName(slug,'table')`, **not** by `category:'interior'`.
- `public/generated/tiles/hgss-newbark-houses/catalog.json` — the only window geometry in the
  project: `window` (3×1, tags `multicell,wall,window`) and a full glass autotile family
  (`glasscorner_corner_*`, `glassmiddle_edge_*`).
- `public/generated/tiles/bw2-adastra/catalog.json` — `bench_n/s/e/w` (`category:'prop'`, tags
  `bench,occluder,seat`, 1×1, `collision:'block'`) for seating.
- `public/generated/tiles/structures/catalog.json` — `pokemon_center` model: `w:8,h:6,baseY:0,
  door:[3,5],collision:'block',emissiveMaterials:['window','door']` — the door offset is at
  model-space x=3 (west edge of the door quad, per `city/layout.js:59-63` `doorCellOf`'s
  comment), landing on cell 3 within the footprint, row 5 (south edge).
- `src/main.js:45-95,111-130,203-267` — `MODULES` array (import + registration), the boot
  decision (`nav.go(nav.boot())`, falls back to `demo-city`), `__HOOKS__.setPreset(name)`
  dispatches to `travel.current()?.module`, `__HOOKS__.destinations()` reads
  `registry.get('travel').destinations()`.
- `src/ui/panels/travel.js:1-60` (`rows()`) — maps `travel.destinations()` 1:1 with no filter
  today; a `hidden` flag needs one `.filter()` added here.
- `src/ui/input.js` (full) — `KeyZ`/`Space` are unbound outside a panel; confirmed for slice 014,
  not touched by this slice.
- `docs/DECISIONS.md` #81 (full) — the three-net redundancy this slice's sibling (014) must not
  break; read in full so 013's door-warp code does not duplicate or fight `travel`'s existing
  `party:wiped` handler (untouched in 013 — that handler still targets the outside marker until
  014 repoints it).
- `tools/shots/regress.js:1-60` — row shape `{id, showcase, mode?, preset?, tod}`; 17 rows today.
- `docs/baseline.json` exists and is what `--accept` rewrites.

## Files / modules affected

New: `src/pokecenter/index.js`, `src/pokecenter/layout.js`, `src/pokecenter/map.js`,
`src/pokecenter/dress.js`, `src/pokecenter/selftest.js`, `src/ui/panels/travel.test.js` (no
test file existed yet for that panel).

Edited: `src/main.js` (import + `MODULES` array), `src/travel/index.js` (`destinations()` gains
a third row with `hidden:true`; `pokecenter`'s own door-warp listener lives in the new module,
not here), `src/travel/selftest.js` (destination count assertion), `src/ui/panels/travel.js`
(`rows()` filters `hidden`), `tools/shots/regress.js` (+1 row), `docs/baseline.json` (accepted),
`ARCHITECTURE.md` (§1 "Stack and layout" — `registry.add` count and the derived init order —
not a "module table", which is `CLAUDE.md`'s; new §5.18; §5.16 destinations shape; §4's
`world:unloaded`/`player:enteredTile` listener lists), `CLAUDE.md` module table,
`docs/DECISIONS.md` (+#82), `tests/flows/boot.spec.js` (its registered-module-ids assertion,
an unavoidable consequence of `pokecenter` existing — not previously in this list). No save
slice, so §10 is untouched. `docs/STATUS.json` was reviewed and left alone — see Result.

## Expected behaviour

- `?scene=pokecenter` boots directly into the room: floor, walls, a counter, a window with a
  motivated light shaft, seating, at least one instanced world beyond the base tileset.
- Walking onto the city's Pokémon Center door tile (`door:pokecenter`) warps into the room at a
  spawn point facing the counter. Walking onto the room's exit tile warps back to the city,
  standing on (or immediately adjacent to) the `pokecenter-door` marker, facing away from the
  building.
- `terrain.handle().biome === 'city'` inside the room (the landmine in the plan: `'interior'`
  is not in `encounter`'s `BIOMES` list and would silently fall back to the **meadow** spawn
  table). `encounter.tablesFor()` for `'city'` is `[]` — already true and already tested.
- `travel.destinations()` gains a `{id:'pokecenter', ..., hidden:true}` row; the T panel is
  visually unchanged (5 rows, not 6).
- The city still heals on arrival (unchanged in this slice).
- `npm run gate` exits 0; the new `boot` case for `pokecenter` draws ≥ 20 draw calls at 0
  console errors.

## Acceptance criteria

1. `node tools/shots/boot.js` (or the full gate's `boot` stage) passes `?scene=pokecenter` at
   ≥ 20 draw calls, 0 console errors, 0 modules `failed`/`blocked`.
2. `src/travel/selftest.js` exits 0 with the destination-count assertion updated to
   `2 + BIOMES.length` and a new case asserting the `pokecenter` row carries `hidden:true` and
   `ui/panels/travel.js`'s row list stays at 5 entries (mocked `travel.destinations()` with the
   hidden row included, or a targeted unit test — implementer's choice, but it must exist).
3. `src/pokecenter/selftest.js` exits 0 under plain Node (seams rule 6): the exit cell is inside
   the room's bounds and walkable; the spawn cell and exit cell are distinct and orthogonally
   adjacent or connected by a walkable path; every counter placement is `collision:'block'`.
4. New `tests/flows/pokecenter.spec.js` (Playwright): from `/`, drive the trainer via
   `__HOOKS__.key` from the `city.marker('pokecenter-door')` cell onto the door cell, assert a
   `scene:entered {sceneId:'pokecenter'}` event; then walk onto the interior's exit cell, assert
   a `scene:entered {sceneId:'demo-city'}` event and that the trainer's cell is the
   `pokecenter-door` marker cell or its immediate neighbour. Both loops bounded (fail on a named
   message, not a timeout). Zero console errors throughout.
5. `terrain.handle().biome === 'city'` when `travel.current().id === 'pokecenter'`, and
   `ctx.get('encounter').tablesFor('city', 12)` is `[]` (already guaranteed by
   `TABLES.city = []`, asserted here as a regression guard specific to this scene).
6. A new regress row `{id:'pokecenter/12', showcase:'pokecenter', tod:12}` is added (17→18 rows)
   and `node tools/shots/regress.js --accept` run in the same commit; the commit message names
   which frames moved and why (a brand-new row always "moves" from nothing — that is expected,
   per `CLAUDE.md`, not a failure).
7. `npm run gate` exits 0.

## Tests required

- `src/pokecenter/selftest.js` (new, seams rule 6).
- `src/travel/selftest.js` (edited — count + hidden-row cases).
- `tests/flows/pokecenter.spec.js` (new).
- `src/ui/panels/travel.js` unit coverage for the `hidden` filter (vitest, if the panel does not
  already have a test file — check before adding one; `src/ui/*.test.js` convention).
- `tools/shots/regress.js` new row + accepted baseline.

## Verification in the real application

```
npm run shot -- --out shots/out/pokecenter-11.png --showcase pokecenter --tod 11
npm run shot -- --out shots/out/pokecenter-21.png --showcase pokecenter --tod 21
```
Open both and look — `regress` compares ten scalars and cannot see composition (`CLAUDE.md`).
Check for: no untextured box, no magenta; the counter reads as a counter, not a random 3×1
slab; the window throws a real light shaft distinguishable from ambient fill; wall-to-floor
meets cleanly at y −0.125 with no seam or z-fighting; the room is lit by the window + lamps, not
by a sun that is not in the room (confirms the `interior` preset's `enclosed:1` is taking
effect — if it visibly is not, that is when `setEnclosure(1)` gets added explicitly, and the
"inspected" note above is corrected in the same commit per `CLAUDE.md`'s "reality wins").

Then walk it for real: `/?seed=1337`, WASD to the Center door in the city, through, look around,
back out.

## Docs to touch

`ARCHITECTURE.md` §1 — **correction, reality wins**: §1 ("Stack and layout") has no
"module table" — that table is `CLAUDE.md`'s, under "Where the code lives". Touched §1's
`registry.add` count and derived init-order list instead, plus a new §5.18 `pokecenter`,
§5.16 travel's destination shape gaining `hidden?`, and §4's two listener-list rows
(`world:unloaded`, `player:enteredTile`). §12 unaffected. `CLAUDE.md` module-ownership table
gets its own `pokecenter` row (not folded — a room reached only through a door reads
differently enough from `city`/`hunts`'s destinations to want a line of its own).
`docs/STATUS.json` — no new `open` entry: the one non-obvious thing found while building this
(§ Result — the room's east/west walls barely read as solid geometry under this camera, no
matter how they are placed) is a DECISIONS entry (#82), not a bug pinned by a failing test.

## Out of scope

- Any healing behaviour change — the city keeps healing on arrival; Nurse Joy, the cooldown,
  and removing `city.enter()`'s heal are slice 014.
- A save slice for `pokecenter` itself — nothing in this room has state yet (no cooldown until
  014). If 014 needs one, it is added there, not retrofitted here.
- The `player:interact` event, Nurse Joy the NPC, the dialogue call — all 014.
- Authored furniture (healing machine, curved counter, sofa, bookshelf, potted plant) — slice
015, composed from `tools/structures/build.js`'s pure-Node pipeline.
- A travel-menu row for the Center (explicitly `hidden:true` — door-only entry, per the user's
  confirmed answer).
- Recoloring the interior walls red (`src/city/recolor.js` reuse requires promoting it to
  `src/core/` for cross-module use — only attempted if time allows within this slice; otherwise
  filed as a follow-up, not blocking).

## Result

**Starting point.** `npm run gate:fast` was green before any edit:
```
lint       ok       2.3s
typecheck  ok       0.4s
seams      ok       1.4s
unit       ok       0.6s
✓ gate: every stage passed
```

**Built.** `src/pokecenter/{layout,map,dress,index,selftest}.js`, `tests/flows/pokecenter.spec.js`,
`src/ui/panels/travel.test.js` (new — no test file existed for that panel yet); edited
`src/main.js`, `src/travel/index.js`, `src/travel/selftest.js`, `src/ui/panels/travel.js`,
`tools/shots/regress.js`, `docs/baseline.json`, `ARCHITECTURE.md`, `CLAUDE.md`,
`docs/DECISIONS.md` (+#82), and — beyond the slice's file list, both required by the new
module existing and explained below — `tests/flows/boot.spec.js`.

**Deviations from the slice doc (reality wins):**

- **`ARCHITECTURE.md` has no "§1 module table."** That table (`| module | owns |`) lives in
  `CLAUDE.md` under "Where the code lives"; ARCHITECTURE.md's §1 is "Stack and layout", prose
  with no such table. Updated what's actually there instead: the `registry.add × 17 → × 18`
  count and the derived init-order list (§1), plus the real ask — CLAUDE.md's module table,
  a new §5.18, and §5.16's `hidden` note.
- **`tests/flows/boot.spec.js` needed an edit the slice didn't list.** It asserts the exact
  sorted array of registered module ids; adding `pokecenter` to `MODULES` in `main.js` makes
  that assertion fail by construction. Added `'pokecenter'` to the expected array — a direct,
  unavoidable consequence of the new module existing, not a design choice.
- **The west and east walls barely read as solid geometry from this camera, and no amount of
  rotation or repositioning fixes that.** Not predicted by the slice's inspection (which had
  no reason to look at face normals). `pt-house-indoor`'s wall pieces are single-sided
  (`THREE.FrontSide`) flat planes, and `core/render.js`'s camera offset has zero `x` — so a
  wall running east-west (north wall) gets real lateral distance from the camera and reads
  clearly, while a wall running north-south (east/west walls) is seen at a grazing angle
  under 0.2 in cosine, correctly-facing or not. Proved empirically: screenshotted the same
  model at `rot:0`, `rot:2`, and moved to the middle of the room, with no visible difference
  each time; confirmed `city`'s own Pokemon Center building has the identical property
  (`docs/progress/city/critic/n12-pokecenter.png` shows a roof and a front wall, no visible
  side wall, and nothing in `city` has ever added one). Recorded as **DECISIONS #82** since it
  constrains how any future room in this engine should be composed, and cited from
  `src/pokecenter/map.js`'s `sideWall()`. The room still places real geometry there (for the
  collision to hang off and because the geometry is not wrong, just barely visible) — nothing
  here reads as a placeholder or a missing-texture magenta box.
- **The room grew from 9x7 to 13x10 cells** after the first screenshot showed a small lit
  stage in a large black void (the fixed camera's frame is ~25 wide, and 9 cells used well
  under half of it). `layout.js`'s header records the arithmetic.
- **The window needed a full-height wall placed behind it**, not just its own reserved
  collision cells: the glass pane only spans y 0.25–1.75 of the wall's 2.875, and leaving the
  rest of that column empty let the void show through above and below it in the first
  screenshot. `map.js` now places the ordinary wall segment there too and only skips it for
  the window's own tag.
- **`docs/STATUS.json` — no entry added**, per the slice's own steer: the side-wall finding is
  an engineering constraint (DECISIONS #82), not a bug, and nothing here is pinned by a
  failing test.

**Screenshots taken and looked at** (not just captured — `/tmp/pcshots/*.png` during the
session; the accepted regress frame is `docs/baseline.json`'s `pokecenter/12`): the first pass
had no visible walls at all (both north and side walls were fully back-face-culled); the
second pass fixed the north wall and the window but left a black gap above them from the
window's own limited height; the final pass (`final-11.png`/`final-21.png`, day and night) has
a visible wallpapered north wall with the window and a lit counter under it, two benches, and
a light shaft from the window whose bulb+filament brightness was tuned down from the first
pass because it bloomed past the wall's own top edge into the void above at the original size.
Day (tod 11) and night (tod 21) are visually near-identical apart from the clock widget and
the window's own tint — confirming `enclosed:1` is doing its job: the room is lit by its own
lamp, not by the sun outside.

**Acceptance criteria.**
1. `node tools/shots/boot.js` — `scene pokecenter` and `showcase pokecenter` both pass at 45
   draw calls (floor is 20), 0 console errors. ✓ (both derive automatically from
   `travel.destinations()` once `pokecenter` is a live destination — no boot-matrix edit
   needed, confirmed by reading `tools/shots/boot.js`'s `discover()`.)
2. `node src/travel/selftest.js` — 43/43 checks, including new `2b`/`2c` (the Center is a
   destination and carries `hidden:true`) and `13b`/`13c` (`go('pokecenter')` still works
   despite being hidden). Count assertion is `2 + BIOMES.length`. ✓
3. `node src/pokecenter/selftest.js` — 16/16 checks (exit inside bounds and walkable, spawn
   and exit distinct and adjacent, every counter cell blocked, plus wall/bench collision
   checks beyond the slice's minimum). ✓
4. `tests/flows/pokecenter.spec.js` — passes in ~2.3s. Movement is driven through a real
   `KeyboardEvent` (`__HOOKS__.key`), which only reaches `simulation.moveIntent` from the
   render loop's own per-frame tick — `__HOOKS__.step()` calls `registry.tick` directly and
   never touches it — so the test resumes the paused render loop around each walk and polls
   real wall-clock time (bounded at 15s, fails with the event log on timeout, never on a bare
   Playwright timeout message). ✓
5. `terrain.handle().biome === 'city'` — set explicitly in `pokecenter.enter()`'s
   `terrain.load()` call; `encounter.tablesFor('city', 12)` is `[]` by the pre-existing
   `TABLES.city = []` (unchanged). Not written as a standalone new test file since it is a
   one-line consequence of the `enter()` call already exercised by the flow spec and the
   boot matrix; asserting it again would test the same line twice. ✓ (verified by reading
   `src/pokecenter/index.js`'s `enter()` and `src/encounter/tables.js`.)
6. `pokecenter/12` row added to `tools/shots/regress.js` (17→18 rows) and
   `node tools/shots/regress.js --accept` run. The only rows that moved: `pokecenter/12`
   (brand new, expected) and `tiles/12` (`mean` 89.62→89.61, `belowL8Pct` 2.393→2.376,
   `pureBlackPct` 0.134→0.132, `saturation` 0.5582→0.5584 — all within the metric's own
   tolerance, ordinary capture noise, confirmed by a clean second `node tools/shots/regress.js`
   run reporting 0 regressed/0 moved against the newly accepted baseline). ✓
7. `npm run gate` exits 0 (see table below). ✓

**Final `npm run gate` (full):**
```
  lint       ok       3.0s
  typecheck  ok       0.5s
  seams      ok       1.6s
  unit       ok       0.6s
  build      ok       4.6s
  coldboot   ok       4.0s
  boot       ok       87.6s
  flows      ok       17.4s
  parity     ok       34.1s
  regress    ok       65.0s
  total               218.3s
✓ gate: every stage passed
```
`boot` covers 24 cases now (was 23) — `scene pokecenter` and `showcase pokecenter` both new,
both passing. `flows` covers 8 specs now (was 7) — `pokecenter.spec.js` new. `unit` runs 5 test
files now (was 4) — `src/ui/panels/travel.test.js` new.

**Left out, on purpose (matches "Out of scope"):** no healing change, no Nurse Joy, no
`player:interact`, no save slice, no authored furniture beyond the pack's one `table`, no
travel-menu row, no wall recolor.

### Review + test pass (reviewer, tester, integrator — parallel, per `CLAUDE.md`)

**Reviewer**: no must-fix findings. Independently re-ran every acceptance check, re-derived the
Kahn init order from every module's real `needs` array by script (matched `ARCHITECTURE.md`
and `main.js` exactly), re-derived the DECISIONS #82 camera-angle arithmetic from
`core/render.js`'s actual offset (`cos θ ≈ 0.196`, matching the entry's "under 0.2"), and took
independent screenshots confirming real textured geometry, a lit window shaft, and
day/night near-identity (confirming `enclosed:1`). Two nice-to-haves, both applied here:
`docs/STATUS.json`'s `modules` map had no `pokecenter` entry (added); the counter reads as "a
lit raised block" more than an obvious reception desk at a glance (accepted — deferred to
015's authored furniture, already out of scope).

**Tester**: wrote 4 new test files independent of the implementer's own
(`src/travel/pokecenter-race.test.js`, `src/ui/panels/travel-realwiring.test.js`,
`tests/flows/pokecenter-quarantine.spec.js`, `tests/flows/pokecenter-scene.spec.js`) covering
`travel.go()` re-entrancy/races, a hidden-destination save round-trip, wiring the *real*
`travel` module to the *real* `ui/panels/travel.js` (not a hand-authored fixture),
`?break=pokecenter` quarantine, and a live in-room `terrain.handle().biome`/
`encounter.tablesFor()` check plus a real-reload save test — each proved to fail on the
pre-slice tree with an on-topic message, then proved to pass post-slice. Found one incidental
bug in the implementer's own `tests/flows/pokecenter.spec.js`: its `walkOnto()` helper called
`key(page, code, false)` to release a key, but `tests/flows/harness.js`'s exported `key()` only
forwarded a single argument to `__HOOKS__.key`, so every call silently dispatched `keydown` —
harmless by luck (the next press overrides the held stack regardless) but not doing what it
looked like. Fixed here: `harness.js key()` now accepts and forwards `down` (default `true`,
so every existing single-arg call site is unaffected) — `tests/flows/hunt.spec.js`'s `key(page,
'KeyZ')` call and the new pokecenter specs both re-verified passing after the change.

**Integrator**: no contract violation across `needs`/`showcaseNeeds` ordering, the
`destinations()` `hidden` field's every consumer, the save-slice round-trip for
`sceneId:'pokecenter'`, the event contract (no new `bus.emit`, seams rule 8 holds), module
boundaries, `world:unloaded` teardown/lamp-clear symmetry, and DECISIONS #82's filing/citation.
Flagged a process risk, not a slice defect: reviewer/tester/integrator ran concurrently in one
shared (non-worktree) working tree, and the integrator's own `git reflog` read mid-run showed a
branch checkout and reset it did not perform — almost certainly the tester exercising
`?break=` scenarios. No data was lost (verified: all tracked diffs and untracked files intact
before and after), but it is exactly the hazard `CLAUDE.md`'s "parallel agents work in separate
`git worktree`s" line exists to prevent, and the next multi-agent review pass on this repo
should isolate concurrent write-capable agents into worktrees rather than share one tree.

**Post-review additions** (this pass): `docs/STATUS.json` `modules.pokecenter` entry;
`tests/flows/harness.js`'s `key()` now forwards `down`. Full `npm run gate` re-run after both
changes, with all seven pokecenter-related test files present:

```
lint       ok       2.3s
typecheck  ok       0.4s
seams      ok       1.5s
unit       ok       0.7s
build      ok       3.5s
coldboot   ok       4.1s
boot       ok       87.5s
flows      ok       23.7s   (12/12 specs — hunt, hunt-recovers ×4, pokecenter ×1,
                              pokecenter-scene ×3, pokecenter-quarantine ×1, save)
parity     ok       33.1s
regress    ok       65.3s   (0 improved, 0 regressed, 0 moved, across 18 frames)
total               222.1s
✓ gate: every stage passed
```

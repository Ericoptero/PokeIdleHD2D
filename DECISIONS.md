# Decisions

Append-only. Numbered, dated, and each one records what was *checked*, not what was
assumed. Builders may add entries about their own module; anything touching core, units,
events or the module API is the integrator's to write.

---

### 1 — 2026-09-07 — Stack: three.js + Vite, plain ES modules, no TypeScript

three `0.185.1`, Vite `8.2.2`, `"type": "module"`, no build-time codegen inside `src/`.
Node ≥ 20 for tools only. `puppeteer-core` drives the system Google Chrome rather than
downloading a Chromium, so the screenshot harness starts in ~1 s and uses the real GPU.

**Why:** the brief asks for plain ES modules; a bundler-agnostic `src/` also means an agent
can reason about a file without reasoning about a build.

---

### 2 — 2026-09-07 — PDSMS smart-drawing palettes are north-up; no flip needed

`.pdsts` smart grids are 5×3 with 13 filled slots. Slot *n* (row-major) carries the
neighbour signature in `SmartGrid.smartUnits[n]` from the PDSMS Java source, in the order
`[top, bottom, left, right, tl, tr, bl, br]`.

The open question was whether PDSMS's "top" is our north (−Z) or our south (+Z), since a
palette may be drawn bottom-up. **Settled empirically.** The grass/path set's four inner
corners were measured: `grass_path_cornerinUL`'s transition-textured triangle sits at cell
(0.67, 0.33) — north-east — which is exactly the corner `smartUnits[3]` leaves empty. The
other three agree. A vertical flip *or* a 180° rotation would have broken that agreement,
so `top = north` and the slot order is row-major as written.

Four of our own slot **names** were wrong and are fixed: slots 3/4/8/9 are
`inner_ne`, `inner_nw`, `inner_se`, `inner_sw` (they had ne↔se and nw↔sw swapped).

`tiles.autotile.setFlipped()` survives as an escape hatch; it should stay unused.

---

### 3 — 2026-09-07 — City structures are authored by us; no PDSMS tileset has them

Every `.pdsts` in the vendored Map Studio tree was parsed and its model list read. **There
is no Pokémon Center, Mart, or any complete building** in any of them. The only building
geometry that exists is modular fragments — `HouseWall*`, `window`, `glassmiddle`,
`stagecorner` (HGSS New Bark, Platinum House Indoor) — plus `HouseMedieval`, `Rancho` and
`Tower` in Sylvan Town, which are the wrong genre entirely.

So the Pokémon Center, the Mart and the town houses are **modelled by us** in Blender
through the MCP server (`.mcp.json`, verified connected), textured with pixel art we author
at the AdAstra texel density (**32 px per world unit**; the shipped textures run 8–64 px and
32 is the mode), in the BW2 colour language — red roof, cream walls, glass doors, the
Poké Ball mark.

This is authored art in the reference style, not programmer art. A coloured box standing in
for a Pokémon Center is a gauntlet failure, not a milestone.

---

### 4 — 2026-09-07 — Sprite-sheet layouts, measured from the shipped art

**Pokémon** (`assets/overworld/<species>/{normal,shiny}.png`): 64×128, 32 px frames,
2 columns × 4 rows. Rows are `[north(back), west, south(front), east]`. Verified: rows 1 and
3 are exact horizontal mirrors — 1024/1024 pixels — which is the signature of a left/right
pair, and the row-0/row-2 silhouettes are unmistakably back and front.

**Trainer** (`assets/trainer/{hero,heroine}.png`): 32×768, 24 frames, single column.
The six back-facing frames are unambiguous (4–8 skin-tone pixels versus 18–24 for every
other frame) and were confirmed by eye. The twelve side frames split into two exact mirror
sets. Grouping:

```
north  [0, 7, 8, 9, 10, 20]      south  [11, 12, 13, 21, 22, 23]
sideA  [1, 2, 3, 14, 15, 16]     sideB  [4, 5, 6, 17, 18, 19]
mirrors: 1↔6  2↔4  3↔5  14↔17  15↔19  16↔18
```

**Still open:** which mirror set is west, and the within-group walk-cycle order. Neither is
decidable from the pixels — the `pokemon` builder must walk the trainer left on screen,
screenshot it, and record the answer here.

---

### 5 — 2026-09-07 — Tile geometry is rewound at export against the artist's normals

DS tileset authors do not keep a consistent triangle winding, because PDSMS renders with
backface culling off and nothing forces them to. Converting Z-up/Y-south to Y-up/Z-south
mirrors two axes on top of that, flipping handedness.

Symptom before the fix: roughly half the ground tiles were invisible under a `FrontSide`
material while still casting shadows — three renders shadows from `shadowSide`, the
*opposite* face, so backwards geometry casts a shadow it does not fill.

`tileToTriangles` now compares each triangle's geometric normal with the average of the
three normals the artist stored and swaps two vertices when they disagree. 2365 of 2402
AdAstra triangles are consistent afterwards; the remaining 37 are on double-sided
billboards whose stored normals genuinely point sideways, and their materials are
`DoubleSide` anyway.

---

### 6 — 2026-09-07 — The texture decides what a tile *is*, not its OBJ name

`grass.obj` appears five times in the AdAstra set, painted as grass (`grass01ax`), as stone
paving (`gake_michi`) and as deep water (`mizu_sita2`). Classifying by OBJ name produced a
lawn with water and paving stones scattered through it.

The classifier now takes its category from the **dominant texture** (the one covering the
most vertices), and names the model after that texture — `ground/grass`, `path/stone_path`,
`water/water_deep`. The OBJ name wins only for categories a texture cannot express: cave,
tree, bridge, stairs, ledge, prop, building, light, fence, wall, interior, plant, decal.

Consequence for map authors: **select tiles by category and tag, never by name.**

---

### 7 — 2026-09-07 — Tiles carry `baseY`; ground-level queries exclude raised tiles

Several tiles are authored on top of a five-unit cliff — `grass_v2` (id 81) has its geometry
at y = 5. Placed at ground level it floats, leaving a hole with sky showing through. This
was the second half of the "black squares in the lawn" bug.

Every model now carries `baseY` (its own geometry's minimum Y) and gains the tag `raised`
when that is ≥ 0.5. `tiles.find()` filters raised tiles out unless the caller asks for them
by tag or passes `maxBaseY`.

---

### 8 — 2026-09-07 — PDSMS global texture mapping is reproduced per instance

Eleven AdAstra tiles set `GLOBALMAPPING`: their baked UVs cover one cell of a larger pattern
and Map Studio derives the rest from world position (`GLOBALTEXSCALE`, 0.25–1). Rendering
the baked UVs alone stretches a quarter of the texture over the whole tile.

The pack carries `globalUv` and `uvScale`; `InstancedWorld` attaches an `aUvOffset`
instanced attribute of `(cx·scale, cz·scale)` and patches the material to add it to `vMapUv`.
A 64×64 lawn therefore shows a 4×4-cell repeat instead of one stamp per square.

---

### 9 — 2026-09-07 — Git LFS stays off

Carried forward from the previous attempt's `.gitattributes`, which was disarmed with a
long explanation. Total asset weight today: `assets/overworld` is 5.12 MB across 2506 PNGs,
plus `public/generated/tiles` at ~9 MB. Three orders of magnitude under any reason to
migrate. Re-add the filter in the same commit that installs `git-lfs` and runs
`git lfs migrate import`, never before.

---

### 10 — 2026-09-07 — The screenshot harness renders on the real GPU by default

SwiftShader produces the same pixels but at ~12 fps, so a software frame rate cannot be
checked against the ≥ 50 fps budget. `tools/shots/shoot.js` uses the system GPU; pass
`--software` for bit-identical output across machines.

The harness also settles, **discards that fps window**, and measures a fresh one, so the
number in the log is steady state rather than shader compilation. Measured baseline at
1920×1080: city 60 fps / 159 draw calls / 15 k triangles / 9 programs, zero console errors.

---

### 11 — 2026-09-07 — The sky is painted first with no depth test

A sky pinned to the far plane by `gl_Position.z = gl_Position.w` fails a `LESS` depth test
against a cleared depth buffer and silently never draws. The sky dome now renders at
`renderOrder -1000` with `depthTest: false` and `depthWrite: false`, so it paints the
background and everything else lands on top.

---

### 12 — 2026-09-07 — Authored buildings ship as a tileset named `structures`

Rather than inventing a second asset path for the buildings we model ourselves,
`tools/assets/build-structures.js` emits them into `public/generated/tiles/structures/` in
exactly the pack shape `.pdsts` produces. `tiles.load('structures')` therefore needs no new
code, and a Pokémon Center is placed by the same call as a tree.

Source art lives in `assets/structures/<name>/` (`.obj` + `.mtl` + `*.png` + `meta.json`
carrying footprint, collision, door cell and emissive material names). Blender exports Z-up,
so `meta.swapYZ` defaults to true.

---

### 13 — 2026-09-07 — `src/preview/` exists so raw art can be reviewed without a scene

An integrator-owned module that lays any generated tileset out on a checkerboard floor:
`/?showcase=preview&mode=<slug>&filter=<category>`. The project's only accepted evidence is
a screenshot somebody looked at, and without this an artist working on a building would have
to wait for the city module to place it before seeing anything. It is never part of the game.

### 14 — 2026-09-07 — Blind judging compares at the reference's own resolution, and the clock is frozen for every shot

Two things that would otherwise quietly invalidate our own measurements.

**Blind pairs.** The final gate (brief step 5) shows a judge two images labelled only A and
B and asks which looks better. Our renders are 1920×1080; the Gamma Emerald stills are
794×446 and 720×480. Putting those side by side leaks the answer before anyone looks at the
picture — the bigger, sharper one is ours — and downscaling ours would smear a pixel-art
frame whose whole point is a crisp grid. So `tools/judge/build.js` reads the reference's
IHDR and captures our shot at *exactly* those dimensions: neither image is ever resampled.
Which file becomes `A.png` comes from an FNV-1a hash of `round:pairId`, so the order is
reproducible across a rebuild but carries no pattern a judge could learn; the answer key is
written one directory *above* the packets so a judge pointed at a packet cannot read it.

The city has no like-for-like reference — ref 06 is a Poké Center *interior*. It is judged
against the nearest still (03, forest at night) and every report marks it `refIsNearest`, so
that result is never quoted as if it were a like-for-like win.

**Frozen clock.** `environment.tick` advances the time of day every simulation step, so two
captures from the same URL a second apart are different pictures. ARCHITECTURE §6.3 promises
the same URL gives the same pixels; that was false. `tools/shots/shoot.js` now sets
`timeFrozen=1` unless a caller explicitly asks otherwise, which makes every screenshot in
`docs/progress/` and every blind pair reproducible — and makes a diff between two rounds mean
something.

---

### 15 — 2026-09-07 — Offline discounts time, not rate; a bad save is quarantined at `warn`, not `error`

Four decisions from `src/offline/`, each of which had a plausible alternative.

**The discount lives in the time axis.** `idle/accrual.js` documents a `state.efficiency`
field ("offline passes `config.offlineEfficiency`"), and `offline` deliberately does not use
it. Two reasons, both checked. First, the discount is a *curve* — full rate for a 30 min
grace period, then a half-life decay of the surplus down to the `offlineEfficiency` floor —
and no single scalar can express a curve, so passing one would have to pick a number that is
wrong at every instant except one. Second, `accrual.simulate` resolves discrete encounters by
*index* (`idle/encounter/N`), and a rate multiplier changes how many indices an absence
consumes; discounting the elapsed seconds instead means `offline`'s single call is exactly
the call `idle` would have made had the player been present for that much active time,
whatever `idle` later decides a second is worth. The curve is integrated in closed form —
`E(T) = grace + floor·d + (1−floor)·halfLife/ln2 · (1 − 2^(−d/halfLife))`, `d = T − grace` —
and checked against a 0.5 s numerical integration in `selftest.js` to 1e-6 relative, so the
number cannot drift with a step size. Twelve hours away is worth **62 %** of twelve active
hours.

`selftest.js` also cross-checks the live `idle.simulate` for chunk additivity (two hours in
one call versus 240 chunks of 30 s): money agrees to 3.1e-15 relative and the encounter set
is identical. That property is the whole licence for handing it one big number.

**A corrupt save is a `warn`, not an `error`.** `core/log.js` feeds `log.error` straight into
the screenshot budget, and §7 requires zero console errors. A quarantined save is the
*handled* path — the bytes are preserved at `pokeidle.save.broken`, the player is toasted,
`offline.info()` reports it, and the game boots — so logging it at error level would fail a
budget for behaving correctly. Unhandled is what `error` is for. Same for a save from a
future version, which is moved to `pokeidle.save.future` and never migrated backwards or
overwritten; re-installing the newer build gets the run back.

**Integrity is checked, not assumed.** The save carries `h`, an FNV-1a of its own
key-order-independent JSON. It is not a security primitive and is not pretending to be one:
it catches a truncated or hand-mangled file before the migrations run on nonsense. A save
with no `h` (hand-written, or from before this field) still loads.

**The save seam is `saveState()`/`loadState()`, or `snapshot()`/`restore()`.** `offline` owns
the file; every other module owns its own state and lives in a folder `offline` may not
touch. So the store *pulls*: at capture time it asks each module for its slice through its
published API, accepting either name pair (both halves must exist — a lone `snapshot()` on
some future module far more likely means something else). `economy` and `idle` already ship
one. For modules that do not, `src/offline/slices.js` carries feature-detected adapters built
only from published methods, which evaporate the moment the owner adds the real seam. Slices
this build does not recognise are carried through a load/save cycle untouched, so a save
written by a newer build loses nothing on a downgrade.

**`?showcase=…` is read-only.** A showcase must be deterministic (§6.3) and must not spend a
player's real absence on a screenshot, so in showcase mode `offline` runs against an
in-memory copy of the save: it never hydrates, never grants and never writes.

### 22 — 2026-09-07 — What "adapt to AdAstra" means, measured from AdAstra's own geometry

The brief says the other tilesets are "tilted sprites in 45 degrees with not connected
parts" and asks for them adapted to the AdAstra style. Rather than guess at that, the two
styles were measured out of `pack.bin`.

**A non-AdAstra prop** — `sylvan-town/barrel` — is *two triangles*: one quad running from
(y 0.10, z 0.10) to (y 1.62, z 1.58), every normal `(0, 0.70, -0.72)`. One flat sheet leaning
back at 45°. It only reads from the angle it was drawn for, it takes light as though it were
a ramp, and anything passing behind it shears across it.

**An AdAstra prop** is built. `tree` (2x2 cells, y 0.19-4.50, 10 triangles) is:

  - two *upright* quads crossing at the cell centre — one at x=1 facing -X, one at z=1
    facing -Z, both spanning the full height;
  - **three horizontal quads** across the whole 2x2 footprint, at y = 0.19, 1.63 and 3.72;
  - four separate materials, one per layer.

Those horizontal slices are the whole trick. Under a camera locked at 45° they stack into
canopy layers, so a 10-triangle tree reads as a volume instead of as a cutout. `bench_s`
(18 triangles) does the solid-object version: a faceted low-poly body whose normals point
up-and-outward `(±0.58, 0.58, -0.58)` to fake soft shading, plus a flat quad at y=0.04 that
grounds it.

So the rebuild recipe, per kind:

  - **foliage** (`hedge`, `tree_mush`) — crossed upright billboards + horizontal slice quads
    + a ground quad;
  - **solid volumes** (`barrel`, `log`, `fat_log`, `pile_of_logs`, the rocks) — a faceted
    prism with up-and-out normals, sprite projected from the front, + a ground quad;
  - **thin decoration** (`axe`) — one upright billboard + a ground quad.

`tools/props/analyze.js` finds the work by *coplanarity*, not by triangle count. A cliff bank
(`bw2-brom/rock_edge_n`, 4 triangles, normals tilted) looks identical to a leaning sprite if
you count triangles, but it climbs in steps and so is not planar; a leaning sprite fits one
plane to within 0.02 of a cell. That test finds **15** models to rebuild across nine
tilesets, and finds **zero** in AdAstra itself — which is the check that it is measuring the
right thing.

---

### 16 — 2026-09-07 — economy: four currencies, and income is multiplied at the `add()` boundary

`src/economy/` mints **money (₽), research (◈), Battle Points (BP) and shards (◆)**, each from a
different activity and none exchangeable for another. `research` is the currency
`src/idle/accrual.js` produces — it reports the same number as both `research` and `tokens` —
so `tokens` is an **alias** for `research` in `currencies.js`, and the seed module's
`wallet.tokens` keeps working. BP comes only from battles won (`idle:tick` gains and
`encounter:resolved`), shards only from catches and released Pokémon.

**Upgrades reach the idle rate without `idle` importing anything.** `idle` banks accrual with
`economy.add('money', n, 'idle')`. `state.add()` classifies the *reason*: `idle`, `offline`,
`battle`, `loot`… are income and are multiplied by the relevant upgrade track on the way in;
`sell:*`, `buy:*`, `grant`, `save:restore` are not. Checked on screen — the transcript in
`docs/progress/economy/r1/terminal-noon.png` shows `add("money", 10k, "idle")` crediting
₽12,400 at Payday level 4, and `add("money", 600k, "grant")` crediting exactly 600k.
Research is deliberately **not** multiplied here: `idle` already applies its own chain to it.

**Balances keep their fractions; only displays are floored.** The seed floored each credit,
and `idle` pays out a few hundredths of a coin at a time, so the entire idle income rounded to
zero. `balance()` floors, the ledger does not.

**Prices were fitted to `idle`'s faucet, not to the mainline's.** A level-5 party already earns
about ₽50,000/h under `accrual.js` and a level-100 one about ₽1.4M/h, so mainline-scale upgrade
prices (₽1,500) were bought out in the first two minutes. `pacing.js` runs a projection of the
real cost curves against a mirror of that income model; the fitted table gives 4 upgrade levels
at 15 minutes, 21 at an hour, 95 at eight hours, 232 at a week and 266 of 291 at a month. Item
prices stay mainline (a Poké Ball is ₽200, a Comet Shard sells for ₽60,000) because they are
recognisable and are no longer the interesting decision. If `accrual.js` retunes its constants,
`INCOME_MODEL` in `pacing.js` is stale and the fit must be re-run — the command is in the file.

**Persistence uses the native seam `src/offline/slices.js` prefers:** `saveState()` /
`loadState()`, which supersedes that file's economy adapter and carries the bag, upgrade levels
and lifetime statistics the adapter cannot see.

---

### 17 — 2026-09-07 — Trainer sheet: sideA is **west**, and the walk cycle is contact / stride / contact / stride

Closes the two items DECISIONS #4 left open. Both were settled on screen, in
`docs/progress/pokemon/r1/02-trainer.png` (three ranks of trainers on a real map: the four
directions on the path, the west walk cycle behind them, the west run cycle behind that).

**(a) `sideA = [1, 2, 3, 14, 15, 16]` is WEST.** Those frames draw the face, the cap brim and
the shoulder bag on the screen-left side of the sprite; `sideB` is their exact mirror. The
camera's yaw is fixed looking north (`core/render.js` never rotates it), so screen-left is
−X, which is west by §3. Confirmed twice: on the frame dumps at 10× and in the shot, where
the second trainer of the front rank faces left and the fourth faces right.

The same test settles the Pokémon sheets: row 1 faces screen-left, so the row order
`[north, west, south, east]` in #4 is right, and `rowByDir = [2, 1, 0, 3]`.

**(b) Each direction owns six frames — three walk, three run.** Within a trio one frame is
the *contact* pose (feet together in profile, feet side by side head-on) and the other two are
the opposite strides. The cycle played is `contact, strideA, contact, strideB`, two phases per
tile walked, so the feet stay locked to the grid instead of sliding.

```
                 walk (contact, strideA, strideB)   run (contact, strideA, strideB)
  south          21, 22, 23                          11, 12, 13
  west            2,  1,  3                           14, 15, 16
  north           0,  9, 20                            7,  8, 10
  east            4,  6,  5                           17, 19, 18      (mirrors of west)
```

The sheet's index order does **not** group them, so the trios were separated by measurement,
not by reading the file in order:

- exact mirrors pair the two profiles: 1↔6, 2↔4, 3↔5, 14↔17, 15↔19, 16↔18;
- comparing only rows 20–31 of each frame (the legs) pairs the same pose across directions —
  0↔21 (0.43), 9↔22 (0.36), 20↔23 (0.34) are each other's best match, so north `[0,9,20]` and
  south `[21,22,23]` are the same three poses from behind and in front, which leaves north
  `[7,8,10]` / south `[11,12,13]` as the other trio;
- the run trio leans into the direction of travel: the alpha centroid of west frames 14/15/16
  sits at x 13.8/12.7/14.8 — ahead of centre while facing left — against 16.0/16.2/16.0 for
  walk frames 1/2/3, and the run frames are one to two rows shorter (crouched).

The idle pose is the walk contact frame: `[21, 2, 0, 4]` in `core/dir.js` order.

**`heroine.png` groups its frames the same way but pairs its mirrors differently.** The sheet
was measured with the same script and looked at frame by frame: same six back frames
`[0,7,8,9,10,20]`, same `{1,2,3}`/`{4,5,6}` and `{14,15,16}`/`{17,18,19}` mirror sets, same
walk/run split (legs-only best matches 0↔21, 9↔22, 20↔23; run frames lean into the direction
of travel, centroids 14.2/13.1/15.0 against 16.5/16.6/16.6). But the pixel-identical mirror
pairs are **not** the hero's:

```
  hero.png     1↔6  2↔4  3↔5   14↔17  15↔19  16↔18
  heroine.png  1↔5  2↔4  3↔6   14↔17  15↔18  16↔19
```

So the east cycle is *derived* from the west cycle through each sheet's own map
(`TRAINER_MIRRORS` in `src/pokemon/sprites.js`) rather than written out once. Applying the
hero's map to the heroine would not have broken her walk — it would have led with the wrong
foot, which is the kind of thing that is never noticed and never right. Both trainers, in all
four directions, are in `docs/progress/pokemon/r1/02-trainer.png`.

**Also corrected in #4:** the Pokémon sheets are *not* all 64×128. 1192 are (32 px frames);
**61 are 128×256 with 64 px frames** — Wailord, Steelix, every Arceus, Lugia, Dondozo and the
rest of the big bodies. Both shapes are 2 columns × 4 rows and are handled by frame size, not
by a hard-coded 32.

---

### 18 — 2026-09-07 — Sprites are 16 texels per world unit, upright, and stretched by 1/cos(pitch)

Three numbers decide whether DS pixel art and 3-D tiles read as one image. All three are now
fixed, and all three are visible in `docs/progress/pokemon/r1/07-pixel-grid.png`.

**Density: 16 texels per world unit — half the tiles' 32 (DECISIONS #3).** The DS overworld
sprites are 32 px frames drawn against 16 px tiles, i.e. two tiles tall, so a 32 px frame is
**two world units** and a 64 px frame is four. That also matches the reference: the creature
pixels in `docs/refs/03-forest-voxel-night.png` are visibly about twice the size of the fence
and flower texels behind them. At 32 texels/unit the trainer would stand 0.75 tiles tall,
which is not the Black & White silhouette; at 16 he stands ~1.5 tiles, which is.

**The billboard is upright, and its height is multiplied by 1/cos(cameraPitch) = 1.414.** The
quad stands in world Y and faces +Z; the camera's yaw is fixed, so it never needs to rotate.
But a vertical world unit only covers cos(45°) of the screen height it would cover face-on, so
an unstretched quad renders the art squashed to 71 % and its texels stop being square. With
the stretch a 32×32 frame lands on screen as a square block of pixels.

**Pixel-exact camera distances.** The internal buffer is 640 px wide at 1080p, so

```
internal pixels per world unit = 640 / (2·D·tan(fov/2)·16/9) = 779.7 / D      (fov 26)
```

`D = 779.7 / (16·k)` puts *both* sprites and tiles on the pixel grid at the focus plane:
**k = 2 → D = 24.36**, where one sprite texel is exactly two internal pixels and one tile texel
is exactly one. The showcase frames at 24.36 (and 16.24 / 8.12 for the close shots). The
game's `config.cameraDistance` default of **30** is not one of these values — at 30 a sprite
texel is 1.62 internal pixels, so pixel blocks come out 4 and 5 output pixels wide at random.
Changing that default is a core change and is filed as a coreRequest, not made here.

**Contact shadow, not a cast sprite shadow.** Each sprite gets a soft elliptical decal on the
ground, sized from the *current frame's* own content box (measured once per atlas build), so it
sits under the body rather than under the empty margin and shifts with a leaning run frame. It
is stretched and offset along the sun's ground direction. This is what the reference does —
see the trainer in `docs/refs/04-cave-golden-hour.png`. The sprite itself does not cast into
the shadow map (a billboarded quad would cast a shadow shaped like whatever the *light* sees,
not the camera), but it does receive, so a sprite standing in a tree's shadow darkens.

**Sprites drop 2 texels so their feet touch.** The modal bottom padding of a south-facing frame
is 2 rows across the whole set; the flyers — Zubat 5, Golbat 5, Butterfree 4, Lugia 6 — keep the
extra clearance their art was drawn with and go on hovering.

---

### 19 — 2026-09-07 — Idle accrual is chunk-additive by construction, and that is measured

`idle.simulate(state, elapsedS, seed)` is the only definition of what a second produces, and
`offline` calls the same function. The two must agree, but they cannot run the same way: a
three-hour gap has to drain in slices on the frame loop, while `offline` applies it in one
call. So the model is built to make slicing irrelevant.

- Continuous currencies are `rate(state) * elapsedS`, and the rate never sees `elapsedS`.
- Discrete encounters are indexed by *cumulative* progress carried in
  `state.progress.encounters`. Encounter **N** is always rolled from
  `makeRng(seed, 'idle/encounter/N')`, so a chunk boundary cannot renumber, add or drop one.

**Measured**, by `node src/idle/selftest.js` (21 checks) and again in the browser on the
showcase panel: one 10 800 s call versus 10 800 × 1 s versus 79 × 137 s give *identical*
encounter counts, wins, catches and shinies, and money within **1.3e-13** relative — IEEE-754
summation error and nothing else. Against the real drainer the figure is **~1e-16**, because
the comparison uses the snapshot the drain actually opened the gap with.

Two consequences worth stating: a gap is settled against the state it *started* with (a
replay of time already past, which is what `offline` does too), and slice width is therefore
free. Gaps under ~8 minutes use the fixed 1-second steps §5.7 asks for; larger ones widen
just enough to stay inside the step ceiling, because 12 h of 1-second steps is 43 200 calls.

### 20 — 2026-09-07 — Three timing bugs the idle module only found by measuring

1. **The frame budget was checked every 16th step** and a wide slice resolves dozens of
   encounters, so a 12 h gap overshot its 4 ms budget to **35.75 ms**. Checked every step it
   is **2.95 ms**. The clock read is nearly free; the assumption that it was not, was not.
2. **The first slice paid V8's compilation** inside the budget it was being measured
   against — **8.4 ms** for a call that costs 1.7 ms warm. `init` now runs one
   `simulate(state, 1e-6, seed)` to warm the model off the critical path.
3. **Heartbeat liveness was measured on the wall clock.** Advancing the module's own clock
   three hours to stage a gap made the watchdog conclude the worker had been silent for
   three hours and swap a perfectly healthy worker for a timer. Liveness is a duration and
   is now measured on `performance.now()`; only *how much time passed* comes from
   `Date.now()`, and that is reconciled, never trusted to a pulse.

### 21 — 2026-09-07 — `economy/pacing.js` mirrors `idle/accrual.js`; they now agree to 1.4 %

`economy` prices its shop against an `INCOME_MODEL` that copies `idle`'s balance constants.
It was copied mid-edit and had drifted (`BASE_MONEY` 0.85 there, 0.55 here) — a silent
mismatch that would have made every price wrong by 55 %. `idle` has been moved back onto the
mirrored values, and a six-member party at levels 10/25/50 now projects `24.04 / 48.82 /
83.70` money per second here against `24.39 / 49.47 / 84.83` there.

Resolved battles were retuned in the same pass: they were keyed to *total party power*, which
is a sum over six members, so a full bench made every encounter a foregone win (97 % wins,
73 % catches). They are keyed to the **lead's** level now — the wild level band already scales
with the lead — giving 69 % wins and 31 % catches against the 72 % / 35 % `pacing.js` assumes.

**This coupling is invisible to both files at runtime.** It wants a seam test asserting the
two tables are equal; that is in the idle builder's `coreRequests`.

### 23 — 2026-09-07 — The adapted props ship as a tileset named `props`

The fifteen rebuilt props (DECISIONS #22) are authored art in the same folder shape as `assets/structures/`,
so they need a source directory and a slug, not a second builder:
`tools/assets/build-structures.js --src assets/props --slug props`. They land at
`public/generated/tiles/props/` and load with `tiles.load('props')` like any other set,
which means a map author places one with the same call that places a tree.

They cost more triangles than the AdAstra props they sit beside: 76 for a revolved rock
against 18 for `bench_s`, because the profile is 8 segments around by 5 rows up and the
exporter triangulates the quads. That is real and is not being rounded down here; against a
900k triangle budget on instanced geometry it is not worth trading the silhouette for, but
it is the number to cut first if the budget ever gets tight.

Two of the fifteen are honestly weaker than the rest. `hgss-overworld/water_rock` and
`hgss-overworld/rock` have the surrounding water and ground baked into the sprite, so the
cylindrical wrap carries ripples and grass up the body; they read as a crystal and a slab
rather than as boulders. Both are still better than the leaning card they replace, and both
are usable, but they are the two to re-cut first if these props go on screen prominently.

### 24 — 2026-09-07 — The screenshot harness never reads a cached asset

Twice during the props round a rebuild produced a screenshot of an empty floor — with the
*same* 40 draw calls and 3k triangles as the shot that had just worked. The geometry was
being submitted and drawing nothing.

The cause was cache, not code. Vite serves `public/` with far-future caching, so after
`pack.bin` is rebuilt the page can fetch the previous copy while loading the new
`catalog.json` beside it. The offsets in one no longer address the other, every model reads
garbage vertices, and the scene renders nothing while the metrics stay perfectly healthy.

That failure is indistinguishable from a real rendering bug, and it cost a wrong diagnosis:
the empty frame was read as a UV problem and "fixed" by flipping V on export, which broke
UVs that had been correct. `tools/shots/shoot.js` now calls `page.setCacheEnabled(false)`,
so a screenshot always shows what is on disk.

The related lesson is recorded here too: **do not judge art in a frame the environment
module is mid-rewrite in.** The same props were called wrong twice from a scene that was
simply too dark to read. What settled it in the end was a measurement — every prop's UV
rect parsed out of `pack.bin` and checked to lie inside the source sprite's rect, which was
itself proven by cropping the atlas and looking at it.

---

### 25 — 2026-09-08 — The lamp was never broken; six DS textures were being alpha-tested into slabs, and `setEmissiveScale(k)` is the night seam

Four findings from `src/tiles/`, each measured before it was changed. The before/after pair
is `docs/progress/tiles/r1/01-lamps-before.png` and `02-lamps-after.png`, same URL, same
`tod`, one code change apart.

**(a) The "featureless obelisk" lamp is a placement problem, not a geometry one.** The four
`lamp_h*` models are one 30-triangle street lamp in four arm directions and every one of
them has a real post, a real cantilevered arm and a real shade — visible in
`docs/progress/tiles/r1/00-lamp-before.png`, taken through `preview` with *no* fix applied.
What made the boot shot's lamps read as blobs is that `lamp_h`'s arm runs from z 0.31 to
**z 2.00** — a cell and a half *south*, which at a fixed 45° pitch is straight down the
camera axis, so the shade lands on top of its own post and hides it. The pack gives all four
`orientation: null`, so there was no query that could have avoided it.

`tiles` now derives `orientation` from each model's own bounds against its footprint — `n`,
`s`, `e`, `w`, using the compass letters the pack already uses elsewhere — for anything that
overhangs its cell by more than a quarter of one. So the handle is
`tiles.find(slug, { category: 'light', orientation: 'w' })[0]` and `src/city/map.js`'s
hard-coded `LAMP_MODEL = { e: 'lamp_h_v4', … }` table can go, which also puts it back inside
DECISIONS #6 (select by category and tag, never by name).

**(b) A DS material's alpha flag says nothing about its texture's alpha.** `pack.materials[i].alpha`
is the *polygon* alpha out of the `.pdsts` (0..31, 31 = opaque) and the loader was building
every non-translucent material with `transparent:false, alphaTest:0.35`. Six AdAstra textures
have soft per-texel alpha and are ruined by that: `kage_out` (0.25/0.48 — the shadow blob
under a lamp or hedge), `h_kage` (under a tree), `ki02c` (the horizontal canopy slice that
DECISIONS #22 says is the whole reason a 10-triangle tree reads as a volume), `kusa_ec3`,
`mori01s` and `dansa01a`. Every texel under 0.35 was discarded and every texel over it drawn
fully opaque, so a soft shadow became a hard near-black slab with a ragged edge — that slab is
the black rectangle at the foot of every lamp in `docs/progress/_boot/wave-a-end.png`.

Each texture is now decoded once at load and classified from its own alpha histogram:
*opaque*, *cutout* (only 0 and 255 — keeps a hard 0.35 test, which is what makes a leaf edge a
pixel edge) or *soft*. A soft texture used **only** by paper-thin geometry (every group that
draws it spans < 0.06 in Y) is a ground decal: it blends, it does not write depth, it gets a
polygon offset, and its InstancedMesh is taken out of the shadow map — a picture of a shadow
casting a second, harder shadow beside the sun's own was the other half of the mess at the
lamp's foot. Soft foliage keeps `depthWrite`, because the tree's crossed billboards sort
against those canopy slices.

**(c) 382 of AdAstra's 7 206 vertices point below the horizon, and the camera never goes
there.** DS artists leave normals wherever they land; 19 of the lamp's 30, 45 of 162 on a
forest entrance, 9 of 48 on a hedge point *down*. Under a sun overhead those faces take no
light and render as black silhouettes — which is why two of the four lamp variants had black
posts and the two mirrored ones, same model, had grey metal ones. Normals are lifted to the
horizon at load (`n.y = max(n.y, 0)`, renormalised, straight-down becoming `+Y`) and no
further, so the up-and-outward shading AdAstra's props are actually built on (DECISIONS #22)
is untouched. 5.3 % of vertices move; nothing in this game is ever seen from underneath.

**(d) The night seam is `tiles.setEmissiveScale(k)`, and `k` is a ramp, not a radiance.**
`tools/assets/obj.js` reads the MTL's `Ke` and the authored packs carry it — `structures` has
`pokemon_center:window` at 0.5, its door at 0.35, `poke_mart:window` at 0.5 — and the loader
was dropping it. A `.pdsts` has nowhere to put a `Ke`, so AdAstra carries none; its lights are
*derived* instead, by a rule tight enough to name one material: a material used **exclusively**
by models in the `light` category. `slamp03` qualifies. `kage_out` is on the lamp too but the
hedges use it as well, so it does not, which is the check that the rule is not just "anything
near a lamp".

Two things about the implementation are worth writing down because both cost a wrong frame:

- `MeshLambertMaterial.emissive` defaults to **black** and *multiplies* `emissiveMap`, so a
  glow map alone emits exactly nothing. It is set explicitly (`0xffb861` for a derived lamp —
  sodium, never a white LED; white for an authored map the artist already coloured).
- A derived material shares one sheet between the post and the glass, so lighting it with its
  own colour map makes the whole post glow. The glow map is rebuilt with a luma gate at 0.90:
  the lamp's glass block is `f8f8f8` (luma 0.973) and the next brightest texel in the sheet is
  `c8d8e0` (0.85), so the gate keeps exactly the glass. Authored maps are used as they are.
  The map's row order is *not* flipped, and that was settled on screen rather than reasoned
  about — flipped, the glow lands on the elbow where the arm meets the shade.

**The contract for `environment` and `city`:**

```js
tiles.setEmissiveScale(k, slug?)   // k = 0 at full daylight, 1 in the middle of the night
tiles.emissiveScale(slug?)         // what was last set
tiles.emissiveMaterials(slug)      // [{ name, base }] — which materials can glow at all
```

`k` is scaled by each material's own authored strength, so one call moves a Poké Center window
(0.5), its door (0.35) and a lamp's glass (1.0) by the right amounts *relative to each other*,
and `tiles` alone owns the conversion from a 0..1 ramp to radiance (currently ×3.2, which is
what clears `core/render.js`'s bloom threshold after AgX — measured, not guessed). `environment`
should drive this from its dusk curve and never needs to know that number; `city` and `hunts`
never call it at all.

Until `environment` does drive it, `tiles` follows `environment.getTimeOfDay()` itself on a
default ramp pinned to `phaseOf`'s own boundaries (up across 18.4→19.8, down across 4.8→6.4),
and **stands down permanently the first time anyone calls `setEmissiveScale`**. So the city
lights at night today (`docs/progress/tiles/r1/15-city-night-auto.png`) and environment taking
ownership is a one-line win rather than a merge. Liveness of `environment` is tested on the
*value* `getTimeOfDay()` returns, never on `typeof`, because the registry's null-object proxy
answers `typeof api.foo === 'function'` with true even when the module is dead.

**(e) Ground variety is instancer-side and on by default.** The AdAstra lawn is *one* model
(`grass_v2` is authored at y=5 and `find` correctly refuses it, DECISIONS #7), globally mapped
at scale 0.25 — so the whole field is one 4×4-cell stamp repeated, and that quilt reads as
horizontal banding across the boot shot. `buildInstances(..., { variety })` — 1 by default,
`?variety=0` for an A/B — gives every flat 1×1 `ground`/`path` tile with no auto-tile role:

- a **quarter turn** hashed from its cell,
- a **UV phase** of whole texels (so the art stays on the pixel grid) folded into the same
  `aUvOffset` attribute the global-mapping trick already uses,
- and a **tonal blotch** from two octaves of interpolated value noise on a 9- and 4-cell
  lattice, ±7 % in red and blue and ±4 % in green.

The interpolation is the part that matters: a per-cell random tint reads as a checkerboard,
because neighbours differ by the full amplitude and the eye finds the grid instantly. A
smoothed lattice gives what `docs/refs/01-forest-tilemap-frame.png` has — large soft patches
of light and shade across a dozen cells — with no step at any cell edge.

A palette's **centre** slot is included (tagged `autotile-center` at load, from the autotiler,
which is the only thing that knows which model a palette put at signature 255) but is never
spun: its twelve siblings meet it at a seam the artist drew. Its edges and corners are excluded
outright — rotating one would point the transition the wrong way.

Cost: zero draw calls and zero programs. Both patched materials share one
`customProgramCacheKey`, so the shader compiles once. Demo city measures 60 fps / 214 draws /
18 k tris / 18 programs / 0 console errors at 1600×900, against a 159-draw baseline taken
before the city had any buildings in it.

---

### 26 — 2026-09-08 — The city is composed against the camera's arithmetic, and a building cannot go through the terrain draft

Five things `src/city/` settled while turning the empty plaza into a lobby. Each was checked
on screen; the shots are `docs/progress/city/r1/{noon,golden,dusk,night,pokecenter-night,
high-street-night,boot-noon}.png`.

**(a) A `Placement` names a model id and nothing else, so the authored sets need their own
worlds.** `terrain.load()` calls `tiles.buildInstances(scene, draft.tileset, draft.placements)`
with exactly one slug, and `InstancedWorld` resolves every id against that tileset's `byId`.
Put a Pokemon Center (id **2** of `structures`) through an AdAstra draft and you draw AdAstra's
id 2 — `grass_path_corner_corner_se` — a path corner where the building should be, with no
warning anywhere, because both ids exist. So the city splits: `map.js` *reserves* the
footprints in the draft (collision, tags, `occupied`, door markers) and `structures.js` builds
a second and third `InstancedWorld` from the same `layout.js`, one for `structures` and one for
`props`, and disposes them itself on re-entry. Counted out of the two `pack.json` files: six
buildings drawn from three models are **22** InstancedMeshes (one per model per material
group) and sixteen props drawn from ten models are **10** — 32 draw calls and 1 378 triangles
for the whole authored half of the town. A `placement.tileset` field would remove the split
and is filed in coreRequests; until then, **every** map author placing an authored set needs
this shape.

**(b) `meta.door[0]` is the door quad's west edge, not a cell index.** The Center stores `3`
for a quad spanning x 3.0–5.0, the Mart `3.6` for 3.6–5.2, the house `1.9` for 1.9–3.1.
`floor()` puts the Mart's marker on cell 3, which its door only reaches 40 % of the way into;
`floor(door[0] + 0.5)` gives 3 / 4 / 2, and each of those cells is *fully* door in all three
buildings. The marker a walker stands on is that cell's southern neighbour, as the brief asks.

**(c) The layout is arithmetic, not taste.** The camera is fixed (fov 26, pitch 45, distance
30, `cameraLookAhead` 1.6) and never rotates, so the frame is decided before anything is
placed: about 26 cells across, and a point at height `h` lands on screen where ground at `z − h`
would. A 4.5-tall roof is only in frame if its ridge is at `z >= focus − 5.5`. That single
inequality is why the Pokemon Center sits at z 34 and not z 28, why the two shops are 6 cells
apart rather than 12 (at 12 the Center ran off the left edge — first shot of the round), and
why the square's landmark is a pair of knee-high flower beds and **not** a tree: a 4.7 m canopy
at z 45 projects onto exactly the band the shopfronts occupy and hides the thing the scene is
about.

**(d) NPCs are deterministic by staging, not by standing still.** `simulation` owns walkers, so
the cast is thirteen `spawnNpc()` calls with scripted routes — but a scripted route is a pure
function of *how many sim steps have run*, and the steps between page load and shutter are
wall-clock luck. Freezing alone would line everyone up on cell centres. So when
`config.timeFrozen` is set (which the harness does for every screenshot — DECISIONS #14) the
city showcase advances the cast **47 fixed steps** and then calls `simulation.freeze(true)`:
walkers are strung out along their loops and caught mid-stride, and the URL is reproducible.

That staging lives in `city.showcase()` and deliberately **not** in `enter()`. `enter()` is
what `/` and `simulation`'s own `mode=city` showcase call, and neither of them asked to have
its frame loop stopped; a scene freezing another module's simulation as a side effect of being
entered is exactly the kind of action at a distance that is impossible to find later.

Verified, and the residual is worth writing down: two runs of `?showcase=city&tod=21.5` agree
to a maximum of **6/255** on any channel, and with `&grain=0` they are byte-identical. So the
cast, the lamps and the geometry are reproducible and the whole of the difference is the post
stack's film grain, whose phase still moves with wall time under `timeFrozen` — which is a
`core/render.js` gap against the promise DECISIONS #14 made, and is filed in coreRequests.

**(e) The street between the two shops is lit from its ends, and the two adapted hedges are
not used.** Following #25a the lamps are selected by
`tiles.find(slug, { category: 'light', orientation: 'e' | 'w' })` — never `'n'`/`'s'`, whose
arm points down the camera axis. The placement consequence is the part #25 could not know: the
lamp's arm reaches a full cell sideways at y 3.4 and the Pokemon Center's roof overhangs its own
footprint by 0.45, so on a four-wide street between two shops there is no cell a post can stand
in without growing through an eave — and a lamp in the middle of that street crosses the frame
at exactly the height the eye reads the buildings at. The street carries no lamp between z 34
and z 40; it is lit from the square and from the pair at z 32.

Separately, `props/pt-forest__hedge` and `props/pt-overworld-7__hedge` are **not placed by the
city**. Both render as a pale grey blob about a third of a cell across with a blue rim, in this
map and in `?showcase=preview&mode=props&filter=hedge` alike, although their catalog record
claims a 1×1×0.86 bush. AdAstra's own `hedge1` does the planting instead. Reported in
coreRequests; not fixed here, because `assets/props/` and `tools/assets/` are not this module's.

Measured at 1920×1080, `?showcase=city&tod=21.5`: **60 fps, 210 draw calls, 18 k triangles,
18 programs, 0 console errors**, against the 159-draw baseline of the plaza with nothing in it.

### 27 — 2026-09-08 — The Pokemon leads, the trainer follows, and the queue needs two tiles of air to be seen

`src/simulation/` is a trail of cells. `trail[0]` is the head's cell, newest first, and every
walker is an index into it: member *i* stands on `trail[i · gap]` and renders between
`trail[k+1]` and `trail[k]`. That one structure gives the whole conga line for free — the
trainer literally occupies the cell the lead stood on `gap` steps ago, checked in
`selftest.js` over an 18-step route (every one of the trainer's cells equals the lead's cell
from `gap` landings earlier), rather than approximated by a spring or a spline.

**The brief inverts the seed, and the API says which entity is which.** The **active Pokemon
leads**; the **trainer follows**. So:

  - `player()` and `teleport()` are about the **trainer** — that is what `offline/slices.js`
    captures and what its `world:loaded` handler puts back, and moving that contract to the
    Pokemon would silently restore a save onto the wrong cell;
  - `player:moved` therefore carries the trainer's cell, and **`player:enteredTile` carries
    the lead's** — the Pokemon is what walks into the tall grass first, so that is the cell an
    encounter must roll on. The two events genuinely describe two different entities in the
    same frame; nothing consumed either yet, and adding a third event is a core change;
  - the **camera follows the trainer** (ARCHITECTURE §5.4). The lead turns a corner `gap`
    steps early and a camera bolted to it swings out of the frame before the player does;
  - `follower()` returns the lead Pokemon, as §5.4 says, and `followerCell()` now means the
    cell an encounter rolls on. The seed had both the other way round.

**`trail[k].dir` is the direction a walker *entered* that cell, and the head's own facing is
carried separately.** Storing "the direction faced here" instead breaks the corner: the lead
turns west on the corner cell, and the follower still walking north into that cell would turn
west a step early and moonwalk into it. The head is the one walker that can turn without
moving, so its facing lives in `line.facing` and nothing else reads it.

**`config.followerGapTiles` ships at 1 and is unusable at a 45-degree camera.** A sprite is
16 texels per world unit stretched by 1/cos(45°) (#18), so a 32 px trainer frame is an upright
quad 2.83 units tall, and under a 45-degree pitch it covers `2.83 · sin(45°) = 2.0` tiles of
*ground depth* on screen. One tile of separation is therefore exactly a total occlusion: shot
at `/` with the party walking north, the lead Pokemon — the entity this whole decision is
about — was **completely hidden** behind the trainer
(`docs/progress/simulation/r1/00-gap1-lead-hidden.png`). 1 is the Black & White number for a
camera that is nearly top-down; ours is not. Until the default moves (filed as a coreRequest)
`simulation.init` raises it to 2 unless the URL pinned a value, so `?followerGapTiles=1` still
wins and the config contract holds.

**A 180-degree turn walks the queue through itself, on purpose.** Reversing puts the head on
the cell its follower is standing on; pushing that onto the trail makes each pair swap, and
the line is straight again `gap · members` steps later. Every alternative is worse — re-laying
the trail teleports a member several cells, and reversing the order leaves the lead at the
back of its own queue. It is also what the mainline games do when you turn round into your
follower. Reversals are kept rare at the *route* layer instead: `makeWander` will not choose
the direction it came from at all unless nothing else is passable.

**`terrain.height()` is not where the ground is.** It reports the authored heightfield, which
the demo city never sets, so every cell reads 0 — while AdAstra's grass sits at baseY 0.07 and
its dirt at 0.125 (#7). Planted at `height()` a walker sinks into the road and its contact
shadow vanishes *under* the surface. `surface.js` measures the top of each cell off the loaded
map's own placements (highest `flat`-tagged model covering it), rebuilt on `world:loaded`. It
is a workaround for a gap in `terrain`, not a second source of truth.

**The starting party is seeded from `placePlayer`, never from `init`.** Init runs in
topological order, so `simulation` is built before `offline` has hydrated; a party seeded there
would be appended to by the restored save, or rejected at six. `placePlayer` runs when a scene
enters, which is after the whole registry is up, and it only seeds when `pokemon.party()` is
still empty — a restored save, a scene handing one over, or `encounter` catching one all win.

**Determinism, and one thing that is not ours.** Every showcase mode walks to an exact step and
then calls `freeze(true)`; the render also drops the frame's `alpha` while frozen, because
interpolating by a value that varies with frame timing would jitter a "frozen" pose. Two loads
of `?showcase=simulation&mode=corner` give a byte-identical simulation state (probe diffed:
only the boot-time log line differs). The **pixels** are not identical, and that is not this
module: `core/render.js` drives the film grain from `uTime = (frameCount % 64) * 0.017`, and
the number of frames rendered before the capture depends on the wall clock. With `--grain 0`
the same two shots are byte-identical (`sha256 2985fd64…` twice). ARCHITECTURE §6.3 and #14
promise the same URL gives the same pixels; the frozen clock covered the sun and missed the
grain. Filed as a coreRequest.

Measured at 1920×1080: **60 fps, 58 draw calls, 12 k triangles, 0 console errors** for the
showcase, and **60 fps, 210 draw calls, 18 k triangles, 0 errors** for the lobby at `/` with
the party and `city`'s thirteen NPCs walking. The whole cast — party, NPCs, contact shadows —
costs **2 draw calls**, because `pokemon`'s sprite field is two instanced meshes; a restage is
coalesced onto a microtask so `city`'s twelve `spawnNpc` calls in a row repack the atlas once.
`node src/simulation/selftest.js` covers the properties a screenshot cannot: 34 checks, all
passing, including that 0.25 s/tile is exactly five 1/20 s ticks and 0.15 s exactly three, that
400 wandering steps contain no diagonal and no two-cell jump, and that one long run of a route
equals seven short ones.


---

### 28 — 2026-09-08 — The pond was buried under its own lawn, the Mart is blue, and the square is paved with somebody else's stone

Round 2 of `src/city/`, against the critic's ranked list. Everything below was checked on
screen; the shots are `docs/progress/city/r2/`.

**(a) A lake that digs in has to have the ground cut out from under it, and `draft.autotile`
cannot place one at all.** AdAstra's lake palette (`set1`) runs from y 0 at the bank down to
**−0.75**, and its water is a flat sheet at **−0.5**; the lawn is a quad at y 0. Round 1
placed the pond *on top of* an unbroken lawn, so all thirteen slots were under the grass and
the `pond` preset framed a field — with a clean console, correct draw counts and no missing
model anywhere. `tiles.autotile.sets()` already reports this as `digsIn`, and the fix is two
things at once: the lawn fill returns `null` inside the ellipse, and the pond is placed
through `solvePlacements(..., { underlay: true })` rather than `draft.autotile`, because
every border slot is a *partial* ramp that leaves the rest of its cell empty and needs the
water sheet laid under the whole region first. `draft.autotile` places one model per cell at
one `y` and cannot express either half. `docs/progress/city/r2/01-pond.png`.

**(b) The silence was the real bug.** `solveField` returns a field of −1 for a set id that is
not in the tileset and places *nothing*, with no warning — which is how a missing region
survives a screenshot round. `autotileSet()` in `map.js` now looks every set up before it is
drawn and warns with the list of ids that do exist, the way the lamp lookup always has, and
the pond additionally warns if it covers cells and resolves none of them. At `warn`, never
`error`: §7 counts errors and a handled diagnostic must not cost a budget.

**(c) The roof wedge is shadow acne, and the discriminator is the sun.** A hard black polygon
sat on the same **west** facet of every roof at 08:00 with the sun in the east *and* at 17:30
with it in the west. A hipped roof's terminator swaps sides when the sun crosses; one that
does not is the roof shadow-mapping itself — `shadowBias -0.0006` / `shadowNormalBias 0.035`
are not enough for a 45° facet at `shadowExtent 56`. Nothing in this town casts onto a roof
(they are the tallest things on the map), so `city` takes the roof and awning meshes out of
the receiver set and the wedge is gone: `04-plaza-m08.png` and `05-plaza-g175.png` now show
opposite facets lit, which is what the sun is actually doing. That is a workaround in the
wrong module and the bias is filed as a coreRequest.

**(d) AdAstra has no stone, so the square is paved from `pt-overworld-7`.** Every `path` and
`ground` texture in the set was looked at: `michi01a/b` and `michi03a/b` are beaten dirt,
`michi_hibi`/`michi_hage` are bald patches, `michi_isi` is three pebbles, and `gake_michi` —
which the square used to be — is the *cliff* path, a 64×64 field of soft brown blotches with
no joint and no course, sampled at `uvScale 0.25` and then shifted per cell by the
instancer's texel phase. Twenty by seven cells of that is mud with its grain scrambled.
`pt-overworld-7`'s `set21` is a real paving palette: pale blue-grey with a joint pattern,
`16` texels per cell — the same density AdAstra's own roads use. ARCHITECTURE §9 allows
another set where AdAstra lacks the piece provided it is adapted to AdAstra's silhouette
language, and every slot here is a **flat two-triangle floor quad at y 0**: there is no
silhouette, and none of the leaning-sprite problem DECISIONS #22 measured. A floor is the one
thing that ports. It gets its own `InstancedWorld` for the DECISIONS #26a reason, costs
**4 draw calls**, and the border course is the square's existing gravel rim — the palette's
own transition slots carry a bright green grass fringe, which was tried
(`02-plaza.png`) and reads as a bowling green, so the fill is centre-only
(`03-plaza-noedge.png`). At `cameraDistance 16` the paving is crisp and on the pixel grid
where the old surface was a bilinear smear: `14-close.png` against
`docs/progress/city/critic/n12-close.png`.

**(e) Lamps are staggered, never paired.** Round 1 put an `'e'` lamp at cx 30 and a `'w'`
lamp at cx 33 — two cantilevered arms three cells apart at the same height reaching towards
each other over a four-wide road — and at a fixed 45° camera each pair closed into one rugby
goalpost. The rule now is one lamp per stretch, alternating sides as the road runs, at least
four cells of `z` apart, and standing on the verge (cx 29 / 34) rather than on the
carriageway so the arm reaches *in* over the kerb. `07-highstreet.png` and `08-southgate.png`.

**(f) Eleven lamps, not twelve, because `environment` only has eight PointLights.** The pool
goes to the eight bulbs nearest the camera *by distance alone*, and a lit shop window is a
bulb too. At the `plaza` framing the round-1 set spent its slots on two lamps at cz 47, two
at cz 51 and both windows, leaving the square's own rim lamps with a glow quad and no light.
Measured in the running page: six of the eight PointLights now sit on plaza lamps. `radius`
came down from 16 to **12** on purpose — at 16 one lamp reaches most of a twenty-cell square
and six of them wash it to an even grey, which is the same complaint as "too weak" from the
other side — and `intensity` went up to 2.0 to pay for the reach.

**Not verified, and it is not this module's frame to judge.** `environment` is being rewritten
right now (`presets.js` changed twice during this round), and at `tod 21` it currently reports
`sun 0.52` and `exposure 4.99`: night renders as an even dusk with no ground pool under any
lamp. That reproduces in **`environment`'s own showcase** with its own lamp values
(`?showcase=environment&tod=21`), which is the check that says it is not the city's numbers.
So the night pool is placed and wired but unproven; DECISIONS #24's rule applies — do not
judge art in a frame another module is mid-rewrite in.

**(g) The Mart is blue, and it is a re-tint, not new art.** All three authored buildings are
painted from one `roof.png`, one `awning.png` and one `wall.png`, so six buildings had one
red roof and the two shops were the same building twice. The pack does give each building its
*own* material record (`poke_mart:roof` is a different material id from `pokemon_center:roof`
even though both name the same PNG), so `recolor.js` decodes that material's texture once
into a canvas, rotates the hue of every non-grey texel and hands back a `CanvasTexture` with
the source's own `flipY`, `colorSpace` and wrapping. The Mart's roof, awning and sign go
blue; the cottages go ochre; the Center stays red and is the landmark. The original is
stashed and restored on `dispose()`, and every repaint starts from it, so a second `enter()`
cannot rotate the hue twice. Honest limit: the Mart's sign is still a **Poké Ball**, re-tinted
— it is not its own emblem, and drawing one at runtime would be programmer art.

**(h) A five-wide hedge is one model, not five.** `tiles.find(..., { maxCells: 1 })` restricts
to `hedge1`, and five of those in a row are five identical cubes with a seam between each
pair — the "green boxes" read. AdAstra also ships `hedge2`, `hedge3` and `hedge4`, the same
bush authored 2, 3 and 4 cells wide as one model. A bed is now laid with the widest pieces
that fit, so the planters read as hedges. Flowers dropped from two rows to one for the same
reason in reverse: a flower tile is a flat decal at a finer texel pitch than anything around
it, and a 5×2 field of them is wallpaper on the ground.

**(i) Loose props are yards now.** The barrels and logs stand against the Mart's own east
wall inside a fence run, and the woodpile and axe against the west cottage's west wall inside
another; the boulders are grouped in threes at the tree line rather than dropped singly.
A fence set is a `line` kind, so a run is only the cells it passes through and the corners
resolve from each piece's own arms (DECISIONS #25a). The same fence made the `garden` preset
mean something: it framed eight hundred square metres of nothing, and now frames three hedged
beds in an enclosure (`12-garden.png`). `sylvan-town__tree_mush` was dropped — at noon it is a
flat near-black leaf standing on the lawn, and DECISIONS #23 already calls it one of the two
weakest of the fifteen.

**(j) `--focus` is dead for this scene and `preset()` is the way round it.**
`window.__HOOKS__.focus()` sets the camera rig and nothing else, and `simulation` re-centres
the rig on the trainer on the next frame, so every `--focus` capture of the city silently
returns the default view — `docs/progress/city/critic/n12-pond-focus.png` is the plaza.
`city.preset()` now also accepts a bare `"cx,cz"`, and it teleports first, so `--preset 50,16`
frames what `--focus 50,16` promised (`19-preset-literal-50-16.png`). The hook itself is
`main.js`'s and is filed in coreRequests.

Measured at **1920×1080**, `?showcase=city&preset=plaza`: **60 fps / p95 16.7 ms, 233 draw
calls, 18 994 triangles, 19 programs, 0 console errors, 0 console warnings**, ready in 3.2 s —
against 210 / 18 098 / 18 before this round. The extra draws over round 1 are the paving world plus the pond,
the fences and the garden in the map world; `city.stats()` reports the two authored worlds
at 34 meshes / 1 828 triangles.

**Two of the critic's items fixed themselves under us, and that is worth recording.** The
lawn checkerboard and the near-black canopy were both `tiles`, and `tiles` shipped its own
round 2 during this one: `docs/progress/city/r2/01-pond.png` (taken early in this round) has
the unmissable per-cell grid, and `23-pond.png` (same URL, hours later) has a smooth organic
lawn. So neither is filed. The canopy residual is *not* gone — the trees along the east and
west map edges still read dark navy at noon in the same pair of shots — but `tiles`' own
STATUS already carries it as a known residual, so it is not re-filed either.

---

### 29 — 2026-09-08 — Two of simulation's three "art" faults were tile geometry, measured off `pack.bin`; the meadow is hedged instead of wooded

The critic's round-1 list gave `simulation` a checkerboard lawn and a striped tree. Both were
measured rather than argued, and only one of them was this module's to fix.

**The lawn is not a two-model coin flip.** The claim was that
`tiles.find(SLUG, {category:'ground', tags:['grass']})` returns `grass` *and* `grass_v2` and
that the map picks between them 50/50. Probed in the running page: it returns exactly **one**
model, `grass` (id 36). `grass_v2` carries the `raised` tag and `tiles.find` excludes raised
models unless asked for them (#7), and `tiles.pick` returns `grass` for every cell sampled.

The checkerboard comes from `tiles/instanced.js`. AdAstra's lawn is `GLOBALMAPPING` at
`uvScale 0.25` (#8), so a cell samples a 16×16-texel window of a 64×64 texture — but the
per-cell phase that breaks the 4-cell repeat offsets by `floor(hash·n)/n` where `n` is the
texture size *in texels*, i.e. by up to the whole texture. Neighbouring cells land on
unrelated crops of a strongly mottled source and every cell edge becomes a value step; the
per-cell quarter turn compounds it. Proved by A/B at the same URL:
`docs/progress/simulation/r2/ab-variety1.png` (checkerboard) against `ab-variety0.png` (clean,
organic, and the 4-cell global repeat is not objectionable at any zoom this module shoots).
`city` reached the same conclusion independently (#28). The bound belongs in tiles.

`variety` is reachable only from the query string, which a critic will not pass, so the
showcase **works around it with public API**: after `terrain.load`, `terrain.world().setVisible(false)`
and `tiles.buildInstances(scene, draft.tileset, draft.placements, { variety: 0 })` builds the
same placements again with the noise off, disposed on `world:unloaded`. It is skipped when the
URL pins `variety`, so the A/B still works. It costs a second set of instanced meshes for the
map — measured at **49 draw calls and 18.5 k triangles** for the meadow against budgets of 1500
and 900 k — and it is a *showcase* workaround: `/` still shows the checkerboard, because
`simulation` quietly rebuilding the whole world for the game would be a far worse trade.

**Every AdAstra tree is edge-on to this camera, and no planting fixes it.** Dumped from
`pack.bin`, model 202 `tree` is five quads:

```
ki02ax   plane x = 1, normal (-1, 0, 0), y 0.19..4.5    <- edge-on, this is the stripe
ki02ax   plane z = 1, normal ( 0, 0,-1), y 0.19..4.5    <- the one you are meant to see
ki02bx   horizontal, y = 1.625, normal (0, 1, 0)        <- the "lintel" above the canopy
ki02dx   horizontal, y = 3.719, normal (0, 1, 0)
ki02c    horizontal, y = 0.188                          <- root decal
```

`round_tree`, `darker_pine` and `big_tree_dark` have the same shape. The camera never yaws
(§2.7), so the `x = 1` plane is *permanently* perpendicular to the view and rasterises as a
full-height sliver of canopy texture — and because it is lit off a normal pointing east while
the horizontal slices are lit off one pointing up, the sliver stays green at 17:30 while the
canopy goes red. That is the artifact, exactly as photographed. It is tile geometry, filed as
a coreRequest, and until it lands **this map plants no tree at all**.

The same test condemns `fence_side_edge_w`, whose rail panel lies in the plane `x = 0.5`: it
renders as a bare dark line. Only `fence_side_edge_s` (panel at `z = 0.5`) is usable, so every
fence run in this map is east-west and north-south boundaries are hedged.

What closes the meadow instead is **hedgerows and post-and-rail fields**. `hedge1` is 14
triangles of real sloped box under a shadow decal — no billboard in it — so it survives both
the 45° camera and the low sun that the trees do not, and a field's long straight edges give
the eye something to read the queue's bend against.

**The grass mode was hidden by the row in front of the lead, not by the row it stood on.** A
2.83-unit sprite covers 2.0 tiles of ground depth at 45°, so the blades one cell *south* of
the lead — between it and the camera — are what swallowed Oshawott. The patch now ends on the
walk's own row (`PATCH.z1 === SPUR.z0 + 1`) with the last two rows in the shorter
`tall_grass_light`: grass behind and beside, open meadow in front. Before, the blades cut the
sprite off below the snout; after, head, arms, scalchop and feet all read
(`docs/progress/simulation/critic/c-grass-tod08.png` against `r2/grass-tod8.png`).

**`run` is now `south` at 0.15 s/tile, on the same cells on purpose.** The trainer sheet ships
a genuinely separate leaning trio (south walk 21/22/23, south run 11/12/13, #17), but a run
frozen somewhere else proves nothing: "a slightly different sprite" is not evidence. A
controlled pair — same cells, same facing, same stride half of the cycle, one variable — makes
the lean the only difference between the two PNGs. 3 ticks a tile against the walk's 5 means
`sub 2` and `sub 3` both land on the stride phase at nearly the same point in the tile.

**`wide` is k = 1.5, and that costs texel exactness.** `pixelExactDistance` only lands a sprite
texel on a whole internal pixel for *integer* k, so the choice was k = 1 (exact, subject ~7 %
of frame height, which is what the critic rejected) or k = 1.5 (subject ~11 %, texels
alternating 1 and 2 internal pixels — visible in a 4× crop, not at 1:1). Both were shot:
`r2/ab-wide-k1.png` against `r2/wide-tod12.png`. Readability won; the cost is recorded rather
than hidden.

**`mode=city` stages itself against whatever `city` shipped this week.** A scripted route
*skips* a blocked step rather than wedging (route.js), so when the lobby grew hedges and flower
beds the freeze drifted 17 steps past its intended pose with no error anywhere. The mode now
finds the longest open east-west run of `plaza`/`path`-tagged cells near the spawn through
`terrain.passable`/`tagsAt`, stands the line on it and walks west two steps: east-west is the
one axis on which a 45° camera cannot make one walker occlude another. Lobby NPCs within 3
cells of a member are then removed (5 of 14 at noon) so the party is not lost in the crowd,
and `sim.frameOffset(0, 2)` — a whole-cell, showcase-only nudge of the camera focus — lifts the
queue into the upper third with the rest of the square, benches, beds and remaining NPCs,
behind it.

Measured at 1600×900 after all of it: **60 fps / 16.8 ms p95, 49 draw calls (233 in the city),
18.5 k triangles, 14 programs, 0 console errors and 0 console warnings** across eleven shots;
`node src/simulation/selftest.js` 34/34 and `node tools/seams/run.js` pass.

---

### 30 — 2026-09-08 — "To the horizon and no further" trades a black silhouette for a black shaft; a down-wound triangle is a hole; and a contact shadow is a shape, not a texture

Five things `src/tiles/` measured before changing, in the round after its first critique. Every
before/after pair is the same URL one code change apart, in `docs/progress/tiles/r2/`.

**(a) The normal floor is 22 degrees above the horizon, and it is a fragment clamp.**
DECISIONS #25c lifted the 382 below-horizon normals *to* `n.y = 0` and stopped there. With the
sun near overhead a normal at exactly zero elevation takes `max(dot(N,L),0) = 0`, so every
vertical face in the set was hemisphere fill only — and `env/presets.js` runs ambient at 0.10 on
purpose. Symptoms, all one defect: a lamp post that is navy over most of its length with a hard
band where the lifted vertices meet the unlifted ones, a canopy that reads dark teal at noon, and
black streaks down every edge-on card. The floor now applies to **every** normal, not only the
ones that were below zero, which is what removes the band.

It has to be a *fragment* clamp, and that is not a stylistic choice. Six AdAstra materials are
`bothFaces` — `ki02ax`, the crossed upright cards a tree is built from, is one — and three flips
the normal for a back face inside `normal_fragment_begin`. A stored normal lifted to +22 degrees
renders its other side at −22, and the camera looks north, so it sees the south face of every
north-facing card: a buffer lift would have made the tree *worse*. Clamping after the flip fixes
both sides. `normal` there is in view space, so world up comes from `viewMatrix`'s own Y column
rather than `vec3(0,1,0)`; `viewMatrix` is already in three's fragment prefix, so it costs no
uniform, and one shared `customProgramCacheKey` keeps every tile material on one program.

`Material.clone()` copies neither `onBeforeCompile` nor `customProgramCacheKey`, and
`instanced.js` clones a material to hang the global-UV attribute on it — so patches are composed
from a list (`applyShaderPatches`) instead of each overwriting the other. Without that the lawn
would shade differently from the path beside it.

**(b) 46 triangles are wound face-down, and eight of them are the north half of a canopy roof.**
PDSMS draws with backface culling off, so a DS artist has no reason to keep a consistent winding
(#5); the exporter rewinds each triangle to agree with the artist's *stored normals*, and where
those point down it faithfully reproduces a face the camera can never see. Measured over the
whole pack: 46 of 2402 triangles have a geometric normal below −0.5 on a `FrontSide` material,
and every one is on a forest entrance — 12 each on the three `forest_entrance_side_back` variants
and 10 on `forest_entrance_front`. Eight of that last ten are the top canopy slice (`ki02dx`,
y 3.59/3.72): eight of its sixteen triangles are wound down, and they are precisely the eight
covering z 0..3 — the model's northern half. The result is a hole in the canopy roof with the lawn 3.7 m below showing through
it, which is the pale diamond in `docs/progress/tiles/critic/tree-close-12.png`. Proof:
`ab-tree-norewind.png` against `tree-close-12.png`, same URL, that one guard flipped.

The rewind runs **before** `liftNormalsAboveHorizon`, not after, and that ordering is load-bearing:
a flipped triangle negates its own stored normals so the shading agrees with the face, and once
the lift has clamped every negative Y to zero there is no negative Y left for it to find.

The critic diagnosed this as `ki02c` being classified as a ground decal. That was worth checking
and is wrong: `ki02c` sits at y 0.19 and `forest_entrance_front` does not use it at all. The
height guard in (c) is still the right rule, but it is not what closed the hole.

**(c) `flatOnly` is half a test; a ground decal is also *low*.** A canopy is built out of
horizontal slices (#22), so thinness alone classifies a leaf layer three metres up exactly as it
classifies the shadow blob under a trunk — and a slice that writes no depth stops occluding
anything behind it. The cut is at 0.35 of a cell: AdAstra's real ground decals top out at 0.13
and the lowest canopy slice a tree owns starts at 1.44, so nothing is near the boundary.

**Decals are also unlit now.** `kage_out` is a flat quad with a +Y normal, so at noon a
`MeshLambertMaterial` gives the *shadow* the full key, and at golden hour turns it orange with
the sun. It is a picture of an absence of light: `MeshBasicMaterial`, and it multiplies down onto
whatever it lies on at every hour.

**(d) A contact shadow is a plateau and a penumbra measured in cells, so it is a shader.** At noon
the sun is nearly overhead and the shadow it casts lands *under* the object, which then stands on
top of it — `hedge-close-12.png` had a working shadow map and a hedge meeting the lawn with no
darkening at all. `docs/refs/01-forest-tilemap-frame.png` carries most of its depth in exactly
that ground shading. AdAstra's artists agreed and painted `kage_out`/`h_kage` under twelve models,
but those sit *under* a footprint and a hedge a full cell tall covers every pixel of its own; what
grounds a piece is the half cell that reaches past it, so a model that ships a baked blob gets a
generated one too.

The first cut of this used a radial texture and was **invisible**, and the reason is worth
keeping: scaled onto a 4x1 hedge a radial falloff becomes an ellipse whose penumbra starts a cell
*inside* the hedge on the long axis and is already at 4 % alpha where it leaves the short one. The
shape has to be per-axis in world cells. Two instanced attributes (`aInner`, `aMargin`) and five
lines of GLSL do it exactly for any footprint. Cost, measured against `?contact=0`:
**+3 draw calls and +1 program for the whole demo city** (one per `InstancedWorld`), 235 draws
against 232. `?contact=0` for the A/B; `buildInstances({ contact: 0 })` for a scene that does not
want them — `rotate` mode passes it, because a shadow over the pale pad hides the one thing that
shot exists to prove.

**(e) The lawn checkerboard was two different bugs, and only one of them was the tint.** The tonal
blotch ran on 9- and 4-cell lattices at ±7.5 %, which puts a **2.8 %** step across every cell edge
— the eye finds a grid in that instantly. On 24 and 11 cells weighted 1.6/0.4 the same ±6.5 % of
tone moves **0.73 %** per cell, a quarter of a level at 8 bits. The amplitude was never the bug;
the period was, and the reference's ground shading needs the amplitude.

That left a residual, and measuring the render is what found it: sampling 60 px windows of lawn in
`hedge-close-12.png` gave neighbouring cells differing by **19 levels of green**, twenty times
what the tint can produce. It was the per-cell UV phase. A `GLOBALMAPPING` tile is one cell of a
pattern the artist drew across `1/uvScale` cells — grass runs 4x4 — and phasing or spinning one
cell of that pattern tears it at every cell edge. Invisible at the game camera, a grid of green
squares at three times the zoom. A global tile is now varied by its **block**: the whole 4x4 patch
shifts together, stays continuous inside itself, and the repeat is broken at the scale it actually
repeats at. A scale-1 tile (the path centre) keeps the per-cell turn and phase, because there each
cell *is* its own stamp. `ground-12.png` still shows no 4x4 repeat.

**Two showcase fixes, for the same reason a showcase exists.** `set2` is the `grass_path_corner`
palette whose centre `michi03b` is a 4-bit indexed PNG with an all-green palette
(`74dc76`/`81db72`/`8bdc74`) — green tiles on a green lawn, so `set2-12.png` placed thirteen cases
and showed none of them. Every stamp, in both the single-set and overview modes, now stands on a
pad of lawn tinted down to `0x6d7488`; tinting rather than swapping in stone keeps the edge tiles
meeting the grass they were drawn to meet, and `set0` still reads tan-on-green. And `lamps` mode's
two benches were at (3,9) and (w−4,9), outside its own framing: one behind the readout panel, one
cut in half at the frame edge. They are on the paving at (4,7) and (12,7) now.

Measured at 1920x1080, `?showcase=tiles&tod=12`: **60 fps, p95 16.7 ms, 400 draw calls, 24 856
triangles, 14 programs, 0 console errors, 0 console warnings**, against 399 / 24 648 / 13 before
this round. Nineteen shots in `docs/progress/tiles/r2/`, every one at 60 fps and zero errors.

---

### 31 — 2026-09-08 — The lamp pool was flooding, not missing; the roof wedge was never a shadow; and night's `gain` was throwing the whole frame away

Six things `src/environment/` measured before changing them, in the round after two critics
(reviewing *other* modules) named this module as the cap on their scores. Every before/after
pair is the same URL one code change apart, in `docs/progress/environment/r2/`;
`base-*.png` is the round-1 frame, the unprefixed name is the round-2 one.

**(a) `gain` is a multiply on the *finished display range*, and night's was 0.42.** The
composite is `scene·exposure → AgX → ·gain + lift → sat → contrast → vignette`
(`core/render.js`). `look.gain` is authored as an sRGB hex and lands in the linear working
space, so the night keyframes' `gain: 0xa9afbc` is **(0.398, 0.428, 0.494)** — every pixel of
the night frame was squeezed into the bottom 42 % of the output before `contrast 1.18` pushed
everything below mid-grey down again. That, and not the ambient colour, is what made
"tod 21 is a global blue-black multiply": nothing in the frame could reach a highlight, so a
lamp could not either. Measured on the demo city at `tod 21`, round 1 ran **p50 42.5, p95 79.8,
p99 96.8** — the whole image inside 90 sRGB levels. `docs/refs/03-forest-voxel-night.png` runs
**p50 33.2, p95 129.5, p99 159.2** with 15 % of its pixels under level 12: darker *and* wider.
Night `gain` is near-white now, `lift` is roughly halved — 0x0f1420 is (0.0048, 0.0075, 0.0155)
in linear and 0x0c0d14 is (0.0033, 0.0037, 0.0069), so it is both smaller *and* far less blue —
and `exposure` came down 5.06 → 0.32 to carry the hour instead. `city-21.png`: **p50 42.9, p95 124.1, p99 165.3, 17 %
under 12**, against ref-03's 33.2 / 129.5 / 159.2 / 15 %.

**(b) The lamps were never failing to cast a pool. They were flooding.** Probed in the running
page, all eight `PointLight`s were on, positioned on the city's bulbs, at 18 cd with
`distance 12, decay 2` — and a fresh 600 cd light dropped into the same scene blew the frame
out, so the tile materials were receiving them all along. The bug is the *shape*: at radius 12
one lamp reaches most of a twenty-cell square, and six of them raise every paving stone by the
same amount. `ab-lamppool-off-21.png` against `city-21.png` is the proof, and it is now a
**pool**: `POOL_REACH 7` (three.js's `(1 − (d/cutoff)⁴)²` window closes six cells out) and
`POOL_GAIN 55` to buy back the peak. Sampling one row of open paving across `city-21.png`, the
brightest point under a lamp reads **148** where the same row six cells further out reads
**34**; with the pool pinned to zero those two points read **1** and **32**. The pool moves
64 % of the frame's pixels by up to 215 levels, and takes the night's p95 from 53 to 124.

**(c) The "hard-edged black polygon slashed across each building roof" is fill starvation, and
it *does* move with the sun.** At 08:00 the sun is at azimuth 103.6° (measured through
`env.sun()`), so a west-facing roof facet takes `dot(N,L) ≤ 0` — literally zero key — and
renders on the hemisphere alone. A `HemisphereLight` is a function of `normal.y`, so it cannot
tell a face turned into the key from one turned away, and raising it lifts both and turns the
frame to milk. Two **shadowless** directional fills fix it without touching the shadow contract
(`three.sun` is still the only light that casts):

* `bounce` — anti-sun azimuth, 20° up. A wall the sun has turned its back on takes 0.94 of it;
  the ground, which already has the sun and the whole sky, takes 0.34.
* `camFill` — the camera axis, 38° up, deliberately *shallower* than the 45° camera. Every
  sprite is an upright card facing the camera (#18), so at 17:30 with the sun due west the
  trainer's front takes `dot(N,L) = 0` whatever the hemisphere does. At 38° the sprite front
  takes 0.79 and a flat floor only 0.62 — and lifting the floor is exactly what erases a
  shadow, so the shallow angle buys the subject and the shadow at once.

`ab-roofwedge-8.png` (fills off | on) and `ab-fills-off-8.png` against `city-8.png`. Measured on
the facets themselves at 08:00, the fills do exactly what a fill should and nothing else:

| facet (08:00) | fills off | fills on |
| --- | --- | --- |
| Mart, west hip (the "black polygon") | (12, 16, 72) | (21, 29, 83) |
| Pokémon Center, west hip | (78, 32, 12) | (99, 35, 13) |
| Pokémon Center, east hip (**lit**) | (198, 43, 14) | (200, 44, 15) |

The lit facet does not move; the two starved ones come up 27 % and 75 %. Across the whole frame
that is 20 % of the pixels by up to 49 levels, and the pixels crushed under level 12 fall from
5.1 % to 3.0 %; at 17:30 from 3.4 % to 1.7 % (`ab-subject-17.5.png`). Honest scale: the Center's
west hip is a *readable dark red* now rather than a *near-black one*, not a lit surface — which
is what a bounce at 20° should do to a facet the sun cannot see.

**(d) The golden hour was monochrome because `contrast` kills whichever channel is lowest, and
at a warm hour that is always blue.** The grade's S-curve is `(x − 0.5)·k + 0.5`, so at
`contrast 1.31` a blue channel sitting at 0.24 comes out at 0.086 while a red at 0.55 barely
moves. Modelled and then confirmed on the render: round 1's distant grass was
`(75, 65, 25)` — hue 47°, an olive — with the plaza at hue 339° and the *blue* Mart roof at
326°, i.e. every surface inside one 70° warm wedge. Three changes, all measured against
`docs/refs/04-cave-golden-hour.png`'s own histogram (**mean 76, p1 26.6, p50 64.2, p95 155.7,
sat 0.773, nothing under level 12**): `contrast` 1.31 → 1.14 and `saturation` 1.20 → 1.40; a
warm `lift` (0x1a1208) so the shadows have a floor the way the reference's do; and the fog
desaturated from `0xc46b34 × 1.15` to `0xcf8a55 × 0.92`, because at 0.0072 density the old fog
was adding **more red to distant grass than the grass had of its own** (0.074 against 0.054 in
scene-linear). `city-17.5.png` now runs **mean 73.8, p1 6.6, p50 71.1, p95 126.9, sat 0.694**,
with grass at hue 67°, the road at 30°, the Mart roof back off the warm wedge and the trainer
reading as a silhouette against the paving. `env-21.png` lands on ref-03 almost exactly:
**mean 38.6, p50 32.2, sat 0.855, 16.6 % under level 12** against **45.1 / 33.2 / 0.853 /
15.4 %**.

**(e) The shadows at a low sun were never missing — they were covering everything.** Toggling
`renderer.shadowMap.enabled` at `tod 17.5` in the environment showcase changed **47 %** of the
pixels, which is the opposite of "there is almost no shadow at all". The sun is 9.6° up there,
so a shadow is **5.93×** the caster's height, and the showcase's 5-unit west massif ran
cz 8..23 and threw 29.6 units east — over every open cell the camera could see. A shadow with
no lit ground beside it is indistinguishable from no shadow. The massif is confined to
cz 6..17 now and a free-standing block stands in the open south of it, so half the stage is lit
at every hour: `env-17.5.png` reads a ladder of long fence shadows running east, `env-8.png`
the same running west. `ab-shadowmap-off-17.5.png` is the A/B.

The second half of that is the ratio. A shadow is the *absence of the key*, so it can only be
as deep as the key is strong, and at 9.6° a flat floor takes `dot(N,L) = 0.167` of it. Round 1
ran `sun 4.40` there, which put the key at 27 % of the floor's own light — invisible. `sun` is
**16.0** at 17:35 and 13.5 at sunrise, with `exposure` down to 0.52 to pay for it: the key
still only reaches the floor at 0.167, but a wall facing it takes 0.64, which is what makes a
low sun look low. Nothing clips — `city-17.5.png` p99 is 148.

**(f) Solar geometry was correct all along, and is now checked rather than assumed.** Measured
through `env.sun()` and `three.sun.light.position − target`: 08:00 altitude 27.6° azimuth
103.6° (shadows west-and-north, 1.91× height); 12:00 altitude 60.0° azimuth 180.0° (due north,
0.58×); 17:30 altitude 9.6° azimuth 270.5° (due east, 5.93×). All three match the shadows on
screen. At night the moon is placed opposite the sun with its elevation floored at 0.38 —
`tod 21` gives a key from azimuth 125° at 30.5° up — which is a convention, not astronomy, and
it is chosen so there is always something with a direction to model geometry with.

**(g) Dusk got *brighter* as the sun set, and the cause was two different elevation floors.**
The key's direction is clamped away from the horizon, because a light exactly on the horizon
takes zero diffuse off every up-facing surface. The day branch floored at 0.06 and the night
branch — the moon — at 0.38, so the instant the sun crossed −2° a flat floor's `dot(N, L)`
jumped 6×. Measured before the fix: `tod 18.3` median **52.5**, `tod 18.7` median **80.1**.
Both branches use the same 0.06 floor now (`KEY_ELEVATION_FLOOR`); by `tod 21` the moon is
30.5° up on its own and the floor does nothing. The ramp across dusk is monotone again —
18.3 **52.5** → 18.7 **57.6** → 19.1 **55.0** → 19.8 **50.2** → 21 **42.9**, the small bump at
18.7 being the lamps coming on, which is the point of that hour. The afternoon had the same
shape for the same reason (a `sun` that has to grow as `1/sin(altitude)` between two
keyframes); 15:24's key went 3.75 → 4.85 with its exposure down to 0.44 to match.

**(h) Two of `city`'s open requests were environment's to answer.** `lamps.add({ point: false })`
registers a bulb that gets the glow quad and the bloom but never claims one of the eight
`PointLight` slots — a lit shop window sits a metre off the ground and wants to *look* lit, and
giving it a pool takes the pool off the pavement the player walks on. Verified in the running
page rather than only written: a `point: false` bulb registered *at the camera focus* — the
nearest position there is, so it would certainly win a slot on distance — claims none, while a
normal bulb two cells away takes `env:lamp0` and carries its colour, and the pool stays at 8.
No scene calls it yet, so the request is **implemented, not exercised**: `city` still has to
pass the flag for its windows before any shipped frame changes.
And `tod 19.1` no longer "renders as dark as 21.5": it is the brightest *highlight* hour of the
whole day (p99 **193**, against noon's 154) because the lamps are lit while the sky is still
blue. `city-18.7.png`, `city-19.1.png`, `city-19.8.png`.

**(i) The sky dome's lower hemisphere is painted with the fog now, not with a ground colour.**
At a 45° pitch the only way the dome's underside is ever on screen is through a *hole* — the
far edge of a map smaller than the view frustum — and the authored `skyGround` 0x2f3a22 comes
out of `exposure 0.33` and `contrast 1.27` clamped to literal black, so the hole reads as a
void. `?showcase=hunts&tod=12` had a black band across its top third and no shot in the tree
proves otherwise. Pulled three quarters of the way to `fog × fogBoost` the same band reads as
the air everything else fades into: the top strip of `xmod-hunts-12.png` went from
**(2, 5, 3)** to **(42, 56, 85)**, and `city-12.png` and `city-21.png` are unchanged to the
decimal, because a map that fills the frustum never shows it.

**(j) Noon did not move, and that is a pixel diff rather than a histogram.** `base-city-12.png`
against `city-12.png`, same URL one round apart: **mean absolute difference 0.23 levels, max 18,
0.92 % of pixels differing by more than 8.** `ab-noon-drift.png` is that difference map at 8×
gain, and every pixel in it is a shop awning, a north-facing bench back, a hedge front or a
window frame — the surfaces `bounce` (due north at noon) and `camFill` are aimed at. The approved
frame is intact.

**Two things changed that were not asked for, and three honest limits.** `tune({ lift: 0x241a10 })`
used to store a *number* in a colour slot and put a NaN straight into the grade uniform — the
whole frame went black. `tune` now knows which look keys are colours. The `forest` preset also
takes 1.55× the camera fill, because under a canopy almost every lit surface is one of a tree's
two crossed upright cards (#29) and a hemisphere cut to 0.78 to sell the shade reaches none of
them — worth 0.20 of a light at noon against a key of 3.85, so it does *not* fix the dark-teal
canopy `tiles` already lists as its own residual, and it is not claimed to. And the `cave` and
`interior` presets replace `sun`/`hemi`/`exposure` wholesale, so they were rescaled to the new
grade by arithmetic and shot only through the *outdoor* showcase, which is a grass field
wearing a cave's palette: they are coherent and not blown, but neither has been judged in a
scene it was written for, because `hunts` has no cave yet.

Measured at 1920x1080, `?showcase=city&tod=21`: **60 fps, 233 draw calls, 18 994 triangles,
0 console errors, 0 console warnings**, unchanged from round 1 — two more `DirectionalLight`s
cost no draw call, only two more terms in the Lambert loop. Forty-four harness shots in
`docs/progress/environment/r2/` (plus eight A/B and difference images that carry no JSON), every one at 60 fps,
p95 16.7–16.8 ms, ≤ 19 programs and zero console errors. Zero console warnings too, except on
the cross-module `hunts` shot, whose one warning is emitted by `hunts` (`tiles.find` by name,
#6) and is not this module's to fix.

### 32 — 2026-09-08 — A pool is a *ratio*, not a brightness; a flat decal is back-facing from above; and a fill aimed at 20° spends half of itself on the floor

Round 3 of `src/environment/`, after a critic scored round 2 at 6.5/10 with two findings that
were really one: *"night is composition-dependent — the lighting model was not fixed, one
histogram was"*, and *"the pool-on/pool-off A/B lifts the WHOLE frame ~60 levels uniformly"*.
Both were right. Every before/after below is the same URL one change apart, all in
`docs/progress/environment/r3/`; `base-*.png` is the round-2 frame and the unprefixed name is
the round-3 one.

**(a) Round 2's "pool" was still a flood, and the fix is the reach, not the gain.** At
`POOL_REACH 7` with the plaza's lamps six cells apart, every paving stone sits inside two or
three of three.js's `(1 − (d/cutoff)⁴)²` windows and the sum is flat: measured on `r2`'s own
`city-21`, paving under a lamp read **103** and paving six cells right **102**. Round 2's
celebrated "148 against 34" was a differential against a pool pinned to zero, not a contrast
anyone could see. `POOL_REACH` is **4.6** now (the window shuts 3.4 cells from the post, well
before the next lamp's opens) with `POOL_GAIN` down 55 → 34, and the honest A/B is
`ab-pool-off-21.png` against `city-21.png`: **median lift across the whole frame 1.1 levels**,
under the near lamp **+46.9**, mid-plaza between two lamps **+8.2**, top-left lawn and
top-left corner **+0.0 and +0.0**. `ab-pool-diff-21.png` is that difference at 3× gain and it
is a set of discs, not a wash. One row of paving at y 805 now reads
`97 · 109 · 117 · 98 · 95 · 82 · 69 · 78 · 65 · 62 · 63 · 64 · 78 · 67 · 57 · 75 · 89 · 77`
— a knee under each lamp and a trough between them.

**(b) A `PointLight` models geometry; it does not compose a frame. So there is a second,
painted pool — and it was invisible for a day because a flat quad is back-facing from
above.** `lamps.js` now builds one world-space quad per bulb lying on the ground at
`terrain.height(x, z)`, with an authored falloff and `blendSrc: DstColorFactor,
blendDst: OneFactor` — `dst · (1 + src)`, a *multiply*, not an add. That matters: an additive
decal puts the same photons on black grass as on pale paving, which is how a painted pool
stops reading as light and starts reading as fog, and a multiply can never lift a pixel the
key never reached. Two bugs, both found by measurement rather than by reading:

* the quad sat at `heightAt + 0.03`, and `heightAt` is a cell's *placement base* — a tile's
  own geometry stands on top of it, so every fragment was inside the paving slab. Lift is
  **0.30** now, which clears the thickest ground tile in `bw2-adastra` (top face 0.25).
* with the lift fixed it *still* drew nothing, at 234 draw calls against 233 and 20 shader
  programs against 19, byte-identical to the same frame with `?envNoDecal=1`. Bisecting the
  vertex shader settled it: a clip-space passthrough of the same geometry drew a disc, and the
  same geometry through `projectionMatrix * modelViewMatrix` drew nothing *at any world
  position*. The quad's winding reads clockwise from a camera above it, so three's default
  `FrontSide` culled all of it. `side: DoubleSide`.

A dead draw call that costs a program and produces a byte-identical frame is not something a
histogram or an fps number can see; only the A/B could.

**(c) `MAX_LIGHTS` 8 → 16, and the pool lights are never hidden again.** The plaza has twelve
lamps plus two shop bulbs competing for eight slots, which is why two in-frame fixtures
rendered as dead props. Sixteen covers it at 60 fps and +0 draw calls. And the unused lights
now sit at `intensity 0` rather than `visible = false`: `NUM_POINT_LIGHTS` is a shader
`#define` derived from the number of *visible* lights, so switching one off at dawn recompiles
every material in the scene mid-frame, where a light at zero costs a multiply.

**(d) The fixture read as "a dark navy dart with a yellow sticker behind it" because the glow
quad was inside the lantern.** The emitter is at the bulb, and the bulb is inside the lamp
head's own geometry, so the depth test ate the quad's lower half. The billboard is pushed
**0.42 units toward the camera in view space** — less than the head is deep, so it still hides
correctly behind a wall — and the halo exponent went 2.6 → 1.7 with its weight 0.55 → 0.95,
because a sodium lamp at twenty metres is a small white filament inside a *large* orange glare
and it is the glare that says "lit". `env-21.png` against `base-env-21.png`, same framing.

**(e) Night was composition-dependent because the key was tiny and the fill was doing its
job.** The moon key ran `sun 1.18` against a hemisphere of 0.47, so on open ground the
key-to-fill ratio was 3.4 : 1 and nothing outside a lamp's reach was modelled at all —
`city-pond-21` measured **p50 26.3 / p95 36.5**, a quarter of `docs/refs/03`'s range, and
`city-garden-21` **p50 17.7 with 42.6 % of the frame under level 12**. A `tod 21` frame is
essentially the `20.6` keyframe (the smoothstepped blend toward midnight is 0.04), and that
keyframe now runs the moon at **`sun 2.35`** — twice round 2's 1.18 — with `exposure` down
0.32 → **0.30** to pay for it. The hemisphere is *not* smaller: `hemi` barely moved (0.47 →
0.46) but `hemiSky` went **0x54688c → 0x74829a**, which is both brighter and far less
saturated, so the fill lifts the shadows more while staining them less. Key doubled, fill
brightened and desaturated, exposure down — the ratio moved, the level did not.
Measured, same URL:

| frame (tod 21) | round 2 | round 3 | `docs/refs/03` |
| --- | --- | --- | --- |
| `city-21` p50 / p95 / p99 | 42.9 / 124.1 / 165.3 | 42.0 / 121.2 / 170.2 | 33.2 / 129.5 / 159.2 |
| `city-pond-21` p50 / p95 | 26.3 / 36.5 | **39.8 / 54.8** | — |
| `city-garden-21` p50 / p95 | 17.7 / 48.0 | **23.4 / 65.5** | — |
| `city-high-street-21` p50 | 27.8 | **34.8** | — |

Two intermediate settings were shot and rejected, and both are worth writing down. Raising
`sun` *and* `exposure` together (2.70 / 0.36) gave `city-pond-21` p50 57 — readable, and it
read as overcast late afternoon, not night. Raising `sun` to 2.95 while cutting `hemi` to 0.30
put the key-to-fill ratio at **7 : 1** and turned every building shadow on the lawn into a
black hole. The shipped 2.35 / 0.46 sits at roughly 4 : 1, and the dusk ramp stays monotone
across it — 17.5 **63.1** → 18.3 **46.9** → 18.7 **45.7** → 19.1 **41.8** → 19.8 **43.4** →
21 **42.0**, with 19.1 still the day's brightest highlight hour (p99 **187**) because the
lamps are lit while the sky is blue.

**(f) `BOUNCE_ELEVATION` 0.34 → 0.18: the anti-sun fill was spending half of itself on the
floor.** This fill exists for the facet the key has turned its back on — the Mart's west hip at
08:00. Its enemy is the ground, which already has the sun and the whole sky. A vertical wall
takes `cos(elevation)` of it and a flat floor `sin(elevation)`: at 20° that is 0.94 against
0.34, at 10.4° it is 0.98 against 0.18. Halving the floor's share is what let `bounce` be
roughly tripled at every low-sun keyframe (7.2: 0.42 → 2.40; 17.35: 0.62 → 2.80) without the
golden hour turning into flat midday. `ab-fills-off-8.png` against `city-8.png` is the proof
that it is *complementary* and not a general lift:

| facet, tod 8 | fills off | fills on |
| --- | --- | --- |
| Mart west hip (the "black polygon") | (4.1, 4.1, 31.2) **L 6.0** | (27.1, 35.4, 62.3) **L 35.6** |
| Pokémon Center west hip | L 7.8 | L 32.5 |
| Mart east hip (**lit**) | L 88.4 | L 89.7 |
| open paving (**lit**) | L 116.6 | L 124.4 |

Starved facets ×5.9 and ×4.2; lit surfaces +1.5 % and +6.7 %. Against round 2 the Mart's west
hip goes **L 25.9 → 35.6** with its saturation **0.77 → 0.56**, so it stops being *more*
saturated than the slope it sits next to — which was the reason it read as black paint rather
than as a shaded facet. It is a 2 : 1 step against the lit front now, not 4 : 1.

**(g) The same change warmed the shadows, which is the "blue-shifted enough to desaturate"
note.** Shadowed plaza paving at 17:30, against lit paving on the same row: round 2 ran
**(76.9, 45.0, 45.0)**, hue 0°, saturation 0.26 — mauve. Round 3 runs **(71.6, 34.9, 28.2)**,
hue 9°, saturation 0.43 — a warm brown. As a ratio to the lit stone beside it the blue channel
went from **1.47×** the red channel's ratio to **1.20×**.

**(h) Saturation was the whole of "noon is plastic", and the lever is the hemisphere, not the
grade.** The critic measured `city-12` at **sat 0.506** against the references' 0.72–0.85.
Cutting `hemi` 1.08 → 0.86 while raising `sun` 3.85 → 4.05 and `exposure` 0.33 → 0.355 keeps
the frame at the same level and swaps a broadband blue-white wash for the key's own colour;
`saturation` then went 1.32 → 1.64 and `contrast` 1.27 → 1.32. Measured, mean unchanged to a
tenth of a level:

| frame | round 2 sat | round 3 sat | mean r2 → r3 |
| --- | --- | --- | --- |
| `city-12` | 0.507 | **0.610** | 94.5 → 94.6 |
| `env-12` | 0.540 | **0.761** | 102.8 → 102.8 |
| `city-8` | 0.547 | **0.709** | 84.2 → 80.6 |
| `city-17.5` | 0.690 | **0.774** | 73.8 → 68.7 |
| `city-pond-17.5` | 0.754 | **0.857** | 87.1 → 84.6 |

`docs/refs/04` is **0.773**; `city-17.5` lands on it.

**(h2) The showcase's own lamps were pointing the wrong way, and that is why the critic's
column scan did not move.** The quoted measurement was "env-21 road column x=790 oscillates
only 88 vs 65 (1.35:1) across a row of six lamps". Round 2 registered every showcase bulb at
its *cell centre*, and the lamps flank the road at cx 24 and 30 — two and a half cells from
the carriageway's middle, which is past where a 4.6-unit pool has any business being. So the
light was landing on the verge and the scan was reading the one strip of road it could not
reach. The showcase now picks the lamp orientation whose cobra arm reaches *in* over the kerb
(`'e'` west of the road, `'w'` east of it — the rule `city` already follows, #25) and derives
the bulb from the model's own bounds instead of assuming the cell centre. Same column, same
pixels: round 2 **66 … 86 (1.30 : 1)**, round 3 **56 … 102 (1.82 : 1)**, with a knee under
each lamp pair. Costs six draw calls (three lamp orientations instead of one) — 147 → 153 in
a showcase whose budget is 1500.

**(i) The "hard-edged dark quadrilaterals on lawns at night with no caster" are cast shadows,
and the A/B says so.** `?envNoShadow=1` at `--preset high-street --tod 21`
(`ab-noshadow-hs21.png`) removes every one of them; the caster is the shop's own two-tier
roof, and the "distinctly lighter outline" the critic saw is the gap between the upper roof's
shadow edge and the lower eave's. They read as holes rather than as shaded grass because the
night fill was too small, which is (e); nothing about the bias or the ortho extent was wrong.

**(j) Two verification toggles now live in the module, and they are the reason (b) was found
at all.** `?envNoShadow=1`, `?envNoPool=1`, `?envNoDecal=1` and `?envNoFills=1` are read
straight from `location.search` in `environment/index.js` — `core/config.js` only accepts keys
it declares, and none of these belong in the shipped tunables. Each defaults to the shipping
behaviour, so a normal load is untouched. An A/B that is a URL change rather than a code change
is the only kind the harness's frozen clock can make byte-exact.

**What is still open, and is not this module's to close.** No sprite casts a shadow anywhere
(`src/pokemon/field.js:106`), and both reference stills are built on sprite shadows — that is
the largest remaining gap to the refs and it is filed, not fixed. Nothing in the city has
contact darkening where it meets the ground; that needs a depth-buffer AO pass in
`core/render.js`. The pond is a flat colour patch with no specular, glint or shore darkening —
verified *not* to be an unlit `MeshBasicMaterial` (its colour tracks the hour: (77, 98, 98) at
17:30 against (12, 47, 123) at 21:00), so it is a Lambert surface that wants a water shader.
And `env-17.5` is still a warm-dominated frame: saturation is up 0.842 → 0.942 and the hue
families do separate (path ≈ 20–30°, grass ≈ 70–95°, conifers teal), but a meadow of green
grass and tan dirt under a 9.6° key is olive-and-orange by construction and no amount of grade
fixes that.

Measured at 1920×1080, `?showcase=city&tod=21`: **60 fps, p95 16.7 ms, 234 draw calls,
19 020 triangles, 20 programs, 0 console errors** — one more draw call and one more program
than round 2, both the ground-pool mesh; the environment showcase costs six more (153) because
its lamps now come in three orientations. Thirty-three harness shots in
`docs/progress/environment/r3/` (plus twelve `base-*` captures of the round-2 build, taken at
the same URLs and sizes so every comparison above is mine rather than the critic's, and one
difference map that carries no JSON), every one at 60 fps and zero console errors, with one
console warning across the whole set, emitted by `hunts` (`tiles.find` by name, #6) and not
this module's to fix. `node tools/seams/run.js`: 88 files, 15 modules, all contracts hold.

---

### 33 — 2026-09-08 — A billboard cannot be shadow-mapped, `gain` was a filter over the finished frame, and a fill aimed at 20° is still aimed at the floor

Round 3 of `environment`. The critic scored round 2 at 7/10 and ranked nine defects; four of
them turned out to be three causes.

**(a) A character sprite cannot be put in the shadow pass, and the reason is geometric, not a
missing flag.** The ranked-worst defect was that no trainer or Pokémon casts a shadow —
`pokemon/field.js:106` sets `castShadow = false` and substitutes a black `MeshBasicMaterial`
disc. Flipping that flag does not work, and neither does the obvious repair:

  * a sprite is one upright quad facing the camera, so a sun 90° off the camera's azimuth sees
    it **edge on** and it occludes a one-texel line. 17:30 — the longest-shadow hour of the day
    and the one the critic measured — is exactly that case;
  * turning the card to face the light in a `customDepthMaterial` makes the caster plane cross
    the receiver plane along the vertical line through the sprite's own origin, so *half of
    every character in the frame* is behind its own occluder and self-shadows as a hard
    vertical split. Pushing the caster clear costs an offset the size of the sprite's own
    half-width — a full world unit of detachment at the feet.

So `environment/castShadows.js` **projects** the shadow instead: the sprite's own silhouette,
sheared flat onto the ground along the sun's azimuth at the length its altitude implies. It
finds its subjects by *shape* rather than by name — an `InstancedMesh` whose geometry carries
an `aUvRect` instanced attribute is a sprite field showing atlas frames — and the mirror mesh
shares `position`, `uv`, `aUvRect` and `instanceMatrix` **by reference**, so it follows the
cast for free, uploads nothing of its own, and cannot be a frame behind the character it
belongs to. One extra draw call and one extra program for the whole cast: 234 → 235 draws,
20 → 21 programs at `?showcase=city&tod=21`, 1920×1080.

Three details are what stop it reading as a decal:

  * it is a **multiply** (`blendSrc: DstColorFactor, blendDst: ZeroFactor`), not a black
    overlay. The contact blob it sits next to is `color: 0, opacity: 0.58`, which mixes every
    pixel toward black and therefore desaturates what it crosses — the critic's "flat uniform
    grey that DESATURATES what it crosses instead of darkening it warmly". A multiply keeps the
    surface's albedo and its hue;
  * the multiplier is not authored. `apply()` now computes `shadowMul = fill / (fill + key)`
    per channel from the lights it has just written — the exact fraction a flat piece of ground
    keeps when the key is taken off it — and hands it to the projected shadow. So a character's
    shadow is the same depth *and the same colour* as the shadow the shadow map casts from the
    bench one cell away, at every hour, with no second set of numbers to keep in sync. Read
    live off the page it is `(0.081, 0.130, 0.227)` at noon and `(0.119, 0.182, 0.390)` at
    17:30: a shadow that is blue because the fill is, and *bluer* at the golden hour, because
    the key has gone warm and the sky has not;
  * the blur widens with distance from the feet (5 taps, radius `uSoft · vRun`), which is
    contact hardening. A penumbra that does not change with distance from the contact point is
    the tell that a shadow was painted, and it was the critic's note on the tile shadows too.

Physical run length is compressed past 1.5× (`1.5 + (raw − 1.5)·0.42`, capped at 3.4). At the
key's elevation floor the true figure is 17× the caster's height, which throws a Pokémon's
shadow clear across the plaza and out of frame; ref 03's two Poochyena throw about three times
theirs. `docs/progress/environment/r3/garden-8.png` against `ab-nocast-garden-8.png` is the
same frame with the layer switched off — the trainer, Snivy and Tepig go from nothing to three
long shadows on the grass, and that is the exact crop the critic filed the defect from.

It cost two bugs worth recording. The atlas is packed with `flipY` off, so a frame's **`dv` is
negative** and `clamp(uv, rect.xy, rect.xy + rect.zw)` had `minVal > maxVal` — undefined in
GLSL, and here it returned garbage, so every fragment sampled alpha 0 and discarded: a draw
call, a program and 36 triangles that put nothing on screen. And the sprite field drops its
quad by `FOOT_PAD_TEXELS` (0.125 units) so a walking frame's empty rows land on the ground,
which puts the instance origin *below* the surface; a shadow laid at it is inside the paving
slab and fails the depth test everywhere — the same failure `lamps.js` shipped with once, and
the reason `uLift` is 0.15 rather than an epsilon.

**(b) `gain` is a multiply on the finished display range, and at the golden hour it was
`(1.00, 0.918, 0.786)` in linear — a 21% blue cut over every pixel of the frame.** This is the
whole of "the warm key is being applied as a chroma-pushing post grade". It was not only dusk:
07:20 ran `(1.00, 0.909, 0.767)`, which is why 08:00 drifted from a cool morning to a pinkish
tan. Every keyframe's `gain` is now within 2% of white and the warmth comes from the light.
Circular hue concentration R over coloured pixels, city plaza, same framing:

| tod | round 1 | round 2 | round 3 | green share r2 → r3 | blue share r2 → r3 |
| --- | --- | --- | --- | --- | --- |
| 08:00 | 0.535 | 0.704 | **0.510** | 23.3% → 23.2% | 6.2% → 10.4% |
| 12:00 | 0.220 | 0.468 | **0.339** | 23.8% → 23.6% | 9.2% → 10.5% |
| 17:30 | 0.803 | 0.861 | **0.567** | 6.3% → 19.4% | 2.1% → 9.1% |
| 21:00 | 0.473 | 0.332 | **0.230** | 16.9% → 16.6% | 17.1% → 22.3% |

The second half of the golden hour's collapse was the **bounce**, not the key. At 2.80 with a
`0xffc086` colour it was the largest single term in the shadowed ground — 59% of the red in it
— so a frame with a warm key had warm shadows too and *both* ends of the histogram sat on the
sun's hue. It is 0.95 now, the hemisphere is a saturated sky blue rather than a pale one
(`0x94a2c2` → `0x7d9ad6`), and the shadows carry it: shadowed plaza at 17:30 is hue 20 lit
against hue ~280 shadowed, which is the warm-key/cool-shadow split the hour is supposed to
have. The blue roof's lit hip went from hue 64 saturation 0.09 (grey-cyan) to hue 203
saturation 0.24, and its shaded hip to hue 231 saturation 0.60.

**(c) A fill aimed at 20° above the horizon is still mostly aimed at the floor, and the floor
is where a shadow lives.** `CAM_FILL_DIR` was `y 0.62` (38°). A sprite card's normal is
`(0, 0.778, 0.628)`, so that geometry gave the card 0.975 and the floor 0.62 — a ratio of 1.6,
and every unit spent on the floor is a unit the shadow no longer shows. At `y 0.180` (10.4°)
the card takes 0.758, a tile's near-vertical face (normal clamped to 22°, DECISIONS #30) takes
0.980, and the floor takes 0.180: a ratio of 4.2. The fill could then be **tripled** at the
low-sun keyframes while the light reaching the floor *fell*. That one number is both halves of
the critic's notes 3 and 6, because both are about how much fill lands on ground the sun has
already left:

| | round 2 | round 3 |
| --- | --- | --- |
| shadowed / lit ground, 08:00 (sun 27.7°) | 0.477 | **0.378** |
| shadowed / lit ground, 12:00 (sun 60°) | 0.347 | **0.372** |
| shadowed / lit ground, 17:30 (sun 9.6°) | 0.557 | **0.347** |
| shadowed / lit ground, 21:00 (moon 30°) | 0.432 | **0.307** |
| trainer at 17:30, as a fraction of noon | 0.722 | 0.714 |
| the paving under him, same fraction | 0.879 | **0.764** |
| subject ÷ ground | 0.82 | **0.93** |

(shadow figures are `city-<tod>.png` against `ns-<tod>.png`, the same URL with
`?envNoShadow=1`, so they are the shadow *layer* rather than a pair of hand-picked boxes.) The
frame is no longer flattest exactly when it should be deepest: 17:30 is now the deepest
daylight hour, which is the behaviour the note asked for.

**(d) A street lantern is a diffusing globe, and a mathematical point at the emitter cannot
light its own post.** The AdAstra cobra head reaches a full cell sideways off its post
(#25), so from a bulb above and to one side the post's camera-facing faces have `dot(N, L)`
slightly *negative* and take literally none of their own lamp — "the pole is taking moon/fill
only". `lamps.js` now drops the point light 0.26 units and brings it 0.34 toward the camera
(yaw is fixed, §2.7, so +z *is* toward the camera), which puts it inside the globe instead of
at its top edge and turns every camera-facing surface within a couple of units positive. The
pool on the ground moves by under one screen pixel.

The falloff exponent moved too, and it is the more interesting number: **`decay` is 1.5, not
the physical 2.** A lamp has two jobs at very different distances — model the post (1–2 units)
and lay a pool on the paving (3.3 units) — and inverse-square gives the near one 19× the far
one, so tuning for the pool starves the post and tuning for the post blows the post, the
flowerbed and the hedge in front of it to white (`docs/progress/environment/r3/a4-21.png` is
that failure). At 1.5 the same pool costs 13× at the post instead of 19×. A sphere of finite
radius does fall off slower than a point until you are several radii from it, so the lie is a
cheap model rather than a fudge.

With the decal's multiply pulled from `0.46·I + 0.08` to `0.205·I + 0.035`, paving inside a
pool at 21:00 reads **0.63× the same box at noon** (round 2: 0.99×, which is a plaza in
daylight with the sky switched off), and the flowers under the near lamp keep saturation 0.47
instead of clipping.

**What did not get fixed, and one thing that got measurably worse.**

*The lamp post is still cool, and its ratio to nearby paving is worse than round 2's, as a
direct consequence of fixing the pool.* Post 0.387 against paving 0.243 one cell east of it is
1.59; round 2 measured 0.342 against 0.325, or 1.05. Round 2's ratio was only 1.05 **because
the paving was flooded** — the same flood the critic filed as note 8. The post's hue did move
(289° → 316°, and warmer still nearer the lantern), but its brightness is albedo × geometry:
a light-grey post takes 0.654 of a 30° moon where the flat ground takes 0.506, and no fill in
the rig separates the two. The lever that would is the moon's *elevation* — at 55° the same
post takes 0.617 against the ground's 0.819 and becomes the darker of the two — which means
giving the moon its own orbit instead of mirroring the sun. That is also what the still-open
sun/moon direction flip needs, so the two should be done together, and not in the last hour of
a round.

*Night away from a lamp still has no rim.* Silhouettes separate by value and hue now (the
lamp-free tile field at 21:00 keeps green grass, warm dirt and readable flowers instead of one
navy), and the moon key was raised from 2.35 to 2.85 with the fill cut to match, so the frame
is modelled rather than washed. But a true rim needs a Fresnel term, and every material in the
scene is `MeshLambertMaterial` owned by `tiles` and `pokemon`. Filed as a core request: a
shared `onBeforeCompile` hook, or a rim term in the composite pass driven from the depth and
normal buffers `core/render.js` already has.

*Water is untouched* — no glitter, no moon path, no wet shoreline. It is a Lambert tile
surface and giving it a specular means either a water material in `tiles` or a screen-space
pass in core.

**(e) One verification toggle added.** `?envNoCast=1` turns the projected sprite shadows off,
joining `envNoShadow`, `envNoPool`, `envNoDecal` and `envNoFills`. Every claim above that is a
ratio was measured from a pair of captures one URL parameter apart, which is the only kind of
A/B the frozen clock can make byte-exact (#24).

Measured at 1920×1080, `?showcase=city&tod=21`: **60 fps, p95 16.8 ms, 235 draw calls,
19 056 triangles, 21 programs, 0 console errors.** 123 harness captures in
`docs/progress/environment/r3/` taken this round, every one at 60 fps and zero console errors;
two console warnings across the whole set, both emitted by `hunts` (`tiles.find` by name, #6)
and not this module's to fix. `node tools/seams/run.js`: 89 files, 15 modules, all contracts
hold.

---

### 34 — 2026-09-08 — The UI is one 2-D canvas at the renderer's own internal size, it costs zero draw calls, and input reaches the world only through `moveIntent`

Five things `src/ui/` settled. The shots are `docs/progress/ui/r1/`.

**(a) A DOM overlay at full resolution cannot be pixel art, so the UI is a canvas at the
scene's own resolution.** ARCHITECTURE §5.12 says "DOM overlay (not WebGL) at full
resolution", and the seed did exactly that: 12 px antialiased text in a `border-radius: 6px`
chip. Over a world rendered at 640×360 and upscaled ×3 with NEAREST (§2.7) that is the one
thing on screen not on the pixel grid, and it reads as a debug overlay rather than as the
game. `src/ui/screen.js` is instead a single 2-D canvas whose **backing store is
`ctx.three.view.internalSize`** — the renderer's own buffer, not a number recomputed from
`pixelScale` — stretched over the viewport with `image-rendering: pixelated`. The two
surfaces are then upscaled by the same factor including its rounding: at 1600×900 the
internal buffer is 533 px wide and the upscale is ×3.002, and the UI inherits that instead of
disagreeing with it (`08-boot.png` is 1600×900, `s-*.png` are 1920×1080).

It is still not WebGL, which is the part of §5.12 that was load-bearing: a 2-D canvas is
composited by the browser and never reaches `renderer.info.render.calls`. **The UI costs
0 draw calls, 0 triangles and 0 programs**, measured — `?showcase=ui` reports 234 draws at
noon and 235 at night with a full-frame shop open, with the menu open, and with nothing open
at all, all at the same camera preset. What it costs is a repaint: **0.58 ms for the whole
shop panel, 0.113 ms for the HUD alone** (timed in the page over 60 forced repaints), and it
only repaints when something marks it dirty, not per frame.

`internalSize` is `[0, 0]` until `src/main.js` sizes the renderer, which happens *after*
every module's `init` — so the size is re-read every frame (two array reads) rather than
once. The first version cached `0` as "already this size", left the canvas at the HTML
default of 300×150, and stretched it 6.4× over the window; it looked plausible in a
thumbnail, which is exactly why it survived until a pixel probe read the canvas back.

**(b) The font is authored here, as data, because there was nothing to load.** §9 allows CC0
and procedural assets only, and a web font would be a network fetch the harness counts as a
console error when it fails. `src/ui/font.js` is a hand-drawn variable-width 5×7 bitmap face
— 117 glyphs, every printable ASCII character plus `₽ ◈ ◆ ★ — × · … ° é É → ← ↑ ↓ ▸ ▾ ▴ ✓ ✗ ♥`,
which is what `economy`'s `formatCurrency`, `collection`'s toasts and the word *Pokémon*
actually need. It is baked once into an atlas and tinted per colour with `source-in`, so a
glyph is one `drawImage`.

Two failures here are invisible in review and both happened: a glyph that exists in the data
but is missing from the *atlas* draws as a blank of the correct width (the Mart's header read
`POK  MART` for a round), and a label cut with `max` alone slices mid-word (`Department Stor`).
The atlas is now built from `font.characters()` rather than a hand-listed string, `text()`
ellipsises instead of slicing, and `src/ui/selftest.js` — 36 checks, run by
`tools/seams/run.js` under Node with no DOM — asserts coverage, that every glyph is a
rectangle inside its 8-row cell, that capitals span row 0 to the baseline, that x-height
letters share a top row, and that `measure()` is the sum of the advances every panel lays
itself out against.

**(c) Input is the seam, and holding a key is re-issuing an intent, not a velocity.**
`simulation.moveIntent(dir, running)` queues **one** step, taken on the next fixed tick where
the queue is standing still (#27), so `src/ui/input.js` re-issues the held direction every
frame and calls `stop()` on release; the walker always finishes the tile it is on. Directions
are bound by physical `code` (arrows *and* WASD) so a non-QWERTY layout still walks, Shift is
run, and the held set is cleared on `blur` — a tab-out with a key down would otherwise leave
the walker jogging into a wall forever.

The thing that could not be guessed: **`city.enter()` leaves the player on a `wander`
autopilot.** A held key fights it for one step and the route resumes on release. So the first
real input calls `simulation.halt()` once, permanently. Measured with real key events against
the running page: from `(31, 36)` on `wander`, holding `→` for 80 frames walks the trainer to
`(34, 34)` facing east with the autopilot now `still`; release stops it *on* a cell; Shift+`W`
runs it to `(36, 33)` with `running: true`. With a panel open the same keypress moves the
walker zero cells and drives the menu cursor instead.

**(d) The lead is changed through `pokemon.setLead`, and `simulation` does the rest.**
`pokemon.setLead(i)` emits `party:leadChanged`; `simulation` already listens and rebuilds the
conga line and the sprite atlas (`src/simulation/index.js:452`), so the party panel makes one
call on `pokemon` and never touches the walker. Verified end to end by keyboard:
`[oshawott, snivy, tepig]` → `[tepig, oshawott, snivy]`, and `docs/progress/ui/r1/06-input-after.png`
is Tepig walking in the street with the party bar showing Tepig — the same frame proves the
input seam and the lead seam at once.

**(e) In someone else's showcase this module draws almost nothing, and the away card opens on
the *event*.** `src/main.js` boots `ui` for every `?showcase=…`, so anything drawn unprompted
lands in another builder's critic shots. Outside `?showcase=ui` and the game itself the module
draws the wallet, the clock and toasts and nothing else — and the wallet is drawn only when
`economy` is actually live, because four zeroes in a scene that never booted the ledger is a
claim about the player's money rather than a report of it (`07-city-minimal.png` is the city
showcase: clock only).

The while-you-were-away card is opened by `offline:applied` and **never** by
`offline.summary() != null`: in showcase mode `offline` runs read-only against a copy of the
save and still builds a summary (#15), so a card driven by the getter would cover every other
module's showcase. Checked on the plain `/` boot as well — a fresh profile is a first launch,
the event is absent from the harness's event log, and no card appears.

Toasts are frozen in showcase mode for the same reason `city` freezes its cast (#26d): a toast
that is 400 ms old in one capture and 900 ms in the next is a diff. `?showcase=ui&mode=shop`
twice with `&grain=0` is byte-identical.

Measured at 1920×1080, `?showcase=ui`: **60 fps, p95 16.7 ms, 234 draw calls (235 at night),
19 k triangles, 0 console errors**, panel open or closed.

---

### 35 — 2026-09-08 — An encounter is addressed by `(seed, index)`, `economy` owns the ball and never rolls it, and the throw is queued rather than jumped to

Seven things `src/encounter/` settled. Every one is either measured on screen in
`docs/progress/encounter/r1/` or asserted by `node src/encounter/selftest.js`, which the
seam suite discovers and runs (35 checks, no browser).

Four of those checks are **golden values** — species, level, shiny and all six IVs for
encounters 0, 1, 7 and 250 under seed 1337, plus the first draw of each of the four streams.
Comparing two live calls to each other, which is what the reproducibility check does, cannot
catch a reordered draw sequence: both calls reorder identically and both agree. Only
literals recorded from a known seed can, and the draw order is the one thing in this module
that must never move.

**(a) Nothing here continues a stream; every roll derives its own from the index it is
rolling.** `idle` resolves encounters *by index* while the tab is closed (DECISIONS #19) and
a live encounter has the same problem in a different shape — the player reloads, `offline`
applies a gap between two steps in the same patch of grass, a save is restored mid-hunt. So
`rolls.js` is four pure functions of `(seed, index)` with no `ctx`, no clock and no module
lookups, and the module's **entire persistent state is two integers**: how many cells of
tall grass the lead has walked, and how many encounters have been started.

The label convention is spelled out rather than derived, so the same code runs in Node:
`ctx.rng` is `makeRng(seed, 'root')` and `fork` appends `/label`, so
`ctx.rng.fork('encounter').fork('roll/7')` is exactly `makeRng(seed, 'root/encounter/roll/7')`,
which is what `streamFor(seed, 'roll', 7)` builds. Check 1 of the selftest asserts that
identity on three consecutive draws rather than trusting the comment.

**The draw order inside a roll is part of the contract** — species, level, shiny, then six
IVs, always, whether or not the caller looks at all of them. A new roll goes on the end.
Measured: encounter #250 rolled alone is identical to #250 rolled after its 250
predecessors; 500 encounters roll identically twice; 64 consecutive indices give 64 distinct
encounters; the shiny rate over 400 000 indices comes out at 1/4255 against a declared
1/4096.

**(b) `tablesFor()` returns a weight-expanded `string[]`, because three modules already
index it directly.** `idle/accrual.js` does `tables[floor(rng.next() * tables.length)]`,
`offline/index.js` carries the array into idle's state and `automation/index.js` synthesises
a caught Pokemon from it. Returning `{species, weight}` objects would have given all three a
species called `[object Object]` with nothing anywhere able to notice. So a row of weight 20
occupies twenty of the 120 slots and a *uniform* pick from the array **is** the weighted
pick — §5.6's "weighted species table" honoured literally, and those three modules get the
right distribution without knowing anything changed. Measured on the live page: 120 slots,
all strings, 19 distinct rows, structured-clone safe, and `idle` reads 120 of them. The rows
are still reachable as a **non-enumerable** `.rows` property, so the bus and the save carry
the plain array and nothing else.

**(c) Capture rates are the real mainline numbers, authored per row.** The whole point of
`economy`'s eighteen balls is that a Caterpie (255) and a Gible (45) are different problems,
and a BST proxy flattens exactly the distinction the shop is selling. All 126 rows across
five biomes carry their mainline rate; `rolls.catchRateFor(bst)` is kept only for species no
table lists, and it is **character-for-character the curve `automation/fields.js` declared
first**. That is a mirror in the same sense `economy/pacing.js` mirrors `idle/accrual.js`,
and it wants a seam test the way rule 5 already asserts that one — filed in `coreRequests`.

**(d) `economy` owns the ball and deliberately does not roll it, so this module rolls it.**
`economy.throwBall()` spends the ball out of the bag and reports the odds; `economy/items.js`
says in as many words that a module which both spent the ball and decided the outcome would
make a catch depend on shop state. So the eighteen-ball line, the Gen 3/4 formula and every
conditional (Dusk 3x at night or in a cave, Quick 5x on turn one, Level 8x/4x/2x, Nest by
level, Heavy by weight) are **asked for, never re-derived**. What this module supplies is
the half `economy` cannot know: the species' capture rate, the HP left after the resolved
battle, and the coin. `docs/progress/encounter/r1/balls.png` is that seam on screen — all
eighteen priced against one level-6 Eevee, Master ∞, Quick x5, Nest x3.5, Ultra x2, Great
x1.5 and every other conditional at x1 because none of its conditions hold.

**This module is the only thing that pays for a live encounter.** `economy` mints BP on
`encounter:resolved` and shards on `catch:succeeded`, and it explicitly refuses to credit
`rewards.money` because `idle` banks its own accrual through `add()` and paying both would
pay for the same battle twice. `idle`'s encounters never reach `resolve()`, so
`economy.add('money', n, 'battle')` here is the one payment and not a second one.

**(e) `catch:failed` is not in ARCHITECTURE §4 and is emitted anyway.** A failed catch is
half of what this module does, `ui` and `automation` both want it, and adding an event is a
core change — so it ships now, with nothing subscribed, and the table catching up is filed
in `coreRequests`. `catch:succeeded` also carries the `ivs` this module rolled:
`collection` prefers a payload's IVs and rolls its own from its own stream when they are
absent, and a Pokemon whose stats depended on which module looked at it first would be the
kind of bug nobody ever finds.

**(f) A throw is queued at the earliest step the animation can honour it, never jumped to.**
`automation` subscribes to `encounter:started` and calls `attempt()` **synchronously from
inside this module's own emit**, so `active` is set *before* the bus sees the event (or the
automation's throw finds nothing to throw at) and the outcome — decided and on the bus
immediately — then plays out from step 22 rather than skipping the reveal. `attempt()`
returns a **boolean** for the same reason: `automation` does `const ok = encounter.attempt(…)`
and reports `ok ? 'caught' : 'missed'`, so anything object-shaped would read as a catch every
single time. The detail goes on `last()`.

**One ball ends the encounter, and that is a limit rather than a rule of the game.**
`attempt()` resolves unconditionally, so `active` is null after the first throw and `turn`
can only ever be 1. The consequence is visible in the ball table: the Timer Ball is
permanently x1.30 and the Quick Ball permanently x5, and the per-turn `catch/<index>/<turn>`
streams are exercised for turn 1 only. That is right for an *idle* game, where the whole
encounter is meant to be over in a beat, and wrong for a mainline one — a second throw is a
change to `resolve()`, not to the rolls, which already take a turn number.

**(g) Passive encounters are armed at `/` and in this module's own showcase, and nowhere
else.** `city` scatters two patches of tall grass and `simulation` plants two more, and a
wild Pokemon rearing up in the middle of another module's hero frame would be this module
vandalising somebody else's evidence — non-reproducibly, because how many sim steps have run
when the shutter opens is wall-clock luck. Same reasoning as DECISIONS #15's "?showcase=… is
read-only".

At `/` it is live, and driving it there is what found the one bug a screenshot could never
have shown. The lobby carries **76 cells of tall grass**; walking the party through them
produced one encounter (Trubbish Lv7, index 0) after six grass steps — and then nothing for
another 894 sim steps, because **nothing in the game throws a ball**. `automation` is off by
default (§5.11) and `ui` has no throw bound yet, so `throwAt` stayed `Infinity`, the wild
stood in the grass forever and `active` never cleared: the first Pokemon a player ever met
was also the last one they would ever meet.

The fix is the thing §5.6 already asks for — **battles are resolved, not turn-by-turn**.
`begin()` has already run the exchange against the lead's level, so after a beat
(`T.LEAVE`, 1.3 s) an unattended encounter pays out *that* battle and the wild leaves. Same
walk after the fix: two encounters, both resolved as wins, ₽33 credited, both recorded as
seen by `collection`, **no ball spent and nothing added to the dex** — because auto-catch is
`automation`'s to unlock and none of its rules are on by default. Walking through grass
earns; catching still costs a ball and still needs somebody to decide to throw one, and
`encounter.attempt(ballId)` is the public call `ui` binds when it has a button for it.

**Three things the pictures settled that reasoning did not.**

  - **The ball does not spin.** A thrown ball rotating freely is what the mainline animates
    and it is wrong at 12 texels drawn at two internal pixels each: the shutter caught it at
    90 degrees and it read as a black lump with a blue corner. Every other sprite in this
    game is axis-aligned for the same reason (DECISIONS #18). The wobble is a **two-texel
    nudge**, not a tilt, for the same reason again.
  - **The ball's contact shadow belongs on the ground, not at the ball's own height.** The
    first cut passed the throw's origin height as the ground and the blob drew as a grey
    ellipse wrapped round the ball; the two together were one unrecognisable object. It is
    also why the arc is flat (`0.45 + 0.14·span`, not `0.9 + 0.35·span`) — a three-unit apex
    on a four-tile throw leaves the ball floating in empty grass with nothing to read it
    against.
  - **A shiny announces itself with a ring of sparkles, and that is not decoration.** A
    shiny Azurill is *green* in green grass and a shiny Murkrow is dark on dark; without the
    ring the rarest thing in the game was an unreadable smudge. The burst sparks are drawn
    **brighter than white** (`color.setRGB(2.6, 2.45, 1.9)` with `toneMapped: false`) so they
    clear `config.bloomThreshold` and the composite lifts them off the lawn — at a flat 1.0
    they blended to the same pale lilac as the grass behind them.

**The showcase freezes both timelines and the shot is bit-reproducible.** `simulation`'s
walk *and* this module's own animation, because the harness spins ninety frames between
`__READY__` and the shutter and `registry.tick` runs the whole time. Two captures of
`?showcase=encounter&mode=caught&tod=12` differ by **zero pixels on every channel**, with
grain on as well as off. Freeze points are named by **stage**, not by step number: the shake
window is `shakes × 14` steps and `shakes` comes out of the catch roll, so the click is step
88 for a three-wobble catch and step 46 for a nought-wobble miss — hardcoding 78 froze
`mode=caught` on the third wobble instead.

Measured at 1920x1080, `?showcase=encounter&mode=throw`: **60 fps, 50 draw calls, 16 k
triangles, 17 programs, 0 console errors**. The whole capture set costs **four draw calls at
its peak and none at rest** — counted off the harness's own numbers rather than off the
source: the same scene measures **48** with no encounter on screen, **50** with the ball in
the air (ball + its contact shadow) and **52** on the click frame (+ the sparkle instancer,
and the wild's sprite mesh leaving the field is what keeps it from being 53).

---

### 36 — 2026-09-08 — Four biomes are four *compositions*; the tree that closes a canopy is the short one; a staircase in a band paints a stripe of the wrong material down its middle

`src/hunts/` replaced a 142-line seed that had never been looked at. Every finding below was
measured or shot before it was acted on; the shots are `docs/progress/hunts/r1/`.

**(a) A biome is region algebra, not a threshold.** `compose.js` is a `Field` — a boolean
cell grid with `grow`/`shrink`/`union`/`subtract`/`ragged`/`despeckle`/`closeCorners` — and
each map is written as "the clearing, grown two cells, minus the path". The two operations
that carry the look are `ragged` (frays only the boundary band, so a patch stays one patch
instead of dissolving into confetti) and the *interpolated* value noise underneath it: per-cell
`noise2` gives neighbours unrelated values and the eye finds the grid instantly, which is the
same failure `tiles` measured on its ground tint (#30e). The selftest pins it — the worst
cell-to-cell step of `valueNoise` over a 60x60 block is **0.1725**.

**(b) The tree that closes a canopy is the *short* one, and that is measurable.** All three
2x2 AdAstra trees have the same footprint, so the first cut weighted `tree` (id 202) heaviest
and the wood came out as a field of lollipops with the ground and the root decals of the row
behind showing between them. `tree` and `darker_pine` are 4.5 tall and their upright card is a
narrow conifer *spire*; `round_tree` is 3.5 and its card is a full round crown. Packed at 1.85
cells with `claim: false` the round crowns overlap into a mass and the spires punctuate it, so
`trees2` is sorted by `bounds.max[1]` ascending and `tiles.pick` is given `baseWeight 6`. A/B
on the same URL: `docs/progress/hunts/r1/forest-12.png` against the round-2 frame that started
this. DECISIONS #29's "this map plants no tree at all" was the right call for an isolated tree
in a meadow and the wrong one for a wood; the meadow here still plants trees only in a copse
on the far northern edge, where they close the top of the frame and no single crown is read.

**(c) A staircase inside an auto-tiled band paints a stripe of the wrong material down the
middle of it.** A trail that drifts one cell every few rows is a staircase, and at each step
the cell on the inside has all four edge neighbours filled and one diagonal empty — the
palette's `inner_nw` case, whose slot carries a wedge of *grass*. A run of them is a dashed
green zigzag straight down a dirt track, and it is not a hole in the field: the field was
dumped and is a contiguous 3-to-5-cell band at every row. `Field.closeCorners()` fills those
single-cell notches in one pass over a snapshot and every one of them goes. It is applied to
paths and tracks and deliberately **not** to water: filling a pond's diagonal notches squares
it into a swimming pool, and the water palettes ship all four inner-corner slots anyway.

**(d) Three AdAstra "1x1" path tiles are not 1x1, and one of them is four cells.** The first
forest laid a 3-cell trail and rendered a track six cells wide with its auto-tiled edge
stranded in the middle of it. Measured out of `pack.json`: `sterr_patch` is catalogued `w:1,
h:1` and its geometry runs `0..2` on both axes — a 2x2 bald patch — and `rot_dirtpatch` reaches
to `x = -0.49`. A scatter that trusts `w`/`h` therefore paints over its neighbours. `snug()` in
`compose.js` checks a model's own bounds against the cells it claims and every biome filters
its scatter pools through it. The same pass drops the `michi03b` family from the scuff pool:
they are `set2`'s centre, a 4-bit indexed PNG with an all-green palette (#30), so one dropped
on a dirt track is a green tile in the middle of it.

**(e) The cave's palette fills the *floor*, and the pool has to be cut out from under itself.**
`bw2-cave`'s `set0` has its centre (`cave_ground_center`) at y 0 and its border slots spanning
y 0..1, so the filled region is the walkable floor and everything outside it is a metre of
rock rising around it. `set3 cave_dark_border` is flat at y 1 — the top of that rock seen from
above — and goes down *first*, so the floor's own wall tiles draw over it. A second floor drawn
with `solvePlacements(..., { y0: 1 })` is the terrace, and that is what gives the frame the
banks-behind-banks depth `docs/refs/04-cave-golden-hour.png` is almost entirely made of.

The pool repeats the city's pond lesson in a new place: `set4`'s water sheet sits at −0.25 and
the floor quad at 0, so drawing both leaves a pond that is in the placement list, costs draw
calls and is **invisible**. `palette.draw` gained a `skip(cx, cz, case)` hook and the floor is
drawn as "every case except `center` where the pool is", which keeps the room's own border and
loses the sheet under the water. Shot before and after: `docs/progress/hunts/r1/cave-pool.png`.

**(f) A cave is lit by *placed* lights, and a preset cannot do it.** `environment`'s own cave
preset says the key is "a warm shaft, the fill almost nothing", and raising ambient instead
gives a lit room — the first cave was one even wash of orange at every hour. `environment`
exposes `lamps.add({x, z, y, color, intensity, radius, size})` and the cave places **seven**: a
cold daylight shaft at the mouth, a second cool bounce inside it, and warm and cyan glows to
walk towards. `size` is the *glow quad*, and at the default it is a floating orb with no lamp
under it, which reads as a bug — the two daylight lights and the one over the pool run
`size: 0.02` (light and ground pool, no visible bulb) and the four crystals keep a small one. The preset runs `lamps: 1.0` at every hour, so the cave is lit identically at noon
and at midnight, which is correct: nothing down there knows what time it is. `hunts.enter`
clears the lamp list before adding, so re-entering cannot stack them.

**(g) `set7` is the shallows and `sea` is the deep — and the whole sea spent a round buried
under a pond, in the module that wrote #28a down.** Measured: `walk_edge`/`walkable_water_center`
is a sheet at −0.65 tagged `wadeable` with a surf border, while `sea` is two quads — a
translucent surface authored **+0.3125 above its placement** over an opaque bed at −0.5. Using
the shallows for open sea is an ocean of ankle-deep sand-coloured water, so the coast is three
regions: `set1`'s sand bank at the coastline, `set7` for the wet band, and `sea` at
**y = −0.9625** beyond it, so its two planes land at −0.65 and −1.4625 and its surface is flush
with the shallows sheet.

The first cut drew all three and rendered **none of them**. `set1` is a blob palette, so
drawing it over the water body resolves every interior cell to its *centre* case —
`lake_water_center`, an opaque `ike01` quad at **−0.5** — and −0.5 is above both the shallows
sheet and the sea's surface. Every wave, every foam tile and the whole two-plane deep water was
in the placement list, cost draw calls, and was under a pond. It reproduces the DECISIONS #28a
failure exactly, one module later, and the reason it survived a whole screenshot round is the
reason #28b gives: the console is clean, the draw counts are healthy and nothing is missing.
Traced out of `solvePlacements` on a 9x9 all-water block rather than argued about:
`set1` centre → `lake_water_center@−0.5`, `set7` centre and underlay → `walkable_water_center@−0.65`.

The fix uses the same `skip` hook (e) needed: `set1` keeps its bank ring and loses its centre,
and `set7` keeps its surf ring and its sheet in the band but loses both under `deep`, so the
sea's own bed is what floors the deep water. Before and after, same URL:
`docs/progress/hunts/r1/ab-coast-pond-buried.png` against `coast-sea.png` — a flat sheet of one
blue becomes a dark rippling deep, a pale wet band and a surf line at the sand.

There is no `sea_border_*` model in AdAstra; `sea_cliff` (`set8`) exists but is missing all four
inner-corner slots, so a coastline drawn with it has to be convex-only and this one is not.

**(h) Camera framings teleport the party, and markers are snapped onto walkable ground.**
`simulation` re-centres the rig on the trainer every frame, so a preset that only moves the rig
is undone before the shutter (#28j). `hunts.preset()` teleports instead — and under
`config.timeFrozen`, which only the harness sets, it then walks the queue seven fixed steps and
freezes it, so the line is strung out and caught mid-stride rather than parked on cell centres.
Markers go through `walkableNear()`: the first `pool` framing put the party on rock and the
queue collapsed onto one cell, which looks exactly like a rendering bug and is a map bug.
`selftest.js` asserts every preset of every biome has a marker, that the marker is inside the
map, that the spawn is passable, and that a flood fill from the spawn reaches more than 150
cells — a walled-in spawn is the one failure that screenshots perfectly and is unplayable.

**Two things are deliberately not used, and both were shot first.** `estalactita` hangs from
y 3.26 to 8.24 and expects a ceiling; this cave has none, because a fixed 45-degree camera
looking down at a floor cannot have one. Placed anyway it floats, and every face on it points
down, so after `tiles` clamps normals to the horizon it takes no key at all and renders as a
black triangle standing on the wall. And `props/hgss-overworld__{rock,water_rock}` — the two
DECISIONS #23 already names as the weakest of the fifteen — read as woven baskets on a beach,
so the coast and the wood use the `sylvan-town` and `bw2-twist` rocks instead. `hunts.stats()`
reports `stalactitesAvailable` so the omission is visible rather than silent.

**The same URL gives the same pixels, and this time that is measured rather than promised.**
`?showcase=hunts&mode=forest&tod=12` shot twice, one file apart, diffs to a **maximum channel
delta of 0 across all 1 440 000 pixels** — byte-identical, with grain on. The city's own check
(#26d) left a 6/255 residual it traced to the grain's wall-clock phase; nothing here reproduces
that, so either the forest's exposure keeps the grain under a quantisation step or the phase is
stable at this hour. `repeat-forest-12.png` is kept beside `forest-12.png` as the pair.

The staging is what had to be deterministic for that to hold: `preset()` teleports the party,
advances **7** fixed sim steps and freezes, and the showcase's own entry advances a per-biome
count (14–23) before freezing. Both are pure functions of the step count, never of wall time.

Measured across **30 shots** at 1600x900 and one at 1920x1080: **60 fps, p95 16.7–16.8 ms,
75–126 draw calls, 10–25 k triangles, 14–18 programs, 0 console errors and 0 console warnings**
in every one. `node src/hunts/selftest.js` 200/200 and `node tools/seams/run.js` passes.

---

### 37 — 2026-09-08 — The forest's night was the forest's own canopy, the cave's pale card is bloom and not a point light, and a threshold on a smooth lattice is a rectangle no amount of `ragged` will fix

Round 2 of `hunts`. Three of the critic's ranked faults turned out to be misattributed —
two *towards* this module and one *away* from it — and each was settled with an A/B at one
URL rather than an argument. The harness freezes the clock and disables the cache, so two
captures of one URL differ by zero pixels (verified again this round: `forest-21.png` vs
`repeat-forest-21.png`, max channel delta 0 over 1,440,000 pixels), which is what makes a
one-variable swap a measurement.

**a. The black forest night is `hunts`, not `environment`'s exposure ramp.** The critic
filed it as shared. Same harness, same hour, same tileset, same `bw2-adastra` grass:

| shot | mean | p50 | % luma < 8 |
| --- | --- | --- | --- |
| `docs/refs/03-forest-voxel-night.png` | 45.2 | 33.2 | 10.5 |
| meadow, tod 21 | 31.2 | 31.4 | **11.9** |
| coast, tod 21 | 33.0 | 34.2 | **12.4** |
| forest, tod 21 (round 1) | 11.0 | 1.8 | **68.6** |
| forest map under the *meadow* env preset, tod 21 | 17.9 | 2.0 | 58.4 |

An open biome under that exposure ramp lands within 1.4 points of the reference night. So
the ramp is not the fault: ~10 points of the forest's 68.6 are `environment`'s forest preset
(`hemi ×0.78`, `fogDensity ×1.75`, `vignette +0.08` — filed as a coreRequest), and the other
**~46 points are the canopy this module plants**. Round 2 takes it to **51.9 %** at the
default framing and **39.4 %** (p50 18.8) at the `route` framing the blind gate actually
shoots. A second control says where the rest is: `?envNoShadow=1` — the sun/moon shadow map
off, nothing else changed — moves the same frame from 51.4 % to **36.3 %** and doubles p50,
so about fifteen points of what is left is the depth of the moon shadow at night, and only
1.2 points is `castShadows`.

**b. The pale card under a party member in the cave is `cave_exit`, and the party was staged
standing inside it.** Round 1 shipped a comment blaming a `PointLight` lighting the sprite
billboard's transparent margin, and called its own mitigation "a mitigation, not a fix". Six
A/Bs, each one variable, each at one URL:

1. `lights = []`, every placed bulb gone — ROI luma **84.0** on a floor of 44.6, against
   87.2/51.7 with all seven bulbs. Unchanged. Not the point lights.
2. plus `?envNoCast=1` — **84.0**. Not the planar sprite shadows either.
3. mud patches removed — byte-identical ROI. Not a floor decal.
4. `pokemon/field.js` builds the sprite material with `alphaTest: 0.5, transparent: false`,
   so the transparent margin is *discarded*. There is nothing there for a light to hit.
5. **Bloom, tested directly and ruled out.** `render.js:syncUniforms` reads
   `config.bloomStrength` every frame, so `__HOOKS__.setConfig({ bloomStrength: 0 })` on the
   running page is a live knob. At 0 and at 6 the frame changes by at most 1 luma over ~400
   pixels and the ROI does not move at all; the same knob at `saturation: 0.2` changes
   1,415,610 pixels by up to 100, so the path works and bloom is simply not in this frame.
   An earlier draft of this entry claimed bloom on circumstantial hue evidence and was
   **wrong**; it is corrected here rather than left standing.
6. The one that found it: teleport the party two cells north with `--preset "26,34"`. The
   pale card **does not follow them** — it stays on its map cell and the party walks off it.
   It was never sprite-attached. It is `cave_exit`, the lit mouth, whose 2x3 footprint at
   `MOUTH − 1, MOUTH[1] − 6` covered cells (26..27, 36..38) — and the `chamber` marker is
   (26, 38) and the `terrace` marker was (26, 36), both *inside* it. Removing that single
   placement and nothing else takes the ROI from **1.69x** its surroundings to **0.93x**:
   from brighter than the floor to darker than it.

The fix is one line of map authoring — the exit moves to `MOUTH − 6, MOUTH[1] − 3` on the
entrance chamber's west wall, where it still frames for the `mouth` preset, and the terrace
marker moves to (20, 33) over the terrace it is named after. This was a `hunts` bug the whole
time, and round 1 spent its cave lighting budget paying for a diagnosis that was wrong twice
over. The lesson is the cheap experiment: *move the subject*. Two shots at two literal camera
positions separated an artefact attached to a sprite from an artefact attached to a cell, and
no amount of reasoning about materials had done it.

**c. The cave's one-hue wash is the environment preset, not the light placement.** Same map,
same seven bulbs, same albedo tints, only `CAVE.preset` swapped `cave` → `interior`: mean
saturation **0.963 → 0.441**, luminance sd **25.1 → 38.3** (`docs/refs/02` is 0.194/53.7).
Grading the floor albedo by distance-to-bulb — everything this module can reach — moved
saturation by 0.003. The warm fog (`0x4a2f18` at density 0.040, boost 1.35) plus
`saturation 1.30` is 170× the lever the albedo is. Filed as a coreRequest. The grading stays
because it is what gives the room falloff, and the pool keeps its cold tint and a visible
bulb *in* the water, which is the one cold thing in the frame.

**d. A threshold on a smooth lattice has straight level sets, and `ragged` can only move a
boundary by one cell.** The tall-grass masses shipped as literal rectangles. Dumping the
*field* rather than the screenshot showed why: the meadow's patch occupied cells 2..17 ×
39..55 — a 15×16 block whose right edge wobbled by exactly one cell — because `fbm2` at
period 7 has long axis-aligned level sets and `ragged` only flips cells that are already on
the boundary. One cell at 35 screen pixels is not a shape. The fix is `warpedFbm`: sample the
noise at a position displaced up to three cells by an independent noise, so the level set
*bends* coherently instead of dissolving; drop the lattice from 7 to 5 so a mass is a patch;
then `Field.fringe` scatters outliers one or two cells past the boundary so the mass ends in
speckle rather than in a line. Used in meadow, coast and forest.

**e. The floor tint is a ramp off the canopy field, not a switch, and it carries a dither.**
Round 1 tinted every wood cell `0x93a48c` and every clearing cell white. On bare clearing
floor (rows y 640–680, x 120–460, averaged to kill texture noise) adjacent columns stepped
**31.9 luma on a local mean of 76.6 — 41.6 %**. The same band after: **4.13 luma, 3.7 %**,
which is the critic's own no-hunts control (`ctl-terrain-12`, 4.4 luma / 3.5 %) to within
noise. Two things do it: the shade is `mixTint(clearing, floor, canopyAt(cx,cz))` over a
~4-cell ramp instead of a boolean, and `mixTint` adds ±5/255 of per-cell noise so the
quantised bands have no contour. `canopyAt` also drives the tree spacing, so the floor
darkens *because* the crowns close over it rather than in parallel with it.

**f. One Poisson radius is a plantation; the radius has to be a field.** `scatterSpaced` now
takes `spacing` as a function of the cell and rejects a pair on the larger of the two radii,
so a sparse cell cannot be crowded by a dense one. The forest reads it off `canopyAt`: 1.75
cells where the canopy closes, opening to 3.1 towards a clearing, modulated by a period-9
grove field so the wood is clumps of two to five crowns with glades between them. Two further
rules came out of measurement rather than taste. Conifers are chosen from a low-frequency
field so the blue-teal spires stand in *stands* instead of interleaving with the green domes
one crown at a time. And the trees that stand inside an opening go in clumps of two or three
in its **far half only** — a clump in the near half throws its shadow across the one part of
the frame that has light in it, and moving them was worth 7.7 points of night crush at a
similar tree count (59.7 % → 52.0 %; the spacing and the distance band moved too, so this is
not a single-variable number).

**g. Small things that were one line each.** `tools/judge/plan.json` shoots
`preset: 'route'` for forest-day, forest-night and cave and no biome defined one, so all
three blind-A/B pairs were falling back to the default framing with `presetApplied: false`;
every biome now has a `route`. The meadow's bridge is **three** `bridge_v2` side by side, not
one — a 1-cell deck on a 3-cell track necked the road to a third and back. The fence run
reaches the map edge and its gap is flanked by `fence_cross` gate posts, so it stops ending
in mid-air; at 6× it is a real post-and-rail fence with visible posts, rail and gaps, and
what makes it read as a curb at 1× is scale plus the unlit vertical faces `tiles` already has
filed. `sylvan-town__rock_tall` and `__rock_small` join `hgss-overworld__*` on the excluded
list — STATUS already had them as woven baskets — and the surviving boulder is clustered on
the headland instead of strewn over open grass. The coast's headland gets a different sigma
each side, because a symmetric Gaussian quantised onto a grid is a symmetric zigzag pyramid.
And the land field is despeckled and inverted back into the water field, which drowns the
one- and two-cell grass islands that were floating in the open sea.

Measured across **23 shots** at 1600×900 and one at 1920×1080: **60 fps, 83–129 draw calls,
10–24 k triangles, 0 console errors and 0 console warnings** in every one.
`node src/hunts/selftest.js` 224/224 and `node tools/seams/run.js` passes. The selftest
earned its keep this round: adding noise to `shoreAt` pushed the coast's `dunes` marker to
cz 46 of 54, inside the nine cells the framing arithmetic needs clear of the south edge, and
the assertion caught it before a screenshot did.

---

### 38 — 2026-09-08 — The panel was authored for one buffer size, the HUD was authored for one time of day, and a list drawn on paper has no shadow end

`ui` round 2. The shots are `docs/progress/ui/r2/`, 33 of them across three window sizes.

**(a) A panel may not carry an authored pixel size, because the buffer is not one size.**
`screen.js` takes its backing store from `ctx.three.view.internalSize` (#34a), so the UI grid
is **533×299** at 1600×900 and **426×239** at 1280×720, not the 640×360 of 1080p. Round 1's
five panels each hard-coded the numbers that fit 640×360 — `dex.js` `w: 560, h: 288`,
`shop.js` `w: 540, h: 278` — and `windowFrame` centres what it is given, so at 533 px the dex
window started at internal **x = −14** and the first character of nine labels was off the left
edge (`POKéDEX` → `OKéDEX`, `Seen` → `een`). At 426 every panel was destroyed. All 22 of the
round-1 panel shots were 1920×1080: the one size where the numbers happen to fit.

The fix is two functions in `panels/common.js` and a rule. `margin(g)` is a fraction of the
buffer rather than a constant 10; `fit(g, w, h)` clamps an authored size to it and every
panel now passes `...fit(g, …)`; `windowFrame` clamps again so a panel that forgets still
cannot draw itself off screen. Then **every internal column is a fraction of `win.w`, never a
constant**: the dex's summary column, the shop's `leftW`/`detailW`, the box grid's cell (which
is solved on *both* axes — six columns of 34 plus a detail pane is wider than a 720p window,
and five rows of 34 is taller than its body), the party's card pitch. Two lists change shape
rather than truncate: the dex entries go 3 columns → 2 below 122 px of column, and the party
card drops its type line below 30 px of height. The box detail pane draws against a **height
budget** — facts first, then the six individual values, stopping at the line the buttons start
on — because at 720p it is 163 px tall and round 1's fixed layout needed 200.

Also latent and now fixed: `hud.drawIcon` computed `y + size - dh` with no clamp, so a species
whose sheet is 64 px per frame drew its sprite 32 px *above* its own cell.

**(b) The HUD is lit by the same sky the city is, and the lamp ramp is emissive.**
Measured in round 1, the wallet's paper was luma **233.6 at noon, 233.6 at 17:30, 233.6 at
21:00** while the plaza under it went 133.9 → 0.2. `theme.js` now keeps the palette as *base*
colours and `applyLight(tod)` writes the lit version back into `C`, `CURRENCY_COLOUR` and
`TOAST_COLOUR` in place, so every `C.x` read at paint time picks it up with no plumbing.
The cast comes from `sin(π(tod−6)/12)` — a solar-elevation proxy, a pure function of `tod`, so
the same URL still gives the same pixels. Measured after: **233.5 at noon, 224.2 at 08:00
(warm), 209.5 at 17:30 (warm), 152.1 at 21:00 (cool, RGB 146/151/174)**.

The night factor is **0.65 of luma and not lower, and that is the interesting constraint**.
Matching the ground would need ≈0.36, and scaling paper *and* ink by 0.36 takes ink-on-paper
from 13:1 to **2.4:1** — the panel would be correctly lit and unreadable, because WCAG's 0.05
flare term stops being negligible once both sides are small. At 0.65 the same pair measures
6.1:1.

The same arithmetic is why two groups are **exempt**. `glowDeep/glowBase/glowLight/glowHi/
bandMid` are lamplight, not paint, and a lamp does not dim because the sun set: dimming them
would have dropped the away card's efficiency labels from 5.3:1 to 2.5:1 at night, and
undimmed they read as *lit*, which is what the ramp is for. The deep recess (d) is exempt for
the same reason with a different fiction — a dex list and a PC box are **displays inside the
device the player is holding**, and a display does not go dim either. That one was found by
measuring rather than by taste: dimmed with everything else, `deepDim` on `deepBase` falls
from 5.4:1 at noon to **2.8:1 at 21:00**, so the box counts and the unseen dex rows stop being
readable at exactly the hour an idle player is most likely to be looking at them. Exempt, the
panel frame takes the sky and the list inside it stays a lit screen — which is also what it
looks like.

The tinted glyph atlases `screen.js` caches are keyed by colour string, so `applyLight`
quantises to the quarter hour and returns `true` when the palette moved; `index.js` calls
`screen.clearTints()` on that. Without it a simulated day would leave 96 generations of dead
atlases in memory.

**(c) Two always-on elements were pinned to overlapping rectangles.** The menu opened at a
hard-coded `y = 22` in the top-right corner — the clock's corner — so it sliced the clock's
phase line in half every single time it opened, at every resolution and every time of day. It
now anchors to the **MENU button that opened it**: bottom-right, above the button strip
(`app.stripBox()`), floored at the clock's own bottom (`app.clockBox()`). The toast stack steps
left while it is open, because they share that corner.

Its rows also had **zero leading** — label at `r.y + 2`, blurb at `r.y + 9`, and a capital
occupies rows 0..6 of its cell, so the blurb's ascenders began one row under the label's
baseline and the descenders of "the last away card" tucked into the bowl of the O: REPORT read
as *REPQRT*. Row pitch 17 → 21, blurb at `r.y + 12`, three clear rows; and the selected row's
blurb is white rather than light-blue-on-medium-blue.

**(d) A DS list sits in a dark recess, not on paper.** Measured, the round-1 window interiors
were luminance μ 154–164 with **no pixel below 62** — the whole shadow end of the range was
absent, and a full-screen panel turned the screen into a beige spreadsheet. `C` gains a deep
ramp (`deepDeep…deepFaint`) and `well`/`row`/`list` take a `dark` flag that hands back the
right ink, so a panel opts in completely or not at all. The dex's ENTRIES, the box tray and its
box list, the shop's shelf and the party's card tray are dark; the summary, detail and shop
cards stay on paper. Same box, round 1 → round 2, one method: dex luminance μ **166.4 → 81.6**,
shop **163.2 → 109.4** with saturation p50 **72.9 → 108.5**, boxes **155.6 → 97.2** and
p5 **31.5 → 28.3**.

The header-colour rule that was missing is written into `section()`: **the window's title bar
carries the module's colour and every section bar inside it is stone.** Round 1 had blue, blue,
grey and red bars in one window with nothing explaining which was which.

**(e) A shape channel, because colour alone is not one.** The toast rails were 1.3 luma apart
between `good` and `info` — the same grey bar to a deuteranope. They are now a value ramp
(CIE L\* 82.9 / 61.5 / 46.8 / 35.6 / 24.3, no two closer than 11) **and** each kind carries a
mark (✓ ! ✗ ▾ ·) on its own ink chip, which is the channel that survives any colour vision.
The away card's bands are the same idea: a flat five-step ramp with the ink chosen against the
band rather than fixed, plus a rule at the band's own height. Round 1 measured 1.41:1 and
2.47:1 on the three bands that tell the player how much idle time was wasted; measured now,
worst case **5.28:1 at tod 8 and 5.86:1 at tod 21**.

**(f) The zero was slashed and the specimen did not do what it claimed.** A slashed zero is a
terminal face's answer to O-versus-0 and no Pokémon UI has used one — `₽598,099` read as
598,O-slash-99. It is a plain oval now and still 5 px wide, so a wallet number does not change
width as it counts up. The star was a four-row widening wedge that read as a sparkle; it is
five-pointed and sits on the baseline. The specimen itself lacked `full: true`, so it drew
*over* the live HUD, and its "at 3x" label sat above three 1× strings drawn with a one-pixel
stagger. It now stands the HUD down and fills each glyph cell by cell out of `font.js`'s own
rows at 3×, with the cell grid and the baseline drawn under it — which is also what makes the
one font fault this round did **not** fix visible rather than arguable: descenders are one row
deep (`HEIGHT` 8, `BASELINE` 6) and lowercase sits on a shelf. `HEIGHT` 9 reflows every 8- and
9-pixel line step in the module and was not worth the regression this round.

**(g) The one thing the critic was wrong about, with the control.** Issue 15(a) said the shiny
star markers in the box grid "straddle the cell border… the stars at (562,398) and (768,703)
sit half in the row above". Probed on the critic's own `18-boxes-1080p.png`: the star ink spans
y **390–401** and **696–707**, and the cell interior at a column 14 px to the left of each star
(clear of it) runs **387–419** and **693–752**. Both stars are entirely inside their own cell,
1 output pixel below its top border. The pixel the critic quotes, (562, 398), is `#9A8A6E` —
cell paper, not star. What is true is that a bare 5×5 glyph tight against a border reads as
belonging to the row above, so the star now sits on its own 7×7 ink chip and the ambiguity is
gone. Filed as fixed, not as agreed.

**(h) Determinism, measured, and where it is not this module's.** `?showcase=ui&mode=boxes`
and `&mode=dex` at `tod 21`, shot twice **after the last edit to `theme.js`**: max channel
delta **0 across all 1 440 000 pixels**, byte-identical, with the light model on the paint
path. `&mode=shop` differs in exactly
**504 pixels in one 50×20 box** — the money digits — because `idle` accrues through the settle
window under `timeFrozen` (the critic's own issue 17a, attributed to `idle`). Everything else
in that frame is identical too.

Across **33 shots** at 1280×720, 1600×900 and 1920×1080: **60 fps, p95 16.8 ms, 234–235 draw
calls (the city control is 235: the UI still costs zero), 19 k triangles, 21 programs, 0
console errors and 0 console warnings**. `node src/ui/selftest.js` and `node tools/seams/run.js`
both pass.

---

### 39 — 2026-09-08 — Half the ball was one table row; the crushed shadow is the rig's, not the scene's; and a "+7 % red" tint that is not clamped paints the field navy

Round 2 of `src/encounter/`, against a critic's ranked list of fifteen. Three of the fifteen
were misattributed and are proved so below with A/Bs at one URL; the rest are fixed or
improved and every number here is measured off a PNG in `docs/progress/encounter/r2/`.

**(a) The ball was 50 % black because three symbolic colours were one colour, and the band
was two rows of twelve.** `BALL_ART` painted the outline `#14141c`, the equator band
`#1d1d24` and the button ring `#2a2a33`; pushed through this scene's grade (AgX at
`exposure 0.355`, then `contrast 1.32`) all three land on literal (0,0,0), and on a ball only
twelve texels tall that was 56 of its 112 filled texels. The band is **one** row now, the
button is a proper 4x4 with a 2x2 lens straddling it, and the three greys are separated by
value — `#2b2b36` / `#4d4d5c` / `#74747f`, which render as (18,10,25), (55,36,68) and
(100,77,100) in the noon frame, i.e. three readable steps.

The measurement, and the mask, because the number moves with it. The critic's silhouette mask
gave 50.4 % pure black in round 1; the mask used here is looser (anything in the ball's bbox
that is not lawn green) and is applied to **both** rounds over the same region, giving
**25.1 % -> 0.0 %**. Either way the direction and the size are the same, and the texel count is
mask-free: the black family went **56 of 112 filled texels to 32**, and those 32 are the
outline, which renders at (18,10,25) and does not clip. Under the same loose mask the two
Pokemon sprites standing in the same frame measure 9.0 % and 10.3 %, so the ball now has *less*
pure black in it than the art it stands next to.

**(b) The apex of a parabola is over the follower by construction, and the fix is the freeze
point.** The camera's yaw is fixed looking north, so screen-x *is* world-x; the trainer, the
lead and the wild all stand on one row and the lead is exactly halfway between thrower and
target. `mode=throw` froze at `t = 0.5` — the apex — so the ball's centre was 5 px from the
lead's on round 1's `c01` and read as a hat. Freezing at **0.72** moves it 72 % of the way
down-range at 81 % of the apex height: measured centre-to-centre separation **5 px -> 114 px**
on a ball 66 px wide. No change to `stageCell()`, so the live game's framing is untouched.

**(c) `Placement.rot` works on tall grass. What painted the field navy was an unclamped
tint, and it was nearly filed as the other thing.** The patch read as rows of identical fern
rosettes at identical phase, so every cell now gets a quarter turn and a +-7 % red/blue,
+-4 % green tint (the same variety `tiles` lays on its own ground, #25e; `instanceColor` is an
attribute, so it costs no draw call). The first cut painted half the patch dark navy — which
is *exactly* what an edge-on billboard card looks like (#29's tree stripe) and was one comment
away from being written up as "tall grass cannot be rotated". It was `Math.round(255 * 1.07)`
= 273, and `273 << 16` carrying into the next byte. Clamped, the same rotation renders
correctly. Re-shot before the finding was written, not after.

**(d) Two readouts contradicted their own frame, and one of them was a real API bug.**
`resolve()` set `last.outcome = caught ? 'caught' : outcome`, where `outcome` is the *battle*
verdict — so a ball that broke out on a won exchange was captioned **win**, directly under
`roll 0.865422 >= 0.388403` and `shakes 0`. `last` is what a UI reads to say what happened to
the ball, so it reports `escaped` when a ball was thrown and did not catch; the bus event
keeps the battle word untouched, because `economy` mints BP off exactly that string. The panel
also printed `battle: flee` two rows above `outcome: caught` — `flee` was the battle module's
word for "the party lost", which reads as "the wild ran away". The panel says `party won` /
`party lost` and `wild HP`, and the ball's row says `caught` / `broke free`.

**(e) The crushed shadow is the lighting rig's, and the control that proves it is
`sun.castShadow = false`.** The critic measured a hedgerow shadow on grass at 0.108 of the lit
ground against a "like-for-like control, same clock, same surface" of 0.443, and attributed it
to `setBiomePreset('meadow')`, to `reground()` or to shadows landing on layer-5 grass. None of
those. The 0.443 control is `pokemon`'s **painted contact-shadow decal** (#18), a fixed-opacity
quad, not a shadow-mapped shadow. Toggling the sun's `castShadow` in the running page and
diffing the two frames gives the honest number: **encounter 0.173, simulation 0.191**, same
`tod 17.5`, same preset (`simulation`'s showcase calls `setBiomePreset('meadow')` too), same
engine — a 10 % difference, not a 4x one. The sun-to-fill ratio at golden hour is
`environment`'s and is filed there, not chased here.

What *was* this scene's, and is fixed: at 17:30 `env.sun()` reports azimuth 270 and a shadow
5.93x the caster's height, so a hedgerow's shadow runs due **east**, parallel to the row — a
gap narrower than six cells is filled by its neighbour's smear and a 21-cell row with a 16 %
dropout paints one unbroken bar across the whole frame. The row is laid as runs of two to four
cells from `hedge2/3/4` (round 1 asked `tiles.find` for `maxCells: 1` and got `hedge1`
twenty-one times) with a deliberate **ten-cell gateway** behind the action. Measured on the
band the bar occupies: **91 % of its columns under L 15 -> 36 %**, band mean L 9.2 -> 33.0. The
remaining bar is a long low-sun shadow, which is what the references have.

**(f) `reground()` is retired, and the A/B says the lawn it was protecting is not flatter
without it.** Round 1 hid `terrain`'s world and rebuilt it with `variety: 0` to dodge a
checkerboard; `tiles` bounded that UV phase in its own round 2 (#29, #30). `?variety=1` against
`?variety=0` now differ by a **maximum channel delta of 43** and, on the far lawn, mean
|gradient| **1.78 vs 1.79** with 5.18 % vs 5.24 % over 8. The workaround was buying nothing and
deleting `tiles`' tonal blotch, so it is gone. The critic's separate claim — that the near lawn
is "the softest surface I measured anywhere" — does not survive a like-for-like box either:
**pure-lawn** boxes with no props in them read 0.85 and 0.74 here against `simulation`'s own
0.81 and 0.82. It is the same lawn. What was true is that the bottom quarter of every frame was
*empty*, and that is a composition fault: the spur now turns south down a `LINK` elbow onto a
`TRACK` that runs across the foot of the picture, both verges are flowered, and a broken hedge
run closes the foreground. That also retires "the spur ends in a bare tan rectangle": it is a
junction now, not a stub.

**(g) Night is `environment`'s grade, but a frame with no emitter in it is the scene's fault.**
`mode=night` is the frame built to sell the Dusk Ball's x3 and round 1 shot it into a meadow
with nothing that emits. Two AdAstra street lamps stand on the track's north verge and their
bulbs are registered through `environment.lamps.add()` — the published seam (#25d, #31h), which
owns the dusk ramp, so they are dark at noon for free. `orientation: 'e'`/`'w'` only, never
`'n'`/`'s'` (#26e). Measured on the scene (HUD and panel excluded), against
`docs/refs/03-forest-voxel-night.png`:

| tod 21.5 | round 1 | round 2 | ref 03 |
| --- | --- | --- | --- |
| L median | 43.0 | 44.6 | 33.2 |
| L p95 | 63.0 | **107.6** | 129.5 |
| L max | 114.3 | **253.6** | 216.9 |
| % over L 100 | 0.38 | **6.71** | 8.77 |
| % over L 140 | 0.00 | **1.60** | 3.04 |
| hue p5-p95 span | 44.6 | **134.8** | 117.8 |

And the consequence the critic ranked separately: the Murkrow's silhouette readability — the
fraction of its pixels more than 25 L from the local background median — goes **8.4 % ->
39.2 %**. The reference's night pair is 63.5 %, so this is closed by more than half and not
all the way.

The lamps are placed **only when `todBand(tod)` is night**, and that is a deliberate staging
rule rather than a dodge: a lamp on `cz 27` is two cells from the camera-side edge of the
frame, so its shade renders about 100 px across — at night it is the brightest thing in the
picture and the reason the frame reads, and at noon it is a dead grey slab with a hard post
shadow beside it. Both were shot and looked at. `tod` is a query parameter, so the same URL
still gives the same pixels.

**(h) The sparkles never bloomed because the threshold they were fitted to is not the one this
scene runs at.** `ball.js` set `color.setRGB(2.6, 2.45, 1.9)` citing `config.bloomThreshold`
0.72; `environment` drives that from its keyframes — **1.15 at noon, 1.8 at golden hour, 2.6 at
night** — so a luma of 2.44 kept 53 % of itself at noon against a bloom *strength* of 0.30, and
literally nothing at night. At `(5.6, 5.5, 5.15)` the core clips to white after AgX and the
bright pass keeps 79 %. The other half is that a diamond painted in one flat colour has no
falloff to bloom: the outline texel is `#8f8878` now, 0.55 of white, which lands at 3.0 in the
HDR target — above every threshold, below the clip. Measured skirt/core (pixels 150<L<200 over
pixels L>200): **0.01 -> 1.01** on the capture burst and **0.02 -> 1.08** on the shiny ring,
with the brightest 400 pixels going from (246,215,186) to (255,247,226). The quads also came
down 0.55 -> 0.34 world units, because in round 1 five 55-px diamonds sat on top of the shiny
the ring exists to make legible.

**(i) A contact blob under a ball flying over tall grass is inside the blades.** `tall_grass`
spans y 0.125..0.625 off its own base (read out of the pack through `tiles.find`) and the blob
was laid at `groundY + 0.02`, so at 4x on round 1's `c01` there is no darkening anywhere under
the airborne ball — the one cue that sells "in the air" in a still frame, missing from the
frame whose whole job is to be that still. The blob goes on the top of the cover (0.66, which
clears the taller model by 0.035), is 0.95 units wide with a tight core, and A/B against
`blob.visible = false` moves **2 040 pixels by up to 46.7 levels**, against 0 before. It is
still a subtle cue on grass that dark, and that is recorded rather than claimed away.

**(j) The pixel-grid correction has to run every rendered frame, because the camera is a
spring.** Elevation walks a sprite toward a 45-degree camera, so the ball at apex measured
7.00 px per texel across and **7.60 down** on `c01` — 8.6 % anisotropy, and the outline steps
raggedly at 8x. `d / d0` cancels it exactly. Applied once inside `arc()` it did nothing:
`advanceToStage()` walks the animation forward while the camera spring is still settling, so
the scale came out **1.0012** instead of 0.946 and a frozen scene never calls `arc()` again.
The module gained a `frame` hook that re-fits the airborne ball against the camera as it is
*now*. Measured after: **6.60 across, 6.70 down — 1.5 % anisotropy**, against 6.30 for the same
ball resting on the ground two cells away. The residual over 6.00 is the off-axis perspective
every sprite in the frame shares, not an elevation error.

**(k) Smaller things, all measured.** The panel was **393x810 of 1600x900 — 22 %** and showed
the same nine sections in all nine modes; it is 286 px wide at 10 px and shows one long section
per mode (the eighteen-ball shelf belongs to `mode=balls`, the step log to `mode=walk`, the
spawn table to the rest), which is **319x590 = 13.1 %**. `mode=walk` frames at `k = 3` — two
thirds of the distance, still an integer so the texels stay exact (#29) — because its whole
claim is that the lead is standing on a `tallgrass` cell and at the shared framing that claim
was a 60-px sprite. `mode=balls` scans for the encounter that fires the **most** ball
conditions rather than the hardest one (five fire on the staged frame instead of two) and every
row now prints `economy`'s own `when` string, so a `x1.00` row says *why*. `mode=reveal` freezes
at the top of the hop rather than 85 % of the way down it, and the wild comes up inside a low
ring of the same bloomed stars — a puff, on the sparkle instancer that is already there, so it
costs no draw call.

**Measured across 17 shots** at 1600x900 and 1920x1080, `tod` 5.8 / 8 / 12 / 17.5 / 21 / 21.5,
plus `--pixelScale 2`: **60 fps, p95 16.7-16.8 ms, 60-72 draw calls, 15.6-15.8 k triangles,
16-24 programs, 0 console errors and 0 console warnings** in every one. Two captures of
`?showcase=encounter&mode=caught&tod=12` still differ by **0 on every channel**.
`node src/encounter/selftest.js` 35/35 and `node tools/seams/run.js` passes.

### 40 — 2026-09-08 — The rendered sun is bent away from the real one, on purpose

Seven blind judges compared our frames against Gamma Emerald stills without being told which
was which. We took 3 of 7. Every one of the four losses was decided by the same sentence —
that the other image "has one committed light direction", "long soft cast shadows rake
across the clearing", "the warm key actually interacts with geometry". All three wins were
night scenes, where our moon key and lamp pools already do exactly that.

The cause was not the renderer. It was astronomy. At latitude 36 degrees north on day 96 the
noon sun sits at **60 degrees of elevation on an azimuth of 180 — due south** — and this
camera looks north and never yaws. So at midday the key is directly behind the viewer, every
shadow falls behind the object that casts it, and `--envNoShadow 1` at tod 12 changed
**0.07%** of the frame. The lighting was physically correct and pictorially dead.

No game does this. So `solarPosition` now takes an optional `look` and returns what should be
*drawn* while still reporting the true position:

  - `config.sunAzimuthOffset` (38 degrees) rotates the whole daily arc off the camera's axis.
    Our fictional world's north simply is not the camera's north.
  - `config.sunMaxElevation` (46 degrees) soft-caps the climb through
    `MAX * (1 - exp(-alt / MAX))` — monotone, 0 at 0, never actually reaching the cap, and
    with no plateau at noon, so the sun still rises and sets instead of parking overhead.

`dayFraction` keeps using the **true** altitude, so dawn, dusk, how long the day is and how
much light there is are all still physical; only the direction the shadows are thrown is
art-directed. The sun still rises in the east and sets in the west.

Measured, same URLs, before -> after: shadows cover 0.07% -> 1.44% of the frame at noon,
2.29% -> 6.80% at 08:00, and 4.73% -> 16.38% at 17:30. 60 fps and zero console errors at
every hour from 06:00 to 21:00, and night is unchanged.

Round 2 of the blind judging then went **1 of 7**, down from 3 of 7, and the whole-game
critic named why: the tilt "was bought partly by dimming — noon mean luma down 19-28% and
p99 down about 20 points". That is arithmetic, not bad luck. A flat floor takes
`sin(elevation)` of the key, so soft-capping 60 degrees down to 33.5 removed a third of the
light from every horizontal surface in the game. The shadows arrived and the picture got
duller, which is a bad trade and my fault.

So the key is now scaled back up by exactly the ratio the tilt took away —
`sin(trueAltitude) / sin(shownAltitude)`, clamped at 1.9 because near sunrise and sunset the
ratio runs away and the grazing hours are meant to be dim. A horizontal surface ends up as
bright as the real sun would have made it while the shadows still rake.

Measured on the meadow, HUD masked, against the state *before* any of this: noon keeps its
p99 at 153 and lifts max from 175 to 199 (reference 04 is 199), 08:00 goes p99 146/max 176
to 151/211, and 17:30 holds at 137/195 — all while shadow coverage stays at 20x its old
value. Strictly brighter or equal at every hour, with the shadows kept.

---

### 41 — 2026-09-08 — Every tall card in the game was drawn upside down; half of a crossed billboard is a pole; and the lamp is not broken, it is blank

Three blind panels in a row named the same three things in our forest, and all three were
measured in `src/tiles/` before anything was changed. The whole round's shots are in
`docs/progress/tiles/r3/`; each fix has an A/B at the same URL one flag apart
(`?uvright=0`, `?crossed=1`, `?foliage=0`).

**(a) "Tree trunks read as flat orange rectangles detached and floating over their
canopies." They were floating over the canopies, because the trees were upside down.**

`pack.bin` stores DS texture coordinates, which are measured *down* from the image's top
row. On `tree`'s upright card `v = 0` sits at `y = 4.50` (the crown) and `v = 1` at
`y = 0.19` (the foot of the trunk). `THREE.TextureLoader` uploads with `flipY = true`, which
puts image row 0 at `v = 1`. Nothing cancels, and every upright face in every tileset has
been sampling inverted since the first one loaded.

Only the trees could show it. A cliff, a rock face and a hedge are all texture an artist drew
to read either way up, and a horizontal tile is not affected by a V flip at all — but
`ki02ax` is a whole conifer with a brown trunk at the bottom of the sheet and a pale spire at
the top. Inverted, it renders as a flat brown rectangle floating over the canopy with a thin
pale pole hanging out underneath, which is the panel's sentence almost word for word, and
also the earlier round's "the conifer spires poke through as thin pale vertical poles".
`docs/progress/tiles/r3/02-trees-before.png` is four trees on open lawn with the trunk
block at the top of each; `12-trees-after-vfix.png` is the same URL one function later.

**The correction cannot be `flipY = false`,** and this is the part worth keeping.
`flipY` is a property of the *upload*, so turning it off would re-orient every face in the
pack, horizontal ones included — and one horizontal tile was measured before deciding:
`ki02c`'s root decal has `v` largest at `z = 0`, so under `flipY = true` its image's top row
lands to the north, and it renders correctly today. A per-triangle correction gated to
upright faces cannot disturb that tile or any other horizontal one; a global flip would
re-orient all of them. That is the same export-side flip DECISIONS #24 had to take back.

*[narrowed 2026-09-08 — see #44c. As first written this paragraph went on to say the `ki02c`
convention "is why every auto-tiled edge in the game has passed round after round" and that
flipping the upload "inverts all of them north-for-south". Neither was measured. The critic
called it an over-reach and was right: the horizontal faces of the fifteen shipped packs do
**not** share one convention — 6111 of them run `v` south and 8296 run `v` north — and no
critic finding was ever traced to this axis. What is measured is the `ki02c` tile above and
the byte-identical `mode=ground` pair below.]*

So `uprightUvToImageOrder` runs per triangle at load, beside the rewind and the normal lift,
and only where the sign says so: geometric normal (from the positions — the rewind has
already negated some stored ones) with `|ny| < 0.5`, and `dv/dy < 0` across the triangle. The
flip is a mirror about the triangle's own V span, so a quad's two triangles mirror about the
same value and the seam between them cannot move. Faces that already run V with height are
untouched, and two in AdAstra do: `plant01`'s hedge (v 0→1) and `saku`'s fence rail (v 1→3),
both of which render correctly today. It corrects 608 of `bw2-adastra`'s 2402 triangles and
fires in all fifteen shipped packs.

The proof that horizontal tiles are untouched is a **byte-identical** pair:
`?showcase=tiles&mode=ground` before and after the change diffs to a maximum channel delta of
**0** across 1 440 000 pixels.

**The same measurement condemns the Poké Center's own sign, and it is deliberately not fixed
here.** `structures` carries the identical convention — `sign.png` has the Poké Ball's red
half in the image's top rows and the building renders it white-side-up. The sign sits on the
roof pitch at `|ny| = 0.85`, outside the upright gate, and widening that gate to catch it
would also flip **672** triangles of cliff bank and lake edge in AdAstra alone on no evidence
at all. It is filed as a coreRequest instead: the V convention belongs in the exporter, where
one rule covers every face at every angle. Until then the ball is upside down, and saying so
is cheaper than a bad fix.

**(b) One half of a crossed billboard is permanently edge-on, and it is the one facing X.**

With the trees the right way up, a second artefact was left over and visible in
`12-trees-after-vfix.png`: a thin pale line down the middle of every crown and a hard black
wedge across it. Both are the `x = 1` card. The camera's yaw is fixed forever (§2.7), so that
card is perpendicular to the view in every frame this game will ever draw. It rasterises as a
1–2 px vertical smear running from above the crown to below the roots; it is lit off a normal
pointing east while its twin is lit off one pointing south, so the smear is a different
colour from the tree it stands in (which is DECISIONS #29's finding, filed then as a
coreRequest and never landed); and it casts a full-height shadow across its own twin.

`dropEdgeOnTwins` collapses it, and the predicate is the whole design. A first cut asked only
"is there an X card and a Z card in this material group" and deleted 440 triangles in
`pt-overworld-7`, every north-south fence panel, every house wall and every hedge side — the
count is what caught it, before any screenshot. The test is now the *crossed pair*: the model
is tagged `billboard`+`foliage`; the material is `bothFaces`; there is exactly one X plane and
one Z plane among its upright cards; each plane falls strictly inside the other's extent (so
two parallel walls of a box, and an L of two walls at a corner, are both out); and the
surviving twin covers at least 80 % of the dropped card's height. Across all fifteen packs
that is **10** triangles in `bw2-adastra`, 6 in `bw-overworld`, 10 in `bw2-brom` and nothing
anywhere else. The four forest entrances are outside it on purpose — several cards per plane,
not a crossed pair — and keep every one.

The triangle is collapsed to a point rather than spliced out: groups are byte ranges shared
with every InstancedMesh that draws the model, so a zero-area triangle costs no fragments, no
shadow and no re-indexing. The triangle *count* therefore does not change (5568 either way),
which is worth knowing before reading it as a no-op.

**(c) The two tree palettes are a material, not a tint and not a model choice.**

"The left third uses a teal-blue tree set butted against a green one"; "the blue-teal conifers
vs green round crowns form two colour populations that never blend." Mean hue of the non-bark
texels of every foliage sheet AdAstra ships, in degrees:

```
ki03ax 153   ki03bx 164   ki03dx 133      round_tree — the green population
ki02ax 155   ki02bx 170   ki02dx 141      tree — the same population
plant01 150  kusa_ec1 113                 hedge and tuft, greener still
ki02DARKax 178  ki02DARKbx 194  ki02DARKdx 164     darker_pine — 25 to 30 degrees out
```

`ki02DARKbx` at 194 is a cyan, and it is the horizontal canopy slice, so it is the layer that
faces the sun and comes back as the brightest thing on the tree. Nothing tints these
instances, so it is not a tint; and dropping `darker_pine` from the planting would leave a
thinner wood rather than a unified one, so it is not model selection either. It is the sheet.

Foliage therefore gets a **hue knee** in the fragment shader, on the sampled map: below 140
degrees untouched, above it compressed by 0.30 toward the knee. Saturation and value are not
touched at all, so `darker_pine` stays the darker, duller tree it is named for. Bark is out of
range by construction (a trunk is 15–70 degrees), and the patch is applied only to materials
whose models are tagged `foliage`, which is what keeps it off `ike01`, `sea_mizu1` and every
other blue in the pack — the coast A/B shows the sea unchanged.

150/0.40 was shot first and was not enough: `darker_pine`'s crown still measured a median hue
of 173 on the render against `round_tree`'s 150. At 140/0.30 it is 164 against 149, and the
three-way stack of no-knee / 150 / 140 at the same URL is what chose it.

Two implementation notes, both of which cost a frame. `onBeforeCompile` runs *before* three
resolves `#include`, so a patch that targets `diffuseColor *= sampledDiffuseColor;` matches
nothing and renders a perfect null result that reads exactly like "the fix did not help"; the
hook is the include line. And `harmoniseFoliageInShader` composes through `applyShaderPatches`
alongside the normal clamp (#30a), because `Material.clone()` copies neither
`onBeforeCompile` nor `customProgramCacheKey`.

**(d) The street lamp is not broken. The art has nothing in it, and that is now measured.**

Two whole-game passes called it "a plain grey untextured pole with a flat lozenge head, no
bulb, no housing, no fixture detail". Three things were checked and all three came back clean:

- the texture resolves — `slamp03.png` loads, and the post's left-to-right shading in
  `docs/progress/tiles/r3/16-lamps-day.png` is the sheet's own gradient;
- no material group is dropped — `lamp_h` ships exactly two, `slamp03` (28 triangles) and
  `kage_out` (2), and both draw;
- the UVs cover the sheet (`u 0..0.94, v 0..1`), and the night glow lands on the underside of
  the shade before and after (a) (`ab/lamps-night-off.png` against `17-lamps-night.png`).

`slamp03.png` is 16x32 and holds **ten** colours, every one a blue-grey between `#809098`
and `#f8f8f8`. There is no bulb drawn in it, no housing, no lens, no cage, no bracket
ornament — the sheet is a pole gradient on the left and a white block with three flat bands
on the right. At the game camera the 30 triangles give a post, a cantilever and a wedge, and
the wedge is exactly the "flat lozenge head" the panel named, because that is what the model
is. **This is an authored-asset job, like the buildings in DECISIONS #3 and #12 were**, and
it is filed as such rather than papered over with a procedural sheet in `src/tiles/`.

**A `trees` mode was added to the tiles gauntlet** (`?showcase=tiles&mode=trees`) and every
finding above is legible in it: each 2x2 tree alone on open lawn with four clear cells around
it, the same three packed at the spacing `hunts` plants at, and one `lamp_h` on paving. A wood
is the worst place to debug a tree, because a card drawn wrong is indistinguishable from a
card merely standing behind something.

Measured across seventeen shots at 1920x1080: **60 fps, p95 16.7–16.8 ms, 27–400 draw calls,
3.6k–24.9k triangles, 8–24 programs, 0 console errors and 0 console warnings** in every one.
`node tools/seams/run.js` passes: 119 files, 15 modules.

---

### 42 — 2026-09-08 — The party walked north because a *second* staging path silently undid the first; a wood needs a ride before a route string means anything; and `walk_edge`'s surf was never on the drop-off because the drop-off was never a boundary

Owner: `hunts`. Four defects the blind A/B panels named, in the order they named them.

---

**(a) "The protagonist's head is a blank cream oval with no face" was two bugs, and the
second one is the one that mattered.**

Three blind rounds named this and only this. The obvious half is the direction: under a
camera whose yaw never changes, a party walking **north** files straight up the screen, each
sprite covers the one behind it, and the only thing the camera can see of the trainer is the
back of the cap — which at a 45° pitch is a featureless lozenge. `coast` is the one biome the
judges said read correctly and it is the one whose route starts east.

The non-obvious half: **`hunts` had two staging paths and the second silently undid the
first.** Round 2 fixed `showcase.js` to freeze with `advanceTo` (which counts *tiles*) instead
of `advanceSteps` (which counts 1/20 s *sim ticks*), and left `stage()` in `index.js` calling
`advanceSteps(7)`. `hunts.preset()` runs `stage()`, the harness applies `--preset` through
`__HOOKS__.setPreset` on **every** capture, and `stage()` teleports first — so every shot in
the module was re-staged from scratch and then walked seven sim ticks, which at
`walkSecondsPerTile` 0.25 is **1.4 tiles**. Probed on the running page before the change,
coast's `route` framing reported `steps: 1, distance: 1.2`, the lead at `dir: 3` and every
other walker still at `dir: 2`. The route strings were fine; nothing ever got to walk them.

**The literal framing goes through the same path.** `hunts.preset()` also accepts a bare
`"cx,cz"` so a critic can point the camera at anything without a marker existing for it — it
is how round 2's cave card was found — and that branch teleported facing `2` and walked
nothing at all. Every literal framing therefore reproduced the exact defect being fixed. It
now stages identically; probed with `preset('26,34')` in the cave, all four walkers come back
`dir: 3` on one row.

There is one staging path now (`stage()`), it takes its route from the biome
(`FOREST.walk`, …), and `tiles` is **3**, not 15–18: `Line.place` already lays the whole queue
along the walk direction at the teleport, so the long counts were compensating for a north leg
that had to be walked off first — and they walked the party out of the framing its marker was
chosen for. Probed after: all four walkers `dir: 3` in all four biomes, strung out along one
row two cells apart.

**(b) A route string cannot fix a map.** `makeScriptedRoute` drops an impassable step
*silently* and falls through to the next direction in its list, so an `e` leg written against
a wood is walked into a tree, dropped, and the walk wraps back to `n` with nothing in the
console. So the maps grew genuine east-west legs, and each one is a thing the reference
stills actually contain rather than a concession to the camera:

- **forest** — two east-west **rides** cut through the wood, unioned into `path` *before*
  `verge`, `open`, `wood`, `distToPath` and `canopyAt` are derived, so the verge, the tree
  exclusion, the undergrowth thinning and the auto-tiled dirt all follow for free. The first
  cut meandered ±3.8 cells and a sine that size quantised onto a grid is not a curve — it is a
  staircase, `closeCorners` fills the inside of every step, and the frame came back with three
  parallel dirt bands where there is one trail. ±1.6 keeps the line a line.
- **meadow** — an east-west **lane** crossing the north-south track at a crossroads. The
  meadow is open ground and an east leg was already walkable anywhere in it, but a party
  striding across a trackless field reads as lost.
- **cave** — an east-west **gallery**, `corridor([5,38] → [51,34])`, cut across the south of
  the hall, with `outcrops` and `terrace` subtracted from a three-cell band around it so
  nothing can plug it. docs/refs/02 *is* a walked gallery with rock either side.

**Markers are snapped through `laneNear`, not `walkableNear`.** `Line.place` lays the queue
along the walk direction at the teleport, so with `followerGapTiles` 2 and four members the
tail sits five cells behind the marker and the lead two ahead: standable ground is not enough,
the *row* has to be clear from `cx − 5` to `cx + 6`. The selftest asserts exactly that span on
every preset of every biome and it caught five bad cave markers before a screenshot did.

**(c) The hunts were empty, and the fix is three existing seams and no fourth.** *"Not one
wild Pokemon appears in any of the sixteen hunt frames across four biomes and four hours; the
city plaza has more creatures in it than the hunting grounds do."* Species come from
`encounter.tablesFor(biome, tod)` — the same weighted table the idle loop rolls, so what
stands in the grass at 21:00 is what you would meet there at 21:00; cells come from each
biome's own build report (`wild`), scattered through its encounter grass; and they are drawn
by `simulation.spawnNpc`, which stages through `pokemon`'s sprite field, so eleven creatures
cost **zero** extra draw calls and pick up contact shadows and the idle animation for free.

Two things had to be got right. The atlas is built **before** the spawn loop — `Cast.sync`
awaits `pokemon.sprites.prepare` internally, so spawning eleven NPCs one at a time leaves real
async work outstanding when `__READY__` flips and a shot can catch the field half-populated.
And they **stand** rather than wander: `advanceTo(3, 7)` is 22 sim ticks, which is 4.4 tiles,
so a wandering creature placed two cells off the lane can be anywhere within four of it by the
time the shutter opens — in `coast-route-21` one walked onto the trainer's head.
`wildCells` also refuses any candidate within two rows of a marker, because that row is the
one the party is about to walk down.

**(d) `walk_edge`'s surf was on the map all along; the drop-off just was not a boundary.**
`set7 walk_edge` ships a complete 13-slot family whose twelve border slots are all tagged
`foam`/`surf`; only slot 6, `walkable_water_center`, is the flat wadeable sheet. Round 2
solved that family over the **whole** water body, so the only boundary it ever saw was
water-against-land: every cell at the shallow/deep drop-off is *interior* to the whole body
and resolved as `center`. The deep water therefore ended at a hard grid step with nothing on
it, twice, one step apart — and the model named `sea` has no border family of its own, so
there was no other way to put anything there.

Solving the same family over the **annulus** (`shallows = water − deep`) gives it two
boundaries and it draws surf on both, against the land and against the deep. `shrink(3)` is
kept, and the erosion is load-bearing twice over: it removes every feature under three cells
(which is why the deep was a *smoothed copy* of the coastline), and because it is 8-connected
every deep cell is Chebyshev ≥ 4 from land, so **no shallows cell ever touches both** and the
13-slot blob never has to draw an isthmus it has no slot for. The band's width now varies
3→7 cells on a low-frequency lattice, so the drop-off is a different line from the coast
rather than a parallel copy of it.

One more thing had to be measured rather than assumed: **`sea_zanami2` is not a white
breaker.** Dumped from the PNG, it is a pale-blue wash (96,168,208) fading to the shallows'
own blue with a *ragged transparent cutout* along its last two rows — on a dark background it
reads as white foam and it is not one. At full brightness next to `sea_asase02` the two are
within a few luma of each other and the surf line vanishes at any distance a critic shoots.
`tint` is an instanced multiply and can only darken, so the *body* of the shallows is taken
down to `0xa9c6dc` and the border slots left at full: same contrast, from the only direction
the renderer allows.

**(e) What moved on forest night and cave hue, and what did not.** Both are shared faults and
only the hunts-owned half moved.

- **Forest night.** STATUS carries the round-2 critic's figure of 48.9 % of the frame below
  luma 8 against the reference night's 10.1 %; that number was not re-measured here, so every
  figure below is this round's own, on the same URL at 1920×1080. The lever this file has is
  *composition*, and specifically the **south** side of a ride: the camera sits south of its
  focus and shows 12.7 cells north of it to 8 south, so the southern verge is the near half of
  every frame shot on a ride, and a symmetric two-cell verge puts a 4.5-unit canopy across it.
  Measured as it was opened: **55.8 % → 41.3 % → 29.1 %** crushed (mean luma 11.9 → 16.4 →
  19.3) at a south verge of 4, 7 and 10 cells, against three cells north so the wood still
  closes the top of the frame. Shipped: `forest-route-21` is **29.05 % crushed, mean 19.27,
  p50 19.88, sd 14.69**, against `03-forest-voxel-night.png`'s 10.14 % / 45.68 / 33.79 / 36.56.
  Still 2.4× darker than the reference and it will not get closer from here: what is left in
  frame is the moon's shadow map throwing hard-edged crowns right across the open ground from
  trees at and below the bottom edge, and `environment`'s forest ramp. Both filed.
- **Cave hue** was mean saturation 0.971 against ref02's 0.194 with luma sd 15.4 against
  ref04's 37.9. The numbers that mattered were read out of `environment/lamps.js` rather than
  guessed: the `PointLight` reach is clamped to `POOL_REACH` 3.9 whatever `radius` says, the
  painted ground pool reaches `min(4.2, radius × 0.42)`, and its strength is
  `min(1, 0.205 × intensity + 0.035)`. Round 2's `radius 9, intensity 0.9` therefore painted a
  3.8-cell pool at a fifth of full strength — a smudge. Rebuilt as five bright warm pools and
  six cold ones (`radius 11, intensity 4.4–5.2`) with the cold family down the gallery and in
  the deep, plus an albedo grade whose cool end is genuinely blue and whose falloff is
  `radius × 0.62` rather than the full radius (at the old falloff `reach` was 1.0 nearly
  everywhere, so the cool end of the ramp was mixed in on almost no cell and the grade was a
  no-op). Measured on `cave-route-12` before and after, same URL: **luma sd 17.11 → 27.35,
  p99 99.72 → 147.47, mean 41.52 → 48.71, mean saturation 0.952 → 0.916**, against ref02's
  0.179 and ref04's sd 38.26. Still one dominant hue, and it will stay one while the preset
  fogs `0x4a2f18` at density 0.040 with `saturation: 1.30` over it and runs `sun: 5.20` inside
  a sealed cave — at 20 world units that fog is about 47 % of every pixel and it is one warm
  brown. Both filed.

Measured across **44 shots at 1920×1080**: 60 fps, p95 16.7–16.8 ms, 67–131 draw calls,
8.9k–24.7k triangles, 14–24 programs, **0 console errors and 0 console warnings** in every
one, `presetApplied: true` on all 44. Determinism re-checked by shooting one URL twice, twice
(`forest route 17.5`, `coast route 21`): max channel delta **0** over 1,440,000 pixels each.
`node src/hunts/selftest.js` 279/279; `node tools/seams/run.js` passes.

### 43 — 2026-09-08 — The sun cast inside a sealed cave, the shadow started a foot behind the feet, and a `sampler2D` read of a comparison texture drops the draw without a word

Three defects, all named by blind judges who were not told which image was ours, all shadow,
all in `src/environment/`.

**(a) An interior has no sun in it, and the preset is where that fact belongs.**

Two separate rounds filed the same thing about `cave-21`: hard-edged near-black darts pointing
west while the only lights in the room are two warm orbs to the north-east, swinging with the
sun's daily arc, under a rock ceiling. One judge called it "geometry corruption".
`?envNoShadow=1` removed them exactly, so they were the sun's.

The fix is not `if (biome === 'cave')`. Every keyframe in `presets.js` now carries **`enclosed`**
(0 outdoors, 1 for `cave` and `interior`), blended by `blendPreset` like any other scalar, and
`environment` publishes **`setEnclosure(v)` / `enclosure()`** so a scene that roofs *part* of an
outdoor map can say so without environment ever learning a biome's name. At `enclosed >= 0.5`
the directional key stops **casting** — it still models geometry, it is the preset's warm shaft —
and the room's own registered practicals throw the character shadows instead: `lamps.nearest(focus, 4)`
into a four-entry uniform, each instance picking whichever bulb dominates *at its own feet*, its
direction away from that bulb and its run `horizontalDistance / (bulbHeight − floor)` capped at
1.15 of the caster's height. Two characters either side of a lantern throw their shadows apart,
which no single global direction can do.

Their *depth* must not be the sun's either, and that is the half that would have shipped a new
defect in place of an old one. `shadowMul` is `fill / (fill + key)`, and the cave preset runs a
key of **5.20** against a hemisphere of **0.50**, so reusing it puts an indoor shadow at 0.09 —
the same near-black dart pointing a different way. A lantern is not the sky. `practicalMul` is
`fill / (fill + lamp)` with the lamp sized at 0.95 of the fill, which lands near 0.5, and it takes
its hue from the bulbs *actually registered*, so a warm lamp in a cool room leaves a shadow
cooler than the floor with no second colour authored anywhere.

The proof is a single number: `?envNoShadow=1` on `?showcase=hunts&mode=cave&tod=21` at
1920x1080 now differs from the same URL without it by **0 pixels on every channel**, where round
3 differed by 2.62% of the frame. The cave costs **67 draw calls instead of 109**, because the
shadow pass is gone rather than merely dark. `?envNoCast=1` still moves 21 447 px, so the
practicals are doing the work the sun was doing badly.

One branch is reasoned rather than shot, and is recorded as such: a roofed room that registers
*no* bulbs falls back to a short pool (`len 0.30`) laid toward the camera, because falling
through to the key there would be defect (a) walking back in through the API's own front door.
No shipped scene reaches it — `hunts`' cave and the environment showcase both register lamps —
so it has no screenshot behind it.

**(b) The shadow started 0.60 world units behind the feet, and its cap was in the wrong unit.**

"The lead character's two shadow blobs float with lit floor between them and his feet, no contact
shadow grounds any sprite"; and from another round, "a tree, a trainer and a Pokemon cast the
same rounded screen-axis bar with zero penumbra". Three pieces of arithmetic, compounding:

  1. The shear was anchored at the **quad's** bottom edge, but `pokemon/field.js` drops the card
     by `FOOT_PAD_TEXELS` so a sprite's two empty rows land on the floor. The first *painted*
     texel therefore already carried `(2/32) x cardHeight x len` of run — **0.60 world units,
     about 27 screen px** of lit paving between a trainer and his own shadow at the golden hour.
     `footFrac` is now derived per instance from the frame's own atlas rect
     (`abs(aUvRect.w) / uTexel.y` is the frame's height in texels), and so is the floor the
     shadow is laid on, so an actor carrying a `scale` comes out right too.
  2. A 32-texel sprite is drawn on a quad **2.83** world units tall — a vertical card seen from
     45 degrees is foreshortened by `cos 45`, so it has to be stretched to read as 2 units — and
     the shear used that as the caster's height. Every shadow was **41% longer** than the thing
     casting it before any cap applied.
  3. The cap, `len <= 3.4`, then made the shadow **9.6 units**: ten tiles for a character who
     reads as two units tall. A 32-texel silhouette stretched that far is a smear, and that is
     the "rounded bar" three judges named. The cap is **3.0 in units of the character's own
     height** now, which is what ref 03's Poochyena throw, and the penumbra came down from 2.8
     atlas texels to 1.15 with the coverage window narrowed from `smoothstep(0.18, 0.66)` to
     `(0.38, 0.62)` — a blurred cutout read through a window that wide is a lozenge whatever
     shape went into it.

Anchoring correctly is necessary and not sufficient. A planar projection runs *along the light*,
and for much of this day the light runs up-screen, so the near half of a correct shadow hides
behind the card that casts it and the sprite still reads as a sticker — the round-3 note
"SPRITES ARE NOT GROUNDED AT NOON", which is not fixed by making the shadow longer, since that
only moves the visible part further away. What fixes it is admitting the caster is a **volume**
and not a plane: the near end is flared 28% wider than the silhouette and pushed 0.17 units
toward the camera, both tapering to nothing at the head where the projection is honest. Every
sprite in `meadow-11` now carries a shadow that touches its feet; `?envNoCast=1` moves
**23 220 px** and the mask sits on each sprite's foot row rather than a tile away from it.

**(c) Two shadows must not multiply — and the exact fix turned out to be a sampler type.**

`castShadows.js` blends `DstColorFactor / ZeroFactor`, a pure multiply, so a shadow landing on
ground the shadow map had already darkened produced `shade²`. Golden-hour plaza paving inside a
stacked shadow measured rgb(0,0,10) against lit paving rgb(151,99,76).

The dominant term is sprite-on-**map**, not sprite-on-sprite: at 17:30 the plaza is mostly inside
the buildings' shade. So the shadow now asks the map. A shadow is the *absence* of a light; once
the sun has already gone from a surface, taking it away a second time cannot darken anything.
What a character still blocks there is sky, so what it should leave is an ambient occlusion —
short and shallow rather than long and deep: the shade lerps to 42% of its depth and the tail
fades to 28% past the feet. Both extremes were shot before settling there. Multiplying at full
strength is the rgb(0,0,10); dropping the shadow entirely leaves every sprite in the shaded half
of the plaza with **nothing** under it, which is a `?envNoCast=1` diff of 0 px on a frame that is
supposed to have four characters standing in it.

Getting there cost most of the round, and the reason deserves writing down, because it is silent
and it will happen again. **three r185 deprecates `PCFSoftShadowMap` and substitutes
`PCFShadowMap`** — one console warning at boot and nothing else — and `PCFShadowMap` is the one
branch of `WebGLShadowMap` that sets `compareFunction` on the shadow depth texture. That makes it
a `COMPARE_REF_TO_TEXTURE` sampler, and reading one through a plain `sampler2D` is a type
mismatch the driver answers by **dropping the entire draw call**: three still counted the draw,
the console stayed at zero errors and zero warnings, and every projected sprite shadow in the
game stopped existing. Three wrong hypotheses (a NaN, the depth test, the blend mode) were shot
and discarded before an A/B that replaced the *sample* with the constant `1.0` — and restored the
shadows — proved the fault was the read and not the value. It is a `sampler2DShadow` now,
`texture(map, vec3(uv, z + bias))`, and the map's own `LinearFilter` gives the answer free 2x2
hardware PCF. Two further traps in the same family: a `sampler2DShadow` bound to three's default
**empty RGBA** texture is the same silent dropped draw, so the uniform always holds a 1x1
comparison `DepthTexture` when the real map is absent (indoors, under `?envNoShadow=1`, and on
the frames before the first shadow pass); and that fallback needs `needsUpdate = true` or it is
never uploaded and the sampler is incomplete, which is the same silent dropped draw a third time.
`update()` re-checks `compareFunction != null` every frame and switches the whole gate off if a
future three changes its mind again.

Two exact solutions to sprite-on-*sprite* overlap were tried and rejected, both worth recording.
The **stencil buffer** is unavailable — `core/render.js` builds the context with `stencil: false`
— which is now a `coreRequest`. **Writing depth** from a plane stepped down per instance *does*
make the group idempotent, and it also occludes every transparent thing drawn after it: a
full-frame A/B showed it eating parts of the scene that have nothing to do with shadows. With the
shadows shortened to the caster's own height there is little overlap left to fix, and the
measurement says so.

Measured on `?showcase=city&preset=plaza&tod=17.5` at 1920x1080, HUD rows masked:

| | round 3 | round 4 | `?envNoShadowClamp=1` | `?envNoCast=1` | ref 04 |
| --- | --- | --- | --- | --- | --- |
| pure black | 5.06% | **2.18%** | 4.19% | 2.05% | 0.00% |
| below L 8 | 15.90% | **7.29%** | 13.42% | 6.08% | 0.07% |

So the projected shadows now cost **0.13 points of pure black and 1.21 of L<8**, against 2.63 and
9.28 in round 3 — and the shadow-map gate is 2.01 and 6.13 of that saving. `?envNoShadowClamp=1`
is a new verification toggle, so the claim is a URL apart from its control.

**What this round did not fix, with numbers.** `forest-21` is p50 21 / p99 49 / **max luma 94** and
15.3% pure black against ref 03's 35 / 152 / 175 / 1.07%; `?envNoCast=1` barely moves it, so the
crush is not the sprite shadows. The diagnosis is that the forest registers **no practicals at
all**, which is `hunts`-owned: the city at the same hour, on the same OUTDOOR base preset, reaches
p99 161 and max 253 because it has lamps. The cave's own p99 is 131-135 against ref 04's 182 and
ref 02's 254 — a preset exposure and bloom question this wave deliberately did not open. And
`pokemon/field.js` still draws its own black, sun-yaw-stretched contact ellipse under every
sprite; it desaturates what it crosses and it is what is left of the "rounded screen-axis bar" in
these frames. It is not environment's to edit.

---

### 44 — 2026-09-08 — A quarter turn made the dropped card the visible one; the wood's last blue is the rig, not the sheets; and a baked shadow is a rectangle with one hard step in it

Owner: `tiles`, round 4. Every claim below is one URL apart from its own control, and every
shot is in `docs/progress/tiles/r4/` at 1920x1080.

**(a) `dropEdgeOnTwins` was yaw-locked to the camera and not to the placement — a regression
this module shipped in round 3.**

`dropEdgeOnTwins` (#41b) collapses the X-facing half of a crossed foliage billboard because
the camera's yaw never changes and that card can only rasterise as a 1–2 px smear. What it
kept is the *Z*-facing card, and a `Placement` carries `rot`. At `rot 1` and `rot 3` the map
turns that survivor a quarter, so the card the camera sees is the one that was thrown away
and the tree renders as a trunk with a few leaves clinging to it.
`docs/progress/tiles/r4/00-rotate-before.png` is `?showcase=tiles&mode=rotate`, the mode that
exists to prove `composeMatrix`, with the `tree 2x2` row full at rot 0 and rot 2 and gutted at
rot 1 and rot 3. `10-rotate-after.png` is the same URL after.

The fix reads the placement's own yaw (`cameraFacingRot` in `instanced.js`): a model whose
twin was dropped is composed at `rot & 2`. A quarter turn of a crossed billboard carries no
information — both cards hold the same picture, which is the ≥80 %-coverage clause the drop
predicate already checks — so snapping the odd turns loses nothing that was ever drawn, while
the 180° component is kept because it mirrors the crown and that is real variety.

Two guards, and both are load-bearing. The snap is **refused on a non-square footprint**,
because `rot & 1` swaps a model's extents and un-swapping them would move the tile off the
cells the map reserved. And the effective yaw is computed at compose time and **never written
back to `p.rot`** — `terrain/draft.js` and `simulation/surface.js` read that field for the
collision footprint and must keep seeing what the author asked for.

Measured per region between the two frames, same URL one commit apart:

| region | changed px | max channel delta |
| --- | --- | --- |
| `tree` rot 0 | 3 of 68 000 | 1 |
| `tree` rot 1 | **12 404** | 213 |
| `tree` rot 2 | 0 | 0 |
| `tree` rot 3 | **11 339** | 199 |
| `stairs` row (3x1, all four turns) | 0 of 210 000 | 0 |
| `forest_entrance_front` row (4x4) | 0 of 360 000 | 0 |

So only the odd-turned crossed billboards moved: the square-footprint guard holds on the 3x1
stairs, and the four forest entrances — several cards per plane, never a crossed pair, outside
the drop predicate on purpose — are untouched.

**How live it was, said plainly.** Every shipped scene places trees at `rot: 0`
(`hunts/biomes/forest.js` passes no `rot`; the one `rot` in that file is on a dirt scuff
decal), so no forest frame in the project was carrying a gutted tree. The defect was live in
the gauntlet — in the mode whose whole job is to prove rotation — and it was a loaded gun for
the first map author who ever turns a tree.

**(b) The two tree populations: the sheets were half of it, and the rig is the other half.**

The knee shipped in #41c closed the gap from 43 degrees to 23 and a blind judge still called
"two mismatched tilesets rather than one place". Two separate causes were found, and they need
separate instruments.

*The sheets.* Re-measured off the shipped PNGs in the **linear** space the fragment shader
works in (round 3's numbers were sRGB and read a few degrees low), median hue of each foliage
sheet's own non-bark texels runs `ue_grass01` 98 · `kusa_ec1` 118 · `ki03dx` 128 · `plant01`
130 · `ki02dx` 131 · `ki03ax` 138 · `ki02ax` 143 · `ki03bx` 152 · `ki02DARKdx` 157 · `ki02bx`
162 · `ki02DARKax` 176 · `ki02DARKbx` 200 · **`ki02c` 226**.

`ki02c` at 226 is the largest outlier by a distance, and it is shared by all five trees — and
**it turns out to contribute nothing**, which is recorded here because it looked like the find
and a first draft of this entry said so. Dumped from `pack.bin`, `tree`'s `ki02c` group is two
triangles at **y 0.19**: the horizontal slice at the tree's *foot*, not a canopy layer
(`tree`'s canopy slices are `ki02bx` at 1.63 and `ki02dx` at 3.72). Its linear median value is
**0.021**, and at a 45-degree camera the trunk and crown stand on top of it. Isolated with
`?foliageBand=74` against `?foliageBand=90` — the only pair of ceilings that moves `ki02c` and
nothing else — it changes **0 pixels of 2 073 600** in `mode=trees` and **0 subpixels of
6 220 800** in the forest. It is scaled anyway, because a rule with an exception carved out for
one sheet is worse than a rule, but it did not close anything.

What actually moved the crowns is the rest of the list: `ki02DARKax` 176, `ki02DARKbx` 200 and
`ki02DARKdx` 157 — `darker_pine`'s whole set, and the reason round 3's per-texel knee only got
partway is that a knee tight enough to reach 200 also flattens `ki03ax`'s own 127-to-169 range,
which is the crown's modelling — plus `ki02bx` 162 and `ki03bx` 152, the mid-canopy slices of
`tree` and `round_tree`.

So each foliage sheet now gets a **hue scale about the bark floor**, computed at load from its
own decoded texels: no sheet's median may sit more than `FOLIAGE_BAND_DEG` (8) above the set's
own texel-weighted median (143.0 in AdAstra, so a ceiling of 151), and a sheet above the
ceiling is scaled down about 90 degrees until its median lands on it. **Scaling, not
translating**, is what makes it safe — 90 is the bark/leaf boundary, the map is monotone, and
nothing above the floor can be pushed below it. A translation would have turned `ki02c`'s
brown half orange. Six sheets scale; `ki03ax`, `ki03dx`, `ki02ax`, `ki02dx`, `plant01`, both
`ue_grass` and every `kusa` tuft are scaled by exactly 1.0 and are bit-identical, so
`round_tree` and the tall grass are untouched by this pass.

*The rig.* With the ceiling in, `darker_pine` still measured 155.6 against `round_tree`'s
137.5 — and pushing the ceiling harder stopped helping: band 8, band 0 and band −8 are three
shots that look the same (`ab/trees-band8.png`, `trees-band0.png`, `trees-band-8.png`).
Bucketing the same two crowns by brightness says why. Both trees ride the *same* curve:

| | darkest 15 % | mid | brightest 15 % |
| --- | --- | --- | --- |
| `round_tree` | 158.1 | 137.3 | 120.9 |
| `darker_pine` | 170.7 | 155.6 | 108.6 |

A lit pixel takes the warm key and comes back yellow-green; a shaded one takes the blue
hemisphere fill and comes back cyan. `darker_pine`'s sheets are 40 % darker than
`round_tree`'s (linear medians 0.141/0.105/0.266 against 0.246/0.162/0.479), so more of its
crown sits in the half of that curve where everything is blue. **The species difference in
value is being converted into a difference in hue by the lighting.**

Lifting `darker_pine`'s value was considered and refused: it erases the one thing the model is
named for, and any rule general enough to lift it also lifts `ki02c` — linear median value
0.021 — by a factor of seven. The instrument is instead a ceiling on the hue of the **lit**
colour, on foliage materials and nothing else, inserted after `#include <opaque_fragment>`
where `gl_FragColor` is still linear and the tonemap has not run. It costs `round_tree`'s
shaded side exactly what it costs `darker_pine`'s, which is the point: it is not a species
correction, it is the rig's blue-in-shade coming off both of them.

**The lit knee is 132 degrees and the number is empirical, not derived.** The frame is
measured after AgX and the grade, which push hue up by 15–25 degrees, so a knee set at the
hue one wants to see is a no-op: at 146 the crowns did not move at all (155.6, unchanged), and
the only way to know that was to shoot the probe at 100 and watch the whole wood collapse to
118. 138 / 132 / 126 were then shot and measured. 132 is where `darker_pine` comes down and
`round_tree`'s own median does **not** move; 126 starts eating the green population too.

Crown hue on the render, `?showcase=tiles&mode=trees&tod=12`, isolated trees on open lawn:

| | `?foliage=0` | round 3 (`?foliage=knee`) | round 4 |
| --- | --- | --- | --- |
| `round_tree` | 137.5 | 137.5 | 137.5 |
| `tree` | 143.3 | 143.3 | 139.6 |
| `big_tree_dark` | 151.6 | 148.6 | 140.6 |
| `darker_pine` | **180.8** | **160.6** | **146.5** |
| spread across the four | 43.3 | 23.1 | **9.0** |
| `darker_pine` P90 vs `round_tree` P90 | 210.7 / 169.7 | 180.0 / 157.1 | **154.1 / 145.8** |

Saturation and value are still not touched anywhere: `darker_pine` measures 0.404 value
against `round_tree`'s 0.529 in all three columns, so it is still the darker tree it is named
for. `ab/foliage-stack-r3-r4.png` is the three columns as pixels and
`ab/forest-12-r3-vs-r4.png` is the wood itself.

**The light-side ceiling is a daylight correction, and it had to be told so.** Tuned at noon
and left alone, it wrecks the night — measured on `?showcase=hunts&mode=forest&tod=21`, one
crown box and one lawn box, the control and the shipped frame captured back to back so they
carry the same draw count:

| knee | crown p10 / p50 / p90 | crown pixels at exactly hue 120 | lawn p50 |
| --- | --- | --- | --- |
| off | 129.1 / 151.8 / 178.6 | 4.6 % | 142.2 |
| 132 (noon's value) | 120.0 / 120.0 / 136.8 | **51.3 %** | 131.6 |
| 144 | 126.0 / **141.8** / 158.3 | 7.5 % | 142.2 |
| 150 | 128.8 / 146.8 / 165.0 | 4.6 % | 142.2 |

At noon's 132 **half the night canopy collapses onto one hue**. A night frame is dark, 8-bit
hue is coarsely quantised down there, and the ceiling pushes a whole mass of pixels onto the
`r == b` boundary; it also leaves the trees *greener* than the lawn they stand on, which is
the same "two tilesets" read at the other end of the clock. Turning it off at night is the
other wrong answer: `off` is a p90 of 178.6, which is the blue-teal conifer this whole round
exists to remove, standing in a wood at 142.

So the ceiling rides `setEmissiveScale` — the seam `environment` already drives and the clock
already falls back to — lifting `FOLIAGE_LIT_NIGHT_LIFT` (12 degrees, 132 → 144) as the lamps
come on. At 144 the crown's median lands on the lawn's own, 141.8 against 142.2, the cyan tail
still comes down from 178.6 to 158.3, and the quantisation spike is back near its 4.6 %
baseline. It is **one shared uniform object** across every foliage material of a tileset,
clones included, so the whole ramp is a single assignment and the program count is untouched.
`ab/forest-21-nolit-vs-shipped.png` is the pair; the noon numbers are unchanged by the ramp
(`darker_pine` 146.5 either way, because `nightRamp(12) = 0`).

`?foliage=knee` had to be made to mean what it says, and it is worth recording why. Pinning
the per-sheet scales to 1 while leaving the light-side ceiling on gives a flag labelled
"round 3" that renders something round 3 never rendered — a control that quietly moves is
worse than no control. It now turns both halves off, and the proof is a diff against the
frame captured from the round-3 build *before* any of this landed: `ab/trees-r3knee.png`
against `ab/trees-knee140.png` is **2 changed subpixels of 6 220 800, max delta 1**.

**Nothing else in the pack moved, and that is a byte count, not an opinion.** The coast's open
sea over a 900x260 rect is **max channel delta 0 across 702 000 subpixels** between the
shipped build and `?foliage=0`. And `?showcase=tiles&mode=ground` is **byte-identical to round
3's own frame** — 0 changed subpixels of 6 220 800 — which covers all three of this round's
changes at once.

**The uniform is the reason the program count did not move.** Every foliage material compiles
the identical source and `customProgramCacheKey` answers the identical `'foliage'`, so three
links one program and each material carries its own `uFoliageScale`. Baking each sheet's
number into the GLSL instead would have cost one program per distinct scale — six more in
`bw2-adastra` alone. `mode=trees` measures **13 programs** with the patch and 13 without.

**(c) The tileset's own baked shadow blobs are hard rectangles, and the code was already
supposed to have dropped them.**

The `CONTACT_CATEGORIES` header comment in `instanced.js` has said since round 1 that the twelve models shipping a
hand-painted `kage_out`/`h_kage` blob "keep theirs — a second one on top would double the
density". `wantsContactShadow` never excluded them, so for all twelve **both** were drawn, and
the baked one is the harder picture. Decoded, `kage_out.png` is an 8x8 sheet holding exactly
two levels — a 6x6 interior of `rgb(29,33,34)` at alpha 0.48 inside a one-texel border of
`rgb(56,60,60)` at 0.25 — and `h_kage.png` is two levels split across a row with no border on
any side at all. Neither has a gradient in it. At the game camera they are dark rectangles
with a single hard step, which is a critic's "floating black rectangles" almost word for word.

`dropBakedShadowDecals` skips those (model, group) meshes, so the generated contact shadow —
a real plateau-and-penumbra measured in cells (#30) — is left to do the job alone. Three
things kept it honest: the predicate is `decal && /kage/` on the image name, not "soft and
flat", because `kusa_ec3`, `mori01s` and `dansa01a` classify as decals too and are artwork the
tile is meant to have; it only fires where the replacement actually exists (`contact > 0` and
`wantsContactShadow`), so an interior built with `contact: 0` keeps every baked blob it ships;
and `?kage=1` puts them back for the A/B.

`ab/city-plaza-kage-diff.png` is that A/B at 5x gain and it is a field of straight-edged bars
and rectangles under the benches, hedges and lamp posts — nothing else in the frame moves.
`ab/plaza-contact-diff-crop.png` is the same region against `?contact=0` and shows the soft
generated penumbra that remains. The city plaza costs **221 draw calls instead of 234**, and
`mode=lamps` 22 instead of 27.

**What this did not fix, measured before it was blamed.** The blind panel's "black rectangles
beside each lamp" is *two* defects and only one of them was mine. On the plain `/` at tod 11
the dark rounded slab north-east of the lamp head (x 920–990, y 240–285) is unchanged by
`?contact=0` — 101.1 vs 101.3 mean red — and lifts to 177.7 under `?envNoShadow=1`. That one is
the sun's own shadow map making a rectangle out of a flat lozenge head, it belongs to
`environment` plus the lamp's geometry, and it is still there. The long hard black shadow bars
the lamps throw at tod 21 from a sun below the horizon (`13-lamps-night-after.png`) are the
same owner and were already filed as tiles coreRequest 6.

**Not commissioned, found while shooting, filed rather than fixed:** `bench_s` renders nearly
black on the paving at noon — `ab/city-plaza-kage-off.png` region (240,780)–(660,920). It is a
`prop`, not foliage, so none of this round's patches touch it.

Measured across 46 captures at 1920x1080 (18 proofs and 28 A/B controls, 39 with a JSON log): **60 fps, p95 16.7–16.8 ms, 22–386 draw calls,
3.6k–24.9k triangles, 8–23 programs, 0 console errors and 0 console warnings** in every one.
`?showcase=tiles&mode=trees` shot twice at the same URL differs by **0** on every channel.
`node tools/seams/run.js` passes: 119 files, 15 modules.

**(d) DECISIONS #41a is narrowed in place, above, and the count that replaces it.** The entry
claimed the `ki02c` convention "is why every auto-tiled edge in the game has passed round after
round" and that flipping the upload "inverts all of them north-for-south". One tile was
measured; neither claim was. Counting it properly across the fifteen shipped packs — geometric
normal `|ny| >= 0.5`, least-squares `dv/dz` per triangle — **6111** horizontal triangles run
`v` with south and **8296** run `v` with north (16 have no z extent). The horizontal faces do
not share one convention at all, so "inverts all of them north-for-south" describes a set that
does not exist, and no critic finding was ever traced to that axis. The paragraph now says
only what was measured: `ki02c` renders correctly under `flipY = true`, a per-triangle
upright-gated correction cannot disturb it, and the byte-identical `mode=ground` pair proves
horizontal tiles were untouched by the fix that shipped.

---

### 45 — 2026-09-08 — A ride is grass; the lane guarantee was one cell short of the walk; and a green selftest that builds a different map is worse than none

Owner: `hunts`, round 4. Every number below is measured off a PNG in `docs/progress/hunts/r4/`
at 1920x1080, seed 1337, and every A/B is one URL apart from its control.

**(a) The forest and meadow went tan because "walkable east" and "paved" were the same field.**

Round 3 needed an east-west leg so the party turns to face the camera, and it got one by
unioning two rides straight into `path` — the field `palette.draw('set0', …)` paints as bare
dirt. The walk worked; the picture did not. Measured with a hue/saturation/value classifier
(warm hue 25-58 deg, S 0.20-0.80, V > 0.35, HUD boxes masked), which reproduces the critic's
own figures to within half a point: the judged forest frame went 12.4 % -> **29.37 %** bare tan
and the meadow 10.0 % -> **18.38 %**, against `docs/refs/01-forest-tilemap-frame.png` at
**0.09 %** and `03-forest-voxel-night.png` at 6.73 %. Ref 01 is a party standing on grass with
the wood behind them and no dirt anywhere in frame.

The fix is a pair of names, not a tuning pass. `path` is what gets painted; **`trodden`** —
the trail plus each ride's one-cell centre line — is what the composition is arranged around,
and it is what drives `distToPath`, the undergrowth thinning, the shoulder scatter and the
wild-cell exclusion. The rides now contribute to `rideVerge` (which excludes the wood, so the
lane is clear) and to `trodden`, and **nothing at all** to `path`. In forestry a ride *is* a
grass strip cut through a plantation, so this is the reference's own answer rather than a
concession. The north-south trail is pinned to three cells (it could reach five), and its
meander amplitudes drop from 7.5/4.5 to 4.6/2.8 so the centre line moves at most 0.49 cells
per row instead of 0.80 — below the slope at which a three-cell band quantises into a
staircase with `closeCorners` filling the inside of every step.

forest default 29.37 % -> **10.59 %**, forest `route` 11.49 % -> **5.20 %**, meadow default
18.38 % -> **13.82 %**. The night frames came *with* it rather than against it: forest default
at tod 21 went 50.74 % -> **38.97 %** of pixels below luma 8, and forest `route` 45.03 % ->
38.65 %, because the fbm verge below opens as much ground as round 3's constant band did.

**(b) The tree line was a ruled line, and a ruled line is a hedge.**

Round 3's `rideVerge` opened a constant `-3 … +10` band along a low-amplitude sine, i.e. a
straight horizontal edge sixty-four cells long — the critic read the canopy as "visibly rowed
at the tree line", and it was. Both extents are now `fbm2` fields (period 9: north 2-4, south
5-10), and `open` takes one `ragged` pass, so the edge advances and retreats by five cells
while the *average* opening — the lever that bought the night crush down in round 3 — is
unchanged. The walk is then put back unconditionally as a separate field, `lane` =
`path.grow(2) ∪ rideLine.grow(2)`, because `ragged` flips boundary cells in both directions
and one flipped cell inside the corridor is a tree in the lane.

**(c) The meadow's cart track is three cells only where the bridge is.**

`bridge_v2` is one cell wide and the deck is three planks (round 3, and still right). But the
other forty rows of the north-south track do not carry a cart: `trackHalf` is 1 within seven
rows of the ford and 0 elsewhere, and the east-west lane is one rut opening to three on about
a fifth of its length. The `lane` marker also moved from cx 22 to cx 16, so after three tiles
of walk the trainer — whom the camera follows — stands seven cells short of the junction
instead of on it: the crossroads is a destination at the edge of frame rather than the subject.

**(d) The lane guarantee was one cell short of the walk, and that is all three "still files
north" framings.**

`Line.place` puts the lead at `cx + 2`; `advanceTo(3, 7)` is 22 sim ticks, which at
`walkSecondsPerTile` 0.25 is 4.4 tiles, so the lead ends at `cx + 6.4` — *stepping into*
`cx + 7`. `laneNear` checked `cx − 5 … cx + 6` and the selftest checked the same window, so
both certified a row whose next cell is rock; `makeScriptedRoute` drops that step in silence
and falls through to the next heading. Probed on the live seed-1337 map before the change:
cave `pool` at (35, 25) was clear across the old window and blocked at **both** `cx + 7` and
`cx + 8`, and the lead reported `dir 2` on `--preset pool` and on `--preset close`, which
borrowed the same marker. `ahead` is 8 now — seven the walk needs plus one of margin.

Coast was the other half: it was the one biome still calling `draft.mark` bare, on the
reasoning that a strand is open ground. It is not — `scrub`, the boulders and the shallows put
blocked cells on it, and probed on the shipped map `point` (50, 18) was blocked at `cx + 3`
and `sea` at `cx − 2`. All five coast markers go through `laneNear` now.

Verified live on the shipped map, all four biomes, every named framing, reading
`simulation.lineup()` rather than `follower()`+`player()`: **31 of 31 framings report
`dirs = 3333`**, four walkers on one row two cells apart, all facing east.

**(e) `cave --preset close`: a lane can be flat and still be a cliff to the camera.**

The critic's second regression — "the trainer is cut off at the waist by the terrace lip and
the lead's feet vanish into it, with the bottom third of the frame a flat dark void". `close`
borrowed the `pool` marker at `distance` 16, which shows 6.8 cells of ground north of the
focus and **4.3 south**, and that marker sat one cell north of the eastern terrace's riser.
`passable` cannot see a lip, because a lip is two walkable cells at different heights. So
`laneNear` grew a `south` skirt — N rows below the marker, checked across the lane's own
width, walkable *and* within 0.26 of the marker's height — and the whole lane is now
height-checked too. `close` also stops borrowing: it has its own marker in the middle of the
hall, the widest flat floor in the map, under two of the warm bulbs, asked for with
`south: 5`. If nothing in range satisfies the whole contract the skirt is what gives, not the
lane: a lip in the corner of the near half is a worse picture, a queue stacked facing north is
the defect three blind rounds named.

**(f) The cave's pool did not exist, and the module's own build report said so.**

`pool.count()` on the shipped seed-1337 map was **0**. The pool was cut last —
`pool.intersect(floor.shrink(2))` *after* the outcrop scatter and the terrace had already been
subtracted from `floor` — so two framings were aimed at a body of water that is not in the
map and the cold bulb sitting in it lit bare rock. A region that other regions may carve into
is not a region; it is a leftover. `poolTarget` is declared before either carver and both are
told to keep off it (`grow(3)`), and the pool room widened from 6.5 to 8.5 east-west because a
thirteen-cell room cannot hold both a `laneNear` lane and a lake — which is why round 3's
`pool` marker had been pushed out into the hall and the `pool` framing was a picture of the
hall. Now: `pool` 33 cells, the marker on its own south strand, water in the upper half of
both framings that aim there.

**(g) Both ends of the cave's albedo ramp were outside the picture.**

The cold end of the *rock* was `0x1f2740`, a near-black navy: the `pool` framing measured
**27.29 %** of pixels at exactly (0,0,0) against ref 02's 0.00 % and ref 04's 0.06 %. Rock in
shadow is slate, not a hole in the map — at `0x6c7691` that frame is **12.43 %**. The cold end
of the *chill* term was `0xbcdcf6` at weight 0.85, a near-white wash on a floor texture with
almost no contrast of its own to survive it: that is the critic's "pale grey slab with no rock
texture in the cave's west quarter". It is `0x9cc2e6` at 0.55 now, and the rock's chill
`0x9dc4e4` at 0.70 is `0x7f9ab8` at 0.35.

Together with the pool the cave stopped being one hue without any of it being a grade:
`--mode cave` mean saturation **0.925 -> 0.482-0.632** across the eight framings (ref 02 is
0.194, ref 04 0.773), and luminance p99 **158.6 -> 209-228** (ref 02 254, ref 04 178) — the
first time anything in this biome has crossed the bright pass outside a lamp quad.

**(h) `--envNoShadow 1` in the cave is byte-identical, so the cave's black is not a shadow.**

Round 3 filed "sun shadows are still cast inside the sealed cave" as a coreRequest against
`environment`. Re-measured this round on `--showcase hunts --mode cave --preset close --tod
12`: with and without `--envNoShadow 1` the two PNGs differ by a **maximum channel delta of 0
over 1 440 000 pixels**. The directional shadow map contributes nothing in this biome, and
that open issue is wrong as written. `--envNoCast 1` moves 3.13 % of pixels (max delta 40),
which is the sprite contact shadows and is `pokemon`'s blob plus `environment`'s cast pass.
What is left of the black is `bw2-cave`'s own `set3 cave_dark_border` art under a low ambient,
and no tint can lift it because `instanceColor` multiplies: a near-black texel stays near
black however white the tint. That is a coreRequest against `environment`'s cave exposure, not
a hunts fix, and it is filed as one rather than chased here.

**(i) The selftest was green on maps that were not the shipped maps, twice over.**

It reported 279/279 for a round in which three shipped framings still filed north. Two
independent reasons, and the first was not the tileset:

 1. **A different RNG stream.** It called `makeRng(seed, 'hunts/<biome>')`. The game calls
    `ctx.rng.fork('hunts/<biome>/<seed>')`, and `ctx.rng` is `makeRng(config.seed, 'root')`
    whose `fork` *appends* — the shipped label is `root/hunts/<biome>/<seed>`. Different label,
    different `hashString`, different xoshiro state: every scatter in the map — outcrops,
    trees, litter, wild cells — landed somewhere else. Fixed: it builds
    `makeRng(seed, 'root').fork(...)` exactly as the game does.
 2. **A stub tileset**, which is still true and cannot cheaply stop being true — loading the
    real pack needs `THREE.TextureLoader` and a DOM. Model footprints, `pick` and
    `solvePlacements` are stand-ins.

So the file now says what it is in its own last line, in full, rather than printing a bare
score: *"composition only — built against a STUB tileset, so these are not the shipped maps;
the shipped map's framings are asserted at runtime by hunts.audit()"*. Its lane window is
`cx − 5 … cx + 8` and it also asserts one height across that span. 279 -> **310** checks.

And the shipped map gets a real assertion: **`hunts.audit()`** runs on the live `MapDraft` at
the end of every `enter()`, walks every preset of the loaded biome, and `log.warn`s the
preset, the cell and the blocked offset when a lane is short or a step is in it. The
screenshot harness records `consoleWarnings` in the JSON beside every PNG, so a clean shot log
*is* the shipped-map assertion. All four biomes: `{ok: true}`, 31 framings audited, 0 warnings.

### 46 — 2026-09-08 — A constant azimuth bend clears the hidden cone twice a day and not at 21:00; `contrast` has a crush point, and a warm lift under it is what made the cave one hue

Five notes were filed against `environment`, three of them by more than one module. Two were
already fixed and are recorded here as *verified false today* rather than fixed again; the
three that were live are (a), (b) and (c) below. Every number is measured at 1920x1080 with
the HUD rows masked (top 96 px, bottom 128 px), and every before/after was shot on the **same
scene in the same minute** — `tiles` and `hunts` were both editing while this round ran, and
an earlier draft of these numbers had their changes folded into ours. The baseline is
`git show HEAD:src/environment/presets.js` swapped in for four shots, plus `?envNoConeBend=1`.

**(a) DECISIONS #40's bend clears the hidden cone at noon and midnight, and at no other hour.**

The camera looks north (ARCHITECTURE §2.7), so a shadow whose azimuth is due north runs
straight up-screen and hides behind its own caster. #40 answered that with a constant
`sunAzimuthOffset` of +38 degrees. That is a rotation, not a guarantee: the shadow's azimuth
still sweeps continuously through the whole day, so it still crosses due north — twice, once
for the sun and once for the moon. Computing the shadow azimuth every half hour says the sun
is inside the +/-38 cone from **08:30 to 12:30** and the moon from **19:30 past midnight**,
and the moon's pass covers `tod 21`, the hour every night frame in the project is shot at. At
21:00 the moon's shadow ran 0.29 lateral over a run of 1.7 caster-heights — which is why
three rounds of judges called the sprite shadows "detached" and "all the same shape": what
they were looking at was a symmetric halo of shadow sticking out around a sprite on every
side, because its shadow was directly behind it.

`pushOutOfCone` remaps the **night** key's azimuth by `sign(a) * 90 * (|a|/90) ^ 0.35`,
`a` measured from due north. Monotone, continuous, fixes 0 and +/-90, steep near 0. It does
not *remove* the pass — a shadow that swings from one side of a caster to the other has to go
behind it once, and any continuous function of the azimuth has to cross the cone — it
compresses the window from about 4.7 game-hours to about 1.0. **The day is deliberately
untouched**: its arc is what #40 paid a blind round for, and noon, 08:00 and 17:30 are the
frames every other module has tuned against. `?envNoConeBend=1` is the control and puts the
night key back on the moon's raw antipode: `forest-21` differs from it by **25.3 % of the
frame** at up to 101 levels, at identical draw calls, and the crop pair
`docs/progress/environment/r5/ship-forest-21-crop.png` against `-nobend-crop.png` is four
sprites with a shadow lying west of their feet against four sprites inside a halo.

**(b) `contrast` is a gain about 0.5, so it has a crush point — and a warm `lift` under it is
exactly how a room becomes one hue.**

`hunts` measured the cave at mean saturation 0.93-0.94 against docs/refs/02's 0.194 and
refs/04's 0.773, and proved it was not shadows: `?envNoShadow=1` gave a byte-identical PNG.
The mechanism turned out to be arithmetic, not taste. The composite runs
`... -> *gain + lift -> saturation -> contrast`, and `contrast` is a gain about 0.5, so every
display value under `0.5 - 0.5/contrast` clamps to **zero**. The cave ran `contrast 1.14`
(crush point 15.7/255) over `lift 0x1a1208` — red 26 clears it, green 18 clears it, **blue 8
does not**. So every unlit pixel in the cave had its blue channel clamped to 0 and its red
held up by the lift: the room could only ever be orange, whatever was in it. Sampled: unlit
floor rgb(69,18,0), lit floor rgb(96,30,2), and the far tray rgb(64,15,0).

Four terms fixed it, each shot on its own before they were combined, in order of how much
each contributed: `fogDensity` 0.040 -> 0.019 (at a 45 degree pitch the visible floor runs
15-30 units out and `exp(-0.04 * 20) = 0.45`, so **over half of the average pixel was the fog
colour**); `fog` 0x4a2f18 -> a cool slate 0x39415a with `fogBoost` 1.35 -> 1.05, so the air is
the cool half of the frame and the practicals are the warm half; `lift` 0x1a1208 -> a cool
0x0b1122 that clears the crush on all three channels; `saturation` 1.30 -> 1.42 with
`contrast` 1.14 -> 1.20 and `exposure` 0.80 -> 1.00 on top. `sun` stays at 5.20 and still does
not cast (#43): dropping it was tried and measured *flatter*, because in a room with no sky it
is the only thing separating a floor from a wall.

Two side effects were shot and are the reason two more numbers moved. Thinning the fog exposed
the cave map's own tray boundary as a hole, so the dome behind it is pitched at the fog's
colour rather than 0x03040a. And 30 % of the frame fell under luma 8 the moment the fog stopped
carrying the light — that was **not** the vignette (0.38 -> 0.20 moved `belowL8` by 0.7 points)
and it was **not** the fill (`ambient` 0.082 -> 0.60 moved the darkest sample by literally
nothing); it was the crush point again, and it went away when `lift` cleared it.

`cave-21`, same scene, HEAD preset -> shipped: saturation **0.942 -> 0.526**, luma sd
**21.96 -> 45.02**, p95 92.9 -> 154.0, p99 134.0 -> **204.5**, max 226.8 -> 241.6, unique
colours 51 416 -> **151 669**, `belowL8` 0.6 -> 2.78, pure black 0.00 both. ref04 is sd 37.9 /
p95 155.7 / sat 0.773; ref02 is sd 53.7 / sat 0.194.

**(c) A canopy is an argument about the sky, and at night there isn't one.**

`forest` multiplied `hemi` by 0.78 and `fogDensity` by 1.75 at *every* hour. At noon that is
most of the look; at 21:00, when the sky is already three stops down, the two compound into a
flat multiply over a frame that has nothing left to take away — `forest-21` measured mean
15.4 / p95 38.7 / 36.5 % of the frame under luma 8, while `meadow-21`, the same OUTDOOR night
keyframes with no tint at all, measured 38.5. That gap is what `hunts` filed as "no shared
lighting language between biomes". docs/refs/03 is a night forest whose *path is the brightest
thing in the picture*: what makes it read as night is the ratio, not the average.

The forest tint now branches on `isDark`. At night the fill goes up (`hemi` x1.30 instead of
x0.78 — the shade under a canopy is filled by the ground and the trunks around it, not by the
sky), the fog thins back toward the outdoor night, the extra vignette comes off a frame that
is already dark at its edges, and `exposure` carries x1.30. The **day branch is byte-identical
to HEAD** and was verified so: `forest-12`, `meadow-12` and `city-17.5` are all a 0-pixel diff
against the round-4 preset on the same scene.

`forest-21`, HEAD -> shipped: mean 15.4 -> **37.3**, sd 13.0 -> 23.4, p50 15.7 -> 42.6, p95
38.7 -> 74.3, p99 47.8 -> 82.3, max 94.1 -> 126.4, pure black 16.4 -> **7.2**, `belowL8` 36.5
-> **18.4**, unique colours 7 050 -> 22 338. And the shadow pass is now buying what it costs:
`?envNoShadow=1` moves the frame by **3.66 luma mean** and 13.4 % of its pixels for its 21
draw calls (86 vs 65), where the filed measurement was 0.6.

The OUTDOOR night keyframes moved too, and only in ways that hold `meadow-21` where it was:
`lift` 0x0c0d14 -> 0x191c28 (the same crush arithmetic as (b) — at `contrast 1.24` the crush
point is 24.7/255 and the old night lift was **entirely inside it**, so the night had no floor
at all and 3.6 % of the meadow was literally black), `saturation` 1.34 -> 1.22 (at 1.34 the
grass sampled rgb(12,75,23) against ref03's rgb(50,76,37) — the red channel was being
saturated away), `sun` 2.8 -> 3.5 against `hemi` 0.74 -> 0.60 for a wider key:fill, and
`sunTint` 0xd4dcee -> 0xb2c4e6 so the moon is actually blue. `meadow-21` 38.5 -> 40.3 mean
with pure black 3.55 -> 1.86; `city-21` 51.0 -> 49.5 mean with p99 **161.9 -> 174.6** and
unique colours 195 602 -> 224 905.

**(d) Two filed defects verified *false* today, with the URL that proves each.**

*The cave is lit by a shadow-casting sun.* Fixed in #43 and still fixed: `?envNoShadow=1` on
`?showcase=hunts&mode=cave&tod=21` is a **0-pixel** diff on every channel at identical draw
calls (118). The filed measurement is from round 3. The seam is `environment.setEnclosure(v)`
/ `environment.enclosure()` on the module's public API, and the `cave` and `interior` presets
already carry `enclosed: 1`, so a scene that roofs part of an outdoor map calls
`setEnclosure(1)` and gets the same behaviour without environment learning a biome's name.

*Sprite cast shadows are all the same shape, and overlapping ones compound to black.* Both
false. `castShadows.js` samples the sprite's **own alpha** (`texture2D(uMap, uv).a` through a
`smoothstep(0.38, 0.62)`), never a stock ellipse — what made four shadows look identical was
(a), the halo. The black `pokemon/field.js` draws under every sprite is a separate contact
ellipse and is not environment's. Compounding: on `?showcase=city&preset=plaza&tod=17.5`, base
1.69 % pure black / 7.65 % `belowL8`; `?envNoCast=1` 1.60 / 6.51; `?envNoShadowClamp=1` 2.59 /
13.09. So every projected sprite shadow in the frame together costs **0.09 points of pure
black and 1.14 of belowL8**, and #43's clamp is saving 0.90 and 5.44 of that.

**What this round did not fix, with numbers.** The highlight note is closed for the cave
(p99 202-206, max 241 across 08/12/17.5/21, against references at 158-254 / 199-255) and for
`city-21` (p99 174.6, max 253.8), and the day frames sit at the band floor (`meadow-12` p99
156.1 / max 198.9, `forest-12` 151.4 / 196.2). It is **still open** for `city-17.5` (p99
134.2, max 226.8) and for the open-air night frames — `forest-21` 82.3 / 126.4 and
`meadow-21` 66.5 / 119.5. The reason is measured rather than guessed: lowering the night
`bloomThreshold` from 0.85 to 0.55 moved `max` by 3 levels, because the whole night scene sits
under the threshold in the HDR target. A moonlit field with no light source in the frame has
no highlight to find; ref03's own highlights are a lit path and a shooting star. What would
close it is a practical, and practicals are placed by the scene, not by `environment`.
`meadow-21` also still reads more like a dim overcast day than like night, and that is a look
this round did not solve — it was pulled back to HEAD's brightness rather than shipped bright.

Finally, one note left deliberately untouched and written down so the next round does not have
to rediscover it: the **`interior` preset carries the same crush arithmetic as (b)** —
`lift 0x140f08` under `contrast 1.16` has a crush point of 17.6/255, which red (20) clears and
green (15) and blue (8) do not. No shipped scene uses `interior` yet, so it was not shot.

**Postscript, same round — a correction to the before/after numbers above, because
`src/environment/` was edited by another agent while this round was being shot.**

Caught by re-reading my own logs: `forest-default-21` measured **38.97 %** of pixels below
luma 8 in `docs/progress/hunts/r4/wip/` and **19.32 %** in `docs/progress/hunts/r4/` — with
byte-identical `hunts` code between the two, and the forest markers probed identical
(`clearing` 27,39; `path` 40,38; `deep` 24,18; `glade` 43,18). Diffing the pairs says exactly
where the drift is and where it is not:

| same hunts code, earlier vs later environment | pixels differing (>2/255) | max channel delta |
| --- | --- | --- |
| forest default, tod 11 | 10.61 % | 31 |
| forest default, tod 21 | **84.27 %** | 70 |
| forest route, tod 21 | 81.45 % | 69 |
| meadow default, tod 11 | 0.39 % | 33 |
| cave close / cave pool, tod 12 | **0.00 %** | **0** |

So the night frames moved almost entirely under `environment`'s hand, not mine, and the
"50.74 % -> 38.97 %" in (a) above spans two modules. The cave frames drifted **not at all**
between my tint A/Bs, so (g)'s `0x1f2740 -> 0x49546d -> 0x6c7691` ladder (pool frame 27.29 %
-> 22.58 % -> 12.43 % pure black) is a clean one-variable measurement and stands. The cave's
*mean saturation* claim does not: its 0.925 baseline was shot under the old environment.

A control was re-shot instead, all four frames under the environment as it is **now**, by
stashing `src/hunts/` back to HEAD — which is the **round-2** tree, not round 3 (HEAD's
`showcase.js` still has `WALKS`/`stageParty`), so it is the *pre-regression* state the critic
measured at 12.4 % and 10.0 %. It lands on those figures almost exactly, which is what makes
it usable: `docs/progress/hunts/r4/base-r2-now/`.

| default framing, one environment throughout | round 2 (pre-regression) | round 4 | reference |
| --- | --- | --- | --- |
| forest, bare tan | 11.64 % | **10.59 %** | ref 01: 0.09 % |
| meadow, bare tan | 10.05 % | **13.82 %** | ref 01: 0.09 % |
| forest tod 21, below luma 8 | 30.16 % | **19.32 %** | ref 03: 10.48 % |
| cave, mean saturation | 0.588 | **0.516** | ref 02: 0.194 |

Read plainly: **the forest is now below where it was before the regression**, and its night is
better than round 2's as well, so round 3's verge fix survived the dirt being taken out of it.
**The meadow is not** — 13.82 % against 10.05 % is a little over half the regression undone,
and the rest is the ford approach and the crossroads, which the three-plank bridge deck argues
against narrowing further. The round-3 tree is not recoverable from git (it was never
committed), so no honest round-3-to-round-4 delta exists for the night or for the cave's hue;
the round-3 column in (a) and (g) is the session-start measurement under the *old*
environment and should be read as "what the critic saw", not as one half of a controlled pair.


### 47 — 2026-09-08 — Every round is gated on a fixed matrix of measured frames

Three consecutive fix rounds on `hunts` scored 6.5, then 6, then 5.5. Each one fixed what it
was commissioned to fix and broke something it was not looking at: the east-west legs that
turned the party to face the camera also turned the wood into a highway junction, and undoing
the highway turned it into a field of lollipops. `environment` did it in one round — it
lifted the highlights and made city night measurably worse at the same time. In every case
the damage was found afterwards, by a critic, one round too late.

A builder cannot avoid a regression it has no way to see. So `tools/shots/regress.js`
captures a fixed matrix of twelve judged frames, reduces each to numbers, and compares them
against `docs/baseline.json`. Every metric carries a direction — `belowL8Pct` should fall,
`p99` should rise, `mean` and `saturation` are movement without a better — so the report
says IMPROVED, REGRESSED or MOVED rather than merely "different", and a round that trades one
for another is visible on one screen.

Two things make it trustworthy. The numbers come from the PNG a critic would open, decoded by
`tools/shots/png.js`, not from the WebGL canvas — that reads back black once the frame is
presented, and preserving it would cost every frame the game draws. And the run-to-run spread
is **zero**: with the clock frozen and the browser cache disabled, two runs over the same
matrix report no movement at all, so any delta the gate prints is real.

It measures with the HUD masked (`hudRows`), which is not a detail. Measuring with the cream
panels in frame reads p99 234 where the scene itself reaches 150, and that is exactly how I
came to tell the user that a real, repeatedly-filed defect "did not reproduce".

---

### 48 — 2026-09-08 — The lamps were the art, not the rotation; a fixture in `structures` cannot go through the AdAstra draft; and taking a lamp out of the shadow map costs the frame one highlight

**The lamp.** DECISIONS #25 read the "pale featureless obelisk" as a placement bug and fixed
it by rotation: AdAstra ships `lamp_h` in four turns, the north/south pair foreshortens down
the fixed camera axis, so the city placed only `_v3`/`_v4`. That was true and it was not
enough. Two whole-game passes and a blind judge then named the lamps *first*, from close
range, in the same words — "a plain grey untextured pole with a flat lozenge head, no bulb,
no housing, no fixture detail". Checked: `slamp03.png` is 16x32 and holds **ten** colours, a
flat blue-grey swatch, and `lamp_h` is two alpha-tested cards wearing it. There is no
rotation of nothing that becomes something.

The town now stands `structures`' authored `street_lamp`
(`tiles.find('structures', { category: 'light', subcategory: 'street_lamp' })`): 64 triangles,
two materials, a post with cast collar rings, a three-box cobra arm, and a cowled head whose
lens is its own material at `Ke 0.9`, so `tiles` ramps it at dusk the way it ramps a Poke
Center window and the city never learns the hour.

Three things had to move with it.

*It cannot go through the terrain draft.* A `Placement` names a model id and
`buildInstances` resolves it against exactly one tileset, so a `structures` id put through the
`bw2-adastra` draft would draw AdAstra's model 3. `map.js` therefore **reserves** the lamp
cells — collision, tag, marker — exactly as it already reserves the plots and the props, and
`structures.js` builds the posts. It deliberately does **not** set `draft.occupied`, because
`draft.scatter` draws from the seeded stream only *after* its occupancy test: claiming one
more cell shifts every draw after it and re-rolls the whole lawn. `place()` never claimed a
1x1 cell either, so this is byte-for-byte what the AdAstra lamp did.

*One flavour, so `head` is a quarter turn.* The authored model overhangs east only.
`lampRotFor()` subtracts the model's own derived `orientation` from the letter `LAMPS` asks
for on the cycle `composeMatrix` actually turns through (`e -> s -> w -> n` as `rot` counts
up), so re-exporting the art pointing north would still land every lamp correctly.

*The bulb is the lens, not a guess off the bounds.* The old `bulbOf` heuristic ("half a cell
short of the far end, a little below the top") was fitted to AdAstra's card and lands 0.26
west and 0.19 above the authored lens. The pack says which materials emit
(`emissiveMaterials`) and each material is its own geometry group with its own bounding
sphere, so the lens centre — `(1.32, 3.45, 0.50)` in model space, confirmed by probing the
running page — is a lookup, turned by the same `rot` the mesh was placed with.

**The black rectangles beside each lamp** were two artifacts wearing one silhouette, and only
one of them was still there. The baked `kage_out` decal is already dropped by
`dropBakedShadowDecals` (DECISIONS #44) — probing the scene for the old lamp found
`lamp_h_v4#0` and no `#1`, i.e. one mesh where its two groups would give two. What remained is
the lamp's own entry in the sun's shadow map: at 21:00 the post drew a hard streak across the
grass and the head, hanging a cell out on the arm, dropped a *detached* black lozenge clear of
it. The lamps are now their own `InstancedWorld` (`city:lamps`) purely so they can carry
`castShadow: false` at construction. Net zero draw calls — two leave `map:demo-city`, two
arrive. A street lamp is the one object in the scene that is itself a light source at the hour
the artifact appears; and the daylight shadow it gives up was only saying "the post meets the
ground", which the generated contact quad already says softly and at every hour: in
`docs/progress/city/r3/n12-lampfoot.png` the lawn inside the quad reads `rgb(31,108,28)`
against `rgb(88,154,84)` three cells away, over a soft disc two and a half cells across.

**What it cost, measured.** Isolated with a contemporaneous A/B — the reverted files back in
`src/city/`, `regress.js --only city`, then the new ones — because three other modules were
being edited while this round ran and the twelve-frame gate cannot tell whose delta is whose.
The reverted state reproduced `docs/baseline.json` exactly (0/0/0 on all three city rows), so
everything below is this change and nothing else:

| row | metric | before | after |
| --- | --- | --- | --- |
| `city/high-street/21` | max | 247 | 243 |
| `city/high-street/21` | belowL8Pct | 23.20 | 22.68 |
| `city/high-street/21` | pureBlackPct | 5.446 | 5.183 |
| `city/high-street/17.5` | max | 230 | 221 |
| `city/plaza/12` | — | all metrics inside tolerance | |

Both `max` losses are the same fact: **the programmer art was the brightest thing in the
frame.** At 21:00 the 247 was `slamp03`'s untextured `f8f8f8` block, which `tiles` derives an
emissive of 1.0 for because the material is used only by `light` models; at 17:30 the 230 was
that same flat lozenge catching the low sun at (562,181), and with it gone the frame's peak
falls back to the HUD panel's own 221. Losing a white swatch is the fix, not a side effect.

The night half is worth recovering anyway, and it is recovered *without* whitening the lamp.
`environment/lamps.js` says a sodium lamp is "a small white filament inside a large orange
glare"; the glare half was true and the core was not, because the glow quad's peak is
`3.2 * intensity * colour` and `0xffb166` through AgX comes out `rgb(255,214,170)` — warm all
the way in. Making the lamp itself whiter would repaint the ground pool and the halo with it,
which is the "heads render pale WHITE, not the 0xffb166 sodium the code specifies" the round-2
critic already filed. So each lamp registers a **second** bulb at the same point: `0xfff0d8`,
`size 0.22` against the sodium bulb's 0.85, `point: false` so it never takes one of the eight
`PointLight` slots and `pool: false` so it paints no second decal. It rides the same quad mesh
— no extra draw call, no extra program. Swept and measured: max 220 with no filament, 233 at
intensity 1.0, 238 at 1.5, **243 at 2.2**, while `mean` moves +0.11 and `over200Pct` −0.03.

**Two things left open, neither of them this module's.**

*The away-side faces go to zero in daylight.* The post's shaded column measures `rgb(0,0,8)`
and the head's `rgb(24,1,1)` at noon, while `post.png`'s darkest texel is `(74,74,70)`, every
vertex colour is white and every normal is an axis-aligned unit. It survives `castShadow:
false` **and** `receiveShadow: false` on the world, so it is not the shadow map, and it
reproduces in `?showcase=preview&mode=structures&filter=light` with no city code in the frame.
Note that `preview` declares `needs: ['tiles']` and boots **without** `environment`, so the
preview repro does *not* prove it is the hemisphere fill — it is either that or `tiles`'
material setup for an authored pack, and I could not discriminate from inside `city`. Filed
for whichever owns it, with the pixel values above. Same family as the critic's "trees render
near-black". At the game camera it is a six-pixel column on a post, so it ships.

*`lamps.nearest()` does not filter `point: false`.* `update()` does — line 436, `.filter((o)
=> lamps[o.i].point)` — but `nearest(focus, n)` ranks every registered bulb by
`intensity / (1 + d²)`, and the filament outranks the sodium bulb it is stacked on (2.2 to
2.0). `environment/index.js:825` asks for `nearest(focus, 4)` to aim character shadows, so a
scene with filaments would get two lamps' worth of answers where it asked for four. It is
**latent, not live**: that call is gated on `enclosed >= 0.5` and the `city` preset is
`enclosed: 0`, so nothing in this town reaches it today. Filed as a coreRequest — `nearest()`
should skip `point: false` bulbs exactly as the point-light pool does — and recorded here
because the next scene to register a decorative bulb indoors will hit it silently.

### 49 — 2026-09-08 — A Poisson radius of 1.75 can only make crowns *touch*; the trail's transition was stamped twice down the middle of the road; and the only honest measurement in a tree three agents are editing is a control taken minutes apart

`hunts`, round 5. The brief was one thing — **make the wood read as a wood** — with a hard
constraint: a higher score and **zero regressions on `tools/shots/regress.js`**, because the
three rounds before this one each fixed their brief and broke something they were not looking
at (6.5 → 6 → 5.5).

**1. The plantation was arithmetic, not taste.**

Four rounds of this file drove the tree scatter off `canopyAt`, as `spacing = 3.1 −
canopyAt·1.35`, and `canopyAt` clamps to 1 — so the radius bottomed out at **1.75**.
`scatterSpaced` rejects a pair on `dx² + dz² < r²`, and the smallest lattice distance above
1.75 is **2**. A 2×2 model at pitch 2 has a footprint that *abuts* its neighbour and can never
overlap it, so every crown in the deep wood was ringed by its own cell of lit floor with its
own root decal under it and its own separate cast shadow — which is, word for word, what the
critic read off the pixels, at "a constant 415-430px pitch across five columns" and "roughly 5
rows x 9 columns of the same crown silhouette".

Two changes, both measurable rather than argued:

* **A separate field.** `packAt` is the packing radius; `canopyAt` stays the floor shade.
  They could never be tuned apart while they were one function: any attempt to close the
  canopy repainted every ground tile in the map at the same time.
* **A floor of 0.95 and a linear range to 3.3**, driven by its own period-7 `stand` field
  rather than by the same lobes that shade the floor. Below 1 the cell next door is legal;
  below √2 the diagonal is. Measured on the shipped seed-1337 map by building it both ways —
  the file reverted to its round-4 behaviour and built again, not inferred from the spacing
  formula: nearest-neighbour distance between trees **2.00 / 2.00 / 2.00** (min / p25 / p50)
  → **1.00 / 1.41 / 1.41**, trees 399 → 681, and the share of crown-covered cells covered by
  *two* crowns **18.1 % → 52.8 %**. Triangles 24 924 → 31 056, draw calls
  unchanged at 86 (they are instances of models the map already used), 60 fps.
* **`distToPath` is out of the packing entirely.** A ride is a two-cell gap that already
  carries its own treeless verge — 2-4 cells north, 5-10 south — and thinning the wood for
  four *more* cells behind that verge is what made the tree line the row of lollipops the
  `route` framing is a picture of. The verge extents are untouched; they are what bought the
  night crush in #45 and they were not this round's lever.
* **The clearing edge thins over 7 cells, not 4**, and that number was chosen against the
  gate rather than by eye: at /4 the golden-hour frame regressed `belowL8Pct` 5.19 → 6.68 and
  `p99` 132 → 126, because every crown added near an opening throws a long low-sun shadow
  across the one part of the frame that has light in it. At /7 the deep mass is unchanged and
  the frame is inside tolerance.

Two smaller pieces of the same complaint. **The crowns are no longer all at one yaw**: half
are placed at `rot 2`, hashed off the cell. The odd quarter turns are deliberately unused —
these are crossed billboards and `dropEdgeOnTwins` (#41b) throws the X-facing card away, so
`rot 1` and `rot 3` render as a bare trunk, which is the sliver `cameraFacingRot` exists to
snap away; `rot 2` keeps the card the camera sees and mirrors the picture on it. And **the
3×3 crown is checked on all nine cells**, not on three corners: `wood` is `open.invert()`
after a `ragged` pass, so one-cell notches exist, and a big crown straddling one wrote
`collision: 'block'` onto a cell the rest of the file believed was open — the exact shape of
bug that shows up a round later as a party walking north.

**The front rank keeps its trunks whatever the canopy does, so something has to stand in
front of them.** A cell one row south draws about 53 px lower at this camera, the root decal
is ~40 px tall and a `hedge1` is ~64, so a bush in *front* of the tree line covers only the
bottom dozen pixels of the trunk behind it — a bush on the *same cell* shares the trunk's base
and occludes the whole decal. Both rows are now scattered (`face` at 1.35, `skirt` at 2.2),
and the skirt excludes `lane` outright rather than trusting a distance test, because a
`block` hedge in the walk is a framing whose east leg `makeScriptedRoute` drops in silence.

**2. The trail was a divided road, and it is a pack defect, not a composition one.**

The critic: *"a 294px band (~5 cells) split into three tan runs by two grass ribbons"*, in
both forest and meadow, at every hour. Round 1's header claimed this was solved. It was not,
and the reason it survived four rounds is that the field is innocent: `path` is **three cells
wide** (four at the meander steps, from `closeCorners`), and `solvePlacements` emits nothing
outside the field, so the brief's own hypothesis — border slots painting the grass cells
outside the field — is ruled out in the source.

What is actually wrong is that `bw2-adastra`'s `set0` `edge_w` and `edge_e` come out of the
pack **mirrored about their own centre**: the strip of grass the artist drew on the tile's
*outer* edge is stamped on its *inner* one. So a three-cell trail draws as
`tan | ribbon | tan | ribbon | tan` with its outer edges meeting the lawn at a bare seam, and
the transition running down the middle of the road twice. Scanned off the shipped frame at
1920×1080: tan 77 px, green 12, tan 76, green 15, tan 76.

The fix that ships is `SET0_OUTWARD` in `hunts/palette.js` plus a `rotate` option on
`palette.draw`: `rot 2` on those two cases and nothing else. A 180° turn is a horizontal
mirror *and* a vertical one, and a vertical mirror is a no-op on a vertical strip of grass, so
the turn is exactly the correction those cases need. The four outer and four inner corners are
**not** turned — their art is diagonal, a quarter turn moves it to the wrong diagonal, and
they are a handful of cells at the meander steps against ~200 cells of straight run. Shot
three ways (all cases at `rot 2`; a full per-case table of 0/1/2/3; the two edges only) and
looked at before choosing: `docs/progress/hunts/r5/`. Applied in `forest` and `meadow`, which
are the two the critic named; `coast`'s track has the same defect and is left for next round.

The real fix belongs in the exporter, where one rule covers every slot of every pack, and is
filed as a coreRequest — the same address as #41a and the `tiles` roof-sign defect.

**3. What the gate can and cannot attribute when three agents share a tree.**

`regress.js` was clean at 0/0/0 when this round started. Half an hour later it reported six
regressions, two of them on `city/high-street` — a frame in which the shot JSON says
`hunts:skipped`, i.e. this module is not even initialised. `src/city/*` and
`src/environment/index.js` had mtimes from *one minute* before that run.

So the only honest measurement is a **control taken minutes apart under the same drift**:
`src/hunts` reverted to its session-start behaviour, `regress.js --only hunts`, restored,
`--only hunts` again. Both halves, all seven hunts rows:

* `cave/12`, `coast/12`, `meadow/12`, `meadow/21` — **every metric identical to three
  decimals.** The meadow road fix moves **5.77 %** of the pixels in its judged frame and does
  not move one metric, because swapping a green ribbon inside the band for a green fringe
  outside it preserves the histogram. That is the ideal shape for a change like this.
* `forest/12` — mean −0.16, `belowL8Pct` −0.018.
* `forest/17.5` — mean −2.58 (tol 4, no direction), `p99` −4.00 (tol 4, at the boundary and
  not flagged), `belowL8Pct` +0.546 (tol 0.8).
* `forest/21` — `belowL8Pct` +0.556 (tol 0.8), `pureBlackPct` +0.075 (tol 0.5).

**Zero REGRESSED rows on this module's own frames, controlled.** The remaining cost is
physics and is stated rather than hidden: at golden hour, a mask of the sub-luma-8 pixels
(`docs/progress/hunts/r5/mask-below-luma8-17.5.png`) is mostly the *unlit halves of the crowns themselves*, so +70 %
crowns buys +0.55 points of crush. `mean` and `p99` fall for the same reason — more of the
frame is mid-green canopy and less of it is sunlit lawn.

Two knobs were tried and rejected with numbers rather than dropped quietly: cutting the tree
count back (681 → 666 → 606) moves `belowL8Pct` at 17.5 by 0.005, so the crush is not a
function of how many trees there are but of *which cells* are wood — the `distToOpenings`
ramp, which is why that is where the tuning went. And `FLOOR_SHADE` was left alone in both
directions: darkening it can only push `belowL8Pct` up, and lightening it to buy margin would
undo the one thing the brief asked for.

**Two selftest checks now stand behind all of this** (310 → 315), because "denser" is not
something a screenshot can be diffed on a round later: the canopy must interlock on more than
40 % of its covered cells (round 4 measures 18.1 there, round 5 measures 52.8 — both built
through the same stub, so the threshold sits between two measurements rather than at a round
number), the median nearest-neighbour distance must be under 1.9 (round 4's was 2.00 at the
minimum, the first quartile and the median alike, which is what a lattice is in numbers), the crowns
must not all be at one yaw, and `palette.draw` must pass `rotate` through — because if it ever
stops, the road silently goes back to being divided and nothing says so.

### 50 — 2026-09-08 — `lift` is authored in one colour space and delivered in another, which is why two rounds of "raise the lift" moved nothing; and the caster-less slabs are trees

Every number below is 1280x720 with `hudRows: 60`, the same reduction `tools/shots/regress.js`
uses, and every before/after was shot **in the same minute on the same tree** — `city`,
`tiles` and `hunts` were all editing while this round ran, and `docs/baseline.json` had
already drifted under them before I touched anything (see (e)).

**(a) The crush point is real, and the lift that was supposed to clear it was ten times too
small. This is the round's main finding.**

`core/render.js` composites `agx(scene * exposure) -> *gain + lift -> saturation -> contrast`,
and `contrast` is `(x - 0.5) * c + 0.5`, a gain about 0.5. So it has a crush point at
`0.5 - 0.5/contrast` — at the night's 1.22 that is **0.0902**, or 23/255 — and everything
under it clamps to zero. #46 got that far. What #46 missed is where the lift actually lands:
`presets.js` authors it as a hex, `key()` runs it through `new THREE.Color(hex)`, and
`THREE.ColorManagement` is on, so the hex is converted **sRGB -> linear** on the way in.
`lift: 0x191c28` does not deliver `(25, 28, 40)/255`. It delivers `(0.0097, 0.0116, 0.0212)`,
which is `(2.5, 3.0, 5.4)/255`. Every night lift this project has shipped has been an order of
magnitude *inside* its own crush point, which is why #46 raising `0x0c0d14 -> 0x191c28` and
calling the floor fixed did not move `belowL8` at all.

The symptom is not "the night is dark", it is **single-channel pixels**. Histogramming the
shipped `city-21` PNG by exact RGB: 4.58 % of the frame at exactly rgb(0,0,0), 1.34 % at
(1,1,1), then 0.43 % at **rgb(25,0,0)**, 0.39 % at (24,0,0), 0.38 % at **rgb(0,0,50)**,
0.37 % at (0,0,49). `forest-21` is the same shape with green surviving: 8.42 % pure black then
a ladder of **rgb(0,k,0)** for k = 1..9. That is `saturation` above 1 pushing the two weaker
channels of a dark pixel below the crush point and `contrast` clamping them to zero — the
exact mechanism #46 diagnosed for the cave, running in every night and golden-hour frame in
the game.

Fixed by sizing the lift against the crush point and paying for it: the two deep-night keys go
`lift 0x191c28 -> 0x3a3f52` with `exposure 0.288 -> 0.26` (so the midtone an offset would
otherwise raise stays put) and `saturation 1.22 -> 1.34` (so the colour a bigger offset washes
out comes back). Blue hour and astronomical twilight get the lift only. The golden hour was the
same bug with a **warm** lift, which is #46(b)'s one-hue cave verbatim: `0x120d07` delivers
`(0.0060, 0.0040, 0.0021)` under a crush point of 0.1183, so a golden-hour shadow had blue
clamped to zero and red held up by the lift and could only ever be orange. It is
`0x242a3a` now, cool, with `exposure 0.425 -> 0.40` and `saturation 1.42 -> 1.50`. The five
day keys got the same treatment at a quarter of the size.

Measured, shipped preset against the same-minute control:

| frame | belowL8 | pure black | p99 | max | mean |
| --- | --- | --- | --- | --- | --- |
| `city-21` | 15.31 -> **11.11** | 4.22 -> **0.76** | 136 -> **148** | 241 -> **250** | 40.7 -> 45.2 |
| `forest-21` (vs baseline) | 18.37 -> **11.45** | 7.31 -> **1.78** | 84 -> **90** | 161 | 37.6 -> 44.3 |
| `meadow-21` (vs baseline) | 8.08 -> **4.92** | 3.01 -> **0.74** | 68 -> **74** | 161 | 38.2 -> 45.4 |
| `forest-17.5` | 9.54 -> **3.84** | 1.52 -> **0.07** | 129 -> 131 | 221 | 34.8 -> 38.8 |
| `city-17.5` | 5.29 -> **3.23** | 1.32 -> **0.59** | 138 -> 141 | 221 | 58.7 -> 61.5 |
| docs/refs/03 (night) | 9.82 | 0.68 | 159 | 217 | 45.2 |

`forest-21` at mean 44.3 / `belowL8` 11.4 / pure black 1.78 is the closest any frame in this
project has been to `03-forest-voxel-night.png` (45.2 / 9.8 / 0.68). The references were
measured with the same reducer and are worth writing down: ref 02 `belowL8` 0.00 / black 0.00,
ref 04 0.05 / 0.00, ref 03 9.82 / 0.68. Ref 01 reads 17.2 % black and that is its letterbox,
not its picture.

**(b) `pushOutOfCone` was not making city night worse. The crush was, and the bend was being
blamed for it.**

The critic isolated the bend with the flag it shipped and measured `city-21` at 24.75 %
`belowL8` / 5.10 % black against `?envNoConeBend=1`'s 17.01 / 3.97 — seven points, which is
what this round was told to fix or default off. With the crush fixed, the same A/B on the same
scene in the same minute is `belowL8` **11.11 / 8.99** and pure black **0.76 / 0.41**. The
bend's cost is **2.13 points**, not 7.7, and on `meadow-21` the bend is now the *better* of the
two (4.92 against 5.66). Seven of those nine points were never the azimuth: they were dark
pixels that the bend moved from one side of the crush point to the other, on a frame whose
floor was ten times below that point.

So the bend stays on. It is buying the thing three rounds of judges filed — at `tod 21` the
party's shadows lie east of their feet instead of haloing them, which
`docs/progress/environment/r6/forest-21.png` shows and `city-21-nobend.png` is the control for.
What is still open is the residual: the bent moon throws the high street's own buildings across
the path, and the frames that pay for it are the ones with tall casters. The untried fix, for
whoever takes it: feed the bent azimuth **only** to `castShadows.js`, which is the only thing
that can shadow a sprite (#33), and leave the shadow map and the Lambert term on the raw moon.
That is two light directions in one frame and it should be measured, not assumed.

**(c) The cave's bloom halos every character in the room, and no threshold separates a lit
sprite from a lamp.**

#46 dropped the cave's `bloomThreshold` to 0.72 to buy the highlight every blind round had
asked for, and it worked — and it also made the trainer under the west lamp a cream blob with
no outline, no eye and no mouth. Diffing `cave-12` at threshold 0.72 against 3.2 is 27.5 % of
the frame and the mask is **every sprite in the room wearing a halo**, not the lamps.

The threshold cannot fix it, and the measurement says why: a lit sprite's face and a lamp's
ground pool leave the bloom at the *same* threshold. Sweeping 0.72 / 0.90 / 1.10 / 1.30 / 1.80
/ 2.40 / 3.20 moves `over200Pct` 1.244 -> 1.126 -> 1.032 -> 0.964 -> 0.873 -> 0.835 -> 0.821,
against 0.812 with the bloom off entirely — so by 2.4 there is no bloom left, and the sprite is
only readable from about 1.8 up. They are the same brightness; the choice is which one to keep,
and it is the sprite.

Shipped: `bloomThreshold 0.72 -> 1.80` with `bloom` held at 1.30, and `exposure 1.00 -> 1.20`
to buy back the highlight the threshold gives up. `cave-12`, baseline -> shipped: p99
206 -> **204**, max 248 -> 248, `over200` 1.244 -> 1.175, `belowL8` **1.913 -> 0.073**, pure
black 0.00 both, mean 59.97 -> 64.89. The highlight is held inside the gate's tolerance and the
sprites are back; `docs/progress/environment/r6/cave-12.png` is the frame. The `exposure` lift
is also `hunts`'s round-4 request arriving by a different route — unlit rock in there is dark
rather than exactly (0,0,0), and `belowL8` 0.073 sits between ref 02's 0.00 and ref 04's 0.05.

**(d) The caster-less slabs are the town's trees, and both fixes for them cost more than they
are worth. Measured, and not shipped.**

Four rounds have called `crops/diff-hs-17.5.png` "giant straight-edged trapezoids with no
caster", and the integrator disproved the obvious cause (`shadowExtent` 56 -> 100 -> 160 moves
coverage under a point). It is none of the three untested suspects either. `?envDumpCasters=1`
lists all 83 shadow casters in the high street with their `side` / `shadowSide` / `alphaTest`:
every tree material is `alphaTest 0.35`, `transparent: false`, with a map, so the shadow pass
*is* cutting the leaf silhouette, and no ground tile is a caster at all, so the lawn cannot be
self-shadowing. `?envCasterOff=tree,pine` removes **100 %** of the slabs and leaves a clean
lawn with the buildings' and lamp posts' own shadows on it
(`docs/progress/environment/r6/city-17.5-nocaster-tree.png`). They are 117 real tree instances,
standing just outside the frame, raked by a shown sun altitude of **8.64 degrees** at `tod 17.5`
— a shadow run of **6.6x** the caster's height, and 16.6x at 18:00 where the elevation floor
binds. The canopy's own gaps stretched 6.6x are the corduroy. `?envNormalBiasMul=20` also
removes them, which is what sent three rounds looking for acne: at a grazing sun a normal offset
of 1.5 units displaces the shadow lookup **8.8 units laterally**, which is wider than the band.

Two fixes were built and measured and both are worse than the defect:

*Cap the shadow run by raising the key's elevation floor* (`?envMinElevDeg`, with the #40 tilt
gain unclamped below 1 so flat-ground brightness is held — verified: at 17.5 the ground takes
`0.2419 * 20 * 0.688 = 3.329` against the old `0.1503 * 20 * 1.107 = 3.328`). At 14 degrees the
city lawn is clean and `city-17.5` gains p99 141 -> 160 for a mean of 61.5 -> 70.5. The same
flag costs `forest-17.5` **mean 38.8 -> 64.8** — the wood's entire dusk is those long shadows,
and shortening them turns 17:30 into midday.

*Make the grazing-hour shadow shallower* (`?envShadowIntensity`, three's
`LightShadow.intensity`). At 0.7 `city-17.5` `belowL8` goes 3.23 -> 2.15 and `forest-17.5` goes
3.29 -> 0.64 — and `docs/progress/environment/r6` has the frame that killed it: a flat green
forest at 17:30 with no golden hour left in it, mean 41 -> 60.

Both flags default to the shipping rig and are byte-identical when off (`TILT_GAIN_MIN` is 1
unless `envMinElevDeg` is set — it has to be, because at sunset `trueAltitude` clamps to 0 and
a floor below 1 there would take 55 % of the key off the sunset frame). The next round's
options, in the order I would try them: ask `city` to move the tree line, or give the shadow a
distance-from-caster falloff, which is a core shader change and not a preset one.

**(e) `docs/baseline.json` had already drifted before this round started, and half of one
headline number is not mine.**

The gate reported `city/high-street/21` `belowL8` 23.2 -> 11.11. Shooting the same frame with
`src/environment/` alone reverted, in the same minute, reads **15.31** — so 7.9 of those 12.1
points were somebody else's edit to `src/city/` between the baseline being accepted at 16:02
and my first shot, and 4.2 are mine. Same story with the round's one REGRESSED row,
`city/high-street/17.5 max 230 -> 221`: I measured max **221** on that frame at 16:20 with an
environment that was still byte-identical to the baseline's (the only code I had added was
multiply-by-one), and `src/city/{layout,map,structures}.js` were written at 16:16, 16:17 and
16:18. It is not environment's. In the other direction, the same control says `forest-17.5` had
drifted from `belowL8` 5.19 to **9.54** and `city-17.5` from 4.13 to 5.29 under other modules
before I started, and this round takes both below where the baseline had them.

One caution for whoever reverts a module to attribute a number: `git checkout -- src/<module>/`
goes to **HEAD**, not to the baseline, and on this tree HEAD is a round behind every visual
module. Doing it threw away round 5's uncommitted `environment` and briefly measured the
*round-4* look (`cave-12` at saturation 0.932, `forest-21` at mean 16.3) — restored from a
copy taken first, which is the only reason this note is not an apology.

**Postscript, same round — the control in (a) and (e) was the wrong tree, and the correction
runs the other way.**

Caught in review. `git checkout -- src/environment/` goes to **HEAD**, and on this tree HEAD is
`environment` as of round *four*; the paragraph at the end of (e) says exactly that and then the
table in (a) and the split in (e) use those round-4 shots as the "before" anyway. They are not a
control for this round — they are a control for the last two rounds put together, which
under-credits this one and mis-credits `city`. The right controls were already in this round's
own logs: three frames shot on the round-5 preset **after** `src/city/{layout,map,structures}.js`
were written at 16:16-16:18 and **before** any preset change here (16:20 and 16:30). Corrected:

| frame, round-5 preset -> shipped | belowL8 | pure black | p99 | max | mean |
| --- | --- | --- | --- | --- | --- |
| `city-21` | 22.69 -> **11.11** | 5.19 -> **0.76** | 142 -> **148** | 220 -> **250** | 38.7 -> 45.2 |
| `city-17.5` | 4.11 -> **3.23** | 0.86 -> **0.59** | 138 -> 141 | 221 -> 221 | 58.9 -> 61.5 |
| `forest-17.5` | 5.91 -> **3.84** | 0.26 -> **0.07** | 129 -> 131 | 221 -> 221 | 36.0 -> 38.8 |

So `city-21`'s 12.1 points of `belowL8` are **11.6 mine and about 0.5 somebody else's**, not the
4.2 / 7.9 the body claims, and `forest-17.5` and `city-17.5` had drifted far less than the
round-4 comparison made it look. The `max 230 -> 221` attribution is unaffected and stands: it
rests on the 16:20 shot, which was round-5 preset plus multiply-by-one, and on the mtimes.

Two other numbers in this entry come from the same wrong control and should be read as
round-4-to-now rather than as this round's work: `forest-17.5` "drifted from 5.19 to 9.54" and
`city-17.5` "from 4.13 to 5.29" in (e). Against the real control the drift was 5.19 -> 5.91 and
4.13 -> 4.11.

**And the frame `hunts` actually asked about.** (c) claimed the cave `exposure` lift answered
their round-4 request by a different route, on the strength of `cave-12` alone. Their
measurement was the *pool* framing — `docs/progress/hunts/r4/cave-pool-12` measured **27.29 %**
of the frame at exactly rgb(0,0,0) under the round-3 environment. Shot now, shipped preset:
`?showcase=hunts&mode=cave&preset=pool` reads **pure black 0.000 %** at `tod 12` and **0.000 %**
at `tod 21`, with `belowL8` 0.34 and 1.61 and p50 24 and 23. Unlit rock in there is dark without
being nothing, which is the request as they wrote it.


### 51 — 2026-09-08 — The encounter had five beats and one picture; `advanceToStage` cannot rewind, so two of them were the same frame; and a mirrored instance is an unlit instance

`encounter`'s systems were finished and verified — 35/35 selftests, deterministic from
`(seed, index)`, the whole eighteen-ball line evaluated through `economy` — and the whole-game
critic still wrote **"there is no encounter on screen at all: `enc-default.png` shows the catch
resolving entirely inside a developer readout — odds, roll, shakes, band table."** That verdict
is correct and it is not about odds. It is about the fact that the module's default frame held
five same-sized sprites standing in the same grass, no mark on any of them, and a side panel
narrating which one the picture was supposed to be about.

**(a) The era already solved this and the reference has it in frame.**
`docs/refs/01-forest-tilemap-frame.png` is a trainer, a Pokemon in grass, and **one white balloon
with a red exclamation mark**. That balloon is the entire difference between "two characters in a
field" and "an encounter". So `ball.js` gained `ALERT_ART` — a 12-texel balloon inside the same
16-texel frame the ball uses, for the same reason (a quad one world unit across is the only size
at which a texel lands on a whole number of internal pixels, #18) — and `advanceScene` hangs it
over the wild from the moment it breaks cover until the ball leaves the hand.

Measured on the shipped `docs/progress/encounter/r3/reveal.png` at 1920x1080: balloon paper is a
114x126 px blob centred at x 545.5, the wild's body 135x141 centred at 583, and the balloon's tail
clears the wild's ears by 55 px. The 37.5 px horizontal offset is **not** a placement bug — it is
the 45-degree camera. A point lifted ~2.1 units above the wild's feet is ~1.5 units nearer the
camera, so it magnifies away from the principal point, and the wild is 377 px left of it:
377 x 1.5/16.2 = 35 px, which is what was measured. Every tall sprite in this project leans the
same way; the balloon leans with the world it is in.

Lit `MeshLambertMaterial` with `emissive 0x4a4438`, not `MeshBasic`. A marker whose whole job is
to be seen has to survive `mode=night`, and an unlit cutout at 21:30 is a black rectangle; a
basic material instead ignores the hour entirely and floats flat midday white over a graded
scene. The emissive is a floor, far below every `bloomThreshold` keyframe in `presets.js`
(1.15 noon / 1.8 golden / 2.6 night), so it never blooms.

**(b) `advanceToStage` cannot rewind, and that silently collapsed two modes into one frame.**
The showcase staged every mode as

```js
enc.advanceToStage('appear', 1);      // let the reveal play out
if (stop.throw) enc.attempt(ball);
enc.advanceToStage(stop.stage, stop.at);
```

`advanceToStage` computes an **absolute** target step and calls `advance(max(0, target - step))`.
Rolling to `('appear', 1)` first therefore parks the scene at the *end* of the appear beat, and
every later request for a step *inside* that beat advances by zero. So `mode=reveal` asked for
0.5 of the beat and got 14 of 14 — the settled frame, after the hop had already come back down.
It is written on the round-2 shot in this module's own panel: `f02-reveal-morning.png` prints
`animation appear @ step 14`, and the critic's issue [15] ("the reveal does not read as a
reveal") is exactly this bug seen from the outside rather than the freeze fraction it was filed
as. The pre-roll is now guarded by `if (stop.throw)`, which is the only case that needs it —
`attempt()` merely *queues* the throw (`marks()`), and queuing it before the reveal has played
is what stops `automation`'s synchronous ball skipping the animation in the live game.

**(c) The grass has to react before anything comes out of it, or there is no reveal to see.**
`T.APPEAR` 14 -> 20 with `T.RUSTLE = 0.4` of it: for the first eight steps the wild is not drawn
at all and only the disturbance is. That window is what `mode=approach` freezes in (0.3) and
`mode=reveal` is now unambiguously past it (0.7 — the apex of the hop, with the squash-and-
stretch at its tallest). Five beats, five modes, each judgeable on its own: `approach`, `reveal`,
`throw`, `shake`, `caught` / `escaped`.

**(d) The rustle is leaves now, and the first two cuts of it were both wrong in a measurable way.**
Round 2 drew the disturbance with the capture burst's own four-point stars. At `mode=approach`
that is ten 65 px stars on a 77 px ring — a solid overlap — and the frame showed one horizontal
white bar. A white bar in grass reads as *magic*; a capture and a shiny should read as magic, a
Pokemon pushing through grass should read as grass. So the rustle got its own 8-texel blade art
and its own lit material.

Two corrections, both from crops rather than from reasoning:

1. **The outline ate the sprite.** The first blade was fully outlined — 8 of 35 filled texels
   were `o`, plus a dark shade side — and at 3x the ring was a clump of near-black lumps with
   cream highlights (`docs/progress/encounter/r3/crops/leaf-outlined-3x.png`; the full frame it
   was cut from is not retained). Same defect the ball had in round 1 (issue [1], 50.4 % pure
   black) at one-quarter the size. Thinned to a partial outline on the lower-right and the shade
   lifted to a mid green — `crops/leaf-shipped-3x.png` is the same crop of the shipped build.
2. **A mirrored instance is an unlit instance.** Varying a pixel sprite by flipping the sign of
   `scale.x` is free where a rotation is not (#18) — and it is wrong for a *lit* instance. A
   negative determinant inverts the normal matrix, so every mirrored leaf turned its normal away
   from the sun. The two crops side by side are unambiguous: pale, dark, pale, dark around the
   ring, four of nine with no lit face at all, against nine lit blades once the flip was dropped.
   Size alone carries the variety now, and nine leaves rather than fourteen, because at the
   opening radius fourteen is closer together than one leaf is wide.

**(e) The game's own message box, in the showcase only.**
`ui/panels/dialogue.js` says in its own header that `ctx.get('ui').say(text)` is a published
seam and nothing yet consumes it. It draws a DS message box into `ui`'s low-res canvas, in the
era's font, at the same pixel pitch as the scene, and `ui`'s `minimal` flag gates the party bar
and the auto-opened away card — not `app.open`. So a foreign showcase can use it, and this one
does: *A wild MARILL appeared!*, *Go! GREAT BALL!*, *Gotcha! MARILL was caught!*, *Oh, no! The
MARILL broke free!*. At 21:30 the box comes through grey because `ui` re-lights its whole palette
from `tod` — the caption belongs to the world rather than sitting on top of it.

It is **not** used in the live game, and the reason is a deadlock rather than a preference: the
box waits for a keypress to advance (`dialogue.advance`), and an idle game that opened one every
time the lead walked through grass would leave a modal in front of a player who is not there.
`begin()` emits `ui:toast` instead, guarded by `!config.showcase` — a toast fades on a wall-clock
timer, which is the one thing a reproducible screenshot may not contain (#14).

**(f) Framing, and the panel.** Every picture mode moved from `pixelExactDistance(k=2)` to `k=3`
— the same integer framing `mode=walk` already used, two thirds of the distance, so a Pokemon is
~180 px tall in a 1080 frame against ref 01's proportion, and the tail of the conga line leaves
the frame instead of competing with the subject. The panel lost the spawn table and the ball
shelf from every mode that is a *picture*: the shelf belongs to `mode=balls`, the step log to
`mode=walk`, the table to the new `mode=table`. What a picture mode keeps is what its own frame
is evidence for — what was rolled, what the ball did, and the two-line proof that the roll
replays identically. The band table the critic named by name is one URL away.

**(g) The ball rests on the cover, not in it.** `arc()` was already passing
`shadowY = at.y + coverY` because a cell of `tall_grass` stands 0.625 units proud and a blob
under that is inside the blades — but `rest()` was still placing the ball itself at `at.y`, i.e.
**0.625 units below its own shadow**, and the blades took its lower shell, band and button. (The
pre-fix frame was not kept; the claim rests on the two call sites, which disagreed by exactly
`coverY`.) Shipped, at 2x:
`docs/progress/encounter/r3/crops/ball-resting-on-cover-2x.png` — the whole ball clear of the
blades with its contact blob directly under it. A ball that has fallen into deep grass sits on the
grass. The wobble also went from a 2-texel nudge to 3: at 2 the extreme of the sweep is 27 screen
px against a 116 px ball, so every frozen frame in the wobble looked like a ball standing still.

**(h) What was re-verified rather than assumed.** The brief asked whether round 2's ball fix
held. Measured on the shipped `docs/progress/encounter/r3/throw.png` with the critic's own looser
not-green mask over an 11,160 px silhouette: **0 pixels at exactly (0,0,0) and 0 at exactly
(1,1,1) — 0.00 %**, against round 1's 50.4 %. The airborne contact shadow is present and lands on
the cover: the row-mean luminance under the ball dips from 66.5 at `y 718` to 56.7 at `y 734`, and
the ellipse is plainly visible at 3x in
`docs/progress/encounter/r3/crops/ball-airborne-shadow-3x.png`. Ball/lead separation at the throw
is 180 px at the new framing.

**(j) A squash-and-stretch on a pixel sprite is issue [12] with a different actor.**
The appear beat first shipped with a continuous scale ramp — `0.62 + 0.38*min(1, out/0.55) +
0.20*sin(out*pi)` — which freezes `mode=reveal` at about 1.10. At the framing every picture mode
now uses one sprite texel is exactly three internal pixels, so 1.10 of that is 3.3 and texels come
out three internal pixels wide in some runs and four in others. That is the critic's issue [12]
verbatim, moved off the ball (where `gridScale` fixed it) and onto the headline sprite in the
frame an outside critic shoots.

Measured the way the critic measured it, on the same species in the same cell, one frame with the
ramp and one without — histogram of horizontal texel-edge spacings over the whole sprite:

| frame | gap 9 px | gap 12 px | on whole texels |
| --- | --- | --- | --- |
| `mode=escaped`, scale 1 (control) | 408 | 223 | 48.9 % |
| `mode=reveal`, continuous ramp ~1.10 | 246 | 441 | **27.1 %** |
| `mode=reveal`, shipped | 415 | 224 | **50.5 %** |

The fix is to quantise rather than to delete: a scale that is a multiple of 1/3 keeps every texel
a whole number of internal pixels, so the pop is **2/3 -> 1 and nothing in between**. Two sizes
read as a pop better than a twenty-step ramp does anyway — it is what the era's own sprites do —
and the frozen reveal lands on the settled 1, the same size as every other Pokemon in the picture.
The burst is carried by the hop, the leaves and the bubble, none of which cost the grid anything.
Worth stating as a rule, because this is the third time it has bitten: **anything that scales a
sprite in this project has to land on a whole number of internal pixels, or it is resampling
pixel art.**

**(i) The default mode is the reveal now.** `?showcase=encounter` with no mode is the URL an
outside critic shoots — it is the one that produced `enc-default.png` — and it was defaulting to
`throw` on the argument that a ball in the air is "the one unambiguous frame". It is unambiguous
about a *ball*. The reveal is the frame that is unambiguous about an *encounter*: the wild is the
only thing off the ground, the only thing wearing the "!", the grass it came out of is still open
under it, and the box at the bottom names it.

---

### 52 — 2026-09-08 — The shadows were hard because `PCFSoftShadowMap` has not existed since r185 and `LightShadow.radius` was never set; a wide kernel needs a receiver-plane bias to be usable; and `mode=biome:cave` was a lawn

Five critics — `city` three times, `tiles`, `hunts` — filed the same defect against their own
modules this round: hard-edged, hue-killed, near-black bars raked across every open lawn at
07:00, 08:00 and 17:30. `hunts` called forest golden hour "a corduroy of parallel hard-edged
near-black bars" and its worst frame. It is one cause, it is `environment`'s, and it is two
numbers nobody in six rounds had printed.

Every measurement below is 1280x720 with `hudRows: 60` — the same reduction
`tools/shots/regress.js` uses — and every A/B is the **same URL one flag apart**, taken in the
same minute, because three other modules were editing the tree while this round ran (#50(e)).
The control flag is `?envNoShadowFilter=1&envShadowRadius=1`, which is the round-6 rig exactly.

**(a) `THREE.PCFSoftShadowMap` is deprecated, and `LightShadow.radius` defaults to 1.**

`ARCHITECTURE` §2.7 asks for `PCFSoftShadowMap` and `core/render.js:144` sets it. three r185
**removed that path**: `WebGLShadowMap.render()` line 99 substitutes `PCFShadowMap` on the first
shadow pass, and `WebGLProgram.js:346`'s `shadowMapTypeDefines` has keys for `PCFShadowMap` and
`VSMShadowMap` only — constant 2 falls through to `SHADOWMAP_TYPE_BASIC`. Read at runtime
through the new `window.__ENVSHADOW__()`: `renderer.shadowMap.type` is **1**, so the substitution
had already happened and the frame was running three's 5-tap Vogel PCF.

Its kernel is `shadowRadius * texelSize`, and `LightShadow.radius` defaults to **1**. Nothing in
this project had ever assigned it. One texel of a 2048² map over a 56-unit ortho box is
`56 / 2048 = 0.0273` world units — a thirty-sixth of a tile. **That is the entire "hard shadow"
defect**: measured on a scanline across the west massif's shadow at `?showcase=environment&tod=17.5`,
row y=380, the 90 %→10 % transition is **3 pixels** wide and drops 87 → 31 luma in one of them.

Six rounds looked for this in the ortho frustum (`shadowExtent` 56→100→160 moves coverage under a
point, integrator), the bias pair, `shadowSide`, and the caster list. It was never any of those.
The standing coreRequest "`PCFSoftShadowMap` has a fixed kernel and `light.shadow.radius` is
ignored by it" is **wrong** and is withdrawn: `radius` is read, every frame, and always has been.

**(b) Raising `radius` alone does not work: 5 taps over a wide disk is salt and pepper.**

Swept with three's own filter at `tod 17.5` on `city/high-street`. The frame gets *brighter* as
the radius grows — mean 61.53 / 61.64 / 61.83 / 62.16 / 62.85 at radius 1 / 4 / 8 / 12 / 20 —
so there is no acne: `src/tiles/instanced.js` keeps flat and decal tiles out of the shadow pass,
so open ground writes nothing to the map and cannot self-shadow. What there *is* is noise.
`docs/progress/environment/r7/sweep/crop-lawn-r20.png` is the whole lawn dithered, because 5
samples rotated per pixel by interleaved gradient noise over a 20-texel disk is a 45 % standard
error on the coverage estimate, and at `pixelScale 3` each of those errors is a 3×3 screen block.

**(c) So the filter is ours: 24 taps and a receiver-plane depth bias, installed as one shader
chunk. `src/environment/shadowFilter.js`.**

`THREE.ShaderChunk.shadowmap_pars_fragment`'s PCF `getShadow` is replaced, found by brace-matching
from its signature rather than by exact text so a patch release cannot silently break it — and if
the anchor is ever gone the install is skipped with a `warn` and three's own filter runs, because
a hard shadow is a defect and a failed string replace that emits invalid GLSL is a black screen.

- **24 taps, not 5, and the count is what actually bought the wide kernel.** Swept behind
  `?envShadowTaps=N` at a fixed radius of 12 on `city/high-street/17.5`, measuring
  high-frequency energy over the lawn crop (x 40..240, y 20..140) — mean
  `|luma − avg(4 neighbours)|`, which is the grass texture plus the dither and nothing else
  because the scene is identical between shots:

  | taps | 5 | 12 | 24 | 32 | (radius 1, the old hard shadow) |
  | --- | --- | --- | --- | --- | --- |
  | hf | 2.874 | 2.440 | 2.301 | 2.282 | 2.804 |

  5 taps of *this* filter reads 2.874, identical to three's own 5-tap kernel at the same radius,
  which is the check that the replacement is like-for-like. 24 → 32 buys 0.019 and is not
  visible; 12 still carries 0.14 over 24. Each tap is a hardware `sampler2DShadow` fetch under
  `LinearFilter` — a free 2×2 comparison, so ~96 effective taps — and it costs 0.6 fps at 1080p.
- **A receiver-plane depth bias**, which is worth less than the theory says and is kept anyway.
  Three compares all of its taps against the receiver depth at the kernel's centre, so on
  anything tilted away from the light the uphill taps read as occluded. `dFdx`/`dFdy` of the
  shadow coordinate give `∂z/∂u`, `∂z/∂v` from a 2×2 solve, and each tap tests
  `z + dot(∂z/∂uv, offset)`. Two details are load-bearing: the derivatives are taken **before**
  the frustum test, because a derivative in non-uniform control flow is undefined for any quad
  straddling the edge of the shadow box; and the fitted slope is clamped **per texel of offset**
  at 0.004 normalised depth, which is flat ground under a sun 2.3° up — below the 3.4° elevation
  floor the key already has, so a real receiver is never clipped and a silhouette's runaway
  derivative always is.

  Priced with `?envNoRpdb=1` at radius 12 (`r7/rpdb/`): it changes **4.31 %** of
  `city/high-street/17.5`, and those pixels sit at **0.70×** their brightness without it. The
  diff image says where, and it is not where I expected: **lamp posts, awnings and the strip of
  ground at the foot of a wall**. Roofs are untouched — region mean 84.17 with against 84.21
  without — and so is the lawn, because `src/tiles/instanced.js` keeps flat and decal tiles out
  of the shadow pass entirely, so open ground writes nothing to the map and cannot self-shadow at
  any radius. That is also why the radius sweep in (b) got *brighter* rather than acneing: on
  this map the classic acne failure mode mostly cannot happen. So the honest attribution is that
  the tap count unlocked the wide kernel and the plane bias keeps the narrow steep casters from
  acneing themselves inside it, at no measurable cost.

**(d) The radius rides the sun's elevation, and the two ends were picked by looking rather than
derived.** One constant cannot serve both hours and both failures were shot: at 12 texels the
golden hour is right (`sweep/crop-f-lawn-r12.png`) and noon is wrong — `sweep/crop-bench-f12.png`
has a bench's shadow blurred to a faint smudge, because 0.33 units of blur across a shadow 1.2
units long is most of the shadow. At 6 texels noon is right (`sweep/crop-bench-f6.png`) and the
golden hour keeps too much corduroy. So `radius = clamp(5 + 14 · (graze − 0.35), 5, 14)` with
`graze = 1 − sin(elevation)`: 6.4 at noon, 12 at 17:30, 13.3 at the elevation floor.

It is **not** derived from `1/sin(e)`, and that matters for whoever tunes it next. The kernel is a
disk in the shadow map; projecting it onto flat ground already stretches it by `1/sin(e)` along
the shadow's run for free. Only the width *across* the run — which is what makes a bar a bar —
needs the ride. Nor is it the per-pixel contact hardening a real filter would do: that needs a
blocker *distance*, and three's PCF map is a comparison sampler that will not hand back a depth
value (`castShadows.js` has the note on what reading one through a `sampler2D` costs).

**(e) Measured, control → shipped, same URL one flag apart.**

| frame | what moved | control | shipped |
| --- | --- | --- | --- |
| `showcase-17.5` massif edge, y=380 | 90→10 % transition | **3 px** | **26 px** |
| `city/high-street/21` | `belowL8` | 11.114 | **9.903** |
| `hunts/meadow/21` | `belowL8` | 4.872 | **3.225** |
| `hunts/forest/21` | `belowL8` | 11.864 | **10.253** |
| `hunts/forest/12` | `belowL8` | 2.803 | **2.352** |

At 1920×1080 on `city/high-street/17.5`: **59.4 fps mean, p95 16.7 ms**, 221 draw calls, 19 k
triangles, 22 programs, 0 console errors — against 60.0 fps with the filter off, so the whole
filter costs 0.6 fps and stays well inside §7's ≥ 50 fps / p95 ≤ 20 ms.

`mean` moves by under 0.3 on every one of those four, so the softening is very nearly free on
brightness: it is not lifting the frame, it is removing the hard black core of a raked bar.
The full gate at the end of the round is **6 improved, 0 regressed, 0 moved** across twelve
frames. Two of the six (`hunts/meadow/12` and `hunts/coast/12` `drawCalls`) are *not* mine —
`src/hunts/` was being edited while this ran; the four `belowL8` rows above are, by the A/B.

**(f) What the softening did to "hue-killed", and what it did not. Measured with the shadow-map
mask (`?envNoShadow=1` differenced against the shipped frame), because the gate is blind to it.**

For the pixels the sun's shadow map darkens, hard → soft:

| | city 17.5 | forest 17.5 |
| --- | --- | --- |
| shadow mean RGB | (36.5, 32.4, 12.2) → **(53.3, 49.3, 13.0)** | (31.6, 31.9, 2.3) → **(37.5, 39.8, 2.7)** |
| per-channel display ratio | (0.29, 0.31, 0.47) → **(0.44, 0.47, 0.52)** | (0.36, 0.33, 0.27) → **(0.43, 0.41, 0.31)** |
| shadow p50 luma | 31 → **42** | 29 → **32** |
| pure black inside the shadow | 1.32 % → **0.71 %** | 0.02 % → **0.01 %** |
| shadow saturation vs lit | 0.799 vs 0.825 | 0.958 vs 0.938 |

The shadow now *darkens* rather than crushing, and its saturation matches the lit surface it
falls on to within 0.03 in both scenes — which is the critics' "desaturating what they fall on"
answered, as a number.

**What is left is not the shadow's, and the measurement says so.** 48.5 % of the forest golden
hour has its **blue channel at exactly 0**. Inside the shadow that figure is 50.5 %; over the
whole frame it is 48.5 %, and in the city the shadow is *less* zero-blue than the frame (10.5 %
against 20.0 %). A defect that is no worse inside the shadow than outside it is not the shadow's.
It is #50(a)'s crush point, still there: `contrast` is `(x−0.5)·c+0.5` with a hard clamp, so at the
golden hour's `c = 1.307` everything under **0.1173** goes to zero, and the golden lift #50 sized
against it delivers 0.0423 in blue — still inside. Reference 04, the golden-hour still we are
judged against, has the same mean blue we do (30.2) and **1.17 %** zero-blue against our 20.0 %.

Four ways to move it were shot and priced on `hunts/forest/17.5`, and **none is shipped**:

| change | zero-blue | mean | verdict |
| --- | --- | --- | --- |
| shipped | 48.5 % | 40.08 | — |
| `saturation 1.57 → 1.30` | 29.7 % | 39.80 | cheapest, and it takes the gold out of the golden hour — looked at, `r7/tune/f175-sat130.png`. Undoes #50's own compensation. |
| `hemi 0.39 → 0.70` | 39.2 % | 43.28 | +3.2 mean for a partial fix, most of the gate's tolerance |
| `hemi 0.39 → 1.20` | 18.9 % | 48.18 | +8.1 mean |
| `contrast 1.31 → 1.18` | 7.0 % | 47.58 | +7.5 mean |
| `lift → 0x3a4260` | 0.15 % | 50.06 | saturation 0.95 → 0.51; the frame washes out |

**One contact check I could not make, said plainly.** The right test for a 12-texel penumbra is
a caster standing on *lit* ground at 17:30, and neither shipped framing has one: the city's trees
are off-frame (#50d) and the showcase's free-standing block and lamp posts are inside the massif's
shadow — street lamps are not in the caster list at all. The contact evidence is therefore noon's,
`sweep/crop-bench-f6.png` at 6.4 texels, which is exactly the hour the radius curve narrows for.
Whoever takes the next round should put a caster on lit ground at 17:30 in the showcase and look.

The honest fix is a **soft toe on the contrast** in `core/render.js` instead of the hard clamp,
which costs the shadowed blue nothing and the black point almost nothing. Filed as a coreRequest
with these numbers. Changing the grade from a preset to chase it is #46/#50 territory and would
have traded a shadow round for a colour regression, which is exactly the failure mode
`tools/shots/regress.js` exists to stop.

**(g) `?showcase=environment&mode=biome:cave` was a lawn, and now it is a cave.**

The mode changed the *palette* and left the meadow stage under it: grass, a stone road, a hedge
and street lamps, lit by the cave preset's key of 5.20 with nothing over them. It measured
**mean 146.07 / p50 150 / belowL8 0.000**, brighter than the noon city. `biome:cave` and
`biome:interior` now build an enclosed stage instead — chosen by reading `enclosed >= 0.5` off
`presets.js` rather than by biome name, so a preset that gains or loses a roof cannot leave the
showcase lying. It is a chamber cut into a sheet of `bw2-cave` rock a metre up, with two
outcrops, a raised terrace, `cave_big_rock`, `cave_exit` straddling the north wall, and five
practicals — two cold at the mouth, three warm — sized against `lamps.js`'s own clamps the way
`hunts` measured them. `estalactita` is deliberately not placed, for the reason
`hunts/biomes/cave.js` records. Now **mean 77.77 / p50 70 / 56 draw calls / 60 fps**, and it
looks like `hunts`'s own cave because it uses the same tileset idiom.

The first cut of it is worth writing down because the mistake is easy to repeat: drawing the
surrounding rock with `set3 cave_dark_border` at y 0 gives a **lavender chequerboard**, because
that set has nine models and its centre slot is `cave_dark_border_inner_ne` — an inner corner
doing duty as the fill — and it puts the outcrops level with the floor, so they read as pits. A
flat `cave_rock_ground_center` sheet at y 1, with the chamber cut out of it, has neither problem
and is what the rock physically is: the top of the metre of wall the `set0` border slots climb.

`biome:interior` gets the same room and measures `belowL8` **39.6 %**, `pureBlack` 11.6 %. That is
the interior preset's own lift-vs-crush error, already on the open-issues list and untouched here;
the difference is that it is now visible in a shot instead of being a note about a preset no scene
used.

---

### 53 — 2026-09-08 — `set0`'s transition faces sample their texture inverted along their *own* axis, so four slots are fixed by a half turn and eight can only be re-cast as a different slot; and a trunk is hidden by a crown, not by a region

**(a) The mirror is not a mirror, and it is not in U. It is a per-face V flip, and which world
axis it lands on differs from slot to slot.**

Three attempts have been made on the divided road: this module's `SET0_OUTWARD` (rot 2 on
`edge_w`/`edge_e`, shipped), the integrator's U flip in `tools/assets/pdsts.js` (reverted, made
the interior gap 6 px → 16 px), and the two together (reverted, 16 px and 15 px — two gaps).
All three were built on the same diagnosis, *"the art is mirrored about its own centre"*, and
that diagnosis is wrong. Dumped from what the game actually loads:

| model | material | `v` at the two ends |
| --- | --- | --- |
| 8 `grass_path_side_edge_w` | `michi01a` | **+0.0562 … +0.9438** |
| 9 `grass_path_center` | `michi01b` | **0 … −0.9999** |

The two materials of **one set** disagree. `michi01a` — the material every transition slot is
drawn with — keeps the DS convention, `v` measured *down* from the image's top row; `michi01b`
has already been negated into OpenGL order. `THREE.TextureLoader` uploads with `flipY = true`,
so the un-negated faces sample upside down. The `.obj` mirror of the same model negates `v`,
which is why reading `obj/path/grass_path_side_edge_w.obj` says the pack is fine and reading
`pack.bin` says it is not; `pack.bin` is what the game loads. This also supersedes the note at
`src/tiles/materials.js:597` that *"a horizontal tile is untouched by a V flip"* — untouched by a
flip in **height**, yes; these tiles map `v` onto **X or Z**, and each slot picks its own, which
is why `edge_w` fails east-west and `edge_n` fails north-south.

**(b) Which is why a rotation reaches four slots out of thirteen.**

`edge_w` maps `v` to world X: its fringe lands east, and a 180-degree turn is a mirror in X and
in Z, of which the Z half is a no-op on a vertical strip. Same for `edge_n`/`edge_s` in the other
axis. An **outer corner** is two triangles split on the tile's diagonal — one carrying the north
strip with `v` on Z, one the west strip with `v` on X — so each strip is flipped *out of its own
triangle* and all that survives is the sliver grazing the diagonal: the green comma stamped
inside the tan at every meander step, six countable at 1x in `forest-wide-12` and two in the
default framing. Rotation moves the comma; it cannot put the strips back, because the flip
happened in texture space before the triangle clipped it. An **inner corner** is one triangle
whose `v` runs from its right-angle corner to its hypotenuse, so the flip puts the fringe *on*
the hypotenuse — a green diagonal streak across the road.

**(c) So the corners are re-cast, and the substitute is chosen by measuring the field.**

`palette.draw` gains `remap(case, cx, cz) -> caseName`, which re-names a solved case before the
model is looked up (through `tiles.autotile.solve`, the same lookup the solver used, so an
unknown substitute keeps the solver's own model rather than losing the cell). `set0Outward(field)`
returns `{ rotate: () => 2, remap }`:

* an **outer corner** becomes the `edge_*` of whichever of its two exposed sides carries the
  longer unbroken shoulder, counted on the field. On the forest's north-south trail that is
  `edge_w`/`edge_e` and the fringe runs *through* the step instead of stopping at it; on the
  meadow's and the coast's east-west tracks the same rule returns `edge_n`/`edge_s`. The rule
  measures rather than names a side, and the selftest asserts both directions on two synthetic
  fields;
* an **inner corner** becomes `center` — plain dirt. The artist's nub for that slot is
  unreachable at every rotation and the streak that stands in for it is worse than nothing.

Measured twice, offline and on screen. Offline, by rebuilding the shipped seed-1337 trail from
`pack.bin` + `michi01a.png` with the solver's own conventions (`outsideIsFilled = true`): green
pixels enclosed by dirt **960 → 0**, dirt meeting bare lawn with no fringe between **720 → 222**.
On screen at 1920x1080, `src/hunts` reverted to its session-start state and built again for the
control: the six stubs in `forest-wide-12` and the two in the default framing are **gone**, and
the dirt-enclosed-green scanline count falls 3987 → 1224 (wide), 4770 → 1818 (default),
22815 → 9900 (coast). `docs/progress/hunts/r6/before/` against `after/`. Draw calls drop with it —
forest 86 → 74, meadow 127 → 115, coast 113 → 101 — because eight of the thirteen slot models are
no longer drawn at all.

The exporter fix is still the right one and the coreRequest is restated with the `pack.bin`
repro, because one rule there covers every slot of every pack; `set0` is simply the only family
in `bw2-adastra` whose art is asymmetric enough to show it.

**(d) A trunk is hidden by a crown, and round 5 tested for woodland.**

The critic measured the front rank honestly in both directions — *"trunk-brown pixels fall 2.71 %
to 2.29 % while trees rise 28 %"*, but *"about 11 bare trunk-and-root decals in a straight line
across x 40-900"* and *"four crowns on lit lawn each with its full trunk and root decal exposed"*.
Round 5 covered them with a Poisson scatter at radius 1.35 over the `face` row, and a scatter has
gaps by construction and does not know where the trunks are. The cover is now driven off the
**tree list**: every crown that was really planted knows its own footprint, and the cover goes on
the footprint's southern row, which is where the surviving Z-facing card's foot stands.

Two things had to be got right and the first cut got both wrong:

* **exposure is measured against the crowns, not against `wood`.** Asking whether the cell south
  of the footprint was woodland covered 91 of 689 crowns, because `wood` is a region and the
  canopy is a scatter inside it — the southernmost *crown* of a column is usually not on the
  southernmost *wood* cell. Testing the crown footprints themselves takes it to 170.
* **the `lane` guard was the wrong guard.** It refused the two crowns the close framing is
  actually about — (23,36) and (29,34), standing beside the trail, whose bases are inside
  `path.grow(2)`. Their bases are already `collision: 'block'`, because their own trunks blocked
  them a moment earlier, so a bush there cannot change what is walkable. Asserting
  `draft.collisionAt(x, bz) === 'block'` is both stricter and less conservative than naming a
  region: 170 → 180 crowns, and the two decals are covered.

The width is a fit, not a guess — a 2x2 crown takes `hedge2`, a 3x3 takes `hedge3`, so the cover
is exactly as wide as the card whose trunk it hides; a 1x1 bush on one of the two cells covers
only the half of the trunk on its own side of the boundary, because the card is centred on that
boundary, and that is the other half of why round 5's scatter left so much showing even where it
landed. Half the crowns take the single run and half take one 1x1 per cell, hashed, because sixty
identical flat-topped boxes along a tree line is the same defect as one crown silhouette at one
yaw. Looked at both ways before choosing (`docs/progress/hunts/r6/after2/` is the run-only
version, `after3/` the mix).

Trunk-brown pixels at 1920x1080, same controlled A/B: `forest-wide-12` **0.818 % → 0.284 %**,
default **0.983 % → 0.416 %**, `forest-close-12` **0.946 % → 0.596 %**, and the close framing's
four fully-exposed decals are **zero**. Gate: 6 improved, 0 regressed, 0 moved.

**(e) The guards, and the proof they are guards.** The selftest asserts that no crown with an
uncovered row to its south keeps a bare cell on its own base row, and that the re-cast happens at
all; both fail when the file is reverted (`180 of 180 front-rank crowns uncovered`, and the two
shoulder-rule checks flip), which is the only reason to believe them. 315 → 324 checks.

**(f) `git stash` is not a control in this repo and must not be used as one.** Taking a "before"
shot by stashing the working tree stashed **three other agents' concurrent edits** as well —
`src/encounter/*`, `src/environment/index.js`, `tools/judge/plan.json` — and `git stash pop` then
restored only the untracked-adjacent files and kept the entry. Recovered with
`git checkout stash@{0} -- <paths>` + `git reset`. The control that is actually safe is the one
this module used in round 5 and used again here: copy `src/hunts` aside, `git checkout HEAD --
src/hunts/`, shoot, copy back. It touches one folder, which is the only folder this agent owns.

---

### 54 — 2026-09-08 — A comparison sampler will not return a blocker depth but it will answer questions about one, so the penumbra is per pixel now; and DECISIONS #48 removed the lamp from the shadow map at 21:00, not at 17:30

`environment`, round 8. Two jobs: repair what round 7's softening cost the contacts, and make
every caster in the frame cast. Both are answers to the same finding across four rounds of
blind judging — **every pair we have ever won had a motivated light source in it** — and to the
two judges who wrote, without knowing whose frame it was, *"two incompatible lighting models in
one frame: characters cast long, soft, offset shadows implying a low key light, while the
bushes, trees and several creatures cast only a thin straight-down edge or nothing at all."*

Everything below is 1280×720 with `hudRows: 60`, and every A/B is the **same URL one flag
apart**, taken back to back, because `src/hunts/` and `src/tiles/` were being edited by other
agents while this round ran. That is not a formality: the twelve-minute gap between two
otherwise identical `city/high-street/21` captures put **0.44 %** of the frame's pixels apart,
while the same pair taken back to back is **0 of 921 600**. Any measurement in this round that
is not back-to-back is worth nothing.

**(a) PCSS with a comparison sampler: the blocker distance is *probed*, not read.**

Round 7's own note and its critic agree on the defect: `LightShadow.radius` is **one width per
frame**, ridden on the sun's elevation, so a shadow at its caster's feet gets the same 12
texels as one 26 units away. Round 7 called the fix "the per-pixel contact hardening a real
filter would do" and did not attempt it, for a stated reason: *"that needs a blocker distance,
and three's PCF map is a comparison sampler that will not hand back a depth value"* — the same
type mismatch DECISIONS #43 paid a round for, where reading a `COMPARE_REF_TO_TEXTURE` texture
through a `sampler2D` silently drops the whole draw call.

That reason is true and it is not an obstacle. A comparison sampler will not *say* where the
blocker is; it will answer **"is the blocker nearer to the light than this?"** as often as you
like. Probe a ladder of references marching from the receiver toward the light and the count of
lit rungs **is** the distance:

```
texture( map, vec3( uv, z − t ) ) == 1   ⟺   t ≥ (z − blockerDepth) = d
```

so a tap's lit-count over a ladder `t = Δ … KΔ` is `K − d/Δ`, and summing over the whole search
disk collapses to two accumulators and one division:

```
Σ over blockers of d  =  Δ · ( N·K − Σ lit )        blockerCount = N − Σ lit at t = 0
```

`src/environment/shadowFilter.js` now spends **8 search taps × (5 rungs + 1)** on that estimate
and feeds it to the PCF loop as a per-pixel radius, `MIN_TEXELS + (max − MIN) · d/dSat`, where
`LightShadow.radius` is re-read as **the widest penumbra this hour** rather than the only one.
Every rung is still a hardware `sampler2DShadow` fetch under `LinearFilter` — a free 2×2
comparison — so the rungs come back *fractional* near an edge and the estimate is smooth rather
than quantised to the K+1 levels a naive count would give.

Two details are load-bearing:

- **The search needs the receiver-plane bias more than the PCF does.** Without it every tap on
  the uphill half of a 12-texel disk reads the receiving ground itself as a blocker at distance
  ≈ 0, and the estimate collapses to `MIN_TEXELS` everywhere — a hard shadow with extra steps.
- **A blocker count of zero is not "lit".** Eight taps over a twelve-texel disk sit about seven
  texels apart and a lamp's crook is about seven texels wide, so a thin caster can slip between
  them. The code therefore falls through to the **tightest** kernel rather than returning
  early, which finds it if it is there and is also the correct answer for a caster that close.

**The ladder is calibrated in world units, and that calibration was wrong for twenty minutes.**
`installShadowFilter` reads `far − near` off the sun's ortho shadow camera. At `environment.init`
that camera is still three's untouched default (0.5…500), because `core/render.js` writes
`cam.near = 0.5; cam.far = extent * 3` from inside `sun.update()`, which `main.js` first calls
*after* `registry.frame()` on frame one. Baked at 499.5 against a real 167.5, every blocker
distance came out three times short. The fix is not to copy core's formula here — a change to
`config.shadowExtent` would desync the copy — but to ask core to fill in its own camera first:
`three.sun.update({x:0,y:0,z:0})` is idempotent and main.js calls it again a moment later.
`window.__ENVSHADOW__()` now reports the live camera range **and** the range compiled into the
chunk, so the next agent reads the mismatch instead of deducing it.

**(b) What it is worth, measured on the one caster that shows it: a lamp post at noon.**

`city/high-street` at `tod 12`, cross-section of the post's own shadow, as `luma(no caster) −
luma(with caster)` so the profile is the shadow and nothing else. Three filters, same frame:
`hard` is `?envNoShadowFilter=1&envShadowRadius=1` (the round-6 rig), `r7` is `?envNoPcss=1`
(**round 7's kernel** — one width per frame; the receiver-plane ceiling is this round's 0.003 in
that column, and `castShadows.js`'s ring sample is in all three, neither of which touches a
shadow-map profile), `r8` is shipped.

| row | | hard | r7 | **r8** |
| --- | --- | --- | --- | --- |
| y=300 (at the foot) | 10→90 % rise | 4 px | **18 px** | **6 px** |
| | peak darkening | 95.7 | **90.7** | **95.7** |
| y=270 | rise / fall | 3 / 4 px | 18 / 18 px | **6 / 6 px** |
| | peak darkening | 102.2 | 100.1 | **102.2** |
| y=240 | rise / fall | 3 / 4 px | 15 / 15 px | **9 / 7 px** |
| | peak darkening | 109.0 | 109.0 | **109.0** |

That is the critic's *"the shadow never reaches full occlusion, it only manages about 40 % of
its darkening"* answered as a number: **PCSS restores the hard filter's plateau exactly** —
95.7, 102.2, 109.0 at the three rows — over a 6–9 px edge instead of the hard filter's 3–4 px
razor. Round 7 both softened the edge to 15–18 px *and* lost 5 points of the plateau at the
foot, which is also the critic's *"at x=1100 a 7-pixel shadow band that exists in the control is
GONE entirely"*: at y=300 round 7's band is 39 px wide and shallow where the control's is 24,
and PCSS's is 25.

**And the far field keeps round 7's win**, which is the whole point of doing this per pixel.
`city/high-street/17.5`, scanline y=40 across a tree bar whose caster is off-frame, shadow→lit
transition: **hard 9 px, r7 46 px, r8 39 px.** PCSS gives up 15 % of the softening on a shadow
26 units from its caster to buy back a factor of three at the contact.

**(c) The receiver-plane clamp moved 0.004 → 0.003, and it matters less than it did.**

The round-7 critic priced the old ceiling: one unit of `shadowCoord.z` is 167.5 world units, so
`0.004 × 12 texels × 167.5` is **8 world units** of depth push at the edge of a golden-hour
kernel — 3.6× more slack than the 0.0011 flat ground needs at 8.6°. It is now **0.003**, which
is flat ground at 3.4°, the `KEY_ELEVATION_FLOOR` `index.js` enforces, so a real receiver is
still never clipped and the runaway derivative at a screen-space depth discontinuity is clipped
25 % harder. The other factor of six went away on its own: the push scales with `|offset|`, and
PCSS *is* the thing that makes `|offset|` small exactly where a contact shadow lives. Swept
behind `?envRpdbSlope=N`; `?envNoRpdb=1` still turns it off entirely.

**(d) It fits the budget, and the cost was probed before a line of it was written — but say
what the probe can and cannot see.**

Round 7 already exposed `?envShadowTaps=N`, so the cost of tripling the fetch count was measured
first, at 1920×1080 on `city/high-street/17.5`: **24 / 48 / 72 / 96 taps → p95 16.7 / 16.7 / 16.8
/ 16.8 ms**, 60 fps throughout. Shipped (72 fetches per pixel plus a 9-tap `sunAlreadyGone`) at
1080p: **60 fps, p95 16.8 ms**, ≤ 222 draw calls, 22–23 programs, 0 console errors on
`city/17.5`, `city/21`, `hunts/forest/12`, the `environment` showcase and the boot city.

**That is not a measurement of the shader's cost and it must not be quoted as one.** The frame
is vsync-locked, so a p95 frame *interval* has a floor at 16.7 ms and cannot resolve GPU work
under it — 96 taps reads the same 16.8 as 72, which is the tell. What the sweep does establish
is the thing §7 actually asks: four times round 7's fetch count does not break the 60 fps lock,
so the budget is met with headroom whose bottom nobody has measured. Round 7's own "the filter
costs 0.6 fps" came from the same instrument and deserves the same caveat.

**(e) Every caster casts, and the one object that did not was taken out on purpose.**

Audited before it was written, not after: the predicate below was run over all fifteen judged
frames — city plaza and high street, forest, meadow, cave, coast, tiles, this module's showcase,
encounter and the boot city — and across every one of them it flips **exactly one object**,
`street_lamp#0`, eleven instances, 3.86 units tall, parented to `city:lamps`. Everything else
tall enough to matter was already in the shadow pass. The predicate (`src/environment/casters.js`)
is: not already casting, height ≥ 1.0, opaque, `alphaTest === 0`, `side === FrontSide`,
`depthWrite`, no `aUvRect` attribute, not `env:*` or `sky`. **It can only ever add**, because
`src/tiles/instanced.js` deliberately keeps flat and decal tiles out of the shadow pass and that
exclusion is load-bearing (#52(b): it is why open ground cannot self-shadow at any radius).

DECISIONS #48 removed that lamp on purpose and priced it, and this does not re-litigate it,
because **every number in #48 is at 21:00**: *"at 21:00 the post drew a hard streak across the
grass and the head, hanging a cell out on the arm, dropped a detached black lozenge clear of
it."* At 21:00 a street lamp *is* the light source, the moon is 30° up so its shadow is short,
and a cowl on an arm drops a lozenge that touches nothing. At 17:30 the same lamp is an unlit
pole under an 8.6° sun and post, arm and cowl rake into one continuous 20-unit shadow. So the
override is gated on the sun still being the key — `!night && lampsOn < 0.5`, both numbers
`index.js` already computes — and the gate was checked rather than assumed:

| tod | `look.lamps` | policy |
| --- | --- | --- |
| 12 | 0 | casting |
| 17.5 | 0.113 | casting |
| 21 | 1.0 | **not casting** |

**`city/high-street/21` with the policy against `?envNoCasterFix=1`, back to back: 0 of 921 600
pixels different.** #48's frame is byte-for-byte what it shipped.

At 17:30 the policy changes **0.87 %** of `city/high-street`, at a mean absolute channel sum of
92.3 on those pixels — eleven posts that stood on lit ground with nothing under them now throw
20-unit raked shadows across the path and the lawn (`docs/progress/environment/r8/crop/
lampshadow-r8.png` against `lampshadow-nolamp.png`). Draw calls 221 → 222. The `structures`
lamp's **lens** is its own material group, 0.3 units tall, and the height term keeps it out of
the shadow pass — which is right twice over, because an emissive lens is the last thing that
should be blocking light, while the cowl above it (the `post` material) does occlude.

**(f) `sunAlreadyGone()` was a single hard tap against a penumbra that is now per pixel.**

Round 7 filed this against itself and did not fix it. `castShadows.js` asks the sun's shadow map
whether the sun has *already* gone from a piece of ground before removing it a second time —
the fix for the "overlapping shadows compound to literal black" defect — and it asked with one
hardware comparison, a hard 2×2 edge. Against a penumbra that now runs from 2 to 12 texels
*within one frame*, a sprite crossing it would have its projected shadow snap from full depth to
the ambient-occlusion branch at the 50 % line while the ground around it ramped smoothly. That
is the judges' "two incompatible lighting models" wearing its other hat, at the scale of one
character. It now reads a **nine-point ring at the key's own current radius**, with the same
receiver-plane fit and the same 0.003 ceiling — and the fit is not optional here, because this
receiver is the horizontal shadow plane and a twelve-texel offset along the light's axis is 2.2
world units of depth at 8.6°: without it a sprite in **full sun** would be told the sun had
already gone and would lose its shadow entirely. Checked on `city/plaza/12`, where the party
stands in open sun: shadows present, starting at the feet, on the pixel grid
(`r8/crop/sprite12-r8.png`, and the `?envNoCast=1` A/B).

**(g) The gate cannot see any of this, and that is the honest report.**

`node tools/shots/regress.js` over the fifteen judged frames came back **6 improved, 0
regressed** — and **none of the six is this round's.** They are `hunts/forest` p99 91→152, max
161→255 and `over200Pct` 0→0.427 at 21:00, which is `src/hunts/biomes/forest.js` gaining a
campfire practical while this ran; a shadow filter cannot move a night frame's peak by 94.

The attributable number is a whole-matrix A/B, control against shipped, **alternating per row**
so a concurrent edit cannot land between the two arms of one comparison. Control is
`?envNoPcss=1&envNoCasterFix=1&envRpdbSlope=0.004`. Result, run twice: **0 improved, 0 regressed,
0 moved, across fifteen frames.**

One honest gap in that control, because it would be easy to overclaim: it restores round 7's
*shadow map* exactly, but **(f)'s nine-tap `sunAlreadyGone` is not behind a flag** and is in both
arms. Its gate effect is therefore bounded rather than isolated — by the two full gate runs
taken either side of this round, neither of which moved a city or encounter row (the frames
where projected sprite shadows are on screen at all), and by the `?envNoCast=1` A/B on
`city/high-street/21`, which puts the whole projected-shadow rig at 0.08 of a point of
`belowL8`. Whoever touches that file next should give it a flag first.

That is the right answer and it is worth stating plainly rather than dressing up: **this round
is histogram-neutral.** The gate reduces a frame to luminance and saturation histograms, and
what changed here is *where* the penumbra is and *which objects* are in the shadow map — 0.87 %
of one frame's pixels for the lamps, and a redistribution within the shadow's own footprint for
PCSS. It costs nothing on brightness and buys nothing on brightness. The evidence for the round
is in (b), (e) and (f), which are scanlines and crops, because that is what the gate is blind to
and what the blind judges are actually looking at.

**(h) Still open, and not this module's to close.**

The judges' *"bushes and trees cast only a thin straight-down edge"* is now, in the city at
least, **not the shadow map**: the audit in (e) shows every tree, hedge and fence family already
casting. What is left wearing that description is `src/tiles/instanced.js`'s **generated contact
quad** — `CONTACT_COLOR 0x1d2122` at `opacity 0.42`, a soft disc laid straight down under a prop
at every hour — sitting under the same prop as its raked map shadow. Two shadows from two
different lights on one object is exactly the defect the judges name, and the quad is tiles'.
Filed there rather than fixed here.

Also carried forward: `config.shadowExtent` is now load-bearing in a second place. The blocker
ladder is calibrated in world units off the shadow camera's depth range, and the penumbra
constants (`MIN_TEXELS`, `SLOPE_TEXELS_PER_UNIT`) are in shadow-map texels, whose world size is
`extent / mapSize`. Changing `shadowExtent` rescales both. `__ENVSHADOW__()` prints every one of
them for exactly this reason.

---

### 55 — 2026-09-08 — The lawn's V step ran backwards for four rounds, so *every* cell row was a seam; the block phase put what was left on a four-cell grid; and the golden-hour crown split is four authored normals the set itself disagrees with

Four blind rounds, four different panels, one sentence about our ground: *"the grass shows
rectangular tile-sized brightness patches"*, *"one texture tiled with obvious repetition and
visible rectangular seams and patchy lighter blocks"*, *"the grass shows raw tiling seams"*.
`tools/shots/regress.js` reduces a frame to a luminance and a saturation histogram and is
**silent** on all of it, so this round is measured with its own rig and the numbers are below.

#### (a) The rig: put the lawn flat-on and axis-aligned, then read the cell grid off the picture

```
?showcase=tiles&mode=ground&tod=12   with  pixelScale=1  cameraPitch=89  fov=20  cameraDistance=42
```

At `cameraDistance 42` that is **73 px per cell** and one texture texel is 4.6 px, which is what
makes a one-pixel seam separable from the texel steps around it. The grid is not assumed: the
vertical path is cells 14..22 and the horizontal one starts at cz 18, so their tan/green
transitions give px-per-cell and the origin. The statistic is mean `|dI/dx|` over a five-pixel
window centred on each cell boundary, split by `cx mod 4` — the lawn sheet spans four cells, so
if the defect is on the four-cell grid exactly one residue class stands out. `cameraDistance 60`
(44.8 px/cell) is the same measurement with twice the sample and half the resolution; it agrees
in direction and is the weaker rig, which is worth knowing before anyone re-shoots it wider.

At the game camera the same defect is `docs/progress/tiles/r5/ab/hunts_coast_12-off.png` against
`-on.png`, which is the pair to look at rather than the numbers.

#### (b) The V step ran backwards, and it was a seam at **every** cell row, not every fourth

`GLOBALMAPPING` means the artist drew one picture across `1/GLOBALTEXSCALE` cells and each cell
is a window onto it, so `instanced.js` shifts each instance's UVs by its own cell. It shifted by
`+uvScale` on **both** axes. Fitting `u = a·x + b·z` and `v = c·x + d·z` by least squares over
the vertices of all eleven global-mapped models in `bw2-adastra` gives

```
du/dx = +s    du/dz = 0        dv/dx = 0    dv/dz = -s        on every one of them
```

— PDSMS is Y-south and the exporter swaps two axes (#5), so V runs against Z. A `+s` step
therefore dropped **half a texture** at every cell boundary along Z. It survived four rounds
because the jump is 32 texels of a 64-texel sheet whose own horizontal band period is ~16, so
the bands re-aligned across the tear even though the picture did not. Measured, at 73 px/cell:

| row boundaries, peak `\|dI/dy\|` | round 4 | V step fixed | shipped |
| --- | --- | --- | --- |
| `cz%4 == 0` | 6.79 | 2.75 | 3.14 |
| `cz%4 == 1` | 6.60 | 2.33 | 2.95 |
| `cz%4 == 2` | 7.24 | 2.68 | 3.28 |
| `cz%4 == 3` (the block row) | **10.45** | **10.22** | **3.92** |
| lawn interior | 1.46 | 1.47 | 1.62 |

Round 4's three non-block classes sit at 4.5–5.0x the interior — that is the tear, on every row.
Fixing the sign alone drops them to 1.6–1.9x and leaves only the real four-cell boundary.

`globalUvStep` now measures the step off the model's own vertices instead of reading `uvScale`,
which also recovers two magnitudes the catalog has wrong: `sea` declares `GLOBALTEXSCALE 0.5` and
spans 0.25 per cell, `lake_water_center` declares 1 and spans 0.5. `?uvstep=0` restores the
assumption.

#### (c) The block phase traded a period for a grid of cuts; the cut has to move off the grid

Round 2 broke the four-cell period by giving each 4x4 block a hashed whole-texel offset, keeping
the artist's picture continuous inside a block and shifting it between blocks. **A shift between
two crops of a tiling sheet is a cut**, and those cuts landed on a perfect four-cell grid in both
axes — which is the rectangle four panels described. Columns, 73 px/cell:

| column boundaries, peak `\|dI/dx\|` | round 4 | shipped |
| --- | --- | --- |
| `cx%4 == 0` (the block column) | **5.11**  (3.28x interior) | 2.67  (1.58x) |
| `cx%4 == 1` | 2.48 | 2.91 |
| `cx%4 == 2` | 2.52 | 2.95 |
| `cx%4 == 3` | 2.58 | 3.02 |

The grid excess — block class over the mean of the other three — is **2.02x → 0.90x** on columns
and **1.52x → 1.26x** on rows. After the change no residue class is distinguishable from any
other, which is the whole claim: there is no longer a period to find.

One sheet cannot cover a field without repeating, so the cut is not removed, it is moved
(`makeGroundScatterPatch`, `src/tiles/materials.js`):

- **off the grid** — the offset is chosen per *region* of a lattice rotated 31.7 degrees off the
  cell axes with a **non-integer** period of 2.9 cells, computed in the fragment shader from the
  global UV. No boundary is axis-aligned, no two are a whole number of cells apart, none lands on
  a cell edge. 2.9 is under the sheet's own four-cell span on purpose: a region can never contain
  two copies of the picture.
- **and off the line** — the lattice coordinate is jittered per *texel* by a hash before it is
  floored, so a boundary is not an edge but a ragged band a few texels wide in which texels from
  both crops interleave. On a noise sheet that reads as clumping. The interior `|dI/dx|` rises
  1.56 → 1.69 and that rise **is** the dither, spread over the field instead of stacked on lines.

It costs **one** texture fetch — the same one that was already happening — because the offset is
applied to the coordinate, not blended between samples. Blending is what the literature does
(Heitz & Neyret) and it is wrong here: these sheets have twelve colours and a blend invents a
thirteenth. Two facts were checked *before* a line was written and both are load-bearing:
`index.js` sets `NearestFilter` on **both** filters with `generateMipmaps false`, so there is no
derivative to blow up at a discontinuity and no mip level to jump; and `RepeatWrapping` is on, so
any offset wraps. The offset is always whole texels (`floor(h·size)/size`), so nothing resamples.

Program count: **+1 across the whole game and no more**, because every number that differs
between materials — texture size, per-cell step, period, angle, jitter — is a **uniform** and
never a baked constant, so all four ground materials compile identical source under one cache
key. Measured on all fifteen gate frames: 13→14 (tiles), 21→22 (city, boot, encounter), 23→24
(coast, meadow), 14→14 in the cave, which places nothing that scatters. Draw calls: **unchanged
on every frame**.

`?scatter=0` restores the block phase, and `?scatter=0&uvstep=0` restores round 4 **exactly**:
the same URL captured against the round-4 build differs by **0 of 6,220,800 subpixels**. The
sweeps are `?scatterRegion=<cells>`, `?scatterAngle=<deg>`, `?scatterJitter=<lattice units>`.

#### (d) `varies()` excluded `raised`, which is elevation, when the test it wanted was `flat`

`raised` is set by `tools/assets/classify.js` from `bounds.min[1] >= 0.5` — a tile authored on
top of a cliff — while the silhouette test the predicate actually wants is `flat`
(`bounds.max[1] - bounds.min[1] < 0.02`), and that clause was already there. The exclusion left
`cliff_top_center` as the one ground surface in the game with no variation at all, and left
`grass_v2` treated differently from the `grass` beside it, which is a hard seam wherever both are
placed. It has not been visible because `tiles.find` hides `raised` models from a blind query
(`index.js:384`), so no shipped scene places `grass_v2` — but a plateau top is a flat square of
one surface at height and varies like any other floor. `?flatvary=0` restores the exclusion.

#### (e) The round's own footprint, separated from two agents editing the tree at the same time

`environment` and `hunts` were both mid-round in the same working tree (`src/environment/*`,
`src/hunts/*` modified, `casters.js` new), so a straight before/after of `regress.js` attributes
their work to this one. The honest measurement is the matrix run **twice back to back**, shipped
against `?scatter=0&uvstep=0&flatvary=0`, and it is
**0 metric movements across all fifteen frames**, 0 draw-call change, 0 console errors, run twice
hours apart. The gate itself finished the round 9 improved / 0 regressed / 2 moved; every one of
those nine is a lamp or a highlight in `hunts`' frames and none of them is this.

#### (f) Golden hour splits the trees because four authored normals disagree with their own set — measured, **not** shipped

The panel, twice: *"at tod 17.5 the four solo trees stand in identical light on flat lawn and the
two populations still read as two tilesets."* Round 4 closed the *hue* gap to 9.0 degrees at noon
and the split came back at 17.30 anyway, so it was never only hue.

First, the measurement everyone before this got wrong, including round 4's: a box around a solo
tree in `mode=trees` is **two thirds lawn**, and an unmasked read reports the grass. Masking the
lawn out first (build the cluster from a clear patch between two trees, drop everything within
2.2 standard deviations of it) changes the answer completely. Masked, at tod 17.5:

```
tree 0.169   round_tree 0.451   darker_pine 0.137   big_tree_dark 0.471      3.43x, hue p50 spread 39.7 deg
```

It is not the shadow map: `--envNoShadow 1` gives 1.30x at noon and the split persists at 17.30.
It is the **stored vertex normal of the upright card that carries the whole tree picture**:

```
tree, darker_pine   ( 0.00,  0.00, -1.00 )   due north, horizontal
round_tree          (-0.71,  0.71,  0.00 )   45 degrees, up and west
big_tree_dark       (-1.00,  0.00,  0.00 )   due west, horizontal
every other card    ( 0.00,  1.00,  0.00 )   straight up
```

Counted over the upright foliage cards of **every** shipped pack — geometric `|ny| < 0.5`, model
tagged `billboard`, category `tree` or `plant` — **180 of 222 triangles are within a few degrees
of straight up**, 100 of 134 in `bw2-adastra` alone, and all of them are category `tree`. Up is
the set's own convention. A horizontal normal makes a crown card behave like a wall, so
`dot(N, L)` collapses the moment the sun's azimuth turns off it — which is what a low sun does,
and why the split appears at 17.30 and not at noon, where the fills mask it.

`crownNormalsToSetConvention` derives the convention from the pack (the direction holding the most
cards inside a 25-degree cone, used only if it holds 60 % of them, area-weighted) and snaps the
outliers — 26 of 124 cards in `bw2-adastra`, to `(-0.0005, 0.99997, 0.0079)`. It works:

| tod 17.5, lawn-masked | authored | snapped |
| --- | --- | --- |
| crown value, max/min | **3.43x** | **1.61x** |
| crown hue p50 spread | **39.7 deg** | **16.4 deg** |

and it is **off by default**, because at noon the same change goes the other way:

| tod 12, lawn-masked | authored | snapped |
| --- | --- | --- |
| crown value, max/min | 2.25x | **5.07x** |
| crown hue p50 spread | 17.4 deg | **89.0 deg** |

`tree` and `darker_pine` fall to value 0.118 / 0.125 at hue 201 / 214 — a flat cyan. Not the
shadow map (`--envNoShadow 1`: 1.30x authored against 3.41x snapped), and not the sheets: an
**up-facing normal on the lawn in the same frame reads value 0.569**, so a crown card at 0.125 is
losing something the ground keeps, and that is not pinned. Noon is five of the fifteen judged
frames, so the trade is refused: `?crownN=1` turns it on and the default path does not call it.
`?showcase=tiles&mode=trees&tod=17.5` with and without `&crownN=1`, and the same at `tod=12`, is
the whole rig for whoever picks this up against a lighting stack that is not being edited
underneath them. The shipped frame is byte-identical to the build before the function existed
(0 of 6,220,800 subpixels on `mode=trees&tod=17.5`).

One hint for that round: `round_tree`'s authored normal is the only one in the set that survives
both hours (0.459 at noon, 0.451 at 17.30), and it is **45 degrees up and horizontal**, not
straight up. The answer is probably that shape, with the horizontal component chosen once for the
set rather than four different ways.

---

### 56 — 2026-09-08 — The coast's "lost fringe" was the defect being removed, not a feature; a wood and a field each get one practical, and the daylight half of it has to be albedo because an instanced tint cannot brighten

#### (a) The −39% coastline fringe is round 5's misplaced fringe, and restoring it would put the green commas back inside the sand

The brief for this round opened with an order to restore something round 6 removed: the critic's
A/B measured *"sand/grass boundary length 21577 → 13076 (−39 %)"* on the coast and *"junctions
20949 → 18304, fringe ratio 0.71 → 0.59"* on the meadow, and read both as this module having
stripped the strand's fringe while fixing the road's meander steps.

Reproduced first, because the number is real even when the reading is not. Control built the way
DECISIONS #53f prescribes — `src/hunts` copied aside, `git checkout c041114^ -- src/hunts/`, shot,
copied back, so only this folder moves while other agents edit `src/environment` and `src/tiles`
in the same tree. Same seed 1337, same framing, 1920x1080, classifier `r > g >= b && r − b > 18`
for sand against `g > r && g > b && g − r > 10` for grass:

| frame | sand/grass boundary px | interior-green **runs** |
| --- | --- | --- |
| coast-12 r5 | 12270 | 1633 |
| coast-12 r6 | **6023** | **755** |
| meadow-12 r5 | 18960 | 2453 |
| meadow-12 r6 | **17396** | **2298** |
| forest-12 r5 | 5246 | 424 |
| forest-12 r6 | **4203** | **222** |

The direction reproduces. The attribution does not. An "interior-green run" is a run of grass
pixels with sand on **both** sides on the same scanline — the shape of the defect #53 is about —
and it halves in all three biomes at the same time as the boundary length falls. Both numbers are
the same fact: round 5's fringe was drawn one cell *inside* the tan, so every scallop of it
contributed two extra sand/grass junctions that a correct fringe does not.

Cropped the same 340x200 window of the strand at 3x in both and looked, which is the only step
that settles it: `docs/progress/hunts/r7/ab/r5-strand-3x.png` has a green scalloped ribbon
floating in the middle of the sand with a **hard, straight** tan/green edge at the real boundary
below it; `r6-strand-3x.png` has the scallop **on** the boundary and no ribbon. Full frames beside
them as `r5-coast-12.png` / `r6-coast-12.png`.

**So the round did not restore it.** The measurement the brief quoted counts a defect as a
feature, and putting it back would put a green comma back inside the sand at every step of the
strand. What *is* genuinely gone is smaller and already filed: the one-cell short face of each
meander step draws no fringe at all, 222 px of it across the whole trail against 720 before
(#53), because an outer corner can only spend its art on one of its two exposed sides. That needs
the exporter's V negation, which is a standing `coreRequest` against `tools/assets`, and no
workaround inside `src/hunts` reaches it.

#### (b) Every pair we have ever won had a practical in it, so the wood and the field get one

Four blind rounds, seven pairs each, scores 3/7 → 1/7 → 1/7 → 2/7. The pairs we have ever won are
`city` at night, on its lamp pools, and `cave` when its torches read. The pairs we have never won
are `forest-day`, `forest-night`, `meadow-day` and `cave-golden` — every frame with no practical
in it — and the judges write the same sentence each time: the reference *"has one committed light
direction"*, ours is *"a uniform tint with no light source anywhere; no moon, no lamp, no rim, no
falloff"*.

Both biomes now have exactly one lit place, and the judged framing is built round it:

- `forest`: a **camp** at cell (36, 35), two cells east of the trail and four north of the walk
  lane, inside the clearing the `clearing` framing is shot on. One bulb through
  `environment.lamps` — `color 0xff7d24, intensity 4.2, radius 11, size 0.17` — plus `rot_rocks`
  as the ring and two single-cell logs from the prop yard.
- `meadow`: the same camp at (25, 32) on the brook bank north of the lane, plus a second
  **pool-only** bulb (`point: false, size 0.02`) two cells toward the lane, which is the cave's
  own trick for light with no visible emitter.

The sizes are read off `environment/lamps.js`, not guessed: the `PointLight` reach is clamped to
`POOL_REACH` 3.9 world units whatever `radius` says, the painted decal reaches
`min(4.2, radius * 0.42)`, and its strength is `min(1, 0.205 * intensity + 0.035)`. The **glow**
quad is the part that has to be small: `size` is a half-width in world units and the fragment
shader multiplies its core by 3.2, so the first cut — `size 0.30` plus a second `size 0.85` halo
bulb — rendered a **white disc two hundred pixels across** with no flame in it. Shot, looked at,
and replaced by one bulb at 0.17, which blooms into a glare instead of being one.

Isolated by setting the day grade to white and re-running the gate: **the fire alone is 5 improved
/ 0 regressed** on the three forest rows, and 3/0 on the two meadow rows.

#### (c) The daylight half cannot be a light, because a tint is a multiply

`environment` holds `look.lamps` at **0** from dawn to dusk (`presets.js`: the four day
keyframes), so a registered bulb contributes nothing at all to `forest-11` or `meadow-11` — the
two pairs that have never been won. The only lever a biome has on a daylight frame is
`instanceColor`, and that is a **multiply**: it can never brighten. So the light in the day frames
is made by shading everything that is not it.

`compose.js` gains two primitives for it. `mulTint(a, b)` composes two gradings (laying a second
over the first with `mixTint` throws the first away — that is how the forest floor's canopy ramp
vanished the first time the pool was laid on it), and `litAt(cx, cz, spec, seed)` is the pool
itself: a wobbled, smoothstepped ellipse. Each biome then grades floor, path, tall grass, flowers
and shoulder decals off it.

**Three numbers in that grade were set by the gate rather than by taste, and each was a
regression before it was a number:**

1. `SUN_SHADE` at 0.78 of white gave `forest/21 belowL8Pct 5.671 → 6.796` (tolerance 0.8) and
   `forest/12 p99 154 → 148` (tolerance 4). 0.83 fits under both.
2. In the wood the grade is damped by the canopy to **nothing** — `(1 − canopyAt)`, not
   `(1 − canopyAt * 0.7)` — because the floor under a closed crown is what is already near black
   at 21:00 and the open clearing is not.
3. In the field there is no canopy to hide behind, so the lawn takes **0.76** of the grade and the
   **track takes all of it**, through its own deeper `PATH_SHADE`. The dirt is the brightest
   surface in the frame at every hour (`meadow/21 p50` 41 against dirt near 100), so a third off
   it lands nowhere near luma 8, and it is the line the eye follows, so it is where a gradient
   reads. Measured down the middle of the judged forest framing at 1920, every 60 rows: the trail
   ran **130–142 with no gradient at all** before this round and runs **140 in the gap to 99 at
   the ends** now.

Two things are deliberately **not** graded, and both are highlight protection rather than
aesthetics: flowers (the palest thing on the floor, and therefore what the noon frame's top
percentile is made of — grading them is half of why `p99` fell on the first attempt), and the
`ue_grass` patches, which are authored at 0.73–0.92 and are the **only** surface with headroom
left, so inside the pool they are lifted *toward white*. That lift is the one brightening
available, and `forest/12 p99` ends at **160 against 154**, up rather than down.

#### (d) A tint is one value per cell, so a gradient across a floor is a staircase

The first version of the grade shipped visible **horizontal bands across the trail** — three of
them down the top of the judged framing, cropped at 3x and looked at. A cell is ~70 screen pixels
wide at this camera and the ramp was falling 7 % per cell. Two changes: `mixTint`'s jitter (the
same dither the canopy ramp has used since #37) at 7, and the ellipse feather widened from 0.42 to
0.80 so the ramp spends ~6 cells instead of ~3. The gate improved with it — `forest/12 p99` 159 →
160, `forest/17.5 p99` 136 → 138 — because a softer ramp keeps more full-albedo cells.

#### (e) The camps are drawn by the auto-tiler, not out of decals

The first camp was a pad of `dirtPatch` glyphs, and at 3x it was **six near-identical tan blobs on
a grid** — the same repeated-glyph failure the scuff scatter and the crown yaws are written to
avoid. The site is now unioned into the field `palette.draw('set0')` resolves, so it gets the
artist's own grass transition all the way round and reads as a worn lay-by. The union is on a
**copy** of the field: `path` is what `verge`, `lane`, `trodden` and `distToPath` were built from,
and widening it under them would move the walk. Everything on the site goes down as
`collision: 'walk'` — the forest camp sits inside `path.grow(2)` and the meadow's is one cell from
the row the `bridge` framing audits, and `makeScriptedRoute` drops an impassable step in silence.

#### (f) The gate, and this round's own footprint separated from two other agents' edits

Full matrix at the end of the round: **9 improved, 2 regressed, 2 moved across 15 frames** — and
one of those two regressions is not this module's. `src/environment` and `src/tiles` were being
edited by other agents throughout (mtimes 20:27–20:44 during this session, plus a new
`src/environment/casters.js`), and `environment/12 belowL8Pct 0.683 → 1.673` is a row `hunts` does
not appear in.

So the round was measured the #53f way as well — round-6 `src/hunts` against round-7 `src/hunts`,
with every other module left exactly as the other agents currently have it:

| row | baseline | control (r6 hunts, today's tree) | this round |
| --- | --- | --- | --- |
| forest/12 belowL8Pct | 0.995 | 1.717 | **1.245** |
| forest/12 p99 | 154 | 154 | **159** |
| forest/21 belowL8Pct | 5.671 | **7.207** | **5.609** |
| forest/21 p99 | 91 | 92 | **163** |
| forest/21 over200Pct | 0 | 0 | **0.557** |
| meadow/21 p99 | 75 | 75 | **183** |
| meadow/21 belowL8Pct | 1.819 | 2.347 | 2.589 |
| coast/12, cave/12 | — | — | byte-identical to control |

That table was captured **before** the dither/feather pass in (d), so its "this round" column
differs from the final gate by at most 1 (`forest/12 p99` 159 against 160, `forest/21 p99` 163
against 162); the final gate numbers supersede it.

`forest/21 belowL8Pct` is the row worth reading twice: the control — round-6 `hunts`, untouched,
against today's other modules — **regresses it to 7.207 on its own**, and the camp fire takes it
back under the baseline at 5.609. This round did not cause that regression and it repairs it.
`meadow/21 belowL8Pct` is the only metric this module moved in the wrong direction, by 0.24 of its
0.8 tolerance, and it is the price of the daylight grade in the one biome with no canopy.

`--accept` was **not** run. 60 fps, 0 console errors and 0 console warnings on all eleven hunt
frames plus the plain boot at `/`, verified by reading every sibling JSON. Selftest 324 → 343, and
**five** of the nineteen new checks are proved by reversion rather than asserted: moving `CAMP` out
of the framing fails "the practical is inside the judged framing" and "the camp cell stays
walkable", returning `lights: []` fails "registers a practical" and "at least one bulb takes a
PointLight slot", and moving `SUN_GAP` off the trail fails "the lit pool covers part of the trail".

---

### 57 — 2026-09-08 — The tiles lamp stage had four glowing heads and no bulb registered, so the pool it was being marked down for was never asked for

Two critics wrote the same sentence about `docs/progress/tiles/r4/13-lamps-night-after.png`: *"a
lit lamp casts no light pool"*. `environment` filed it as a request against this file and was
right: the pool has worked since its round 2 and is demonstrable in the city, and `tiles`' own
stage simply never called `environment.lamps.add()`, so there was nothing for the pool to be.
That is the shape of this whole wave — every pair we have won had a practical in it — and it cost
four lines.

`lampsMode` and `treesMode` now register one bulb per lamp they place. Three things are worth
recording rather than re-deriving:

- **The bulb is not the cell centre.** An AdAstra street lamp is a post in its own cell with an
  arm reaching a cell and a half out of it — `lamp_h_v3` spans `x -1.00..0.69` — and the lit lens
  is at the far end of that arm. A bulb at the cell centre lights the post's foot and leaves the
  head glowing over dark ground, which is the same defect one cell to the side. `bulbOf` takes the
  largest overhang (the quantity `overhangOf` already measures and `orientation` already names)
  and walks 0.75 of it, at `0.92 · bounds.max[1]`.
- **`isLive`, not `typeof`.** The registry's null object answers a `typeof` check TRUE on every
  property and logs a `warn` per read, so `typeof env.lamps.add === 'function'` passes against a
  quarantined `environment` and then spends the zero-warning budget. `api.__missing === undefined`
  is the marker, and it is the same one `ui`, `city` and `hunts` use.
- **tiles says where, environment says how bright.** No `PointLight` is created here and no hour
  is read here; `environment` owns the eight-light pool and the ramp (§5.3), which is why the
  lamps are dark at noon without this file knowing what noon is.

Measured on `?showcase=tiles&mode=lamps&tod=21`, same framing as round 4's shot: the paving beside
the `lamp_h_v3` head goes `rgb(52.6, 35.3, 27.1)` at luminance 38.4 to `rgb(87.8, 45.2, 36.8)` at
53.7 — 40 % brighter and warm. 24 draw calls, 12 programs, 60 fps, 0 errors, **0 warnings**, which
is the `isLive` clause doing its job. `docs/progress/tiles/r5/09-lamps-night.png`. Honest caveat:
`environment` was mid-round in the same tree, so that pair is not a one-variable control — what is
controlled is the panel readout, which now says `4 bulbs registered with environment.lamps`, and
said nothing before because nothing was registered.

Still not fixed and still not tiles': the long hard black bars the lamps throw at 21:00 from a sun
below the horizon (tiles coreRequest 6 against `environment`), and `slamp03.png`, which has no
fixture drawn on it at all (the integrator's authored-asset job).

---

### 58 — 2026-09-09 — How the party walks is a property of the place; run is gone; and a sprite texel is a whole number of internal pixels at any camera distance

Seven changes asked for in one go. They divide cleanly into two: **a scene now says how it is
played**, and **the DS art now survives the pipeline**.

**(a) The formation is map data, and the queue is a pair.** `simulation.setFormation({ head,
input, autopilot, preferTags })` is the whole seam. `city/layout.js` exports
`{ head:'trainer', input:true, autopilot:'none' }` and `hunts` exports
`{ head:'pokemon', input:false, autopilot:'wander', preferTags:['tallgrass','encounter','path'] }`;
each scene applies its own inside `enter()`, **before** `placePlayer`, because `placePlayer`
lays the queue out through `formation.head` and a formation applied afterwards leaves the line
cut the wrong way round.

`rebuildMembers` now builds exactly two walkers — the trainer and `party[0]` — ordered by
`head`. The bench stays in `pokemon.party()`, shows in the party bar and can be swapped to the
front with `setLead`; it does not follow the trainer around. **`line.js` needed no change at
all**: with `trainerIndex === 0` the anchor *is* the head, so `place()` skips its forward loop
and lays the Pokémon at `trail[gap]` behind, and `pose()` already gives index 0 `line.facing`
(so the player's avatar turns on the spot into a wall, which is the Black & White behaviour you
want from your own avatar) and gives the follower `to.dir` (so it does not moonwalk round a
corner — DECISIONS #27's reason, unchanged).

`config.followerGapTiles` stays at **2**, and the re-reasoning matters because #27's argument
looks like it was about the lead: it was not. A walker covers `2.83 · sin(45°) = 2.0` tiles of
ground depth on screen, so two walkers less than two tiles apart overlap **whichever order they
are in**. The floor is a property of the separation. What does change is who is occluded, and
the case to look at is the party walking *south*, where the trainer both leads and is nearer
the camera.

`player:moved` still carries the trainer and `player:enteredTile` still carries the head — but
in the city the head *is* the trainer, so **the trainer now triggers city grass**. That is not
an accident to be papered over: `city/map.js:338` really does plant `['tallgrass','encounter']`
over the two patches in `layout.js:170-173`, and `encounter/tables.js` has a real `city` table
at `stepRate 0.06`. With the trainer in front, the body that visibly walks into the grass is
the one that rolls, and `encounter.stageCell()` still stands the wild two cells ahead of the
head with no code change. `followerCell()` needed none either; `follower()` and `lineup()` did,
because both were reading slot 0 rather than *the Pokémon*.

**(b) The autopilot moved from the lobby to the hunt, which is where it belonged.** It used to
be installed unconditionally at boot — in the city, the one place the player should be driving
— and `placePlayer` reset the route without ever replacing it, so the city's own
`preferTags:['path']` wander followed the player into a forest and biased the party away from
the grass it was there to hunt in. It is now forked per scene
(`ctx.rng.fork('simulation/wander/hunt-forest')`), so two biomes are two strolls and each is
reproducible from its own stream. Measured: two loads of `/` now leave the party on the same
cell with `autopilot: 'still'`; before, they did not.

That kills DECISIONS #34(c)'s "the first real input calls `halt()` once, permanently" seam, and
with it the measured trace in #34(c) — **read that entry as history, not as behaviour**. A
walkable map has no route to take over from, and halting a hunt's wander is the one thing a
stray keypress must not do.

**(c) Input is refused, not swallowed.** `moveIntent` returns `false` where the scene says the
player does not drive, which closes the console and any future input source as well as the
keyboard; `ui/input.js` checks the same flag, still calls `preventDefault()` on the arrows
(a page that scrolls out from under the game is worse than a dead key), does not draw the touch
pad, and raises **one** toast per scene saying who is leading. The hint's dismissal flag had to
change meaning with it: it read `hasMoved()`, and in a hunt the player can never move, so a
control hint would have sat over the near ground in every hunt frame a critic ever took.

**(d) Run is gone, the sheet data is not.** One cadence, `walkSecondsPerTile`. `running`,
`runSeconds` and `runSecondsPerTile` are removed from `line.js`, `route.js`, `simulation`,
`config` and the touch pad's RUN latch. `sprites.js` keeps `TRAINER_SHEET.run` and
`TRAINER_MIRRORS`: DECISIONS #17 measured those trios and the per-sheet mirror pairs frame by
frame, and the measurement is worth more on the record than the four lines it saves. The
selftest's "0.15 s/tile is exactly 3 sim ticks" check is **replaced rather than deleted** — it
now steps with a stray `running: true` and asserts the tile still takes five ticks, so a caller
that has not been updated cannot quietly resurrect a second cadence. `simulation/showcase.js`'s
`run` mode went with it, which `docs/STATUS.json` had already asked for on its own merits.

**(e) `travel` is a module, not core.** Core is the only thing every module may import, and a
scene manager needs `city`, `hunts`, `simulation`, `encounter` and a save slice. It is not `ui`
either — that would put the destination table, the teardown order and the save in the
presentation layer, unreachable from the boot path. So `src/travel/`, `needs: ['terrain']`,
neighbours through `ctx.get`, and `src/main.js` keeps the old `city.enter()` as the fallback so
a quarantined `travel` costs the game travel and not its lobby. Exactly two core edits fall out:
the `scene:entered` row in §4, and a `scene` key in `config` (which is what lets the harness
frame a hunt at `/` with `?scene=hunt-forest` instead of only in a showcase).

**Three bugs had to be fixed before travel could work, and two of them had never worked at
all.**

1. `city` had no `world:unloaded` listener. `hunts` has had one since it was written; the city
   only ever tore down inside its own `enter()`, which covers entering it twice and not
   *leaving* it. Travelling city → forest would have left the Pokémon Center, the Mart, the
   cottages, the lamps and thirteen NPCs standing in the middle of the wood. Probed over
   `forest → city → cave → city`: draw calls and triangles return to the same numbers each
   time instead of climbing, which is what a leak would look like.
2. `offline` discovered its providers from `Object.keys(ADAPTERS)`, not from the registry.
   §5 promises a module opts into saving "simply by having" `saveState`/`loadState` and needs
   no entry anywhere — it was not true, and **`encounter` has shipped a save seam that nothing
   ever called** since it was written. Passing the registry's ids fixes both at once; steps,
   encounter count and the chosen ball now persist for the first time.
3. `offline`'s `restorePlayer` listened for `world:loaded` — which `terrain.load()` emits from
   *inside itself*, a few lines before the scene calls `placePlayer(spawn)`. So the restore
   landed and was overwritten microseconds later, on every boot the game has ever had. It
   listens for `scene:entered` now, which fires after `enter()` has resolved, and restores
   **once per session** so travelling city → forest → city does not yank the player back to
   wherever they last saved. `slices.js` was also reading `handle().mapId`, and `handle()`
   returns `id` — that read had been `null` since it was written, which is why the bug was
   invisible rather than merely wrong.

There is one ordering trap worth writing down: `offline` builds its provider list during its
own `init`, and the registry's topological order does not guarantee `travel` is up by then.
So `travel` also hands its seam to `offline.store.register()` directly when `offline` is
already live, and pulls the slice `hydrate()` read before it existed. Both orders work; neither
is relied on.

---

**(f) A sprite texel is a whole number of internal pixels, at any camera distance.**

The complaint was that the trainer and the Pokémon "are strange and without quality, some
pixels are not real". They were right, and it is measurable: `assets/trainer/hero.png` frame 0
is **14 colours**; an 80×180 crop of that same trainer on screen was **2165**, and the source
orange `(255,180,32)` arrived as `≈(240,144,1)`.

Three causes, stacked.

*The magnification was fractional.* At `cameraDistance: 30` one sprite texel covers **1.62**
internal pixels, so NEAREST hands out blocks 1 and 2 pixels wide at random. DECISIONS #18 knew
this — it names 24.365 as the distance where a texel is exactly two pixels and filed the
default as a coreRequest. **We did not take that route**, because it only fixes one distance
and it was explicitly not what was asked for. `field.js` derives the world size of one internal
pixel **at the camera's focus plane**, rounds the magnification there to a whole number, draws
the whole cast at that magnification, and shifts each sprite so its own anchor lands on a whole
pixel at its own depth. It holds at any distance, which is the point. (Round one rounded per
sprite instead, which strobed — see (g), which is the correction.)

*The quad stays upright.* Round one laid it **parallel to the image plane** — every point at
one depth, so the magnification is exact everywhere on the sprite rather than drifting ~6 %
between the feet and a head that sits ~2 units nearer at a 45° pitch. That was reverted in (g)
and the residual is recorded there: it also rotated and translated the matrix that
`environment/castShadows.js` reads a sprite's geometry back out of, which detached every
projected shadow from its own feet. The quad keeps `frameWorldSize`'s `1/cos(pitch)` aspect —
which is what makes its texels square on a screen looking down at 45° — and only grows, so the
matrix keeps the exact shape that shader decodes: no rotation, `scale = (w, w/cos(pitch), 1)`,
translation at the feet.

**Sprites therefore render about 23 % larger** at the shipped distance on a 1080p window —
1.62 rounds to 2 — and about 27 % *smaller* at 900p, where 1.36 rounds to 1. That is the price
of exactness at an arbitrary distance rather than at one chosen one, and it is why
`pixelExactDistance()` exists for the showcases that would rather move the camera.
`?spriteSnap=0` restores the old behaviour and `?spriteMagnification=<n>` pins it.

*The camera had to be snapped too.* Pinning a sprite to a whole pixel while `makeCameraRig`
lerps the focus continuously slides the *ground* under it by a fraction of a pixel every frame
— the same mush from the other side, and `simulation/index.js` already had a comment naming it.
The rig now offsets along its own right/up axes so the focus projects onto a whole internal
pixel. `?cameraSnap=0`.

*The shading was per fragment.* `receiveShadow` samples the sun's shadow map once per fragment
through `environment`'s PCSS filter, so a flat cutout of fourteen colours was being softly
graded across its own face: 2165 colours became 1321 under `?envNoShadow=1`, so roughly 40 % of
the spread was that one lookup. The fix moves the sample rather than removing it —
`worldPosition` is swapped for the instance's own origin for the duration of
`shadowmap_vertex`, so every vertex writes the same shadow coordinate and the varying
interpolates to a constant. The sprite still darkens in a building's shade and still goes blue
at 21:00; it just does so as a whole, the way a DS sprite does.

That swap has to be wrapped in three's own `#if` guard, and the reason is worth recording: a
scene with no shadow-casting light — `?showcase=hunts&mode=cave` is one, lit entirely by
ambient and practicals — never *declares* `worldPosition`, and the shader simply fails to
compile. The regression gate caught it as `hunts/cave/12 capture failed`, which is exactly the
job that gate exists to do.

*Two smaller ones, on the same principle.* Grain and the vignette were evaluated per **output**
pixel in a pass that runs at canvas size, so one texel blown up to a 6×6 output block received
36 grain values and 36 points along the vignette ramp. Both now quantise their coordinate to
the internal grid — two lines and one uniform. Bloom deliberately stays where it is: moving it
before AgX would turn it from scene-linear into additive-in-display-space and retune every
`environment` preset, which is a large risk for the smallest of the three defects. And
`ui/hud.js`'s `drawIcon` picked a fractional scale (0.906 in a 29 px cell at 720p) — with
smoothing off `drawImage` does not blend a fraction, it *drops rows*, so it is clamped to whole
ratios now.

*The final upscale is an integer, by overscanning rather than letterboxing.*
`floor(w / pixelScale)` does not divide back: 1600 gives 533, and 533 → 1600 is ×3.002. 1080p
is the one size where it happens not to bite, which is why DECISIONS #34(a) documented it and
moved on. The canvas is now `ceil(w / scale) · scale` and hangs up to two pixels off each edge,
clipped. Letterboxing was tried first and reverted **for a measured reason**: every number this
project gates on comes from `sceneStats` over the whole PNG, and black bars read as scene
content — at the gate's own 1280×720 they moved `belowL8Pct` on five of fifteen frames and
`boot/12`'s saturation from 0.689 to 0.540 without a pixel of the picture changing.

**What this is worth, measured — and which fix earns which number.** In a 100×220 crop of the
city trainer at 1920×1080, noon: **3123 colours → 707**. Inside the orange of the backpack
alone, which is one colour in the source: 67 → 22. And the picture that settles it is
`k-snap-6x.png` against `a-baseline-trainer6x.png` — the same sprite, before as a smear of 1-
and 2-pixel blocks, after as `hero.png` frame 0 with square texels.

Do not attribute all of that to the sprite snap. Re-run with `?spriteSnap=0`, which leaves the
flat shadow sample, the quantised grain and vignette and the integer upscale in place, and the
same crop still falls to **816 colours** — so those three account for most of the collapse and
the snap for the last 109. Likewise the "colour boundaries on the internal pixel grid, 34.9 %
→ 90.8 %" figure written in the first draft of this entry: `?spriteSnap=0` scores 92.2 % on it,
because after a NEAREST upscale of a buffer whose grain and vignette no longer vary inside an
internal pixel, *every* boundary lands on the grid whatever the sprites do. It measures the
composite, not the sprites, and it should not be quoted for the sprites.

The metric that is actually about the sprites is the magnification itself, read off the
instance matrix on the running page: **1.62 px per source texel → a whole number, within
0.3 %** — 1.994 at 1920×1080 and 1920×1000 where the shipped distance rounds to 2, 0.998 at
1600×900 and 1280×720 where it rounds to 1. (The 2165 → 449 and 35.2 → 89.3 figures first written
here were the same measurements on a smaller 80×180 box against round one's geometry; these
supersede them.)

**The gate.** `node tools/shots/regress.js`: 10 improved, 1 regressed, 3 moved across fifteen
frames. Eight of the ten "improvements" are **not this work** and must not be claimed as it —
`hunts/forest/21` and `meadow/21` p99 91→163 and 75→183, max 161→255, over200 0→0.556/0.762 —
they are the campfire round `docs/STATUS.json` already recorded as landing after the baseline
was taken, and the numbers match that entry digit for digit. The frames this work genuinely
moves are `boot/12` and `hunts/meadow/12`, and it moves them by **composition**: two walkers
where there were four, standing at the spawn instead of wherever the wander had taken them,
at 23 % more sprite. `node tools/seams/run.js` — 123 files, 16 modules, all contracts hold.
`node src/simulation/selftest.js` — 34 checks.

**(g) One magnification for the whole cast, because rounding per sprite strobes.**

The first thing the player said back was that the sprites now blink, "getting bigger and small
fast". They were right and the cause is in (f) as first written: `m = round(mFloat)` per sprite
per frame, where `mFloat` is a function of that sprite's own **continuously moving** depth. A
walker whose depth carries `mFloat` across an x.5 boundary flips between one and two pixels per
texel — a 2× jump, every frame the wobble crosses back.

Reproduced before it was fixed, so the fix has a control: at 1080p in `hunt-forest` with
`__HOOKS__.setConfig({cameraDistance: 32.4})` — the distance that puts the party's `mFloat`
exactly on 1.50 — the lead Pokémon's on-screen height alternated between **33.0 px and 66.2 px**
twice in 240 frames. The same run now reports **0 jumps**, as does every other distance tried
(the shipped 30, 24.365, 14).

A second defect fell out of the same measurement and would have been reported next: at
1920×1000 two identical city NPCs whose depths differ by ~7 % straddled the boundary and
rendered at **33 px and 66 px in the same frame**. Per-sprite rounding cannot not do that.

So the magnification is now **one integer for the whole field**, taken at the camera's focus
plane — read from `makeCameraRig`'s own `unitsPerPixel()`, newly published for the purpose,
because a sprite grid that is not the world's grid is two grids and the picture shimmers
between them. Every sprite is drawn `k = m / mFloat` times its nominal size; the anchor snap
stays per sprite at its own depth, since where a sprite falls on the grid is its own business.
The consequences are worth stating plainly:

- the party is **exact** — within 0.3 % of the integer at every window size tried, 1.994 where
  the shipped distance rounds to `m = 2` (1920×1080, 1920×1000) and 0.998 where it rounds to
  `m = 1` (1600×900, 1280×720) — because the camera focuses on the trainer, at any distance;
- everything else scales **smoothly** with depth (the follower, two tiles off the focus plane,
  lands at 2.10 px/texel) instead of jumping between integers. That is a smaller fault than a
  2× pop, and it is what perspective actually looks like;
- nothing can flip per frame, because `cameraDistance` is piecewise constant. A dead band of
  0.1 on top of the 0.5 boundary is kept anyway, against a preset that ever animates it.

The upright quad came back with it, and that is the honest cost: the head is ~2.5 units nearer
than the feet, so texel rows run 2.00 px at the sole and ~2.18 px at the hat, which puts about
three of the sprite's 32 rows a pixel over. Round one's camera-parallel quad had no such drift
— but it also rotated the instance matrix and pushed its origin ~1.4 world units toward the
camera, and `environment/castShadows.js` decodes that same matrix as "no rotation, scale
`(w, w/cos(pitch), 1)`, translation at the feet" to project a silhouette along the sun. Under
round one every projected shadow was therefore ~29 % short and displaced by over a tile from
the body casting it — visible in `hunts/forest/12` before and after, where the trainer's shadow
goes from a detached blob up and to the right to a shadow starting at the feet. The drift is
worth ~2.8 px over a 64 px sprite, about a texel and a half; the shadow bug cost every shadow
in the game its footing.

`?spriteSnap=0` remains the A/B and `?spriteMagnification=<n>` the pin. The flat shadow sample
also moved with the origin: it now reads the shadow map at the sprite's feet on the ground
rather than 1.4 units toward the camera in mid-air, which is more correct and does visibly
change a sprite standing at the edge of a building's shade.

### 59 — 2026-09-09 — The camera snap was cancelled by `lookAt`, the sprite snap was measured from the world origin instead of the camera, and it was all computed against the previous frame's camera

The report after #58 was that the sprites "appear to be recalculated every second… pixels
shimmering all over the place and the sprites getting different in different frames", both
while walking and while standing still.

**Nothing is recalculated, and nothing runs at 1 Hz.** The sprite atlas is keyed by
`` `${kind}:${url}` `` (`pokemon/field.js`), has no time, frame, seed or `tod` component, and
`SpriteAtlas.ensure` early-outs unless a *new sheet* arrives. `field.update()` writes instance
matrices and uv-rects and allocates nothing; `Math.random()` is banned in `src/` and no
`Date.now()`/`performance.now()` appears on any sprite path. Two independent sweeps of the tree
for periodic invalidation came back with the UI glyph tint cache (15 s, HUD text only) and
nothing else. The symptom was **sampling**, and #58's own pixel grid was wrong in four places.

**(a) `makeCameraRig.update()` snapped the camera and then aimed it at the un-snapped focus.**
`lookAt` re-aims so the focus projects to exact screen centre whatever the position is — so the
snap was cancelled at the focus plane and the world went on sliding a fraction of a pixel every
frame, which is the entire defect the block was added for in #58(f). Worse, it rotated the
"locked yaw" basis by a hair every frame, and `pokemon/field.js` reads that basis back to place
its sprites, so one bug fed the other. Aiming *first* fixes both: the look direction is then
`(0, cameraLookAhead, 0) - offset`, both terms constant while the camera is only following, so
the basis really is fixed and the snap survives into the projection matrix.

**(b) The sprite anchor snap dropped the camera term.** Screen position is
`(p - camPos) · right / upp`. `field.js` snapped `p · right / upp`. Those agree only at the
focus depth `D`, where the rig has already made `camPos · right / upp(D)` whole; at any other
depth the same quantity is that whole number times `D / d`, which is not. So the follower,
every city NPC and every staged wild — everything that is not the trainer the camera is
focused on — snapped onto a grid that slid under them whenever the camera moved.

**(c) All of it was computed against the previous frame's camera.** `main.js` ran
`registry.frame(...)` — which is where `pokemon`'s `field.update()` lived — and only then
`rig.update(frameDt)`. The rig cannot move earlier: the focus is set from inside `simulation`'s
own `frame` hook. So core gains a **`lateFrame`** hook, run after the camera is placed and
before anything is drawn, and `pokemon` moves onto it. That also fixes a second frame of lag
nobody had noticed: `simulation` declares `needs: ['pokemon']`, so `simulation.frame` runs
*after* `pokemon.frame` and the matrices were built from last frame's actor positions too.
`environment/castShadows.js` needed no change — it does `mesh.instanceMatrix = src.instanceMatrix`,
sharing the buffer rather than copying it, so a projected shadow cannot lag its body.

**(d) An odd internal buffer put every anchor on a half pixel.** `resize()` rounds the buffer
*up*, so odd is the ordinary case away from 1080p — 1600×900 is 534×301, 1280×720 is 427×241.
The screen coordinate is `dim/2 + v`, so `v` wants to be whole on an even buffer and a half on
an odd one; `Math.round` gave whole in both, and 1080p (640×360, both even) is the one size the
gate captures at, which is why it looked right. `snapTo(v, phase)` with
`phase = (dim % 2) ? 0.5 : 0`, and `inW` is read now as well as `inH`.

**Measured, on the running page, over 120 frames of the party wandering in `hunt-forest`, with
each actor's instance matrix projected through the camera the frame was actually rendered
with** (the anchor's distance from a whole internal pixel, worst of x and y over every actor):

| | 1920×1080 (even/even) | 1600×900 (even/odd) | 1280×720 (odd/odd) | 390×844 (phone) |
| --- | --- | --- | --- | --- |
| before | 0.4996 px | 0.4997 px | 0.5000 px | — |
| after | 0.0001 px | 0 px | 0 px | 0 px |

The number that names the symptom is not the size of the error but its **wander**: before, each
actor's sub-pixel offset swept the full pixel (spread 0.97–1.00) and took **~105 distinct values
across 120 frames** — a different sub-pixel position on essentially every frame, which is
"the sprites getting different in different frames" exactly. After, every actor sits on
**one** offset for the whole run (spread 1e-4) at every buffer parity.

#58(g)'s own control holds in the same data: the cast's on-screen heights drift smoothly with
depth over ~99–109 distinct values per actor across 210 frames — the lead walker spans
68.0–69.7 px — with no sign of the 33 ↔ 66 px flip (g) was written to remove.

**(e) Grain does not animate any more, and that is the half that was visible standing still.**
#58 moved grain from per-output to per-internal pixel for a good reason, but kept the per-frame
phase — so at `pixelScale: 3` every sample became a 3×3 block of output pixels at full
amplitude, re-rolled every frame, over the whole screen. In the city with the player standing
still and the clock effectively frozen (`secondsPerGameHour=1000000`), the share of output
pixels that change from one frame to the next: **83.2 % with the phase running, 6.5 % without**.
A fixed dither still breaks banding, which is grain's job here. `?grainAnimate=1` is the A/B.

The number that is actually about a sprite is the same diff taken **inside a 200×247 box around
the standing trainer** (49 400 pixels), and it is worth having rather than inferring, because
the residual could have been the blob shadow or the flat-shadow sample:

| | pixels changing per frame pair, in the trainer's box |
| --- | --- |
| `?grainAnimate=1` | 43 169 – 43 643 (≈88 %) |
| shipping | **6 – 39 (≈0.07 %)** |

Those survivors are not the sprite. They are scattered over the whole box rather than clustered
on the body, and **every one of them moves by exactly 1/255** — about half of them stop under
`?timeFrozen=1`, so that half is `environment.apply()`'s continuous regrade writing new
`exposure`/`contrast` floats into config on every tick, which is pre-existing and unrelated.
It is not zero and is not claimed to be; it is one least-significant bit on 0.07 % of the box.

The regression baselines do not move: the harness already captured with `timeFrozen`, i.e.
`uTime = 0`, which is what this now does in play as well.

**Not the cause, and worth writing down so it is not chased again.** The phase was
`(frameCount++ % 64) * 0.017`, a 64-frame loop ≈ 1.07 s at 60 fps, and it is tempting to read
"every second" straight off it. It is not that: consecutive frames draw uncorrelated noise, so
the period is not perceptible. "Every second" is two things at once — grain flicker that never
stops, and the step/settle cadence of walking, where `cameraDamping: 0.12` makes the camera
lerp hard on each tile step and then settle, firing (a)–(c) in bursts.

**The gate.** Run against the same tree with and without this change, rather than against
`docs/baseline.json`, which predates #58 and would have scored both at once. Before: 10
improved, 1 regressed, 3 moved — digit for digit what #58 recorded, which is the cross-check
that the reconstruction was faithful. After: **11 improved, 1 regressed, 3 moved**. No new
regressed row; the pre-existing `boot/12 belowL8Pct` is #58's and is marginally better
(1.658 → 1.654); one row improves (`city/high-street/21 max 250 → 255`); everything else moves
in the fourth significant figure, which is what shifting every sprite by up to half a pixel
looks like. `node tools/seams/run.js` — 123 files, 16 modules. `node src/simulation/selftest.js`
— 34 checks. `node tools/shots/shoot.js --tod 11` — 60 fps, p95 16.7 ms, 221 draws, 19 576
triangles, 22 programs, and `consoleErrors`/`consoleWarnings` both empty in the sibling JSON.

**Residual, deliberately left.** #58(g)'s one magnification for the whole cast still means
sprites off the focus plane sit at a fractional px/texel (the follower at ~2.10). With the
anchor now genuinely on the grid that is a *static* distortion at a given depth rather than a
per-frame change, and the alternative — rounding per sprite — is the 2× strobe #58(g) was
written to remove.

### 60 — 2026-09-09 — `unitsPerPixel` was an output of the window size, so the trainer was 82% bigger on a monitor than on a laptop; it is the primitive now, and the camera is orthographic

**The report.** "Some screens have the trainer, pokemons and npcs assets bigger, i want a
concise view independent of the device with perfect pixel that dont change when im walking
neither on trainers, structures or props. All pixelart environments sometimes create additional
borders or lose the core definition of how it looks."

Three complaints. One root cause and one architectural limit.

**(a) The density was an output, not an input.** `resize()` pinned `pixelScale: 3` but let the
internal buffer *height* float with the window, and the camera framing was fixed in world units
(`fov 26`, `cameraDistance 30` → 13.85 units tall, always). So internal pixels per world unit
was `ih / 13.85` — a different number on every screen:

| viewport | `ih` | px/unit | `mFloat` | `_mag` | **`k`** |
| --- | --- | --- | --- | --- | --- |
| 1280×720 | 241 | 17.4 | 1.087 | 1 | 0.92 |
| 1600×900 | 301 | 21.7 | 1.358 | 1 | **0.74** |
| 1512×982 | 328 | 23.7 | 1.480 | 1 | **0.68** |
| 1920×1080 | 360 | 26.0 | 1.624 | 2 | **1.23** |
| 2560×1440 | 481 | 34.7 | 2.170 | 2 | 0.92 |

`k` is `field.js`'s `_mag / mFloat` and it multiplies every trainer, Pokemon and NPC quad, so
the cast was drawn between 0.68× and 1.23× of its authored size depending on the window — an
82% spread, and a *discontinuous* one, because `_mag` is a rounded integer. That is the whole
of complaint one, and no amount of tuning fixes it while the density is downstream of the
window.

Tiles and structures are authored at 32 texels per world unit (`tools/structures/textures.js`)
and were being rendered at 17–35 px/unit, never 1:1. A NEAREST minification at a fraction drops
texel rows, and *which* rows it drops changes as the camera moves. That is complaint three, and
it is the same defect.

**The fix is to invert the dependency.** `config.pixelsPerUnit` is now the primitive: a
constant, 32, and `rig.unitsPerPixel()` returns `1 / 32` exactly rather than measuring
`2·D·tan(fov/2)/ih`. The camera frustum is derived from *it* and the internal buffer.
`mFloat` therefore comes out at a whole 2 and `k` at exactly 1, on every device.

**The ladder is 16, 32, 64 and nothing else.** Sprites carry 16 texels/unit so `ppu/16` must be
whole (16, 32, 48, 64); tiles carry 32 so `ppu/32` must be whole or an exact half (16, 32, 64).
48 is the number that looks reasonable and is not. Verified against the shipped assets: every
PNG under `public/generated/tiles/*/tex/` is 8/16/32/64 px on a side and every non-zero
`uvScale` in the catalogs is 0.25, 0.5 or 1 — all power-of-two, all integer at 32.

**(b) Perspective could only ever fix one row of the screen.** Locking the density is
necessary and not sufficient. At pitch 45° and half-fov 13° the camera sits `D·sin45 = 17.2`
units up; the top ray meets the ground at slant depth `17.2/sin32° = 32.5` and the bottom at
`17.2/sin58° = 20.3`, so `D/d` runs **0.75 at the top of the frame to 1.20 at the bottom**.
After a density lock, tiles would be 1:1 on one horizontal row, minified 25% at the top and
magnified 1.2× at the bottom, and that pattern crawls as the camera follows the player.
#58(g) already conceded this in its own terms ("everyone else keeps scaling smoothly with
depth"), and #59's residual note named the follower sitting at ~2.10 px/texel.

So the camera is **orthographic**. `unitsPerPixel` is depth-independent, which means the one
camera snap in `rig.update` grids the entire frame rather than the focus plane, and a walk is a
whole-pixel translation of every building, fence, tile and sprite in it. This is the only option
that answers the sentence as written — "neither on trainers, structures or props" — and it was
chosen with its cost stated: the picture flattens, and every baseline and score is re-taken.

**(c) Two latent defects found while measuring, both fixed here.**

The aim was never 45°. `lookAt(focus.x, focus.y + cameraLookAhead, focus.z)` from
`focus + offset` gives a look direction of `(0, 1.6, 0) - (0, 21.2, 21.2)`, i.e. **42.77°**.
`sprites.js` pre-stretches every sprite by `1/cos(cameraPitch)` to cancel the foreshortening of
an upright quad, and it was cancelling an angle the camera was not at: every sprite in the game
was **3.9% too tall with non-square texels**. The rotation is set directly now and
`cameraLookAhead` is a whole-pixel translation along the camera's up axis, taken before the
snap so the snap leaves it alone.

`resize()` rounded `ih` up to whatever it landed on, so odd buffers were the ordinary case
(1512×982 → 504×328, 1600×900 → 534×301). A sprite edge lands on a pixel boundary when
`dim/2 + v` is whole, so an odd buffer wants a half-pixel phase — `field.js` applied one and
`render.js`'s camera snap did not, which is two grids. Both dimensions are rounded up to
**even** now. That costs one internal pixel of overscan and deletes `snapTo`/`phaseX`/`phaseY`
outright.

**(d) `pixelScale` adapts, and the stretch branch is gone.** At a pinned 3 a 390 px phone
rendered the world into a **130 px** buffer, about five pixels per tile — unusable before any
of this. `pixelScale: 0` derives it as `round(width / targetInternalWidth)`, bumped while the
buffer would exceed `maxInternalWidth`. That also replaces the old `capped` branch, which gave
up above ~2900 px and stretched by a non-integer — the exact defect the surrounding comment
was written to prevent, one stage later.

**What it cost: zoom is three rungs, and ~40 framings collapsed onto them.** The hunt biomes
used `distance` as a continuous knob across 16, 22, 24, 26, 28, 30, 32, 34, 40, 44, 46, and the
gauntlet had its own ladder. Every intermediate value was non-pixel-exact — that is the defect —
so snapping them is the fix, but framings that differed only by a few tiles now differ only by
their marker. `cave --preset wide` is the one that lost something real: it was 34, a *slightly*
wider frame, and 46 had already been tried and rejected as "a picture of nothing"; there is no
rung between 32 and 16, and 16 is the 46 that did not work, so it stays at 32.

Two showcases needed the second knob rather than a coarser rung. A tiles contact sheet is wider
than the game's own 20 cells and the ladder cannot reach it, so `rig.fitFraming()` buys the room
by **widening the buffer** (dropping `pixelScale`) at an unchanged density: `tiles/12` now shows
all eleven autotile sets *and* every texel 1:1, where the old shot showed them at ~21 px/unit
with the horizon in frame. The encounter stops were `k: 3` — not on the ladder — and `close`
cut the party off at the knees against the message box, so they take `normal`, which is also
the zoom the game runs at.

`coast --preset shore` needed the *camera* moved rather than the zoom. The marker stands eight
cells inland of `shoreAt(cx)`, which put the shoreline and the water in the top third at the
perspective camera's 20.7 cells of ground depth and left a sliver of sea against the top edge at
the orthographic 15.9 — a biome named for the thing that had fallen out of frame. Dropping it to
`ppu 16` would have halved the detail of a shot whose whole job is shoreline autotiles, so it
takes `offset: [0, -3]` on the mechanism `stage()` already had. This is the shape of the audit
the ladder forces: for each framing, decide whether it wants a rung or a nudge.

Both `pixelExactDistance()` copies (`simulation/showcase.js`, `encounter/showcase.js`) are
deleted. They were this feature hand-rolled, they still used the pre-#59 `Math.floor` and
`innerWidth`, and they solved for a distance that was only exact at the window they were
measured at.

**How it is gated.** `tools/shots/parity.js`, new, and it asserts the claim rather than
describing it. Seven viewports — 390×844, 844×390, 820×1180, 1280×720, 1512×982, 1920×1080,
2560×1080 — must each report `unitsPerPixel` **exactly** 1/32, `_mag` exactly 2, `k` exactly 1
and both internal dimensions even; and a crop of the trainer must match the reference within 8
levels per channel. The tolerance is measured, not chosen:

| comparison | max Δ per channel |
| --- | --- |
| same window, captured twice | **0** (asserted separately, whole frame) |
| 1280×720 vs 1920×1080 | 1 (same 640×360 buffer; the composite runs at output resolution and bloom is sampled bilinearly at ×2 vs ×3) |
| phone / tablet / laptop / ultrawide | 4 (the vignette gradient — `environment.apply()` rewrites `vignette` and `grain` from its look table every frame, so they cannot be switched off for a shot, and both are functions of the *frame*) |
| `spriteMagnification=1` — the defect | **253**, on 2378 of 4096 px |

So 8 sits an order of magnitude below the defect and twice above the noise, and a grid error
cannot hide under it: putting a sprite on the wrong texel phase swaps whole blocks of DS pixel
art for their neighbours, and neighbouring colours in a 14-colour palette are tens of levels
apart. `--walk` takes two frames one sim tick apart and requires a whole-pixel offset that
reproduces the static frame: **96.95%** with the snap on, **85.8%** with `cameraSnap=0`, the
remainder in both cases being the NPCs, which walked too and are supposed to have moved.

`__HOOKS__.step()` had to learn to go through a showcase's freeze — a frozen `simulation`
ignores `registry.tick` outright, so the first version of the walk test was comparing a frame
with itself and passing.

**Honest limits, deliberately left.**

- A 45° tilted view foreshortens the ground, and any upright wall, by `cos45 = 0.707`: a
  32-texel/unit wall covers 32 px horizontally and 22.6 vertically. This is inherent to a 3D
  tilted view and is *not* fixed here. What matters is that under orthographic it is a **fixed
  affine map** — walking translates it by whole pixels, so it never crawls. Sprites escape it
  because `frameWorldSize` pre-stretches them; models would have to be authored pre-stretched
  to do the same, which is separate work.
- 64×64 textures at `uvScale: 1` are 64 texels/unit and sample 1:2 at ppu 32 — a clean, stable
  halving, but half the authored detail is discarded. `?pixelsPerUnit=64` for a close-up.
- 1080p now frames **20 tiles across** where `config.js` used to claim 24. `targetInternalWidth`
  is the one knob; 768 restores ~24 at the cost of a smaller pixel on screen.
- DPR is left to the browser on purpose, and this was measured rather than assumed —
  `shoot.js` pins `deviceScaleFactor: 1`, so no gate covers it. `setPixelRatio(1)` stays and
  `image-rendering: pixelated` does the CSS→device step. Sampling a 390×844 phone buffer at
  several device pixel ratios and asking whether each internal pixel is a *uniform* block of
  device pixels:

  | DPR | device block | ragged blocks |
  | --- | --- | --- |
  | 1 | 1×1 | 0 of 6600 |
  | 2 | 2×2 | 0 of 6600 |
  | 3 | 3×3 | 0 of 6600 |
  | **1.5** | 2×2 nominal | **3183 of 3780** |

  So an integer internal scale times an integer DPR really is integer all the way to the glass,
  and **fractional** DPR (Windows at 125%, browser page zoom) really does resample — 84% of the
  frame, at 1.5. Nothing in the app can see or correct that final blit. Out of scope, named here
  with its number so it is neither rediscovered as a bug nor quietly assumed to be fine.
- A portrait phone sees a *lot* of ground — 390×844 at ppu 32 is 12 cells across and 37 deep.
  That is the honest consequence of the aspect ratio, not a defect, but a preset framed near a
  map edge will show the void there where it does not at 16:9.
- The night practicals got hotter and are not tuned here. A lamp bulb covers `(32/21.7)² = 2.2×`
  the pixels it used to at 1600×900, so more of it clears `bloomThreshold`: `hunts/meadow/21`
  went `max 161 → 255` and `over200Pct 0 → 1.198`, and `hunts/forest/21` the same. The gate
  scores that as an improvement and the blind rounds have said night is where we win, so it is
  left alone — but it is a lighting change caused by a geometry change, it belongs to
  `environment`, and it should be looked at on its own rather than discovered later as a
  mystery.

**Every one of the 15 `_regress` rows moved. That is a re-baseline, not a regression** —
accepted with `--accept` after looking at all fifteen PNGs. The composition changed (a tighter
frame, a flatter picture), so the blind A/B has to be re-run before any claim about the score:
r4 was 2/7 and this entry does not predict r5.

---

### 61 — 2026-09-09 — The hunt becomes the game: a loop past fixed slots, a real turn engine, and money that is earned rather than accrued

The largest contract change the project has taken, and it starts by reversing a sentence
ARCHITECTURE has carried since it was written: **§5.6's "Battles are resolved, not turn-by-turn"
is gone.** Everything below is either measured in this entry or is a decision recorded here so
the phases that follow implement against it rather than renegotiate it (§12).

**What the tree actually was, checked before any of this was designed.** Every one of these is a
grep with zero hits, not an impression:

  - **Levels never change.** `simulation/index.js:50` seeds three starters at level 5 and nothing
    in the repo ever mutates `inst.level`.
  - **All experience is discarded.** `idle/index.js:213` calls `pokemon.grantExp(...)` behind a
    `typeof` guard and **that method does not exist anywhere in the tree** — the guard makes it a
    permanent no-op. It has been minting a number nobody could spend since it was written.
  - **Evolution is data, not behaviour.** `economy/index.js:268` builds `{ kind:'evolve', … }`
    objects that nothing consumes; `{ kind:'heal' }` and `{ kind:'exp' }` are dead the same way.
  - **The combat model is eleven lines.** `rolls.js:159 resolveBattle` is one win-chance
    comparison. No moves, no PP, no type chart, no damage formula, no HP, no fainting.
  - **There is no trainer.** No `trainerLevel`, no gate: `travel/index.js:56-73` returns all five
    destinations unconditionally from the first boot.
  - **The twelve `treasure` items cannot be obtained.** They carry mainline sell prices
    (`items.js:253-264`) and no drop table exists anywhere to grant one.

**(a) The loop, and who owns which half of it.** A hunt is a closed circuit walked forever past
fixed spawn slots; proximity starts a battle; a win is followed by a throw. The ownership split is
the thing worth writing down, because three modules touch one slot:

  - **`hunts` owns the slot cell**, authored into the draft with `MapDraft.mark`/`addTag`, which
    already exist (`terrain/draft.js:42, :62`) and needed nothing new.
  - **`simulation` owns the slot's NPC actor**, tethered to ±1 tile by a new `makeTether` route.
  - **`encounter` owns the index counter and the slot→encounter binding.**

Slots sit at Chebyshev distance **exactly 2** from the path: tether radius 1 plus trigger radius 1.
`compose.js:344-346` already excluded the walk lane when it placed decorative wildlife; that
exclusion stops being a screenshot fix and becomes the rule the geometry rests on.

**The looping walker was already there and nobody had used it for this.** `makeScriptedRoute(spec,
{ loop = true })` (`route.js:43`) has looped by default since it was written, and every biome
already carries a `walk.route` string — but those strings are screenshot staging, and real
gameplay ran `makeWander`. The one real hazard is that a **blocked step is silently skipped**
(`route.js:52-59`), which three separate places already document as routes drifting off-path with
no error (`compose.js:476-487`, `hunts/selftest.js:440`). Hence `strict`: a stall you can see beats
a drift you cannot.

**(b) The pity is a lerp, and it is NOT `catchOdds`'s `bonus`. The algebra is why.** The first
design folded it into the existing `bonus` parameter, and that cannot work. `bonus` multiplies `a`
*inside* the Gen 3/4 formula (`items.js:329-333`):

```
a = ((3 − 2·hp)/3) · catchRate · ballMult · statusMult · bonus
p = (65536 / (255/a)^(3/16))^4 / 65536^4
```

`p → 1` only at `a ≥ 255`, so the multiplier needed to reach certainty is a function of
`catchRate`, `hp`, `ball` and `status` **all at once**. No fixed multiplier can express "maximum at
125 % of the price". So `catchOdds` stays pure and untouched and the pity wraps it:

```
t    = clamp((sum / speciesPrice − 0.90) / (1.25 − 0.90), 0, 1)
odds = p0 + (1 − p0) · t
```

At 0.90 this is `p0` exactly, which is the requirement ("below 90 % the base % is unchanged"); at
1.25 it is 1. Two sub-decisions that were not asked and are recorded rather than left implicit:
**the ball being thrown counts toward its own throw** (add the price, then compute the odds —
otherwise the throw that crosses 125 % is the one that fails), and **a shiny shares its species'
pity key**, with the shiny premium living in `speciesPrice`; a separate key would make the rarest
thing in the game the one thing pity never helps with, which is backwards.

**All balls count**, specialty balls included, at their `price`. BP-priced balls are converted at
`BP_MONEY_EQUIVALENT = 2500`, which is a **third** copy of `automation/ball.js`'s `bpWeight` — so
it goes on seam rule 5's mirrored list rather than being left to drift the way `BASE_MONEY` and
`INCOME_MODEL` already did once.

**(c) Trainer level lives in `economy`, and that is not where it looks like it belongs.**
`economy.progress()` (`index.js:129-141`) is *already* the single snapshot every unlock gate is
evaluated against, and `requirementMet` already gates shop shelves, whole shops, upgrade tracks and
automations. Putting `trainerLevel` there means the travel gate, the shop gate and the upgrade gate
read one object, and `economy/state.js` already has `bump()`, lifetime counters and a save slice,
so the persistence costs nothing. `pokemon` owns creature instances and had **no save seam at all**;
a `src/trainer/` module would have cost a showcase, a selftest, a `main.js` ordering constraint and
a seventeenth module for about forty lines of state.

**(d) `BASE_MONEY` is zeroed, not deleted, and the reason is the gate.** `tools/seams/run.js`
rule 5 asserts `economy/pacing.js INCOME_MODEL` mirrors `idle/accrual.js` **by name** and fails with
`accrual.js no longer exports BASE_MONEY` the moment the export goes. That rule exists because the
copy had already drifted 0.85 against 0.55 with nothing able to notice — "the shop simply priced
itself against a game that no longer existed". Zeroing keeps the rule doing its job. `BASE_RESEARCH`
goes the same way and becomes per-battle-won: after this, **nothing in the game grows with the
clock**.

**(e) The accrual becomes a fold, and the additivity claim gets *stronger*.** `idle/selftest.js`
rests on chunked drain equalling one offline call exactly, and that holds today only because
nothing carries between encounters. The new loop carries — the pity sum changes the odds, balls
deplete, XP changes stats, party HP persists — so index-invariance is not available and pretending
otherwise is how a player comes back from twelve hours to a different game than the one that ran.
Whole encounters are still the integers in `(p0, p1]` (`accrual.js:402-404`, untouched), so chunk
boundaries still fall on whole encounters and cannot add, drop or renumber one; the fold runs those
integers in order against carried state, and a fold with exact carry composes. The **continuous**
half — the per-second products and their IEEE-754 summation caveat — disappears entirely with the
faucet, so there is less to prove than there was.

Fainting had no answer in the first draft and the offline replay cannot do without one: twelve
unattended hours will knock a party out. The rule is auto-potion below a threshold (which finally
lands the dead `{kind:'heal'}` branch), then swap, then **a partial heal per completed lap** — per
lap because that is additive over a chunked gap and "heal when you travel" is not replayable — and
a wholly fainted party stands still and accrues nothing.

**(f) The two encounter systems are unified, closing a core request filed twice.**
`encounter/index.js:38-40` admits that `idle` rolls its own encounters from its own
`idle/encounter/N` stream and that the module "cannot make it delegate without a core change, and
that is filed rather than pretended". `accrual.js` may not import `encounter/rolls.js` (seam rule
2), so the pure functions are **injected through `state`**, exactly as `state.tables` already is:
`encounter.pure()` returns `{rollAt, dropAt, resolve}` and `idle`/`offline` add it where they
already back-fill `tables` and `balls`. `accrual.js` stays `ctx`-free with no new imports, and a
quarantined `encounter` produces zero encounters — a visible degradation rather than a silent
disagreement. One index space, `root/encounter/roll/N`, live and idle and offline.

**(g) Determinism: every new roll is index-addressed, and one thing must be pinned.** New streams
are `root/battle/<i>/<turn>`, `root/encounter/slot/<biome>/<k>/<n>` and
`root/encounter/drop/<i>`; `root/encounter/battle/<i>` is retired with `resolveBattle`. **A slot's
occupant is `rollAt(globalEncounterIndex)` and nothing else** — the slot stream decides *when* a
slot refills, never *what* stands in it. Species is the first draw in `rollAt`'s contractual order,
so a second species roll would make live and offline disagree about index N, which is the exact bug
(f) is about, arriving from the other end.

Inside a turn the draw order is a contract the way `rollAt`'s is: speed-tie coin, then per side
(paralysis skip, confusion self-hit, accuracy, crit, damage roll, multi-hit count, secondary
chance, flinch), then end of turn (burn/poison, sleep, thaw, confusion). New rolls go on the END,
and **a draw is taken unconditionally and discarded when unused** — a conditional draw makes the
stream position depend on state, which is why `rollAt` already draws all six IVs whether the caller
looks at them or not. It is also why a Showdown `secondary` with no effect this engine models is
**dropped at build time** rather than kept: a coin rolled for an outcome nobody reads would move
every subsequent draw in the turn.

**Which goldens survive, honestly.** `encounter/selftest.js`'s four golden encounters (0/1/7/250 at
seed 1337) **survive verbatim**, provided moves are derived from the learnset and never rolled —
keeping that check passing is the evidence the index space was not disturbed. The stream-start pin
partially breaks: `roll/7`, `catch/5/1` and `step/0` stand; **`battle/12` (`roll
0.8988670797552913`, `hpFraction 0.21394539445638655`) is deleted** with `resolveBattle`, along
with selftest check 15. No save migration is needed for *that* — nothing ever persisted a battle
outcome; `encounter`'s whole slice is `{v, steps, encounters, ball}`.

**(h) The city keeps its tall grass, and that is a decision.** DECISIONS #58(a) had just wired the
trainer to trigger the city's 76 grass cells and `encounter/tables.js` carries a real 23-row `city`
table at `stepRate 0.06`. Slots are how a *hunt* works; a walkable map the player drives keeps
`player:enteredTile` → `stepRoll`. Keeping it is less work than removing it, it keeps the `step/0`
golden alive, and it does not violate "the hunt is the only way to evolve" — because evolution is
gated on `grantExp(…, { source:'hunt' })` in `pokemon`, at one point, regardless of where the
battle happened. City battles grant experience and **no drops**: drops are the money source and
money is hunt-only.

**(i) `hpFraction` is ~0 by construction now, and that is intended, not a bug to be fixed later.**
The loop throws at a *defeated* wild, so `catchOdds` clamps to 0.01 and every throw takes the
maximum HP bonus. It is also why `resolveUnattended()` and its `T.LEAVE` beat (1.3 s) are removed:
a multi-turn battle cannot coexist with a beat that auto-pays after 1.3 seconds, and that beat only
ever existed because **nothing in the game threw a ball** (#35(g)). The throw is automatic now, so
its reason is gone.

**(j) `automation` will break silently unless it moves in the same phase.**
`automation/index.js:689-705` calls `encounter.attempt()` **synchronously inside the
`encounter:started` emit** — #35(f) describes that as deliberate. Once `attempt()` refuses before a
win it returns `false` forever, auto-catch dies with no console error, and
`automation/selftest.js` would not notice because it exercises the pure ball optimiser against a
stub. `battle:ended {won}` is emitted and the subscription moves onto it.

---

**The data step, measured.** Two build-time scripts, both cache every remote input under
`node_modules/.cache/` and sort every key and array before `stringify`, so a rebuild is offline and
byte-stable. **Both were run twice and produced byte-identical output.**

**Capture rate and growth rate were not missing, they were in a file nobody had joined.** Showdown
publishes neither. PokeAPI's `data/v2/csv/pokemon_species.csv` publishes both, and the join against
our 1253 sprite folders is **994 by slug, 259 by dex number, 0 unmatched**. `pokemon.csv` supplies
`base_experience` the same way. **Do not reach for `veekun/pokedex` instead** — it is the same
dataset but its master stops at species #898, which drops all of Gen 9 including `lechonk`, a live
row in `encounter/tables.js`. So the two BST-derived catch-rate proxies the tree grew while this
was missing (`encounter/rolls.js:76` and `automation/fields.js:59`, character for character the same
curve, and the subject of an open core request asking for a mirror check between them) are both
obsolete: there is one committed field now, and no third copy was added beside them.

**Showdown records an evolution on the child; the game asks the opposite question.**
`ivysaur.evoLevel = 16` says what ivysaur needs to exist, but a levelling Pokémon asks "do I become
something?". The requirement is inverted onto the parent once, at build time, into
`evo: [{to, level, type, item, cond}]` — **492 parents** carry one. `evolves: string[]` is kept
beside it unchanged; nothing reads it yet and a rename would be churn. The stone ids fall out
exactly right with no mapping table: `toSlug('Water Stone').replace(/-/g,'')` is `waterstone`,
which is verbatim the id `economy/items.js:191-194` already ships.

**The trim is the whole point of the battle data.** Showdown's `learnsets.json` is **3.05 MB** and
almost all of it is TM/egg/tutor/event rows for generations this game does not model. Keeping only
level-up entries, from each species' **latest generation that has any** — not a hard `9L` filter,
which would leave a Pokémon cut from the current games with no moves at all — and then keeping only
the moves those entries reach:

| file | before | after | gzipped |
| --- | --- | --- | --- |
| `moves.json` | 490 KB, 954 moves | **64 KB, 721 moves** | 12 KB |
| `learnsets.json` | 3.05 MB | **266 KB**, 1253 species, 18 330 rows | 53 KB |
| `species.json` | 388 KB | 504 KB (+ catchRate, growthRate, baseExp, evo) | 62 KB |

**330 KB of new payload, 65 KB gzipped**, fetched by `battle`'s own `init` and **not** by
`pokemon` — which already awaits `species.json` on the boot critical path against the ≤ 6 s cold
budget (§7), and which should not lose its sprites because a move table 404'd.

**Learnset coverage is 1253 of 1253**, because a cosmetic form with no learnset of its own falls
back to its base species (**190 species**) the same way `build-species.js` already folds its stats.
Average 14.6 level-up moves per species. Spot-checked against the mainline: Pikachu is
`4:thunderwave … 36:thunderbolt 44:thunder`, Caterpie is `1:stringshot 1:tackle 9:bugbite`.

**The effects the engine has to model are all present in the trimmed table**, counted rather than
assumed: 161 moves with a secondary effect, 66 with stat boosts, 27 multi-hit, 22 high-crit, 14
with a direct status, 11 recoil, 11 drain. Everything else is plain damage at its correct power,
type and PP, which is the agreed depth.

**The 18×18 type chart is source, not data.** ~324 non-neutral entries that have not moved since
Gen 6; it is authored in `src/battle/types.js` and pinned by landmark pairs in that module's
selftest. A network fetch and a boot-time parse for a constant is cost for nothing.

**After the data step, before any gameplay change:** `node tools/seams/run.js` green (124 files, 16
modules), and `/` at tod 11 renders at **60 fps, 221 draw calls, 20 k triangles, 0 console errors,
0 warnings, all 16 modules ready** — `docs/progress/_boot/phase0-boot.png`, looked at.

---

### 62 — 2026-09-09 — Evolution stops happening to the player: it is a button, and it costs a hunt's worth of drops

DECISIONS #61 shipped evolution as an automatic consequence of a level threshold, gated on
`source === 'hunt'`. Asked to look at it, the answer was that it was still the wrong shape: an
evolution that fires the instant an experience bar crosses a line is something that **happens to**
the player, and the only decision they get is where they happened to be standing when it did.

**It is manual now, and it is priced.** `grantExp` reports and stops; `pokemon.evolve()` is the
only path into an evolution, and the only thing that calls it is a button.

**(a) The hunt gate moved from a place to a price, and that is a stronger rule.** §0 said
evolution happens only in a hunt, and that was enforced by checking where the party was. It is
enforced now by what the evolution *costs*: a level **and** a pile of `category: 'treasure'`
items. Those twelve items have shipped in `economy/items.js` since the economy was written — with
mainline sell prices, no buy price and **no way to obtain them at all** — and they become the
drop table in phase 5. So an evolution is a reason to go hunting rather than a number going up on
its own, and it cannot be reached by idling in the city no matter how much experience accrues.

**(b) The bill is derived, not authored, because 492 lines evolve.** Same argument as
`speciesPrice`: a hand-written table of 492 requirements would be 492 numbers to maintain and one
of them would always be wrong. `pokemon/evolution.js` derives it from three things the data
already carries:

  - **which material** — the parent's primary type picks one of four families, and the four
    families are exactly the twelve treasure items (`mushroom`, `pearl`, `star`, `mineral`).
    Thematic rather than balanced: a Grass-type wanting mushrooms is a thing a player reads once.
  - **which rung** — the *child's* base-stat total, not the parent's, in three bands at 420 and
    520. The cost tracks the prize.
  - **how many** — `2 + max(0, (childBst − parentBst)/55) + rarity`, where rarity is 2 for a
    capture rate ≤ 45 and 1 for ≤ 120, clamped to 2..12.

Measured across the whole table: Caterpie → Metapod is **3× Tiny Mushroom**, Bulbasaur → Ivysaur
**6× Tiny Mushroom**, Magikarp → Gyarados **10× Pearl String**, Dragonair → Dragonite **7× Comet
Shard**, Eevee → Flareon **1× Fire Stone + 8× Big Nugget**. A stone evolution pays the stone *and*
the materials — the stone is the mainline's requirement and the materials are this game's, and
dropping either would make one of the two shopping trips pointless.

**(c) Nine evolution items exist in Showdown's data and not in this game, and asking for one
would have made those lines unreachable forever.** `sweetapple`, `syrupyapple`, `tartapple`,
`crackedpot`, `metalalloy`, `auspiciousarmor`, `maliciousarmor`, `galaricacuff`,
`galaricawreath` — all Gen 8/9, none stocked by `economy/items.js`, which ships ten stones and
thirteen trade items. `materialsFor` takes an `isItem` predicate and **drops** an unknown id, so
the route degrades to a plain level-and-materials evolution. It does not invent the item: what the
shop stocks is `economy`'s call, not `pokemon`'s. Check 30 asserts that after this, **every
material named by every one of the 492 routes is an item the game actually ships**.

**(d) A branching line points at the shortest grind, not the first alphabetically.** #61 had
already had to fix this once — `evo` is sorted by name at build time, so "the first row that
qualifies" made Eevee permanently an Espeon. With a price attached the rule gets better: the
offer shown is the route with the fewest units still missing, so an Eevee with four Big Nuggets
and a Fire Stone is offered Flareon and one with nothing is offered the cheapest route it has.
`pokemon.evolutions(id)` returns all eight, priced, for a panel that wants to show the fork.

**(e) A refusal has to say which of the three reasons it is.** `evolve()` answers
`{ ok: false, why }` — *"needs level 36"*, *"still needs 6× Big Nugget"*, *"it does not evolve"* —
and the panel toasts it. The first cut answered "nothing it can evolve into yet" whenever nothing
was affordable, which is true and useless; it falls back to the closest route now and names that
route's actual shortfall. **A greyed-out button that does not say why is the defect this panel
exists to avoid**, and it was on screen for one capture before it was fixed.

**(f) Spend before transforming.** `evolve()` calls `economy.take()` for every line of the bill
and bails on the first refusal, *then* swaps the species. The other order leaves an evolved
Pokémon that was never paid for, and the bug would only show up when a bag was concurrently
drained by an automation.

**(g) Where the button is.** `ui/panels/party.js` — the pane that already owns "which Pokémon is
this" — with the bill above it: the level with what it has beside it, and every material with
`have/need` and a tick. Bound to **E**, listed in the footer. It is drawn from `canEvolve()`,
which is pure, so the panel can call it on every redraw. `pokemon:levelled` toasts *once* per
Pokémon when an evolution first becomes affordable, and the toast names the panel rather than
pressing the button.

**Two things looked at, not reasoned about.**

  - The "EVOLVES INTO …" heading was drawn in `roofLight` when the evolution was ready. In the
    capture it reads as *another red row*, in a block where red is exactly what an unmet
    requirement looks like. It is `ink` now. `docs/progress/pokemon/r3/evolve-ready.png`.
  - `evolutionFor` spread `requirementFor`'s result **over** the species object, and
    `requirementFor` reports `to` as the child's *name* — so `row.to` silently became a string
    and every caller reading `row.to.name` got `undefined` with nothing throwing. Exactly the
    shape of #61's blank type chart, and caught the same way: by looking at a picture that had
    eight rows of `undefined` in it.

**Measured.** `node src/pokemon/selftest.js` 49/49, including: `grantExp` never evolves even with
a full bag (18); an unaffordable offer is still reported rather than hidden (21); a stone route
wants the stone *and* materials (22-23); a branching line offers all eight (24); the cost curve
separates a Caterpie from a Dragonite (26-27); every one of 492 priced routes names a real item
(30) and asks for a reachable level (31). Seams green at 134 files / 17 modules; `/` boots at 60
fps with 0 console errors. Shots: `docs/progress/pokemon/r3/{levelup,evolve-ready,evolve-shopping-list}.png`.

---

### 63 — 2026-09-09 — The HUD said Dewott and an Oshawott kept walking in front of the trainer; and an evolution you paid a hunt for has to be worth watching

Two things, one of them a bug that had been shipping since #62 landed an hour earlier.

**(a) The sprite never changed, and nothing anywhere threw.** `pokemon.evolve()` swaps the
species **in place** on the instance, so `pokemon.party()` reported the new one and the party bar
and the HUD both updated. But `simulation`'s `members` array holds the species object captured at
its last `rebuildMembers`, and `Cast.keyOf` derives the sprite sheet from *that*. So the game drew
a Dewott's name over an Oshawott's sprite, for the rest of the session, with no console error and
no failing check — `simulation` listened for `party:leadChanged` and there was no equivalent for
"the lead is now a different species".

The fix is one listener on `pokemon:evolved` doing what `party:leadChanged` already did:
`rebuildMembers(); restage();`. **The restage runs unconditionally**, before and after the
animation question — a quarantined `pokemon` costs the moment its flourish, never its
correctness.

Verified by driving the real page rather than by reading the code: `oshawott → dewott`, six pearls
spent and the bag left at zero, and the staged cast afterwards contains `dewott` and no
`oshawott`. `docs/progress/pokemon/r3/evolved-overworld.png` is the blue Dewott walking in front
of the trainer with `Dewott Lv 40` in the HUD.

**(b) The animation is built from three properties because those are the three that exist.**
`pokemon/field.js` patches an `aUvRect` attribute into the sprite material and nothing else —
there is **no per-instance colour on the overworld sprite mesh**, so the mainline's white
silhouette is not available and neither is a fade. What an actor does expose is `key` (which sheet
it reads), `scale`, and `visible`. So:

  1. **the alternation**, old form / new form, with the interval easing quadratically from 0.30 s
     to 0.05 s. Quadratic and not linear because a linear ramp reads as a constant flicker for
     most of its length; this one is unmistakably accelerating. Eleven swaps over two seconds.
  2. **a one-frame blink at each swap.** This is the load-bearing one. Two sprites cutting between
     each other with no gap looks like a *dropped frame*, which is precisely what this must not
     look like; the gap is what makes it read as a flash. It is also why the showcase strip below
     deliberately includes one.
  3. **a pop** at the end — the new form overshoots to 1.35 on a half-sine and settles, so the
     sequence lands on something instead of stopping.

It is driven from `pokemon`'s `lateFrame` in **real seconds, not sim steps**: it is presentation,
it must not change what the world does, and a frozen clock has to leave it alone. It does not
fight the walk, and that was checked rather than hoped: `poseWalker` builds
`{ x, y, z, dir, visible, gait, phase }` and never touches `key` or `scale`, and `lateFrame` runs
after `frame`, so the animation's write is the last one of the frame.

**Ownership.** `simulation` plays it because `simulation` owns the actor — it stages the cast and
knows which slot the lead is in. `pokemon` owns the *animation*, because it owns the sprite field
and the atlas, and both sheets have to be prepared before an alternation can read from either.
Neither reaches into the other: an actor id goes one way and a promise comes back.

**(c) It is never played in a showcase, and that is why there is a strip.** The harness spins
ninety frames between `__READY__` and the shutter, so a 2.5-second flash would be caught at a
different point every run and `?showcase=…` would stop being a function of its URL (§6.3). So the
animation is suppressed under `config.showcase`, and `?showcase=pokemon&mode=evolving` lays it out
as **nine sprites, each holding the frame `frameAt()` produces at a fixed instant** — the same
pure function the running animation calls, so the strip is the animation and not a drawing of it.

The first cut of that strip picked its nine timestamps by eye, and **three of them landed exactly
on swap boundaries** — which are blink frames, so three of the nine sprites were invisible — while
three others happened to fall on the same form in a row. A strip of an alternation that does not
alternate. The stops are sampled at the *middle* of each swap now, with one boundary kept on
purpose so the gap is visible. `docs/progress/pokemon/r3/evolving-strip.png`.

**Measured.** `node src/pokemon/selftest.js` 56/56, seven of them new: the flash starts on the old
form and ends settled on the new one, it swaps at least eight times, it blinks but not for more
than forty frames of a hundred and fifty, the scale never collapses or exceeds 1.4, and the swap
interval at 1.8 s is less than half what it is at 0.5 s. Driven live in the page: eleven swaps
across both sheets, twenty-three blink frames, peak scale 1.35, settled on `dewott`, zero console
errors. Seams green at 136 files / 17 modules; regression 0/0/0 across fifteen frames.

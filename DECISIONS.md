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

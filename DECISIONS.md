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

### 15 — 2026-09-07 — What "adapt to AdAstra" means, measured from AdAstra's own geometry

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

### 16 — 2026-09-07 — The adapted props ship as a tileset named `props`

The fifteen rebuilt props are authored art in the same folder shape as `assets/structures/`,
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
